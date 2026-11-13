/** 仅用独占临时文件和两个回环HTTP实例，验证生产静态验收宿主边界；不访问公网或业务数据。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import test from 'node:test'
import { startProductionStaticServer } from './production-static-server.mjs'

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) }
const request = (origin, target, { method = 'GET', body = '', headers = {} } = {}) => new Promise((resolve, reject) => {
  const destination = new URL(origin)
  const client = http.request({ hostname: destination.hostname, port: destination.port, path: target, method, headers }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }))
  })
  client.on('error', reject)
  client.end(body)
})

test('代理目标固定，合法查询/请求体/SSE和静态双边界均保留', { timeout: 15000 }, async t => {
  const parent = fs.realpathSync(process.env.YLINK_ISSUES_VERIFY_ROOT ?? os.tmpdir())
  const directory = fs.mkdtempSync(path.join(parent, 'ylink-static-contract-'))
  const dist = path.join(directory, 'dist'), outside = path.join(directory, 'outside')
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(dist, 'index.html'), '<p>isolated SPA</p>')
  fs.writeFileSync(path.join(dist, 'assets/app.js'), '/* isolated asset */')
  fs.writeFileSync(path.join(outside, 'private.txt'), 'must remain outside')
  fs.symlinkSync(outside, path.join(dist, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const received = []
  let finishStream, trapHits = 0
  const backend = http.createServer((req, res) => {
    if (req.url === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write('data: first\n\n')
      finishStream = () => res.end('data: second\n\n')
      return
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const record = { url: req.url, method: req.method, body: Buffer.concat(chunks).toString(), marker: req.headers['x-fixture-marker'] }
      received.push(record)
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Isolated-Upstream': 'expected' })
      res.end(JSON.stringify(record))
    })
  })
  const trap = http.createServer((_req, res) => { trapHits += 1; res.end('wrong upstream') })
  let host
  try {
    const backendOrigin = await listen(backend), trapOrigin = await listen(trap)
    host = await startProductionStaticServer({ dist, backend: backendOrigin })
    await t.test('绝对URL、网络路径和反斜杠变体在代理前拒绝', async () => {
      for (const target of [`${trapOrigin}/api/probe`, `//127.0.0.1:${trap.address().port}/api/probe`, `/\\127.0.0.1:${trap.address().port}/api/probe`]) {
        assert.equal((await request(host.origin, target)).status, 400, target)
      }
      assert.equal(trapHits, 0)
      assert.equal(received.length, 0)
    })
    await t.test('四类合法路径、重复query、编码值、body及响应头保留', async () => {
      for (const route of ['/api/example', '/health', '/uploads/example.png', '/__issues_verify/example']) {
        const result = await request(host.origin, `${route}?a=1&a=2&encoded=%2F`, { method: 'POST', body: 'fixture body', headers: { 'Content-Type': 'text/plain', 'X-Fixture-Marker': 'safe' } })
        assert.equal(result.status, 200)
        assert.equal(result.headers['x-isolated-upstream'], 'expected')
        assert.deepEqual(JSON.parse(result.body), { url: `${route}?a=1&a=2&encoded=%2F`, method: 'POST', body: 'fixture body', marker: 'safe' })
      }
      assert.equal(trapHits, 0)
    })
    await t.test('SSE首帧在上游结束前到达，后续帧正常转发', async () => {
      const response = await fetch(`${host.origin}/api/stream`, { signal: AbortSignal.timeout(5000) })
      assert.match(response.headers.get('content-type'), /text\/event-stream/)
      const reader = response.body.getReader()
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n')
      assert.equal(typeof finishStream, 'function')
      finishStream()
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: second\n\n')
      assert.equal((await reader.read()).done, true)
    })
    await t.test('真实资产/SPA保持，词法越界和目录链接越界均拒绝', async () => {
      assert.equal((await request(host.origin, '/assets/app.js')).body, '/* isolated asset */')
      assert.equal((await request(host.origin, '/client/orders?tab=pending')).body, '<p>isolated SPA</p>')
      assert.equal((await request(host.origin, '/assets/missing.js')).status, 404)
      assert.equal((await request(host.origin, '/..%2foutside%2fprivate.txt')).status, 403)
      assert.equal((await request(host.origin, '/escape/private.txt')).status, 403)
    })
    await t.test('非127.0.0.1或非HTTP的后端配置仍拒绝', async () => {
      for (const target of ['http://localhost:12345', 'http://127.0.0.2:12345', 'https://127.0.0.1:12345', 'http://user:password@127.0.0.1:12345']) {
        await assert.rejects(startProductionStaticServer({ dist, backend: target }))
      }
    })
  } finally {
    await host?.close()
    await close(backend)
    await close(trap)
    const relative = path.relative(parent, fs.realpathSync(directory))
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('ylink-static-contract-'))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
