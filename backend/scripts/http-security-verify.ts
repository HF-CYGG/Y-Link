/** 验证可信代理和协议边界；仅启动本机临时 HTTP 服务，不连接业务数据库。 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mock } from 'node:test'
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
  await crossSite.text()
  const baseUrl = 'http://127.0.0.1:' + guardedAddress.port
  for (const route of ['/api/auth/webauthn/capabilities', '/API/Auth/WebAuthn/Capabilities/?query=fixture']) {
    const sameOrigin = await fetch(baseUrl + route)
    assert.equal(sameOrigin.status, 200)
    assert.equal(sameOrigin.headers.get('cache-control'), 'no-store')
    await sameOrigin.text()
    const rejected = await fetch(baseUrl + route, { headers: { 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(rejected.status, 403)
    assert.equal(rejected.headers.get('cache-control'), 'no-store')
    await rejected.text()
  }
  const originRejected = await fetch(baseUrl + '/API/Data-Maintenance/DB-Migration/Switch/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://cross-site.example' }, body: '{}',
  })
  assert.equal(originRejected.status, 403)
  await originRejected.text()
} finally { await new Promise<void>((resolve, reject) => guardedServer.close(error => error ? reject(error) : resolve())) }

// 在抛弃型 Express 应用中让真实屏障面对长连接，避免修改维护状态文件及业务数据库。
const { databaseMaintenanceWriteBarrier } = await import('../src/middleware/database-maintenance.middleware.js')
const { databaseMaintenanceModeService } = await import('../src/services/database-maintenance-mode.service.js')
const { databaseOperationGate } = await import('../src/database/operation-gate.js')
const maintenanceApp = express()
maintenanceApp.use(databaseMaintenanceWriteBarrier)
maintenanceApp.get(['/api/client-feedback/stream', '/api/customer-service/stream'], (_req, res) => {
  res.type('text/event-stream').flushHeaders()
})
maintenanceApp.get('/api/v1/mobile-auth/capabilities', (_req, res) => res.json({ code: 0 }))
const maintenanceServer = maintenanceApp.listen(0, '127.0.0.1')
await once(maintenanceServer, 'listening')
const maintenanceAddress = maintenanceServer.address()
assert.ok(maintenanceAddress && typeof maintenanceAddress === 'object')
try {
  const baseUrl = 'http://127.0.0.1:' + maintenanceAddress.port
  const activeBefore = databaseOperationGate.snapshot().activeOperations
  for (const route of ['/api/client-feedback/stream', '/api/Client-Feedback/Stream/?fixture=1', '/api/Customer-Service/Stream/']) {
    const connection = new AbortController()
    try {
      const response = await fetch(baseUrl + route, { signal: AbortSignal.any([connection.signal, AbortSignal.timeout(3000)]) })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
      assert.equal(databaseOperationGate.snapshot().activeOperations, activeBefore, 'SSE 长连接不得持有排空租约')
      const freeze = databaseOperationGate.freeze()
      try { await freeze.drain(300) } finally { freeze.release() }
    } finally { connection.abort() }
  }
  const normal = await fetch(baseUrl + '/api/v1/mobile-auth/capabilities')
  assert.equal(normal.status, 200)
  await normal.text()
  const readOnly = mock.method(databaseMaintenanceModeService, 'isReadOnly', () => true)
  try {
    for (const method of ['GET', 'HEAD']) {
      const blocked = await fetch(baseUrl + '/API/V1/Mobile-Auth/Capabilities/?fixture=1', { method })
      assert.equal(blocked.status, 503, '维护期请求不能越过屏障到达认证限流')
      assert.equal(blocked.headers.get('cache-control'), 'no-store')
      if (method === 'GET') assert.equal((await blocked.json()).code, 50301)
    }
  } finally { readOnly.mock.restore() }
} finally {
  maintenanceServer.closeAllConnections()
  await new Promise<void>((resolve, reject) => maintenanceServer.close(error => error ? reject(error) : resolve()))
}

// 使用真实路由、投影和频控，在隔离夹具中代替会话、持久窗口和业务写入。
const { o2oRouter } = await import('../src/routes/o2o.routes.js')
const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
const { authService } = await import('../src/services/auth.service.js')
const { clientAuthService } = await import('../src/services/client-auth.service.js')
const o2oApp = express()
o2oApp.use('/api/o2o', o2oRouter)
const o2oServer = o2oApp.listen(0, '127.0.0.1')
await once(o2oServer, 'listening')
const o2oAddress = o2oServer.address()
assert.ok(o2oAddress && typeof o2oAddress === 'object')
const orderFixture = {
  records: [{ id: 'fixture', systemNo: 'SYS-FIXTURE', customerOrderShowNo: 'SYS-FIXTURE', businessNo: 'BUS-FIXTURE' }],
}
const stubs = [
  mock.method(authService, 'resolveAuthUserByToken', async (token: string) => ({
    role: token === 'admin-fixture' ? 'admin' : 'operator', permissions: ['orders:view'], sessionToken: token,
  })),
  mock.method(authService, 'isSessionActivityUpdateDue', () => false),
  mock.method(clientAuthService, 'resolveClientByToken', async (token: string) => ({ userId: token })),
  mock.method(o2oPreorderService, 'listConsoleOrders', async () => orderFixture),
  mock.method(o2oPreorderService, 'listMyOrders', async () => orderFixture),
]
try {
  const baseUrl = 'http://127.0.0.1:' + o2oAddress.port
  for (const [token, route] of [
    ['admin-fixture', '/api/o2o/Orders/'],
    ['operator-fixture', '/api/o2o/Orders/'],
    ['client-fixture', '/api/o2o/Mall/Preorders/'],
  ]) {
    const result = await fetch(baseUrl + route, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3000) })
    assert.equal(result.status, 200, route)
    const { records } = (await result.json()).data
    assert.equal(records[0].businessNo, 'BUS-FIXTURE')
    assert.equal('systemNo' in records[0], token === 'admin-fixture')
    assert.equal('customerOrderShowNo' in records[0], token === 'admin-fixture')
  }
  assert.equal(orderFixture.records[0].systemNo, 'SYS-FIXTURE', '投影不得修改原有快照')

} finally {
  for (const stub of stubs) stub.mock.restore()
  await new Promise<void>((resolve, reject) => o2oServer.close(error => error ? reject(error) : resolve()))
}

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
console.log('[http-security] 默认拒绝代理伪造、可信单跳协议、Cookie、本机救援与 HTTP 路径边界通过')
