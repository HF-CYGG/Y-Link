/**
 * 文件说明：O2O 订单治理路由级隔离验收。
 * 文件职责：在独立 SQLite 与真实 HTTP 应用中验证管理端撤销、批量永久删除的权限、CSRF、永久删除密码和参数边界。
 * 实现逻辑：
 * - 先设置独立运行环境，再动态加载后端模块，避免污染本地开发库；
 * - 通过真实登录接口取得 Cookie 与 CSRF Token，不以 Bearer 兼容路径替代 Cookie 防护验证；
 * - 构造管理员、操作员、供货方与 O2O 订单，覆盖权限不足、角色不足、CSRF 缺失、密码错误、2/200 与 50/51 边界。
 * 维护说明：新增 O2O 管理写接口时，应在此脚本中补充对应的真实路由门禁断言。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `o2o-governance-route-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Zz9!`
const permanentDeletePassword = `Purge_${verifySeed}_Zz9!`

// 必须先于任何后端模块加载：env.ts 在模块初始化时读取这些值。
process.env.APP_PROFILE = `o2o-governance-route-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword
process.env.PERMANENT_DELETE_PASSWORD = permanentDeletePassword

type JsonPayload = { code?: number; message?: string; data?: unknown }
type CookieSession = { cookie: string; csrfToken: string }

const log = (message: string) => console.log(`✅ ${message}`)

async function readJson(response: Response): Promise<JsonPayload> {
  const body = await response.text()
  try {
    return JSON.parse(body) as JsonPayload
  } catch {
    throw new Error(`响应不是 JSON：status=${response.status} body=${body}`)
  }
}

async function expectStatus(request: () => Promise<Response>, expectedStatus: number, scene: string): Promise<JsonPayload> {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, expectedStatus, `${scene}：期望 HTTP ${expectedStatus}，实际 ${response.status}`)
  assert.equal(payload.code, expectedStatus >= 200 && expectedStatus < 300 ? 0 : expectedStatus, `${scene}：业务 code 异常`)
  return payload
}

function getSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const values = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
  return values.filter(Boolean)
}

async function loginCookieSession(baseUrl: string, username: string, password: string): Promise<CookieSession> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const payload = await readJson(response)
  assert.equal(response.status, 200, `登录 ${username} 失败：${JSON.stringify(payload)}`)
  assert.equal(payload.code, 0, `登录 ${username} 业务失败：${JSON.stringify(payload)}`)
  const cookies = getSetCookies(response)
  const cookie = cookies.map((item) => item.split(';')[0]).join('; ')
  const csrfCookie = cookies.find((item) => item.startsWith('y_link_admin_csrf='))
  const csrfToken = csrfCookie?.split(';')[0]?.slice('y_link_admin_csrf='.length)
  assert.ok(cookie.includes('y_link_admin_session='), `登录 ${username} 未取得会话 Cookie`)
  assert.ok(csrfToken, `登录 ${username} 未取得 CSRF Cookie`)
  return { cookie, csrfToken: decodeURIComponent(csrfToken) }
}

const writeHeaders = (session: CookieSession, csrf = true): Record<string, string> => ({
  Cookie: session.cookie,
  'Content-Type': 'application/json',
  ...(csrf ? { 'x-csrf-token': session.csrfToken } : {}),
})

async function registerAndLoginClient(clientAuthService: typeof import('../src/services/client-auth.service.js').clientAuthService) {
  const captcha = await clientAuthService.createCaptcha()
  const captchaCode = captcha.captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
  const account = `1${String(Date.now()).slice(-10)}`
  const password = 'ClientVerify_2026A'
  const registered = await clientAuthService.register({
    accountType: 'personal', account, username: '路由治理测试用户', password, captchaId: captcha.captchaId, captchaCode,
  })
  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginCaptchaCode = loginCaptcha.captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
  const login = await clientAuthService.login({
    account: registered.user.mobile, password, captchaId: loginCaptcha.captchaId, captchaCode: loginCaptchaCode,
  })
  return clientAuthService.resolveClientByToken(login.token)
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const [{ createApp }, { AppDataSource }, { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime }, { authService }, { userService }, { systemConfigService }, { clientAuthService }, { productService }, { o2oPreorderService }] = await Promise.all([
    import('../src/app.js'),
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/services/auth.service.js'),
    import('../src/services/user.service.js'),
    import('../src/services/system-config.service.js'),
    import('../src/services/client-auth.service.js'),
    import('../src/services/product.service.js'),
    import('../src/services/o2o-preorder.service.js'),
  ])

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  const bootstrapAdmin = await authService.ensureDefaultAdmin()
  await systemConfigService.ensureDefaultConfigs()
  const scriptAdmin = {
    userId: String(bootstrapAdmin.id), username: bootstrapAdmin.username, displayName: bootstrapAdmin.displayName,
    role: 'admin' as const, permissions: [], status: 'enabled' as const, sessionToken: 'o2o-governance-route-script', authSource: 'bearer' as const,
  }
  const operatorPassword = 'OperatorVerify_2026A'
  const supplierPassword = 'SupplierVerify_2026A'
  const operator = await userService.create({ username: `o2o_operator_${verifySeed}`, password: operatorPassword, displayName: '路由测试操作员', role: 'operator' }, scriptAdmin)
  const supplier = await userService.create({ username: `o2o_supplier_${verifySeed}`, password: supplierPassword, displayName: '路由测试供货方', role: 'supplier' }, scriptAdmin)

  const server = createApp().listen(0, '127.0.0.1')
  try {
    if (!server.listening) await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number', '无法取得隔离 HTTP 端口')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const [adminSession, operatorSession, supplierSession] = await Promise.all([
      loginCookieSession(baseUrl, 'admin', adminPassword),
      loginCookieSession(baseUrl, operator.username, operatorPassword),
      loginCookieSession(baseUrl, supplier.username, supplierPassword),
    ])
    const clientAuth = await registerAndLoginClient(clientAuthService)
    const product = await productService.create({ productName: `路由治理商品-${verifySeed}`, pinyinAbbr: 'LYZL', defaultPrice: 10, isActive: true, o2oStatus: 'listed', currentStock: 100, limitPerUser: 100 })
    const submit = (clientRequestId: string) => o2oPreorderService.submit(clientAuth, {
      clientRequestId, items: [{ productId: product.id, qty: 1 }], remark: '路由隔离验证', isSystemApplied: false, pickupContact: '路由测试提货人',
    })
    const permissionOrder = await submit('o2o-route-permission-0001')
    const csrfAndPasswordOrder = await submit('o2o-route-batch-0001')
    await o2oPreorderService.cancelMyOrder(clientAuth, csrfAndPasswordOrder.order.id)

    const missingUpdate = await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/${permissionOrder.order.id}/cancel`, { method: 'POST', headers: writeHeaders(supplierSession), body: JSON.stringify({ reason: '供货方越权撤销' }) }),
      403,
      '缺少 orders:update 的供货方撤销订单',
    )
    assert.equal(missingUpdate.message, '当前账号无权执行该操作')
    log('撤销接口拒绝缺少 orders:update 的已登录供货方')

    const operatorBatch = await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/batch-purge-cancelled`, { method: 'POST', headers: writeHeaders(operatorSession), body: JSON.stringify({ orders: [{ id: csrfAndPasswordOrder.order.id, confirmShowNo: csrfAndPasswordOrder.order.showNo }], permanentDeletePassword }) }),
      403,
      '非管理员且缺少 orders:delete 的操作员批删',
    )
    assert.equal(operatorBatch.message, '当前账号无权执行该操作')
    log('批删接口拒绝非 admin 且缺少 orders:delete 的操作员')

    const csrfRejected = await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/batch-purge-cancelled`, { method: 'POST', headers: writeHeaders(adminSession, false), body: JSON.stringify({ orders: [{ id: csrfAndPasswordOrder.order.id, confirmShowNo: csrfAndPasswordOrder.order.showNo }], permanentDeletePassword }) }),
      403,
      '管理员 Cookie 会话缺少 CSRF 的批删',
    )
    assert.equal(csrfRejected.message, '请求安全校验失败，请刷新页面后重试')
    log('批删接口拒绝缺少 CSRF Header 的管理员 Cookie 会话')

    const passwordRejected = await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/batch-purge-cancelled`, { method: 'POST', headers: writeHeaders(adminSession), body: JSON.stringify({ orders: [{ id: csrfAndPasswordOrder.order.id, confirmShowNo: csrfAndPasswordOrder.order.showNo }], permanentDeletePassword: 'wrong-permanent-password' }) }),
      403,
      '管理员错误永久删除密码的批删',
    )
    assert.equal(passwordRejected.message, '永久删除密码不正确')
    log('批删接口拒绝错误永久删除密码')

    const shortReasonOrder = await submit('o2o-route-reason-short-01')
    await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/${shortReasonOrder.order.id}/cancel`, { method: 'POST', headers: writeHeaders(adminSession), body: JSON.stringify({ reason: '短' }) }),
      400,
      '撤销原因长度 1',
    )
    const minReasonOrder = await submit('o2o-route-reason-minimum-01')
    const minReason = await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/${minReasonOrder.order.id}/cancel`, { method: 'POST', headers: writeHeaders(adminSession), body: JSON.stringify({ reason: '刚好' }) }),
      200,
      '撤销原因长度 2',
    )
    assert.equal(minReason.code, 0)
    const maxReasonOrder = await submit('o2o-route-reason-maximum-01')
    const maxReason = await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/${maxReasonOrder.order.id}/cancel`, { method: 'POST', headers: writeHeaders(adminSession), body: JSON.stringify({ reason: '原'.repeat(200) }) }),
      200,
      '撤销原因长度 200',
    )
    assert.equal(maxReason.code, 0)
    const longReasonOrder = await submit('o2o-route-reason-longest-01')
    await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/${longReasonOrder.order.id}/cancel`, { method: 'POST', headers: writeHeaders(adminSession), body: JSON.stringify({ reason: '原'.repeat(201) }) }),
      400,
      '撤销原因长度 201',
    )
    log('撤销原因 1/2/200/201 路由边界通过')

    const upperLimitOrders = Array.from({ length: 50 }, (_, index) => ({ id: `route-upper-${index}`, confirmShowNo: `route-upper-${index}` }))
    const upperLimit = await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/batch-purge-cancelled`, { method: 'POST', headers: writeHeaders(adminSession), body: JSON.stringify({ orders: upperLimitOrders, permanentDeletePassword }) }),
      200,
      '批删数量 50',
    )
    assert.equal((upperLimit.data as { summary?: { requested?: number } }).summary?.requested, 50)
    const overLimit = await expectStatus(
      () => fetch(`${baseUrl}/api/o2o/orders/batch-purge-cancelled`, { method: 'POST', headers: writeHeaders(adminSession), body: JSON.stringify({ orders: [...upperLimitOrders, { id: 'route-over-50', confirmShowNo: 'route-over-50' }], permanentDeletePassword }) }),
      400,
      '批删数量 51',
    )
    assert.match(overLimit.message ?? '', /最多 50|50/)
    log('批删数量 50/51 路由边界通过')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    try { fs.rmSync(sqlitePath, { force: true }) } catch { /* SQLite 句柄延迟不覆盖断言结果。 */ }
  }
}

main().then(
  () => console.log('\nO2O 订单治理路由隔离验收通过'),
  (error) => { console.error('\nO2O 订单治理路由隔离验收失败'); console.error(error); process.exitCode = 1 },
)
