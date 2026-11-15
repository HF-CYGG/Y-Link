/** 验证可信代理和协议边界；仅启动本机临时 HTTP 服务，不连接业务数据库。 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import express from 'express'

process.env.APP_PROFILE = `http-security-${process.pid}`
process.env.DB_TYPE = 'sqlite'
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.Y_LINK_TRUST_PROXY = ''
process.env.Y_LINK_FORCE_SECURE_COOKIES = 'false'

const { createApp } = await import('../src/app.js')
assert.equal(createApp().get('trust proxy'), false, '直接运行 Node 默认不得信任任意私网代理')

const { configureHttpSecurity, readHttpSecurityConfig, resolveSecureCookieFlag, isSecureOrDirectLoopback } =
  await import('../src/utils/http-security.js')

// 实际app挂载链：switch的前置JSON解析不能成为绕过认证/跨站策略的响应端点。
const guardedServer = createApp().listen(0, '127.0.0.1')
await once(guardedServer, 'listening')
const guardedAddress = guardedServer.address()
assert.ok(guardedAddress && typeof guardedAddress === 'object')
try {
  const url = `http://127.0.0.1:${guardedAddress.port}/api/data-maintenance/db-migration/switch`
  const unauthorized = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: 'fixture-only' }) })
  assert.equal(unauthorized.status, 401, '解析taskId之后仍必须经过真实管理员认证')
  const crossSite = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' })
  assert.equal(crossSite.status, 403, '维护切换路径仍受全局跨站保护')
} finally { await new Promise<void>((resolve, reject) => guardedServer.close(error => error ? reject(error) : resolve())) }

async function probe(trusted: string) {
  const app = express()
  configureHttpSecurity(app, readHttpSecurityConfig({
    NODE_ENV: 'production', Y_LINK_TRUST_PROXY: trusted,
  }))
  app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure, local: isSecureOrDirectLoopback(req) }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' },
    })
    return { data: await response.json() as { ip: string; secure: boolean; local: boolean }, headers: response.headers }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

const direct = await probe('')
assert.equal(direct.data.ip, '127.0.0.1')
assert.equal(direct.data.secure, false, '不可信 XFP 不得开启安全协议')
assert.equal(direct.data.local, false, '携带代理头的请求不得作为容器本机救援入口')
assert.equal(direct.headers.has('strict-transport-security'), false)
assert.match(direct.headers.get('content-security-policy') ?? '', /default-src 'none'/)
const proxy = await probe('127.0.0.1/32')
assert.equal(proxy.data.ip, '203.0.113.7')
assert.equal(proxy.data.secure, true)
assert.match(proxy.headers.get('strict-transport-security') ?? '', /max-age=/)
assert.equal(resolveSecureCookieFlag({ secure: false }), false, 'LAN HTTP 仍可登录')
process.env.Y_LINK_FORCE_SECURE_COOKIES = 'true'
assert.equal(resolveSecureCookieFlag({ secure: false }), true)
assert.throws(() => readHttpSecurityConfig({ Y_LINK_TRUST_PROXY: 'true' }))
assert.throws(() => readHttpSecurityConfig({ Y_LINK_TRUST_PROXY: '0.0.0.0/0' }))
assert.throws(() => readHttpSecurityConfig({ Y_LINK_TRUST_PROXY: '127.0.0.1; injected' }))
console.log('[http-security] 默认拒绝代理伪造、可信单跳协议、Cookie 与本机救援边界通过')
