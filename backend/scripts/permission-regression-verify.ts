/**
 * 文件说明：backend/scripts/permission-regression-verify.ts
 * 文件职责：执行管理端角色权限、写入防护与订单内容编辑路由的真实 HTTP 回归。
 * 实现逻辑：
 * 1) 使用独立 SQLite 数据库启动真实后端应用，避免污染开发数据库；
 * 2) 管理员登录后创建操作员，先验证管理员可访问关键治理接口（正向）；
 * 3) 使用操作员访问管理员专属接口，验证 403 拦截（反向）；
 * 4) 经过真实 Express 中间件验证 admin/operator/supplier 的订单编辑、修订和乐观版本行为；
 * 5) 读取审计日志，验证越权拦截会写入 `security.access_denied` 记录。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installCaptchaServiceForTesting } from '../src/services/captcha.service.js'
import { requestLocalHttp } from './support/local-http-request.js'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const repositoryRoot = path.resolve(backendRoot, '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `permission-regression-${verifySeed}.sqlite`)
const adminPassword = process.env.Y_LINK_VERIFY_ADMIN_PASSWORD?.trim() || `Admin_${verifySeed}_Zz9!`
const operatorPassword = process.env.Y_LINK_VERIFY_OPERATOR_PASSWORD?.trim() || `Op_${verifySeed}_Aa1!`
const supplierPassword = process.env.Y_LINK_VERIFY_SUPPLIER_PASSWORD?.trim() || `Supplier_${verifySeed}_Cc3!`
const forbiddenUserPassword = process.env.Y_LINK_VERIFY_FORBIDDEN_PASSWORD?.trim() || `Forbidden_${verifySeed}_Bb2!`
const verifyDatabaseType = process.env.Y_LINK_PERMISSION_VERIFY_DB_TYPE?.trim().toLowerCase() === 'mysql'
  ? 'mysql'
  : 'sqlite'

process.env.APP_PROFILE = `permission-regression-${verifySeed}`
process.env.DB_TYPE = verifyDatabaseType
process.env.DB_SYNC = verifyDatabaseType === 'mysql' ? 'true' : 'false'
if (verifyDatabaseType === 'sqlite') process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

const TEST_CAPTCHA_CODE = 'ABC123'
installCaptchaServiceForTesting({ createCode: () => TEST_CAPTCHA_CODE })

type JsonPayload = {
  code?: number
  message?: string
  data?: unknown
}

function pass(message: string) {
  // eslint-disable-next-line no-console
  console.log(`✅ ${message}`)
}

async function readJson(response: Response): Promise<JsonPayload> {
  const bodyText = await response.text()
  try {
    return JSON.parse(bodyText) as JsonPayload
  } catch (error) {
    throw new Error(
      `响应不是合法 JSON，status=${response.status} body=${bodyText}\n解析错误：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function expectJsonOkResponse<TData>(response: Response, scene: string): Promise<TData> {
  const payload = await readJson(response)
  assert.equal(response.status, 200, `${scene} HTTP 状态码异常：${response.status}`)
  assert.equal(payload.code, 0, `${scene} 业务状态码异常：${JSON.stringify(payload)}`)
  return payload.data as TData
}

async function expectJsonOk<TData>(request: () => Promise<Response>, scene: string): Promise<TData> {
  return expectJsonOkResponse<TData>(await request(), scene)
}

function readCookieValueFromResponse(response: Response, cookieName: string): string | null {
  const headersWithSetCookie = response.headers as Headers & {
    getSetCookie?: () => string[]
    raw?: () => Record<string, string[]>
  }
  const setCookieValues = headersWithSetCookie.getSetCookie?.()
    ?? headersWithSetCookie.raw?.()['set-cookie']
    ?? [response.headers.get('set-cookie') ?? '']
  const rawSetCookie = setCookieValues.filter(Boolean).join(',')
  const match = rawSetCookie.match(new RegExp(`(?:^|,\\s*)${cookieName}=([^;]+)`))
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

async function loginAdminSession(
  baseUrl: string,
  body: Record<string, unknown>,
  scene: string,
): Promise<{
  token: string
  csrfToken: string
  user: { username: string; role: string }
}> {
  const response = await requestLocalHttp(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const loginData = await expectJsonOkResponse<{
    token?: string
    user: { username: string; role: string }
  }>(response, scene)
  const token = loginData.token ?? readCookieValueFromResponse(response, 'y_link_admin_session')
  const csrfToken = readCookieValueFromResponse(response, 'y_link_admin_csrf')
  assert.ok(token, `${scene} 未返回可用于回归请求的管理端会话`)
  assert.ok(csrfToken, `${scene} 未返回管理端 CSRF Cookie`)
  return {
    token,
    csrfToken,
    user: loginData.user,
  }
}

async function expectJsonForbidden(request: () => Promise<Response>, scene: string) {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, 403, `${scene} 期望 403，实际 ${response.status}`)
  assert.equal(payload.code, 403, `${scene} 业务状态码应为 403`)
  assert.equal(payload.message, '当前账号无权执行该操作', `${scene} 拦截提示异常`)
  return payload
}

async function expectJsonStatus(request: () => Promise<Response>, scene: string, expectedStatus: number) {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, expectedStatus, `${scene} 期望 ${expectedStatus}，实际 ${response.status}`)
  assert.equal(payload.code, expectedStatus, `${scene} 业务状态码应为 ${expectedStatus}`)
  return payload
}

async function expectJsonOneOfStatuses(request: () => Promise<Response>, scene: string, expectedStatuses: number[]) {
  const response = await request()
  const payload = await readJson(response)
  assert.ok(
    expectedStatuses.includes(response.status),
    `${scene} expected one of ${expectedStatuses.join(', ')} but got ${response.status}`,
  )
  assert.equal(payload.code, response.status, `${scene} business status should match HTTP status`)
  return {
    status: response.status,
    payload,
  }
}

const readCaptchaCode = (_captchaSvg: string) => TEST_CAPTCHA_CODE

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    // Windows 上 sqlite 句柄释放偶发滞后，清理失败不能掩盖权限回归断言结果。
    console.warn(
      `[permission-regression] 临时 SQLite 清理失败，已忽略：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  try {
    await requestLocalHttp('http://127.0.0.1:6000/permission-http-transport-probe')
  } catch (error) {
    assert.doesNotMatch(
      error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error),
      /bad port/i,
      'Node http.request 适配器不得重现 fetch forbidden-port 错误',
    )
  }
  pass('本地 HTTP 请求适配器不受 fetch forbidden-port 限制')

  const { createApp } = await import('../src/app.js')
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
  const { BizOutboundOrderItem } = await import('../src/entities/biz-outbound-order-item.entity.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()

  const app = createApp()
  const server = app.listen(0, '127.0.0.1')

  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await authService.ensureDefaultAdmin()
    await systemConfigService.ensureDefaultConfigs()

    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.once('listening', () => resolve())
      })
    }

    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number', '回归服务端口获取失败')
    const baseUrl = `http://127.0.0.1:${address.port}`

    await expectJsonStatus(
      () => requestLocalHttp(`${baseUrl}/api/users?page=1&pageSize=20`),
      '未登录访问用户列表',
      401,
    )
    pass('未携带 token 访问治理接口会返回 401')

    await expectJsonStatus(
      () =>
        requestLocalHttp(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: `${adminPassword}_wrong`,
          }),
        }),
      '管理员错误密码登录',
      401,
    )
    pass('管理端错误密码登录会进入失败计数')

    await expectJsonStatus(
      () =>
        requestLocalHttp(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: adminPassword,
          }),
        }),
      '失败后未带验证码登录',
      428,
    )
    pass('管理端失败后再次登录要求图形验证码')

    const adminCaptcha = await expectJsonOk<{
      captchaId: string
      captchaSvg: string
    }>(() => requestLocalHttp(`${baseUrl}/api/auth/captcha`), '获取管理端图形验证码')
    await expectJsonStatus(
      () =>
        requestLocalHttp(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: adminPassword,
            captchaId: adminCaptcha.captchaId,
            captchaCode: 'WRONG',
          }),
        }),
      '错误图形验证码登录',
      400,
    )
    pass('错误图形验证码会被拒绝')

    await expectJsonStatus(
      () =>
        requestLocalHttp(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: `${adminPassword}_wrong_again`,
            captchaId: adminCaptcha.captchaId,
            captchaCode: readCaptchaCode(adminCaptcha.captchaSvg),
          }),
        }),
      '正确验证码但错误密码登录',
      401,
    )
    pass('正确验证码不会绕过密码校验')

    const adminCaptchaForSuccess = await expectJsonOk<{
      captchaId: string
      captchaSvg: string
    }>(() => requestLocalHttp(`${baseUrl}/api/auth/captcha`), '重新获取管理端图形验证码')
    const adminLogin = await expectJsonOk<{
      token: string
      user: { username: string; role: string }
    }>(
      () =>
        requestLocalHttp(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin',
            password: adminPassword,
            captchaId: adminCaptchaForSuccess.captchaId,
            captchaCode: readCaptchaCode(adminCaptchaForSuccess.captchaSvg),
          }),
        }),
      '管理员登录',
    )
    assert.equal(adminLogin.user.username, 'admin')
    assert.equal(adminLogin.user.role, 'admin')
    const adminSession = await loginAdminSession(
      baseUrl,
      {
        username: 'admin',
        password: adminPassword,
      },
      'admin session token fallback login',
    )
    const adminToken = adminLogin.token ?? adminSession.token
    pass('管理员登录成功')

    const createdOperator = await expectJsonOk<{
      id: string
      username: string
      role: string
      status: string
    }>(
      () =>
        requestLocalHttp(`${baseUrl}/api/users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: `permission_operator_${verifySeed}`,
            password: operatorPassword,
            displayName: '权限回归操作员',
            role: 'operator',
            status: 'enabled',
          }),
        }),
      '管理员创建操作员',
    )
    assert.equal(createdOperator.role, 'operator')
    pass('管理员可创建操作员（正向）')

    const createdSupplier = await expectJsonOk<{
      id: string
      username: string
      role: string
    }>(
      () =>
        requestLocalHttp(`${baseUrl}/api/users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: `permission_supplier_${verifySeed}`,
            password: supplierPassword,
            displayName: '权限回归供货方',
            role: 'supplier',
            status: 'enabled',
          }),
        }),
      '管理员创建供货方',
    )
    assert.equal(createdSupplier.role, 'supplier')
    pass('管理员可创建供货方（正向）')

    const adminUsers = await expectJsonOk<{
      list: Array<{ id: string }>
    }>(
      () =>
        requestLocalHttp(`${baseUrl}/api/users?page=1&pageSize=20&keyword=permission_operator_`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      '管理员读取用户列表',
    )
    assert.ok(adminUsers.list.some((item) => item.id === createdOperator.id), '管理员未查询到刚创建的操作员')
    pass('管理员可读取用户列表（正向）')

    const adminAuditLogs = await expectJsonOk<{
      list: Array<{ id: string }>
    }>(
      () =>
        requestLocalHttp(`${baseUrl}/api/audit-logs?page=1&pageSize=10`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      '管理员读取审计日志',
    )
    assert.ok(Array.isArray(adminAuditLogs.list), '管理员审计日志列表结构异常')
    pass('管理员可读取审计日志（正向）')

    const adminMigrationRuntime = await expectJsonOk<{
      effectiveDatabase: { dbType: string }
    }>(
      () =>
        requestLocalHttp(`${baseUrl}/api/data-maintenance/db-migration/runtime-override`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      '管理员读取数据库迁移运行时状态',
    )
    assert.equal(adminMigrationRuntime.effectiveDatabase.dbType, verifyDatabaseType)
    pass('管理员可读取数据库迁移运行时状态（正向）')

    const operatorLogin = await expectJsonOk<{
      token: string
      user: { username: string; role: string }
    }>(
      () =>
        requestLocalHttp(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: createdOperator.username,
            password: operatorPassword,
          }),
        }),
      '操作员登录',
    )
    assert.equal(operatorLogin.user.role, 'operator')
    const operatorToken = operatorLogin.token ?? (await loginAdminSession(
      baseUrl,
      {
        username: createdOperator.username,
        password: operatorPassword,
      },
      'operator session token fallback login',
    )).token
    pass('操作员登录成功')

    const supplierLogin = await expectJsonOk<{
      token: string
      user: { username: string; role: string }
    }>(
      () =>
        requestLocalHttp(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: createdSupplier.username,
            password: supplierPassword,
          }),
        }),
      '供货方登录',
    )
    assert.equal(supplierLogin.user.role, 'supplier')
    const supplierToken = supplierLogin.token ?? (await loginAdminSession(
      baseUrl,
      {
        username: createdSupplier.username,
        password: supplierPassword,
      },
      'supplier session token fallback login',
    )).token
    pass('供货方登录成功')

    const productRepo = AppDataSource.getRepository(BaseProduct)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const orderItemRepo = AppDataSource.getRepository(BizOutboundOrderItem)
    const legacyProduct = await productRepo.save(productRepo.create({
      productCode: `PERMISSION-P-${verifySeed}`,
      productName: '权限回归历史商品',
      pinyinAbbr: 'QXHG',
      defaultPrice: '10.00',
      discountRate: '10.0',
      isActive: true,
      o2oStatus: 'unlisted',
      currentStock: 20,
      preOrderedStock: 3,
    }))
    const legacySku = await skuRepo.save(skuRepo.create({
      productId: legacyProduct.id,
      skuCode: `PERMISSION-SKU-${verifySeed}`,
      specValuesJson: '{}',
      specText: '当前规格',
      defaultPrice: '10.00',
      discountRate: '10.0',
      currentStock: 20,
      preOrderedStock: 3,
      isActive: true,
      isCurrent: true,
      o2oRecommended: false,
      sortOrder: 0,
    }))
    const legacyOrder = await orderRepo.save(orderRepo.create({
      orderUuid: randomUUID(),
      showNo: `hyyz${verifySeed.replace(/\D/g, '').slice(-6).padStart(6, '0')}`,
      businessNo: `hyyz8${verifySeed.replace(/\D/g, '').slice(-5).padStart(5, '0')}`,
      editVersion: 1,
      inventoryMode: 'legacy_none',
      orderType: 'walkin',
      hasCustomerOrder: false,
      isSystemApplied: false,
      issuerName: '权限回归验证员',
      customerDepartmentName: null,
      idempotencyKey: `permission-order-${verifySeed}`,
      customerName: '权限回归客户',
      remark: null,
      totalQty: '2.00',
      totalAmount: '20.00',
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deletedByUsername: null,
      deletedByDisplayName: null,
      creatorUserId: createdOperator.id,
      creatorUsername: createdOperator.username,
      creatorDisplayName: '权限回归操作员',
    }))
    await orderItemRepo.save(orderItemRepo.create({
      orderId: legacyOrder.id,
      lineNo: 1,
      productId: legacyProduct.id,
      productNameSnapshot: legacyProduct.productName,
      skuId: null,
      skuCodeSnapshot: null,
      specTextSnapshot: '历史无 SKU 规格',
      qty: '2.00',
      unitPrice: '10.00',
      lineAmount: '20.00',
      remark: null,
    }))

    const legacyEdit = (expectedVersion: number, qty: number, reason: string) => ({
      expectedVersion,
      reason,
      items: [{
        productId: legacyProduct.id,
        skuId: null,
        qty,
        unitPrice: 10,
        remark: null,
      }],
    })
    const adminEdit = await expectJsonOk<{
      order: { editVersion: number; inventoryMode: string }
      items: Array<{ skuId: string | null }>
      inventoryDeltas: unknown[]
      notice: string | null
    }>(
      () => requestLocalHttp(`${baseUrl}/api/orders/${legacyOrder.id}/content`, {
        method: 'PATCH',
        headers: {
          Cookie: `y_link_admin_session=${encodeURIComponent(adminSession.token)}; y_link_admin_csrf=${encodeURIComponent(adminSession.csrfToken)}`,
          'x-csrf-token': adminSession.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(legacyEdit(1, 3, '管理员修改历史无 SKU 行')),
      }),
      '管理员修改 legacy_none 订单',
    )
    assert.equal(adminEdit.order.editVersion, 2)
    assert.equal(adminEdit.order.inventoryMode, 'legacy_none')
    assert.equal(adminEdit.items[0]?.skuId, null)
    assert.deepEqual(adminEdit.inventoryDeltas, [])
    assert.match(adminEdit.notice ?? '', /legacy_none|\u4e0d追溯/)
    pass('管理员通过真实 PATCH 修改历史无 SKU 行')

    const operatorEdit = await expectJsonOk<{ order: { editVersion: number }; items: Array<{ skuId: string | null }> }>(
      () => requestLocalHttp(`${baseUrl}/api/orders/${legacyOrder.id}/content`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyEdit(2, 4, '操作员修改历史无 SKU 行')),
      }),
      '操作员修改 legacy_none 订单',
    )
    assert.equal(operatorEdit.order.editVersion, 3)
    assert.equal(operatorEdit.items[0]?.skuId, null)
    pass('操作员通过真实 PATCH 修改历史无 SKU 行')

    await expectJsonForbidden(
      () => requestLocalHttp(`${baseUrl}/api/orders/${legacyOrder.id}/content`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${supplierToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyEdit(3, 5, '供货方越权修改')),
      }),
      '供货方越权修改订单内容',
    )
    pass('供货方访问订单内容编辑路由被 403 拦截')

    await expectJsonStatus(
      () => requestLocalHttp(`${baseUrl}/api/orders/${legacyOrder.id}/content`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyEdit(2, 5, '过期版本修改')),
      }),
      '过期 expectedVersion 修改订单内容',
      409,
    )
    pass('过期 expectedVersion 通过真实 PATCH 返回 409')

    const adminRevisions = await expectJsonOk<Array<{ revisionNo: number }>>(
      () => requestLocalHttp(`${baseUrl}/api/orders/${legacyOrder.id}/revisions`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      '管理员读取订单修订',
    )
    const operatorRevisions = await expectJsonOk<Array<{ revisionNo: number }>>(
      () => requestLocalHttp(`${baseUrl}/api/orders/${legacyOrder.id}/revisions`, {
        headers: { Authorization: `Bearer ${operatorToken}` },
      }),
      '操作员读取订单修订',
    )
    assert.deepEqual(adminRevisions.map((revision) => revision.revisionNo), [3, 2])
    assert.deepEqual(operatorRevisions.map((revision) => revision.revisionNo), [3, 2])
    await expectJsonForbidden(
      () => requestLocalHttp(`${baseUrl}/api/orders/${legacyOrder.id}/revisions`, {
        headers: { Authorization: `Bearer ${supplierToken}` },
      }),
      '供货方越权读取订单修订',
    )
    pass('修订时间线真实 GET 权限与结果正确')

    const productAfterLegacyEdit = await productRepo.findOneByOrFail({ id: legacyProduct.id })
    const skuAfterLegacyEdit = await skuRepo.findOneByOrFail({ id: legacySku.id })
    assert.deepEqual(
      [productAfterLegacyEdit.currentStock, productAfterLegacyEdit.preOrderedStock, skuAfterLegacyEdit.currentStock, skuAfterLegacyEdit.preOrderedStock],
      [20, 3, 20, 3],
      'legacy_none 通过真实 HTTP 编辑后不得改动商品或 SKU 库存',
    )
    const contentDialogSource = fs.readFileSync(
      path.resolve(repositoryRoot, 'src/views/order-list/components/OrderContentEditDialog.vue'),
      'utf8',
    )
    assert.match(contentDialogSource, /skuId:\s*row\.skuId\s*\|\|\s*null/, '历史原有无 SKU 行的空字符串必须显式序列化为 null')

    await expectJsonForbidden(
      () =>
        requestLocalHttp(`${baseUrl}/api/users?page=1&pageSize=20`, {
          headers: { Authorization: `Bearer ${operatorToken}` },
        }),
      '操作员反向访问用户列表',
    )
    pass('操作员访问用户列表被拦截（反向）')

    await expectJsonForbidden(
      () =>
        requestLocalHttp(`${baseUrl}/api/users`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${operatorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: `forbidden_user_${verifySeed}`,
            password: forbiddenUserPassword,
            displayName: '越权用户',
            role: 'operator',
            status: 'enabled',
          }),
        }),
      '操作员越权新增用户',
    )
    pass('操作员越权新增用户被拦截')

    await expectJsonForbidden(
      () =>
        requestLocalHttp(`${baseUrl}/api/audit-logs?page=1&pageSize=10`, {
          headers: { Authorization: `Bearer ${operatorToken}` },
        }),
      '操作员越权读取审计日志',
    )
    pass('操作员越权读取审计日志被拦截')

    await expectJsonForbidden(
      () =>
        requestLocalHttp(`${baseUrl}/api/data-maintenance/db-migration/runtime-override`, {
          headers: { Authorization: `Bearer ${operatorToken}` },
        }),
      '操作员越权读取数据库迁移运行时状态',
    )
    pass('操作员越权读取数据库迁移运行时状态被拦截')

    await expectJsonForbidden(
      () =>
        requestLocalHttp(`${baseUrl}/api/data-maintenance/backup/sqlite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${operatorToken}` },
        }),
      '操作员越权创建 SQLite 备份',
    )
    pass('操作员越权创建 SQLite 备份被拦截')

    await expectJsonForbidden(
      () =>
        requestLocalHttp(`${baseUrl}/api/system-configs/verification-providers/test-send`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${operatorToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            channel: 'mobile',
            target: '13800138000',
            config: {
              enabled: true,
              httpMethod: 'POST',
              apiUrl: 'https://example.com/send-sms',
              headersTemplate: '{"Content-Type":"application/json"}',
              bodyTemplate: '{"mobile":"{{target}}","code":"{{code}}","scene":"{{scene}}"}',
              successMatch: '',
            },
          }),
        }),
      '操作员越权测试验证码平台发送',
    )
    pass('操作员越权测试验证码平台发送被拦截')

    await expectJsonForbidden(
      () =>
        requestLocalHttp(`${baseUrl}/api/inbound/admin/list`, {
          headers: { Authorization: `Bearer ${supplierToken}` },
        }),
      '供货方越权访问管理端入库列表',
    )
    pass('供货方访问管理端全量入库列表被拦截')

    const lockedUsername = `locked_admin_${verifySeed}`
    await expectJsonStatus(
      () =>
        requestLocalHttp(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: lockedUsername,
            password: 'WrongPassword1',
          }),
        }),
      '登录锁定首轮错误',
      401,
    )
    for (let index = 0; index < 4; index += 1) {
      const captcha = await expectJsonOk<{
        captchaId: string
        captchaSvg: string
      }>(() => requestLocalHttp(`${baseUrl}/api/auth/captcha`), `登录锁定验证码 ${index + 1}`)
      const lockProbe = await expectJsonOneOfStatuses(
        () =>
          requestLocalHttp(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: lockedUsername,
              password: 'WrongPassword1',
              captchaId: captcha.captchaId,
              captchaCode: readCaptchaCode(captcha.captchaSvg),
            }),
          }),
        `登录锁定错误计数 ${index + 2}`,
        [401, 429],
      )
      if (lockProbe.status === 429) {
        break
      }
    }
    await expectJsonStatus(
      () =>
        requestLocalHttp(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: lockedUsername,
            password: 'WrongPassword1',
          }),
        }),
      '连续错误后临时锁定',
      429,
    )
    pass('管理端连续登录失败会触发 429 临时锁定')

    const deniedLogs = await expectJsonOk<{
      list: Array<{
        actionType: string
        actorUserId: string | null
        targetCode: string | null
      }>
    }>(
      () =>
        requestLocalHttp(
          `${baseUrl}/api/audit-logs?page=1&pageSize=100&actionType=${encodeURIComponent('security.access_denied')}`,
          {
            headers: { Authorization: `Bearer ${adminToken}` },
          },
        ),
      '管理员查询越权拦截审计日志',
    )

    const operatorDeniedLogs = deniedLogs.list.filter((item) => item.actorUserId === createdOperator.id)
    assert.ok(operatorDeniedLogs.length >= 6, '操作员越权拦截审计日志数量不足，期望至少 6 条')

    const deniedTargets = operatorDeniedLogs.map((item) => item.targetCode ?? '')
    assert.ok(
      deniedTargets.some((target) => target.includes('GET /api/users')),
      '缺少操作员越权访问用户列表的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('POST /api/users')),
      '缺少操作员越权新增用户的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('GET /api/audit-logs')),
      '缺少操作员越权读取审计日志的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('GET /api/data-maintenance/db-migration/runtime-override')),
      '缺少操作员越权读取数据库迁移运行时状态的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('POST /api/data-maintenance/backup/sqlite')),
      '缺少操作员越权创建 SQLite 备份的审计记录',
    )
    assert.ok(
      deniedTargets.some((target) => target.includes('POST /api/system-configs/verification-providers/test-send')),
      '缺少操作员越权测试验证码平台发送的审计记录',
    )
    pass('接口越权拦截会写入审计日志（security.access_denied）')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })

    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    if (fs.existsSync(sqlitePath)) {
      cleanupSqliteFile()
    }
  }
}

try {
  await main()
  // eslint-disable-next-line no-console
  console.log('\n权限回归验证通过：管理员正向、操作员反向、接口越权拦截均符合预期')
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('\n权限回归验证失败')
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
}
