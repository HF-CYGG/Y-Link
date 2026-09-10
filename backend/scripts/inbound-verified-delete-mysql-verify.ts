/**
 * 文件说明：已入库送货单删除的 MySQL 并发隔离验收。
 * 文件职责：在外部准备的全新临时 MySQL 实例中验证重复删除、反序商品单据与库存占用竞争。
 * 维护说明：只接受 127.0.0.1 高位端口和 y_link_issue66_ 前缀数据库，禁止连接默认或业务数据库。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'

interface CookieSession {
  cookie: string
  csrfToken: string
}

const rejectionMessage = (result: PromiseSettledResult<unknown>) => {
  if (result.status !== 'rejected') return ''
  return String(result.reason instanceof Error ? result.reason.message : result.reason)
}

async function readJson(response: Response) {
  return JSON.parse(await response.text()) as { code?: number; message?: string; data?: unknown }
}

async function expectStatus(request: () => Promise<Response>, status: number, scene: string) {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, status, `${scene}：${JSON.stringify(payload)}`)
  return payload
}

function getSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  return (headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']).filter(Boolean)
}

async function loginCookieSession(baseUrl: string, username: string, password: string): Promise<CookieSession> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const payload = await readJson(response)
  assert.equal(response.status, 200, `登录 ${username} 失败：${JSON.stringify(payload)}`)
  const cookies = getSetCookies(response)
  const cookie = cookies.map((item) => item.split(';')[0]).join('; ')
  const csrfCookie = cookies.find((item) => item.startsWith('y_link_admin_csrf='))
  const csrfToken = csrfCookie?.split(';')[0]?.slice('y_link_admin_csrf='.length)
  assert.ok(cookie.includes('y_link_admin_session='))
  assert.ok(csrfToken)
  return { cookie, csrfToken: decodeURIComponent(csrfToken) }
}

const writeHeaders = (session: CookieSession, userAgent: string): Record<string, string> => ({
  Cookie: session.cookie,
  'Content-Type': 'application/json',
  'x-csrf-token': session.csrfToken,
  'User-Agent': userAgent,
})

const dbHost = process.env.Y_LINK_ISSUE66_MYSQL_HOST ?? process.env.DB_HOST ?? '127.0.0.1'
const dbPort = Number(process.env.Y_LINK_ISSUE66_MYSQL_PORT ?? process.env.DB_PORT)
const dbUser = process.env.Y_LINK_ISSUE66_MYSQL_USER ?? process.env.DB_USER ?? 'root'
const dbPassword = process.env.Y_LINK_ISSUE66_MYSQL_PASSWORD ?? process.env.DB_PASSWORD ?? ''
const dbName = process.env.Y_LINK_ISSUE66_MYSQL_DATABASE ?? process.env.DB_NAME ?? ''
assert.equal(dbHost, '127.0.0.1', 'MySQL 验收只允许连接 127.0.0.1')
assert.ok(Number.isInteger(dbPort) && dbPort >= 10_000 && dbPort <= 65_535, 'MySQL 验收必须使用高位隔离端口')
assert.match(dbName, /^y_link_issue66(?:_[a-z0-9_]+)?$/i, 'MySQL 验收数据库名必须使用 y_link_issue66 专属命名空间')

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const adminPassword = `Admin_${verifySeed}_Aa1!`
const permanentDeletePassword = `Purge_${verifySeed}_Aa1!`
process.env.APP_PROFILE = `issue66-mysql-${verifySeed}`
process.env.DB_TYPE = 'mysql'
process.env.DB_HOST = dbHost
process.env.DB_PORT = String(dbPort)
process.env.DB_USER = dbUser
process.env.DB_PASSWORD = dbPassword
process.env.DB_NAME = dbName
// 本脚本只接受本任务的专属空库；使用仓库已验证的 TypeORM 空库建表路径。
process.env.DB_SYNC = 'true'
process.env.INIT_ADMIN_PASSWORD = adminPassword
process.env.PERMANENT_DELETE_PASSWORD = permanentDeletePassword
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

async function main() {
  const [
    { createApp },
    { AppDataSource },
    { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime },
    { authService },
    { userService },
    { productService },
    { inboundService },
    { o2oPreorderService },
    { auditService },
    { BaseProduct },
    { BaseProductSku },
    { BizInboundOrder },
    { ClientUser },
    { O2oPreorder },
    { InventoryLog },
    { SysAuditLog },
    { SysUser },
  ] = await Promise.all([
    import('../src/app.js'),
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/services/auth.service.js'),
    import('../src/services/user.service.js'),
    import('../src/services/product.service.js'),
    import('../src/services/inbound.service.js'),
    import('../src/services/o2o-preorder.service.js'),
    import('../src/services/audit.service.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-inbound-order.entity.js'),
    import('../src/entities/client-user.entity.js'),
    import('../src/entities/o2o-preorder.entity.js'),
    import('../src/entities/inventory-log.entity.js'),
    import('../src/entities/sys-audit-log.entity.js'),
    import('../src/entities/sys-user.entity.js'),
  ])

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  const bootstrapAdmin = await authService.ensureDefaultAdmin()
  const bootstrapAdminUser = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: bootstrapAdmin.username })
  const adminActor: AuthUserContext = {
    userId: String(bootstrapAdminUser.id),
    username: bootstrapAdmin.username,
    displayName: bootstrapAdmin.displayName,
    role: 'admin',
    permissions: [],
    status: 'enabled',
    sessionToken: 'issue66-mysql-admin',
    authSource: 'bearer',
  }
  const supplier = await userService.create({
    username: `issue66_mysql_supplier_${verifySeed}`,
    password: 'SupplierVerify_2026A',
    displayName: 'Issue66 MySQL 供货方',
    role: 'supplier',
  }, adminActor)
  const supplierActor: AuthUserContext = {
    userId: String(supplier.id),
    username: supplier.username,
    displayName: supplier.displayName,
    role: 'supplier',
    permissions: [],
    status: 'enabled',
    sessionToken: 'issue66-mysql-supplier',
    authSource: 'bearer',
  }

  let productIndex = 0
  const createProduct = async (label: string, currentStock = 10) => {
    productIndex += 1
    const key = `${verifySeed}-${productIndex}`
    const product = await productService.create({
      productName: `${label}-${key}`,
      pinyinAbbr: 'ISSUE66',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      limitPerUser: 100,
      specGroups: [{ name: '规格', values: ['标准'] }],
      skus: [{ skuCode: `ISSUE66-${key}`, specValues: { 规格: '标准' }, defaultPrice: 10, currentStock, isActive: true }],
    } as Parameters<typeof productService.create>[0])
    const sku = product.skus[0]
    assert.ok(sku)
    return { productId: String(product.id), skuId: String(sku.id) }
  }

  const createDelivery = async (items: Array<{ productId: string; skuId: string; qty: number }>, verified: boolean) => {
    const delivery = await inboundService.submitSupplierDelivery(supplierActor, { remark: 'Issue66 MySQL 并发验证', items })
    if (verified) await inboundService.verifyInbound(delivery.order.verifyCode, adminActor)
    return delivery
  }

  const duplicateProduct = await createProduct('重复删除商品')
  const duplicateDelivery = await createDelivery([{ ...duplicateProduct, qty: 5 }], true)
  const duplicateBefore = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: duplicateProduct.productId })
  const duplicateResults = await Promise.allSettled([
    inboundService.deleteVerifiedSupplierDelivery(supplierActor, String(duplicateDelivery.order.id), {
      confirmShowNo: duplicateDelivery.order.showNo,
      permanentDeletePassword,
    }),
    inboundService.deleteVerifiedSupplierDelivery(supplierActor, String(duplicateDelivery.order.id), {
      confirmShowNo: duplicateDelivery.order.showNo,
      permanentDeletePassword,
    }),
  ])
  assert.equal(duplicateResults.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(duplicateResults.filter((result) => result.status === 'rejected').length, 1)
  const duplicateAfter = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: duplicateProduct.productId })
  assert.equal(Number(duplicateAfter.currentStock), Number(duplicateBefore.currentStock) - 5)
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'biz_inbound_order', refId: String(duplicateDelivery.order.id), changeType: 'inbound_reverse' },
  }), 1)
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'inbound.supplier.delete_verified', targetId: String(duplicateDelivery.order.id), resultStatus: 'success' },
  }), 1)

  const first = await createProduct('锁序商品A')
  const second = await createProduct('锁序商品B')
  const deleteDelivery = await createDelivery([
    { ...second, qty: 2 },
    { ...first, qty: 2 },
  ], true)
  const verifyDelivery = await createDelivery([
    { ...first, qty: 3 },
    { ...second, qty: 3 },
  ], false)
  const lockOrderBefore = new Map((await AppDataSource.getRepository(BaseProduct).findByIds([first.productId, second.productId]))
    .map((product) => [String(product.id), Number(product.currentStock)]))
  const lockOrderResults = await Promise.allSettled([
    inboundService.deleteVerifiedSupplierDelivery(supplierActor, String(deleteDelivery.order.id), {
      confirmShowNo: deleteDelivery.order.showNo,
      permanentDeletePassword,
    }),
    inboundService.verifyInbound(verifyDelivery.order.verifyCode, adminActor),
  ])
  assert.equal(lockOrderResults.filter((result) => result.status === 'fulfilled').length, 2, JSON.stringify(lockOrderResults))
  for (const productId of [first.productId, second.productId]) {
    const product = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: productId })
    assert.equal(Number(product.currentStock), (lockOrderBefore.get(productId) ?? 0) + 1)
  }

  const raceProduct = await createProduct('预订竞争商品', 0)
  const raceDelivery = await createDelivery([{ ...raceProduct, qty: 5 }], true)
  const reserveQty = 1
  const raceClient = await AppDataSource.getRepository(ClientUser).save(AppDataSource.getRepository(ClientUser).create({
    mobile: null,
    email: `issue66-${Math.random().toString(16).slice(2, 12)}@example.test`,
    passwordHash: 'issue66-mysql-not-used',
    realName: 'Issue66 MySQL 客户',
    departmentName: '',
    departmentNodeId: null,
    accountType: 'personal',
    staffNo: null,
    staffVerified: false,
    status: 'enabled',
  }))
  const raceClientAuth: ClientAuthContext = {
    userId: String(raceClient.id),
    account: raceClient.email ?? 'issue66@example.test',
    mobile: '',
    email: raceClient.email ?? '',
    realName: raceClient.realName,
    accountType: 'personal',
    staffNo: null,
    sessionToken: 'issue66-mysql-client',
    authSource: 'bearer',
  }
  const clientRequestId = `issue66-mysql-race-${verifySeed}`
  const submitPreorder = () => o2oPreorderService.submit(raceClientAuth, {
    clientRequestId,
    isSystemApplied: false,
    pickupContact: 'Issue66 MySQL 客户',
    items: [{ productId: raceProduct.productId, skuId: raceProduct.skuId, qty: reserveQty }],
  })
  const raceResults = await Promise.allSettled([
    inboundService.deleteVerifiedSupplierDelivery(supplierActor, String(raceDelivery.order.id), {
      confirmShowNo: raceDelivery.order.showNo,
      permanentDeletePassword,
    }),
    submitPreorder(),
  ])
  assert.equal(raceResults.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(raceResults.filter((result) => result.status === 'rejected').length, 1)
  const [raceProductAfter, raceSkuAfter, raceOrderAfter] = await Promise.all([
    AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: raceProduct.productId }),
    AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: raceProduct.skuId }),
    AppDataSource.getRepository(BizInboundOrder).findOneByOrFail({ id: String(raceDelivery.order.id) }),
  ])
  assert.ok(Number(raceProductAfter.currentStock) >= Number(raceProductAfter.preOrderedStock))
  assert.ok(Number(raceSkuAfter.currentStock) >= Number(raceSkuAfter.preOrderedStock))
  const deleteSucceeded = raceResults[0]?.status === 'fulfilled'
  const preorderSucceeded = raceResults[1]?.status === 'fulfilled'
  if (deleteSucceeded) {
    assert.match(rejectionMessage(raceResults[1]!), /库存不足/)
  } else {
    assert.ok(preorderSucceeded)
    assert.match(rejectionMessage(raceResults[0]!), /预订|占用|无法冲销/)
  }
  assert.equal(Boolean(raceOrderAfter.isDeleted), deleteSucceeded)
  assert.equal(await AppDataSource.getRepository(O2oPreorder).count({
    where: { clientUserId: String(raceClient.id), clientRequestId },
  }), preorderSucceeded ? 1 : 0)
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'o2o_preorder', changeType: 'preorder_hold', productId: raceProduct.productId },
  }), preorderSucceeded ? 1 : 0)
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'biz_inbound_order', refId: String(raceDelivery.order.id), changeType: 'inbound_reverse' },
  }), deleteSucceeded ? 1 : 0)
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'inbound.supplier.delete_verified', targetId: String(raceDelivery.order.id), resultStatus: 'success' },
  }), deleteSucceeded ? 1 : 0)
  assert.equal(Number(raceProductAfter.currentStock), deleteSucceeded ? 0 : 5)
  assert.equal(Number(raceSkuAfter.currentStock), deleteSucceeded ? 0 : 5)
  assert.equal(Number(raceProductAfter.preOrderedStock), preorderSucceeded ? reserveQty : 0)
  assert.equal(Number(raceSkuAfter.preOrderedStock), preorderSucceeded ? reserveQty : 0)

  const releaseFirst = await createProduct('管理删除锁序商品A', 5)
  const releaseSecond = await createProduct('管理删除锁序商品B', 5)
  const releaseInboundDelivery = await createDelivery([
    { ...releaseSecond, qty: 2 },
    { ...releaseFirst, qty: 2 },
  ], true)
  const releasePreorder = await o2oPreorderService.submit(raceClientAuth, {
    clientRequestId: `issue66-mysql-admin-delete-${verifySeed}`,
    isSystemApplied: false,
    pickupContact: 'Issue66 MySQL 客户',
    items: [
      { productId: releaseSecond.productId, skuId: releaseSecond.skuId, qty: 1 },
      { productId: releaseFirst.productId, skuId: releaseFirst.skuId, qty: 1 },
    ],
  })
  const adminDeleteRaceResults = await Promise.allSettled([
    inboundService.deleteVerifiedSupplierDelivery(supplierActor, String(releaseInboundDelivery.order.id), {
      confirmShowNo: releaseInboundDelivery.order.showNo,
      permanentDeletePassword,
    }),
    o2oPreorderService.deleteConsoleOrder({
      orderId: String(releasePreorder.order.id),
      confirmShowNo: releasePreorder.order.showNo,
    }, adminActor),
  ])
  assert.equal(adminDeleteRaceResults.filter((result) => result.status === 'fulfilled').length, 2, JSON.stringify(adminDeleteRaceResults))
  for (const item of [releaseFirst, releaseSecond]) {
    const [product, sku] = await Promise.all([
      AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: item.productId }),
      AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: item.skuId }),
    ])
    assert.equal(Number(product.currentStock), 5)
    assert.equal(Number(product.preOrderedStock), 0)
    assert.equal(Number(sku.currentStock), 5)
    assert.equal(Number(sku.preOrderedStock), 0)
  }
  assert.equal(await AppDataSource.getRepository(O2oPreorder).countBy({ id: String(releasePreorder.order.id) }), 0)
  assert.equal(Boolean((await AppDataSource.getRepository(BizInboundOrder).findOneByOrFail({
    id: String(releaseInboundDelivery.order.id),
  })).isDeleted), true)
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'o2o_preorder', refId: String(releasePreorder.order.id), changeType: 'preorder_release' },
  }), 2)
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'biz_inbound_order', refId: String(releaseInboundDelivery.order.id), changeType: 'inbound_reverse' },
  }), 2)
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'o2o.preorder.delete', targetId: String(releasePreorder.order.id), resultStatus: 'success' },
  }), 1)
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'inbound.supplier.delete_verified', targetId: String(releaseInboundDelivery.order.id), resultStatus: 'success' },
  }), 1)

  const unicodeUserAgent = `issue66/${'😀'.repeat(260)}`
  const unicodeAudit = await auditService.record({
    actionType: 'inbound.supplier.delete_verified.test_unicode_meta',
    actionLabel: 'Issue66 Unicode 审计元信息验证',
    targetType: 'biz_inbound_order',
    targetId: String(raceDelivery.order.id),
    actor: supplierActor,
    requestMeta: {
      ipAddress: '127.0.0.1',
      userAgent: unicodeUserAgent,
      clientRiskBrowserId: null,
      clientRiskSessionId: null,
    },
  })
  assert.equal(Array.from(unicodeAudit.userAgent ?? '').length, 255)
  assert.equal(unicodeAudit.userAgent, Array.from(unicodeUserAgent).slice(0, 255).join(''))
  assert.ok(unicodeAudit.userAgent?.endsWith('😀'))

  const server = createApp().listen(0, '127.0.0.1')
  try {
    if (!server.listening) await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const session = await loginCookieSession(baseUrl, supplier.username, 'SupplierVerify_2026A')
    // Fetch 的 Header 值遵循 ByteString，真实 HTTP 使用 ASCII；Unicode code-point 边界由上面的 MySQL 直写验证。
    const longUserAgent = `issue66-mysql/${'A'.repeat(300)}`
    const expectedUserAgent = Array.from(longUserAgent).slice(0, 255).join('')

    const httpSuccessDelivery = await createDelivery([{ ...(await createProduct('长UA成功商品')), qty: 1 }], true)
    await expectStatus(() => fetch(`${baseUrl}/api/inbound/supplier/${httpSuccessDelivery.order.id}/verified`, {
      method: 'DELETE',
      headers: writeHeaders(session, longUserAgent),
      body: JSON.stringify({ confirmShowNo: httpSuccessDelivery.order.showNo, permanentDeletePassword }),
    }), 200, 'MySQL 长 UA 删除已入库单')
    const httpSuccessAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
      where: {
        actionType: 'inbound.supplier.delete_verified',
        targetId: String(httpSuccessDelivery.order.id),
        resultStatus: 'success',
      },
      order: { id: 'DESC' },
    })
    assert.equal(httpSuccessAudit.userAgent, expectedUserAgent)
    assert.equal(Array.from(httpSuccessAudit.userAgent ?? '').length, 255)

    const httpFailureDelivery = await createDelivery([{ ...(await createProduct('长UA失败商品')), qty: 1 }], true)
    for (let index = 0; index < 7; index += 1) {
      await expectStatus(() => fetch(`${baseUrl}/api/inbound/supplier/${httpFailureDelivery.order.id}/verified`, {
        method: 'DELETE',
        headers: writeHeaders(session, longUserAgent),
        body: JSON.stringify({ confirmShowNo: httpFailureDelivery.order.showNo, permanentDeletePassword: 'wrong-password' }),
      }), 403, `MySQL 长 UA 错误密码 ${index + 1}`)
    }
    await expectStatus(() => fetch(`${baseUrl}/api/inbound/supplier/${httpFailureDelivery.order.id}/verified`, {
      method: 'DELETE',
      headers: writeHeaders(session, longUserAgent),
      body: JSON.stringify({ confirmShowNo: httpFailureDelivery.order.showNo, permanentDeletePassword: 'wrong-password' }),
    }), 429, 'MySQL 长 UA 频控拒绝')
    const httpFailureAudits = await AppDataSource.getRepository(SysAuditLog).find({
      where: {
        actionType: 'inbound.supplier.delete_verified',
        targetId: String(httpFailureDelivery.order.id),
        resultStatus: 'failed',
      },
    })
    assert.equal(httpFailureAudits.length, 8)
    assert.ok(httpFailureAudits.every((audit) => audit.userAgent === expectedUserAgent))
    assert.ok(httpFailureAudits.some((audit) => audit.detailJson?.includes('rate_limited')))
    assert.equal(JSON.stringify(httpFailureAudits).includes('wrong-password'), false)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  console.log('inbound verified delete mysql verify: passed')
  await AppDataSource.destroy()
}

main().catch(async (error) => {
  console.error(`[inbound-verified-delete-mysql-verify] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  try {
    const { AppDataSource } = await import('../src/config/data-source.js')
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  } catch {
    // 初始化失败时没有可关闭的数据源。
  }
  process.exitCode = 1
})
