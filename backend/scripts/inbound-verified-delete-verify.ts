/**
 * 文件说明：已入库送货单删除与库存冲销的隔离回归验证。
 * 文件职责：在随机 SQLite 与真实 HTTP 应用中验证高危确认、库存不变式、失败回滚、审计和并发幂等。
 * 实现逻辑：
 * - 先创建并核销真实送货单，再从供货方入口请求删除，确保测试覆盖真实入库流水；
 * - 每个负向场景使用独立商品与送货单，避免库存或频控状态互相污染；
 * - 所有数据库、端口和账号均为本脚本临时资源，不连接本地业务数据库。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `inbound-verified-delete-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Aa1!`
const permanentDeletePassword = `Purge_${verifySeed}_Aa1!`

process.env.APP_PROFILE = `inbound-verified-delete-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword
process.env.PERMANENT_DELETE_PASSWORD = permanentDeletePassword

type JsonPayload = { code?: number; message?: string; data?: unknown }
type CookieSession = { cookie: string; csrfToken: string }
type DeleteVerifiedInput = { confirmShowNo?: string; permanentDeletePassword?: string }
type DeleteVerifiedService = {
  deleteVerifiedSupplierDelivery: (
    actor: AuthUserContext,
    orderId: string,
    input: DeleteVerifiedInput,
  ) => Promise<{ order: { id: string; showNo: string; status: string; isDeleted: boolean }; items: unknown[] }>
}

function cleanup() {
  for (const filePath of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
  }
}

async function readJson(response: Response): Promise<JsonPayload> {
  const body = await response.text()
  try {
    return JSON.parse(body) as JsonPayload
  } catch {
    throw new Error(`响应不是 JSON：status=${response.status} body=${body}`)
  }
}

async function expectStatus(request: () => Promise<Response>, status: number, scene: string): Promise<JsonPayload> {
  const response = await request()
  const payload = await readJson(response)
  assert.equal(response.status, status, `${scene}：期望 HTTP ${status}，实际 ${response.status}`)
  assert.equal(payload.code, status >= 200 && status < 300 ? 0 : status, `${scene}：业务 code 异常`)
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
  assert.ok(cookie.includes('y_link_admin_session='), `登录 ${username} 未取得会话 Cookie`)
  assert.ok(csrfToken, `登录 ${username} 未取得 CSRF Cookie`)
  return { cookie, csrfToken: decodeURIComponent(csrfToken) }
}

const writeHeaders = (session: CookieSession, csrf = true): Record<string, string> => ({
  Cookie: session.cookie,
  'Content-Type': 'application/json',
  ...(csrf ? { 'x-csrf-token': session.csrfToken } : {}),
})

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const inboundServiceSource = fs.readFileSync(path.resolve(backendRoot, 'src/services/inbound.service.ts'), 'utf8')
  const verifyInboundSource = inboundServiceSource.slice(
    inboundServiceSource.indexOf('async verifyInbound('),
    inboundServiceSource.indexOf('// 管理端查看所有入库单'),
  )
  const verifyProductLockIndex = verifyInboundSource.indexOf('loadAndLockInboundProducts')
  const verifySkuLockIndex = verifyInboundSource.indexOf('loadAndLockInboundSkus')
  assert.ok(verifyProductLockIndex >= 0, 'verifyInbound 必须批量锁定全部商品')
  assert.ok(verifySkuLockIndex > verifyProductLockIndex, 'verifyInbound 必须在全部商品之后批量锁定全部 SKU')
  const o2oPreorderServiceSource = fs.readFileSync(path.resolve(backendRoot, 'src/services/o2o-preorder.service.ts'), 'utf8')
  const releasePendingStockSource = o2oPreorderServiceSource.slice(
    o2oPreorderServiceSource.indexOf('private async releasePendingPreorderStockForDeleteInManager('),
    o2oPreorderServiceSource.indexOf('private async resolveCustomerOrderShowNoMap('),
  )
  const releaseProductLockIndex = releasePendingStockSource.indexOf("orderBy('product.id', 'ASC')")
  const releaseSkuLockIndex = releasePendingStockSource.indexOf("orderBy('sku.productId', 'ASC')")
  assert.ok(releaseProductLockIndex >= 0, 'O2O 管理删除必须批量升序锁定全部商品')
  assert.ok(releaseSkuLockIndex > releaseProductLockIndex, 'O2O 管理删除必须在全部商品之后批量升序锁定全部 SKU')
  const [
    { createApp },
    { AppDataSource },
    { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime },
    { authService },
    { userService },
    { productService },
    { inboundService },
    { BaseProduct },
    { BaseProductSku },
    { BizInboundOrder },
    { BizInboundOrderItem },
    { InventoryLog },
    { SysAuditLog },
    { SysUser },
    { env },
    { auditService },
    { readMallCatalogRevision },
  ] = await Promise.all([
    import('../src/app.js'),
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/services/auth.service.js'),
    import('../src/services/user.service.js'),
    import('../src/services/product.service.js'),
    import('../src/services/inbound.service.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-inbound-order.entity.js'),
    import('../src/entities/biz-inbound-order-item.entity.js'),
    import('../src/entities/inventory-log.entity.js'),
    import('../src/entities/sys-audit-log.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/config/env.js'),
    import('../src/services/audit.service.js'),
    import('../src/services/mall-catalog-revision.service.js'),
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
    sessionToken: 'inbound-delete-admin',
    authSource: 'bearer',
  }
  const supplierPassword = 'SupplierVerify_2026A'
  const otherSupplierPassword = 'OtherSupplierVerify_2026A'
  const rateSupplierPassword = 'RateSupplierVerify_2026A'
  const supplier = await userService.create({
    username: `inbound_supplier_${verifySeed}`,
    password: supplierPassword,
    displayName: '入库删除验证供货方',
    role: 'supplier',
  }, adminActor)
  const otherSupplier = await userService.create({
    username: `inbound_other_${verifySeed}`,
    password: otherSupplierPassword,
    displayName: '入库删除越权供货方',
    role: 'supplier',
  }, adminActor)
  const rateSupplier = await userService.create({
    username: `inbound_rate_${verifySeed}`,
    password: rateSupplierPassword,
    displayName: '入库删除频控供货方',
    role: 'supplier',
  }, adminActor)
  const actorOf = (user: typeof supplier): AuthUserContext => ({
    userId: String(user.id),
    username: user.username,
    displayName: user.displayName,
    role: 'supplier',
    permissions: [],
    status: 'enabled',
    sessionToken: `inbound-delete-${user.id}`,
    authSource: 'bearer',
  })
  const supplierActor = actorOf(supplier)
  const otherSupplierActor = actorOf(otherSupplier)
  const deleteService = inboundService as unknown as DeleteVerifiedService

  let fixtureIndex = 0
  const createVerifiedDelivery = async (actor = supplierActor, quantity = 5) => {
    fixtureIndex += 1
    const fixtureKey = `${verifySeed}-${fixtureIndex}`
    const product = await productService.create({
      productName: `入库删除商品-${fixtureKey}`,
      pinyinAbbr: 'RKSCSC',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      limitPerUser: 100,
      specGroups: [{ name: '规格', values: ['标准'] }],
      skus: [{
        skuCode: `IN-DELETE-${fixtureKey}`,
        specValues: { 规格: '标准' },
        defaultPrice: 10,
        currentStock: 10,
        isActive: true,
      }],
    } as Parameters<typeof productService.create>[0])
    const sku = product.skus[0]
    assert.ok(sku)
    const delivery = await inboundService.submitSupplierDelivery(actor, {
      remark: '已入库删除验证',
      items: [{ productId: String(product.id), skuId: String(sku.id), qty: quantity }],
    })
    await inboundService.verifyInbound(delivery.order.verifyCode, adminActor)
    return { productId: String(product.id), skuId: String(sku.id), orderId: String(delivery.order.id), showNo: delivery.order.showNo, quantity }
  }

  const createVerifiedMultiSkuDelivery = async () => {
    fixtureIndex += 1
    const fixtureKey = `${verifySeed}-${fixtureIndex}`
    const product = await productService.create({
      productName: `入库删除多规格商品-${fixtureKey}`,
      pinyinAbbr: 'RKSCGG',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      limitPerUser: 100,
      specGroups: [{ name: '规格', values: ['A', 'B'] }],
      skus: [
        { skuCode: `IN-DELETE-A-${fixtureKey}`, specValues: { 规格: 'A' }, defaultPrice: 10, currentStock: 10, isActive: true },
        { skuCode: `IN-DELETE-B-${fixtureKey}`, specValues: { 规格: 'B' }, defaultPrice: 10, currentStock: 10, isActive: true },
      ],
    } as Parameters<typeof productService.create>[0])
    assert.equal(product.skus.length, 2)
    const quantities = [3, 4]
    const delivery = await inboundService.submitSupplierDelivery(supplierActor, {
      remark: '多规格整单回滚验证',
      items: product.skus.map((sku, index) => ({
        productId: String(product.id),
        skuId: String(sku.id),
        qty: quantities[index] ?? 1,
      })),
    })
    await inboundService.verifyInbound(delivery.order.verifyCode, adminActor)
    return {
      productId: String(product.id),
      skuIds: product.skus.map((sku) => String(sku.id)),
      quantities,
      orderId: String(delivery.order.id),
      showNo: delivery.order.showNo,
    }
  }

  const createTwoProductDelivery = async (verified: boolean) => {
    const products = []
    for (const suffix of ['A', 'B']) {
      fixtureIndex += 1
      const fixtureKey = `${verifySeed}-${fixtureIndex}-${suffix}`
      products.push(await productService.create({
        productName: `入库删除跨商品-${fixtureKey}`,
        pinyinAbbr: 'RKSKSP',
        defaultPrice: 10,
        discountRate: 10,
        isActive: true,
        o2oStatus: 'listed',
        limitPerUser: 100,
        specGroups: [{ name: '规格', values: ['标准'] }],
        skus: [{
          skuCode: `IN-CROSS-${fixtureKey}`,
          specValues: { 规格: '标准' },
          defaultPrice: 10,
          currentStock: 10,
          isActive: true,
        }],
      } as Parameters<typeof productService.create>[0]))
    }
    const items = products.map((product, index) => ({
      productId: String(product.id),
      skuId: String(product.skus[0]?.id),
      qty: index + 2,
    }))
    const delivery = await inboundService.submitSupplierDelivery(supplierActor, { remark: '跨商品 SKU 防护验证', items })
    if (verified) await inboundService.verifyInbound(delivery.order.verifyCode, adminActor)
    return { products, items, orderId: String(delivery.order.id), showNo: delivery.order.showNo, verifyCode: delivery.order.verifyCode }
  }

  const readStocks = async (fixture: Awaited<ReturnType<typeof createVerifiedDelivery>>) => {
    const [product, sku] = await Promise.all([
      AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: fixture.productId }),
      AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: fixture.skuId }),
    ])
    return {
      productCurrent: Number(product.currentStock),
      productReserved: Number(product.preOrderedStock),
      skuCurrent: Number(sku.currentStock),
      skuReserved: Number(sku.preOrderedStock),
    }
  }

  const successFixture = await createVerifiedDelivery()
  const successOrder = await AppDataSource.getRepository(BizInboundOrder).findOneByOrFail({ id: successFixture.orderId })
  assert.equal(String(successOrder.supplierId), supplierActor.userId)
  const successBefore = await readStocks(successFixture)
  const revisionBeforeSuccess = readMallCatalogRevision()
  const successResult = await deleteService.deleteVerifiedSupplierDelivery(supplierActor, successFixture.orderId, {
    confirmShowNo: successFixture.showNo,
    permanentDeletePassword,
  })
  assert.equal(successResult.order.status, 'verified')
  assert.equal(successResult.order.isDeleted, true)
  assert.equal(successResult.items.length, 1)
  const successAfter = await readStocks(successFixture)
  assert.equal(successAfter.productCurrent, successBefore.productCurrent - successFixture.quantity)
  assert.equal(successAfter.skuCurrent, successBefore.skuCurrent - successFixture.quantity)
  assert.equal(successAfter.productReserved, successBefore.productReserved)
  assert.equal(successAfter.skuReserved, successBefore.skuReserved)
  assert.equal(readMallCatalogRevision(), revisionBeforeSuccess + 1)
  await assert.rejects(
    () => deleteService.deleteVerifiedSupplierDelivery(supplierActor, successFixture.orderId, {
      confirmShowNo: successFixture.showNo,
      permanentDeletePassword,
    }),
    /已删除|重复/,
  )
  await assert.rejects(() => inboundService.restoreSupplierDelivery(supplierActor, successFixture.orderId), /已入库/)
  await assert.rejects(() => inboundService.purgeSupplierDelivery(supplierActor, successFixture.orderId, successFixture.showNo), /已入库/)
  const reversalLogs = await AppDataSource.getRepository(InventoryLog).find({
    where: { refType: 'biz_inbound_order', refId: successFixture.orderId, changeType: 'inbound_reverse' },
  })
  assert.equal(reversalLogs.reduce((sum, row) => sum + Number(row.changeQty), 0), -successFixture.quantity)
  assert.ok(reversalLogs.every((row) => Number(row.afterCurrentStock) - Number(row.beforeCurrentStock) === Number(row.changeQty)))
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'inbound.supplier.delete_verified', targetId: successFixture.orderId, resultStatus: 'success' },
  }), 1)

  const crossProductPending = await createTwoProductDelivery(false)
  const crossPendingItems = await AppDataSource.getRepository(BizInboundOrderItem).find({
    where: { orderId: crossProductPending.orderId },
    order: { productId: 'ASC' },
  })
  assert.equal(crossPendingItems.length, 2)
  crossPendingItems[1]!.skuId = crossPendingItems[0]!.skuId
  await AppDataSource.getRepository(BizInboundOrderItem).save(crossPendingItems[1]!)
  const crossPendingProductStocks = new Map(await Promise.all(crossProductPending.items.map(async (item) => [
    item.productId,
    Number((await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: item.productId })).currentStock),
  ] as const)))
  await assert.rejects(() => inboundService.verifyInbound(crossProductPending.verifyCode, adminActor), /跨商品复用 SKU/)
  for (const item of crossProductPending.items) {
    assert.equal(Number((await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: item.productId })).currentStock), crossPendingProductStocks.get(item.productId))
  }
  assert.equal((await AppDataSource.getRepository(BizInboundOrder).findOneByOrFail({ id: crossProductPending.orderId })).status, 'pending')
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'biz_inbound_order', refId: crossProductPending.orderId, changeType: 'inbound_sys' },
  }), 0)

  fixtureIndex += 1
  const duplicateFixtureKey = `${verifySeed}-${fixtureIndex}`
  const duplicateProduct = await productService.create({
    productName: `入库删除重复明细-${duplicateFixtureKey}`,
    pinyinAbbr: 'RKCFMX',
    defaultPrice: 10,
    discountRate: 10,
    isActive: true,
    o2oStatus: 'listed',
    limitPerUser: 100,
    specGroups: [{ name: '规格', values: ['标准'] }],
    skus: [{
      skuCode: `IN-DUPLICATE-${duplicateFixtureKey}`,
      specValues: { 规格: '标准' },
      defaultPrice: 10,
      currentStock: 10,
      isActive: true,
    }],
  } as Parameters<typeof productService.create>[0])
  const duplicateSku = duplicateProduct.skus[0]
  assert.ok(duplicateSku)
  const duplicateDelivery = await inboundService.submitSupplierDelivery(supplierActor, {
    remark: '同商品同 SKU 重复明细验证',
    items: [{ productId: String(duplicateProduct.id), skuId: String(duplicateSku.id), qty: 2 }],
  })
  const duplicateItemRepo = AppDataSource.getRepository(BizInboundOrderItem)
  const firstDuplicateItem = await duplicateItemRepo.findOneByOrFail({ orderId: String(duplicateDelivery.order.id) })
  await duplicateItemRepo.save(duplicateItemRepo.create({
    orderId: firstDuplicateItem.orderId,
    productId: firstDuplicateItem.productId,
    skuId: firstDuplicateItem.skuId,
    productNameSnapshot: firstDuplicateItem.productNameSnapshot,
    qty: '3',
  }))
  await AppDataSource.getRepository(BizInboundOrder).update({ id: String(duplicateDelivery.order.id) }, { totalQty: '5' })
  const duplicateBefore = await readStocks({
    productId: String(duplicateProduct.id),
    skuId: String(duplicateSku.id),
    orderId: String(duplicateDelivery.order.id),
    showNo: duplicateDelivery.order.showNo,
    quantity: 5,
  })
  const duplicateVerifyResult = await inboundService.verifyInbound(duplicateDelivery.order.verifyCode, adminActor)
  assert.equal(duplicateVerifyResult.items.length, 2)
  assert.ok(duplicateVerifyResult.items.every((item) => String(item.sku?.id) === String(duplicateSku.id)))
  assert.ok(duplicateVerifyResult.items.every((item) => item.sku?.specText === duplicateSku.specText))
  const duplicateAfterVerify = await readStocks({
    productId: String(duplicateProduct.id),
    skuId: String(duplicateSku.id),
    orderId: String(duplicateDelivery.order.id),
    showNo: duplicateDelivery.order.showNo,
    quantity: 5,
  })
  assert.equal(duplicateAfterVerify.productCurrent, duplicateBefore.productCurrent + 5)
  assert.equal(duplicateAfterVerify.skuCurrent, duplicateBefore.skuCurrent + 5)
  const duplicateInboundLogs = await AppDataSource.getRepository(InventoryLog).find({
    where: { refType: 'biz_inbound_order', refId: String(duplicateDelivery.order.id), changeType: 'inbound_sys' },
  })
  assert.deepEqual(duplicateInboundLogs.map((log) => Number(log.changeQty)).sort((left, right) => left - right), [2, 3])
  const duplicateDeleteResult = await deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    String(duplicateDelivery.order.id),
    { confirmShowNo: duplicateDelivery.order.showNo, permanentDeletePassword },
  )
  assert.equal(duplicateDeleteResult.order.status, 'verified')
  assert.equal(duplicateDeleteResult.order.isDeleted, true)
  assert.deepEqual(await readStocks({
    productId: String(duplicateProduct.id),
    skuId: String(duplicateSku.id),
    orderId: String(duplicateDelivery.order.id),
    showNo: duplicateDelivery.order.showNo,
    quantity: 5,
  }), duplicateBefore)
  const duplicateReversalLogs = await AppDataSource.getRepository(InventoryLog).find({
    where: { refType: 'biz_inbound_order', refId: String(duplicateDelivery.order.id), changeType: 'inbound_reverse' },
  })
  assert.equal(duplicateReversalLogs.length, 1)
  assert.equal(Number(duplicateReversalLogs[0]?.changeQty), -5)

  const crossProductVerified = await createTwoProductDelivery(true)
  const crossVerifiedItems = await AppDataSource.getRepository(BizInboundOrderItem).find({
    where: { orderId: crossProductVerified.orderId },
    order: { productId: 'ASC' },
  })
  assert.equal(crossVerifiedItems.length, 2)
  crossVerifiedItems[1]!.skuId = crossVerifiedItems[0]!.skuId
  await AppDataSource.getRepository(BizInboundOrderItem).save(crossVerifiedItems[1]!)
  const crossVerifiedProductStocks = new Map(await Promise.all(crossProductVerified.items.map(async (item) => [
    item.productId,
    Number((await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: item.productId })).currentStock),
  ] as const)))
  await assert.rejects(() => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    crossProductVerified.orderId,
    { confirmShowNo: crossProductVerified.showNo, permanentDeletePassword },
  ), /跨商品复用 SKU/)
  for (const item of crossProductVerified.items) {
    assert.equal(Number((await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: item.productId })).currentStock), crossVerifiedProductStocks.get(item.productId))
  }
  assert.equal(Boolean((await AppDataSource.getRepository(BizInboundOrder).findOneByOrFail({ id: crossProductVerified.orderId })).isDeleted), false)

  const oversizedOrderId = 'x'.repeat(65)
  await assert.rejects(() => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    oversizedOrderId,
    { confirmShowNo: 'IN000000000000', permanentDeletePassword },
  ), /送货单不存在/)
  const oversizedIdAudit = await AppDataSource.getRepository(SysAuditLog).findOne({
    where: { actionType: 'inbound.supplier.delete_verified', targetId: null, resultStatus: 'failed' },
    order: { id: 'DESC' },
  })
  assert.ok(oversizedIdAudit)
  assert.equal(JSON.parse(oversizedIdAudit.detailJson ?? '{}').reason, 'invalid_order_id')

  const assertRejectedWithoutMutation = async (
    fixture: Awaited<ReturnType<typeof createVerifiedDelivery>>,
    run: () => Promise<unknown>,
    message: RegExp,
  ) => {
    const before = await readStocks(fixture)
    await assert.rejects(run, message)
    const after = await readStocks(fixture)
    assert.deepEqual(after, before)
    const order = await AppDataSource.getRepository(BizInboundOrder).findOneByOrFail({ id: fixture.orderId })
    assert.equal(Boolean(order.isDeleted), false)
    assert.equal(await AppDataSource.getRepository(InventoryLog).count({
      where: { refType: 'biz_inbound_order', refId: fixture.orderId, changeType: 'inbound_reverse' },
    }), 0)
  }

  const wrongPasswordFixture = await createVerifiedDelivery()
  await assertRejectedWithoutMutation(wrongPasswordFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    wrongPasswordFixture.orderId,
    { confirmShowNo: wrongPasswordFixture.showNo, permanentDeletePassword: 'wrong-password-value' },
  ), /密码不正确/)

  const missingPasswordFixture = await createVerifiedDelivery()
  await assertRejectedWithoutMutation(missingPasswordFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    missingPasswordFixture.orderId,
    { confirmShowNo: missingPasswordFixture.showNo },
  ), /请输入永久删除密码/)

  const envMutable = env as unknown as { PERMANENT_DELETE_PASSWORD?: string }
  const configuredPassword = envMutable.PERMANENT_DELETE_PASSWORD
  envMutable.PERMANENT_DELETE_PASSWORD = undefined
  const unconfiguredFixture = await createVerifiedDelivery()
  try {
    await assertRejectedWithoutMutation(unconfiguredFixture, () => deleteService.deleteVerifiedSupplierDelivery(
      supplierActor,
      unconfiguredFixture.orderId,
      { confirmShowNo: unconfiguredFixture.showNo, permanentDeletePassword },
    ), /未配置永久删除密码/)
  } finally {
    envMutable.PERMANENT_DELETE_PASSWORD = configuredPassword
  }

  const mismatchFixture = await createVerifiedDelivery()
  await assertRejectedWithoutMutation(mismatchFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    mismatchFixture.orderId,
    { confirmShowNo: `${mismatchFixture.showNo}-WRONG`, permanentDeletePassword },
  ), /确认单号不一致/)

  const ownershipFixture = await createVerifiedDelivery()
  await assertRejectedWithoutMutation(ownershipFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    otherSupplierActor,
    ownershipFixture.orderId,
    { confirmShowNo: ownershipFixture.showNo, permanentDeletePassword },
  ), /不存在/)

  const soldFixture = await createVerifiedDelivery(supplierActor, 5)
  const soldProduct = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: soldFixture.productId })
  const soldSku = await AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: soldFixture.skuId })
  soldProduct.currentStock = 4
  soldSku.currentStock = 4
  await AppDataSource.manager.save([soldProduct, soldSku])
  await assertRejectedWithoutMutation(soldFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    soldFixture.orderId,
    { confirmShowNo: soldFixture.showNo, permanentDeletePassword },
  ), /库存.*不足|已售出/)

  const reservedFixture = await createVerifiedDelivery(supplierActor, 5)
  const reservedProduct = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: reservedFixture.productId })
  const reservedSku = await AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: reservedFixture.skuId })
  reservedProduct.preOrderedStock = Number(reservedProduct.currentStock) - reservedFixture.quantity + 1
  reservedSku.preOrderedStock = Number(reservedSku.currentStock) - reservedFixture.quantity + 1
  await AppDataSource.manager.save([reservedProduct, reservedSku])
  await assertRejectedWithoutMutation(reservedFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    reservedFixture.orderId,
    { confirmShowNo: reservedFixture.showNo, permanentDeletePassword },
  ), /预订|占用/)

  const partialRollbackFixture = await createVerifiedMultiSkuDelivery()
  const partialProductBefore = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: partialRollbackFixture.productId })
  const partialSkusBefore = await AppDataSource.getRepository(BaseProductSku).find({
    where: { productId: partialRollbackFixture.productId },
    order: { id: 'ASC' },
  })
  assert.equal(partialSkusBefore.length, 2)
  const insufficientSku = partialSkusBefore.find((sku) => String(sku.id) === partialRollbackFixture.skuIds[1])
  assert.ok(insufficientSku)
  const originalInsufficientStock = Number(insufficientSku.currentStock)
  insufficientSku.currentStock = 1
  partialProductBefore.currentStock = Number(partialProductBefore.currentStock) - (originalInsufficientStock - 1)
  await AppDataSource.manager.save([partialProductBefore, insufficientSku])
  const partialProductSnapshot = Number(partialProductBefore.currentStock)
  const partialSkuSnapshot = new Map((await AppDataSource.getRepository(BaseProductSku).find({
    where: { productId: partialRollbackFixture.productId },
  })).map((sku) => [String(sku.id), Number(sku.currentStock)]))
  await assert.rejects(() => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    partialRollbackFixture.orderId,
    { confirmShowNo: partialRollbackFixture.showNo, permanentDeletePassword },
  ), /库存.*不足|已售出/)
  assert.equal(Number((await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: partialRollbackFixture.productId })).currentStock), partialProductSnapshot)
  const partialSkusAfter = await AppDataSource.getRepository(BaseProductSku).find({ where: { productId: partialRollbackFixture.productId } })
  assert.deepEqual(new Map(partialSkusAfter.map((sku) => [String(sku.id), Number(sku.currentStock)])), partialSkuSnapshot)
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'biz_inbound_order', refId: partialRollbackFixture.orderId, changeType: 'inbound_reverse' },
  }), 0)
  assert.equal(Boolean((await AppDataSource.getRepository(BizInboundOrder).findOneByOrFail({ id: partialRollbackFixture.orderId })).isDeleted), false)

  const missingSkuFixture = await createVerifiedDelivery()
  await AppDataSource.getRepository(BizInboundOrderItem).update({ orderId: missingSkuFixture.orderId }, { skuId: null })
  await assertRejectedWithoutMutation(missingSkuFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    missingSkuFixture.orderId,
    { confirmShowNo: missingSkuFixture.showNo, permanentDeletePassword },
  ), /缺少 SKU|SKU.*不存在/)

  const retiredSkuFixture = await createVerifiedDelivery()
  const retiredSku = await AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: retiredSkuFixture.skuId })
  retiredSku.isCurrent = false
  retiredSku.isActive = false
  await AppDataSource.getRepository(BaseProductSku).save(retiredSku)
  await assertRejectedWithoutMutation(retiredSkuFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    retiredSkuFixture.orderId,
    { confirmShowNo: retiredSkuFixture.showNo, permanentDeletePassword },
  ), /SKU.*退役|SKU.*停用|无法安全冲销/)

  const logMismatchFixture = await createVerifiedDelivery()
  await AppDataSource.getRepository(InventoryLog).delete({
    refType: 'biz_inbound_order',
    refId: logMismatchFixture.orderId,
    changeType: 'inbound_sys',
  })
  await assertRejectedWithoutMutation(logMismatchFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    logMismatchFixture.orderId,
    { confirmShowNo: logMismatchFixture.showNo, permanentDeletePassword },
  ), /入库流水.*不一致|无法确认.*入库/)

  const logEntryMismatchFixture = await createVerifiedMultiSkuDelivery()
  const mismatchedLogs = await AppDataSource.getRepository(InventoryLog).find({
    where: { refType: 'biz_inbound_order', refId: logEntryMismatchFixture.orderId, changeType: 'inbound_sys' },
    order: { id: 'ASC' },
  })
  assert.equal(mismatchedLogs.length, 2)
  const mismatchedQuantities = [2, 5]
  for (const [index, log] of mismatchedLogs.entries()) {
    const nextQty = mismatchedQuantities[index] ?? 1
    log.changeQty = nextQty
    log.afterCurrentStock = Number(log.beforeCurrentStock) + nextQty
  }
  await AppDataSource.getRepository(InventoryLog).save(mismatchedLogs)
  const mismatchProductBefore = Number((await AppDataSource.getRepository(BaseProduct).findOneByOrFail({
    id: logEntryMismatchFixture.productId,
  })).currentStock)
  const mismatchSkusBefore = new Map((await AppDataSource.getRepository(BaseProductSku).find({
    where: { productId: logEntryMismatchFixture.productId },
  })).map((sku) => [String(sku.id), Number(sku.currentStock)]))
  await assert.rejects(() => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    logEntryMismatchFixture.orderId,
    { confirmShowNo: logEntryMismatchFixture.showNo, permanentDeletePassword },
  ), /原始入库流水与明细不一致/)
  assert.equal(Number((await AppDataSource.getRepository(BaseProduct).findOneByOrFail({
    id: logEntryMismatchFixture.productId,
  })).currentStock), mismatchProductBefore)
  assert.deepEqual(new Map((await AppDataSource.getRepository(BaseProductSku).find({
    where: { productId: logEntryMismatchFixture.productId },
  })).map((sku) => [String(sku.id), Number(sku.currentStock)])), mismatchSkusBefore)
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'biz_inbound_order', refId: logEntryMismatchFixture.orderId, changeType: 'inbound_reverse' },
  }), 0)

  const negativeLogSnapshotFixture = await createVerifiedDelivery()
  const negativeSnapshotLog = await AppDataSource.getRepository(InventoryLog).findOneByOrFail({
    refType: 'biz_inbound_order',
    refId: negativeLogSnapshotFixture.orderId,
    changeType: 'inbound_sys',
  })
  negativeSnapshotLog.beforeCurrentStock = -negativeLogSnapshotFixture.quantity
  negativeSnapshotLog.afterCurrentStock = 0
  await AppDataSource.getRepository(InventoryLog).save(negativeSnapshotLog)
  await assertRejectedWithoutMutation(negativeLogSnapshotFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    negativeLogSnapshotFixture.orderId,
    { confirmShowNo: negativeLogSnapshotFixture.showNo, permanentDeletePassword },
  ), /原始入库流水.*库存数据异常|无法安全冲销/)

  const invalidReservedLogSnapshotFixture = await createVerifiedDelivery()
  const invalidReservedSnapshotLog = await AppDataSource.getRepository(InventoryLog).findOneByOrFail({
    refType: 'biz_inbound_order',
    refId: invalidReservedLogSnapshotFixture.orderId,
    changeType: 'inbound_sys',
  })
  invalidReservedSnapshotLog.beforePreorderedStock = Number(invalidReservedSnapshotLog.beforeCurrentStock) + 1
  invalidReservedSnapshotLog.afterPreorderedStock = Number(invalidReservedSnapshotLog.afterCurrentStock) + 1
  await AppDataSource.getRepository(InventoryLog).save(invalidReservedSnapshotLog)
  await assertRejectedWithoutMutation(invalidReservedLogSnapshotFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    invalidReservedLogSnapshotFixture.orderId,
    { confirmShowNo: invalidReservedLogSnapshotFixture.showNo, permanentDeletePassword },
  ), /原始入库流水.*库存数据异常|无法安全冲销/)

  const invalidStockFixture = await createVerifiedDelivery()
  await AppDataSource.query('PRAGMA ignore_check_constraints = ON')
  await AppDataSource.query('UPDATE base_product SET current_stock = -1 WHERE id = ?', [invalidStockFixture.productId])
  await AppDataSource.query('PRAGMA ignore_check_constraints = OFF')
  await assertRejectedWithoutMutation(invalidStockFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    invalidStockFixture.orderId,
    { confirmShowNo: invalidStockFixture.showNo, permanentDeletePassword },
  ), /库存数据异常/)

  const totalMismatchFixture = await createVerifiedDelivery()
  await AppDataSource.getRepository(BizInboundOrder).update({ id: totalMismatchFixture.orderId }, { totalQty: '999' })
  await assertRejectedWithoutMutation(totalMismatchFixture, () => deleteService.deleteVerifiedSupplierDelivery(
    supplierActor,
    totalMismatchFixture.orderId,
    { confirmShowNo: totalMismatchFixture.showNo, permanentDeletePassword },
  ), /总数量.*不一致/)

  const concurrentFixture = await createVerifiedDelivery()
  const concurrentBefore = await readStocks(concurrentFixture)
  const concurrentResults = await Promise.allSettled([
    deleteService.deleteVerifiedSupplierDelivery(supplierActor, concurrentFixture.orderId, {
      confirmShowNo: concurrentFixture.showNo,
      permanentDeletePassword,
    }),
    deleteService.deleteVerifiedSupplierDelivery(supplierActor, concurrentFixture.orderId, {
      confirmShowNo: concurrentFixture.showNo,
      permanentDeletePassword,
    }),
  ])
  assert.equal(concurrentResults.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(concurrentResults.filter((item) => item.status === 'rejected').length, 1)
  const concurrentAfter = await readStocks(concurrentFixture)
  assert.equal(concurrentAfter.productCurrent, concurrentBefore.productCurrent - concurrentFixture.quantity)
  assert.equal(concurrentAfter.skuCurrent, concurrentBefore.skuCurrent - concurrentFixture.quantity)
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'biz_inbound_order', refId: concurrentFixture.orderId, changeType: 'inbound_reverse' },
  }), 1)
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'inbound.supplier.delete_verified', targetId: concurrentFixture.orderId, resultStatus: 'success' },
  }), 1)

  const auditRollbackFixture = await createVerifiedDelivery()
  const auditRollbackBefore = await readStocks(auditRollbackFixture)
  const originalAuditRecord = auditService.record.bind(auditService)
  auditService.record = async (input, manager) => {
    if (manager && input.actionType === 'inbound.supplier.delete_verified') {
      throw new Error('verify-only-success-audit-failure')
    }
    return originalAuditRecord(input, manager)
  }
  try {
    await assert.rejects(() => deleteService.deleteVerifiedSupplierDelivery(
      supplierActor,
      auditRollbackFixture.orderId,
      { confirmShowNo: auditRollbackFixture.showNo, permanentDeletePassword },
    ), /verify-only-success-audit-failure/)
  } finally {
    auditService.record = originalAuditRecord
  }
  assert.deepEqual(await readStocks(auditRollbackFixture), auditRollbackBefore)
  assert.equal(Boolean((await AppDataSource.getRepository(BizInboundOrder).findOneByOrFail({ id: auditRollbackFixture.orderId })).isDeleted), false)
  assert.equal(await AppDataSource.getRepository(InventoryLog).count({
    where: { refType: 'biz_inbound_order', refId: auditRollbackFixture.orderId, changeType: 'inbound_reverse' },
  }), 0)
  const auditRollbackFailure = await AppDataSource.getRepository(SysAuditLog).findOne({
    where: { actionType: 'inbound.supplier.delete_verified', targetId: auditRollbackFixture.orderId, resultStatus: 'failed' },
    order: { id: 'DESC' },
  })
  assert.ok(auditRollbackFailure)
  assert.equal(JSON.parse(auditRollbackFailure.detailJson ?? '{}').reason, 'success_audit_failed')

  const failedAudits = await AppDataSource.getRepository(SysAuditLog).find({
    where: { actionType: 'inbound.supplier.delete_verified', resultStatus: 'failed' },
  })
  assert.ok(failedAudits.length >= 9, '每个服务层拒绝场景都必须留下失败审计')
  const failedAuditText = JSON.stringify(failedAudits)
  assert.equal(failedAuditText.includes(permanentDeletePassword), false)
  assert.equal(failedAuditText.includes('wrong-password-value'), false)

  const server = createApp().listen(0, '127.0.0.1')
  try {
    if (!server.listening) await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object' && typeof address.port === 'number')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const [supplierSession, otherSupplierSession, rateSupplierSession] = await Promise.all([
      loginCookieSession(baseUrl, supplier.username, supplierPassword),
      loginCookieSession(baseUrl, otherSupplier.username, otherSupplierPassword),
      loginCookieSession(baseUrl, rateSupplier.username, rateSupplierPassword),
    ])

    const csrfFixture = await createVerifiedDelivery()
    const csrfPayload = await expectStatus(() => fetch(`${baseUrl}/api/inbound/supplier/${csrfFixture.orderId}/verified`, {
      method: 'DELETE',
      headers: writeHeaders(supplierSession, false),
      body: JSON.stringify({ confirmShowNo: csrfFixture.showNo, permanentDeletePassword }),
    }), 403, 'Cookie 写请求缺少 CSRF')
    assert.equal(csrfPayload.message, '请求安全校验失败，请刷新页面后重试')

    const routeOwnershipFixture = await createVerifiedDelivery()
    await expectStatus(() => fetch(`${baseUrl}/api/inbound/supplier/${routeOwnershipFixture.orderId}/verified`, {
      method: 'DELETE',
      headers: writeHeaders(otherSupplierSession),
      body: JSON.stringify({ confirmShowNo: routeOwnershipFixture.showNo, permanentDeletePassword }),
    }), 404, '其他供货方删除他人已入库单')

    const routeSuccessFixture = await createVerifiedDelivery()
    const routeSuccess = await expectStatus(() => fetch(`${baseUrl}/api/inbound/supplier/${routeSuccessFixture.orderId}/verified`, {
      method: 'DELETE',
      headers: writeHeaders(supplierSession),
      body: JSON.stringify({ confirmShowNo: routeSuccessFixture.showNo, permanentDeletePassword }),
    }), 200, '本人通过真实 HTTP 删除已入库单')
    const routeData = routeSuccess.data as { order?: { status?: string; isDeleted?: boolean } }
    assert.equal(routeData.order?.status, 'verified')
    assert.equal(routeData.order?.isDeleted, true)

    const rateFixture = await createVerifiedDelivery(actorOf(rateSupplier))
    for (let index = 0; index < 8; index += 1) {
      await expectStatus(() => fetch(`${baseUrl}/api/inbound/supplier/${rateFixture.orderId}/verified`, {
        method: 'DELETE',
        headers: writeHeaders(rateSupplierSession),
        body: JSON.stringify({ confirmShowNo: rateFixture.showNo, permanentDeletePassword: 'wrong-password-value' }),
      }), 403, `高危删除失败尝试 ${index + 1}`)
    }
    await expectStatus(() => fetch(`${baseUrl}/api/inbound/supplier/${rateFixture.orderId}/verified`, {
      method: 'DELETE',
      headers: writeHeaders(rateSupplierSession),
      body: JSON.stringify({ confirmShowNo: rateFixture.showNo, permanentDeletePassword: 'wrong-password-value' }),
    }), 429, '高危删除账号频控')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  console.log('inbound verified delete verify: passed')

  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  cleanup()
}

main().catch(async (error) => {
  console.error(`[inbound-verified-delete-verify] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  try {
    const { AppDataSource } = await import('../src/config/data-source.js')
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  } catch {
    // 初始化失败时没有可关闭的数据源。
  }
  cleanup()
  process.exitCode = 1
})
