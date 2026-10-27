/** 真实Vite HTTPS/HTTP2专项：隔离SQLite与独立端口，逐次RST归还连接；不使用或重启UI环境。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import { EventEmitter } from 'node:events'
import { createServer } from 'vite'
import { configureFeedbackSseProxy } from '../../scripts/feedback-sse-dev-proxy.js'
import { createRestockTestRuntime } from './restock-test-runtime.js'

const runtime = await createRestockTestRuntime()
const { customerServiceRealtimeService: realtime } = await import('../src/services/customer-service-realtime.service.js')
const backend = await runtime.listen()
const certificate = fs.readFileSync(path.resolve('node_modules/.vite/basic-ssl/_cert.pem'))
const freePort = await new Promise<number>((resolve, reject) => {
  const server = http.createServer(); server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(() => resolve(address.port)) })
})
const closes: Array<{ path: string; writableFinished: boolean; upstreamDestroyed: boolean }> = []
const proxy = await createServer({ configFile: false, root: runtime.runtimeDir, cacheDir: path.join(runtime.runtimeDir, 'vite-cache'), appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: freePort, strictPort: true, https: { key: certificate, cert: certificate }, proxy: {
    '/api': { target: backend.baseUrl, changeOrigin: true, configure: (server, options) => {
      configureFeedbackSseProxy(server, options)
      server.on('proxyReq', (upstream, req, res) => {
        if (!req.url?.endsWith('/stream')) return
        res.once('close', () => closes.push({ path: req.url!, writableFinished: res.writableFinished, upstreamDestroyed: upstream.destroyed }))
      })
    } },
  } } })
await proxy.listen()
const origin = `https://127.0.0.1:${freePort}`
const h2 = http2.connect(origin, { rejectUnauthorized: false })
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const count = (scope: 'client' | 'service') => {
  const snapshot = realtime.buildServiceSessionSnapshot()
  return scope === 'client' ? snapshot.clientConnectionCount : snapshot.serviceConnectionCount
}
const until = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await pause(10)
  assert.ok(predicate(), message)
}
const route = (scope: 'client' | 'service') => scope === 'client' ? '/api/client-feedback/stream' : '/api/customer-service/stream'
const token = (scope: 'client' | 'service') => scope === 'client' ? runtime.client.token : runtime.operator.token
const openH2 = (scope: 'client' | 'service', status = 200) => new Promise<http2.ClientHttp2Stream>((resolve, reject) => {
  const stream = h2.request({ ':path': route(scope), authorization: `Bearer ${token(scope)}` })
  stream.setEncoding('utf8'); let text = ''
  stream.once('response', (headers) => {
    try { assert.equal(headers[':status'], status) } catch (error) { reject(error) }
    if (status !== 200) resolve(stream)
  })
  stream.on('data', (chunk) => { text += chunk; if (text.includes('event: connected')) resolve(stream) })
  stream.once('error', reject); stream.end()
})
const stopH2 = async (stream: http2.ClientHttp2Stream) => {
  const closed = new Promise<void>((resolve) => stream.once('close', resolve))
  stream.close(http2.constants.NGHTTP2_CANCEL); await closed
}
const openHttp1 = (url: string) => new Promise<http.ClientRequest>((resolve, reject) => {
  const request = (url.startsWith('https') ? https : http).get(url + route('client'), { headers: { Authorization: `Bearer ${runtime.client.token}` }, rejectUnauthorized: false }, (response) => {
    assert.equal(response.statusCode, 200); response.setEncoding('utf8'); let text = ''
    response.on('data', (chunk) => { text += chunk; if (text.includes('event: connected')) resolve(request) })
  })
  request.once('error', (error) => { if (!request.destroyed) reject(error) })
})
try {
  // 先关闭的下游在proxyReq事件时不得留下监听或上游；普通接口完全不加钩子。
  const fakeProxy = new EventEmitter()
  configureFeedbackSseProxy(fakeProxy as never, {} as never)
  for (const pathname of ['/api/client-feedback/stream', '/api/customer-service/stream']) {
    const upstream = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; this.emit('close') } })
    const response = Object.assign(new EventEmitter(), { destroyed: true })
    fakeProxy.emit('proxyReq', upstream, { url: pathname }, response)
    assert.equal(upstream.destroyed, true)
    assert.equal(response.listenerCount('close') + response.listenerCount('error'), 0)
  }
  const ordinaryResponse = new EventEmitter()
  fakeProxy.emit('proxyReq', new EventEmitter(), { url: '/api/client-feedback/portal-config' }, ordinaryResponse)
  assert.equal(ordinaryResponse.listenerCount('close') + ordinaryResponse.listenerCount('error'), 0)
  for (const url of [backend.baseUrl, origin]) for (let index = 0; index < 3; index += 1) {
    const request = await openHttp1(url); assert.equal(count('client'), 1)
    request.destroy(); await until(() => count('client') === 0, 'HTTP1中止必须逐次归还基数0')
  }
  assert.equal(h2.alpnProtocol, 'h2')
  for (const scope of ['client', 'service'] as const) for (let index = 0; index < 3; index += 1) {
    const stream = await openH2(scope); assert.equal(count(scope), 1)
    await stopH2(stream)
    await until(() => count(scope) === 0, `${scope} HTTP2 RST_STREAM必须逐次归还基数0`)
  }
  const healthy = await Promise.all([openH2('client'), openH2('client'), openH2('client')])
  assert.equal(count('client'), 3)
  const denied = await openH2('client', 429)
  denied.resume()
  assert.equal(count('client'), 3, '第四连接429不得踢掉三条健康连接')
  for (const stream of healthy) await stopH2(stream)
  await until(() => count('client') === 0, '三条健康连接逐个中止后归零')
  const normal = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const stream = h2.request({ ':path': '/api/client-feedback/portal-config', authorization: `Bearer ${runtime.client.token}` }); let status = 0, body = ''
    stream.once('response', (headers) => { status = Number(headers[':status']) }); stream.setEncoding('utf8'); stream.on('data', (chunk) => { body += chunk })
    stream.once('end', () => resolve({ status, body })); stream.once('error', reject); stream.end()
  })
  assert.equal(normal.status, 200); assert.equal(JSON.parse(normal.body).code, 0)
  assert.ok(closes.some((item) => item.writableFinished && item.upstreamDestroyed), '覆盖原代理会漏掉的writableFinished=true关闭事件')
  const evidence = { status: 'passed', protocol: h2.alpnProtocol, http1DirectAborts: 3, http1ProxyAborts: 3, http2ClientAborts: 3, http2ServiceAborts: 3,
    healthyConnections: 3, fourthStatus: 429, finalClientCount: count('client'), finalServiceCount: count('service'), closes }
  fs.writeFileSync(path.join(runtime.runtimeDir, 'sse-proxy-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} finally {
  h2.destroy(); await proxy.close(); backend.server.closeAllConnections()
  await new Promise<void>((resolve) => backend.server.close(() => resolve()))
  realtime.disconnectByOwner('client', runtime.client.auth.userId); realtime.disconnectByOwner('service', runtime.operator.auth.userId)
  await runtime.close()
}
