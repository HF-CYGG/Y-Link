/**
 * 文件说明：backend/scripts/o2o-discount-price-verify.ts
 * 文件职责：验证 O2O 商品折扣、预订单价格快照、核销出库金额与商城公告配置的端到端一致性。
 * 实现逻辑：
 * - 使用独立 SQLite 数据库启动真实服务层，避免污染本地开发数据；
 * - 先创建带 8.8 折的线上商品，再下单并修改商品当前价格，确认历史预订单仍按下单快照展示；
 * - 核销后检查正式出库单金额继续沿用预订单快照，避免后续商品改价串改历史金额；
 * - 通过 O2O 规则配置写入商城公告，确认客户端商城接口可以透传公告与营业时间。
 * 维护说明：
 * - 若后续调整折扣字段名或订单明细金额字段，必须同步更新本脚本；
 * - 覆盖退货冲减价格快照、工作台及报表统计，其余库存与权限回归由对应专项覆盖。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createVerificationIsolation } from './verification-isolation.js'

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const isolation = createVerificationIsolation('o2o-discount-price-verify')
isolation.seal({ type: 'sqlite', database: path.join(isolation.rootDir, 'fixture.sqlite') })
process.env.DB_SYNC = 'false'
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'

const adminActor: AuthUserContext = {
  userId: 'o2o-discount-verify-admin',
  username: 'o2o-discount-verify-admin',
  displayName: '折扣验证管理员',
  role: 'admin',
  permissions: [],
  status: 'enabled',
  sessionToken: 'o2o-discount-verify-session',
}

function pass(message: string) {
  console.log(`OK ${message}`)
}

function normalizeMoney(value: unknown) {
  return Number(value).toFixed(2)
}

const TEST_CAPTCHA_CODE = 'ABC123'
const readCaptchaCode = (_captchaSvg: string) => TEST_CAPTCHA_CODE
const pendingClientVerificationTargets = new Set<string>()

async function registerAndLoginClient(clientAuthService: typeof import('../src/services/client-auth.service.js').clientAuthService): Promise<ClientAuthContext> {
  const seed = String(Date.now()).slice(-10)
  const password = `Client@${seed.slice(-6)}`
  pendingClientVerificationTargets.add(`1${seed}`)
  const registerResult = await clientAuthService.register({
    accountType: 'personal',
    account: `1${seed}`,
    username: '折扣验证员',
    password,
    verificationCode: '123456',
  })
  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginResult = await clientAuthService.login({
    account: registerResult.user.mobile,
    password,
    captchaId: loginCaptcha.captchaId,
    captchaCode: readCaptchaCode(loginCaptcha.captchaSvg),
  })
  return clientAuthService.resolveClientByToken(loginResult.token)
}

async function main() {
  const { installCaptchaServiceForTesting } = await import('../src/services/captcha.service.js')
  installCaptchaServiceForTesting({ createCode: () => TEST_CAPTCHA_CODE })
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
  const { BizOutboundOrderItem } = await import('../src/entities/biz-outbound-order-item.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
  const { O2oPreorderItem } = await import('../src/entities/o2o-preorder-item.entity.js')
  const { O2oReturnRequest } = await import('../src/entities/o2o-return-request.entity.js')
  const { O2oReturnRequestItem } = await import('../src/entities/o2o-return-request-item.entity.js')
  const { OrderRevision } = await import('../src/entities/order-revision.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { dashboardService } = await import('../src/services/dashboard.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { reportService } = await import('../src/services/report.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { verificationCodeService } = await import('../src/services/verification-code.service.js')

  await isolation.assertTarget(AppDataSource)
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()
    const originalProviders = systemConfigService.getVerificationProviderConfigs.bind(systemConfigService)
    systemConfigService.getVerificationProviderConfigs = async () => {
      const configs = await originalProviders()
      return { ...configs, mobile: { ...configs.mobile, enabled: true, ready: true } }
    }
    verificationCodeService.verifyCode = async (input) => {
      assert.equal(input.channel, 'mobile')
      assert.equal(input.scene, 'register')
      assert.equal(input.code, '123456')
      assert.ok(pendingClientVerificationTargets.delete(input.target), '注册验证码必须绑定本次手机号且只能使用一次')
    }
    const userRepo = AppDataSource.getRepository(SysUser)
    const admin = await userRepo.save(userRepo.create({
      username: `discount-admin-${verifySeed}`,
      passwordHash: 'verify-only',
      displayName: '折扣验证管理员',
      email: null,
      role: 'admin',
      status: 'enabled',
      lastLoginAt: null,
    }))
    adminActor.userId = String(admin.id)
    adminActor.username = admin.username
    adminActor.displayName = admin.displayName

    const product = await productService.create({
      productName: `折扣验证商品-${verifySeed}`,
      pinyinAbbr: 'ZKYZ',
      defaultPrice: 10,
      discountRate: 8.8,
      isActive: true,
      o2oStatus: 'listed',
      o2oRecommended: true,
      currentStock: 20,
      limitPerUser: 10,
    }, adminActor)
    assert.equal(product.discountRate, '8.8')
    assert.equal(product.discountedPrice, '8.80')
    assert.equal(product.o2oRecommended, true)
    pass('商品服务返回折扣、折后价和手动推荐标记')

    const mallConfigBefore = await o2oPreorderService.listMallProducts()
    const mallProduct = mallConfigBefore.list.find((item) => item.id === product.id)
    assert.ok(mallProduct)
    assert.equal(mallProduct.discountRate, '8.8')
    assert.equal(mallProduct.discountedPrice, '8.80')
    assert.equal(mallProduct.o2oRecommended, true)
    assert.equal(mallProduct.soldQty, 0)
    pass('商城商品接口返回折扣与推荐字段')

    const currentRules = await systemConfigService.getO2oRuleConfigs()
    const updatedRules = await systemConfigService.updateO2oRuleConfigs(
      {
        autoCancelEnabled: currentRules.autoCancelEnabled,
        autoCancelHours: currentRules.autoCancelHours,
        limitEnabled: currentRules.limitEnabled,
        limitQty: currentRules.limitQty,
        clientPreorderUpdateLimit: currentRules.clientPreorderUpdateLimit,
        storeBusinessHoursText: '09:30 - 21:30',
        mallAnnouncementText: '折扣验证公告',
      },
      adminActor,
    )
    assert.equal(updatedRules.config.mallAnnouncementText, '折扣验证公告')
    const mallConfigAfter = await o2oPreorderService.listMallProducts()
    assert.equal(mallConfigAfter.storefront.businessHoursText, '09:30 - 21:30')
    assert.equal(mallConfigAfter.storefront.mallAnnouncementText, '折扣验证公告')
    pass('O2O 规则配置透传商城公告与营业时间')

    const clientAuth = await registerAndLoginClient(clientAuthService)
    const preorder = await o2oPreorderService.submit(clientAuth, {
      clientRequestId: 'discount-price-order-0001',
      items: [{ productId: product.id, qty: 2 }],
      remark: '折扣快照验证',
      pickupContact: '折扣验证提货人',
      isSystemApplied: false,
    })
    assert.equal(preorder.order.totalAmount, '17.60')
    assert.equal(preorder.items[0]?.originalPrice, '10.00')
    assert.equal(preorder.items[0]?.discountRate, '8.8')
    assert.equal(preorder.items[0]?.defaultPrice, '8.80')
    assert.equal(preorder.items[0]?.unitPrice, '8.80')
    assert.equal(preorder.items[0]?.subTotal, '17.60')
    assert.equal(preorder.items[0]?.lineAmount, '17.60')
    const preorderSkuId = preorder.items[0]?.skuId ?? null
    assert.ok(preorderSkuId, 'default SKU preorder should preserve skuId snapshot')
    pass('下单时写入折扣价格快照')

    const mallConfigAfterPendingPreorder = await o2oPreorderService.listMallProducts()
    const pendingSoldProduct = mallConfigAfterPendingPreorder.list.find((item) => item.id === product.id)
    assert.equal(pendingSoldProduct?.soldQty, 0)
    pass('未核销预订单不计入商城已售数量')

    await AppDataSource.getRepository(BaseProduct).update(
      { id: product.id },
      {
        defaultPrice: '20.00',
        discountRate: '10.0',
      },
    )
    const detailAfterProductChange = await o2oPreorderService.detailById(preorder.order.id)
    assert.equal(detailAfterProductChange.order.totalAmount, '17.60')
    assert.equal(detailAfterProductChange.items[0]?.originalPrice, '10.00')
    assert.equal(detailAfterProductChange.items[0]?.unitPrice, '8.80')
    assert.equal(detailAfterProductChange.items[0]?.lineAmount, '17.60')
    pass('商品改价后历史预订单金额仍使用快照')

    await o2oPreorderService.verifyByCode(preorder.order.verifyCode, adminActor)
    const outboundOrder = await AppDataSource.getRepository(BizOutboundOrder).findOneByOrFail({
      idempotencyKey: `o2o-preorder-verify:${preorder.order.id}`,
    })
    assert.equal(normalizeMoney(outboundOrder.totalAmount), '17.60')
    const outboundItems = await AppDataSource.getRepository(BizOutboundOrderItem).find({
      where: { orderId: outboundOrder.id },
    })
    assert.equal(normalizeMoney(outboundItems[0]?.unitPrice), '8.80')
    assert.equal(normalizeMoney(outboundItems[0]?.lineAmount), '17.60')
    pass('核销生成正式出库单沿用预订单快照金额')

    const mallConfigAfterVerify = await o2oPreorderService.listMallProducts()
    const verifiedSoldProduct = mallConfigAfterVerify.list.find((item) => item.id === product.id)
    assert.equal(verifiedSoldProduct?.soldQty, 2)
    pass('已核销预订单计入商城已售数量')

    const returnRequest = await o2oPreorderService.createReturnRequest(clientAuth, preorder.order.id, {
      reason: '已售数量回归验证',
      items: [{ productId: product.id, skuId: preorderSkuId, qty: 1 }],
    })
    await o2oPreorderService.verifyByCode(returnRequest.verifyCode, adminActor)
    const afterPartial = await o2oPreorderService.detailById(preorder.order.id)
    assert.equal(afterPartial.order.totalAmount, '8.80')
    assert.equal(afterPartial.items[0]?.lineAmount, '8.80')
    const preorderItems = AppDataSource.getRepository(O2oPreorderItem)
    assert.equal(normalizeMoney((await preorderItems.findOneByOrFail({ orderId: preorder.order.id })).lineAmount), '8.80')
    const partialOutbound = await AppDataSource.getRepository(BizOutboundOrder).findOneByOrFail({ id: outboundOrder.id })
    assert.equal(normalizeMoney(partialOutbound.totalQty), '1.00')
    assert.equal(normalizeMoney(partialOutbound.totalAmount), '8.80')
    assert.equal(normalizeMoney((await AppDataSource.getRepository(BizOutboundOrderItem).findOneByOrFail({ id: outboundItems[0]!.id })).lineAmount), '8.80')
    const partialStats = await dashboardService.getStats()
    assert.equal(partialStats.todayOrderCount, 1)
    assert.equal(normalizeMoney(partialStats.todayOrderAmount), '8.80')
    // 模拟上线前已退一件、初始小计和正式单尚未冲减的存量。
    await preorderItems.update({ orderId: preorder.order.id }, { lineAmount: '17.60' })
    await AppDataSource.getRepository(BizOutboundOrder).update({ id: outboundOrder.id }, { totalQty: '2.00', totalAmount: '17.60' })
    await AppDataSource.getRepository(BizOutboundOrderItem).update({ id: outboundItems[0]!.id }, { qty: '2.00', lineAmount: '17.60' })
    assert.equal((await o2oPreorderService.detailById(preorder.order.id)).order.totalAmount, '8.80')
    const listed = await o2oPreorderService.listMyOrders(clientAuth)
    assert.equal(listed.list.find((item) => item.id === preorder.order.id)?.totalAmount, '8.80')
    assert.equal(normalizeMoney((await preorderItems.findOneByOrFail({ orderId: preorder.order.id })).lineAmount), '17.60', '只读旧金额不回写历史')
    const mallConfigAfterVerifiedReturn = await o2oPreorderService.listMallProducts()
    const returnedSoldProduct = mallConfigAfterVerifiedReturn.list.find((item) => item.id === product.id)
    assert.equal(returnedSoldProduct?.soldQty, 1)
    pass('已核销部分退货按下单价冲减，历史预订单显示实际余量金额')

    const finalReturn = await o2oPreorderService.createReturnRequest(clientAuth, preorder.order.id, {
      reason: '累计退完并冲减存量出库明细', items: [{ productId: product.id, skuId: preorderSkuId, qty: 1 }],
    })
    await o2oPreorderService.verifyByCode(finalReturn.verifyCode, adminActor)
    await assert.rejects(() => o2oPreorderService.verifyByCode(finalReturn.verifyCode, adminActor), /不可重复核销/)
    const finalOrder = await AppDataSource.getRepository(BizOutboundOrder).findOneByOrFail({ id: outboundOrder.id })
    assert.equal(finalOrder.businessNo, outboundOrder.businessNo)
    assert.equal(normalizeMoney(finalOrder.totalQty), '0.00')
    assert.equal(normalizeMoney(finalOrder.totalAmount), '0.00')
    assert.equal(Number(finalOrder.editVersion), Number(outboundOrder.editVersion) + 2)
    assert.equal(await AppDataSource.getRepository(BizOutboundOrderItem).countBy({ orderId: outboundOrder.id }), 0)
    const finalRevision = await AppDataSource.getRepository(OrderRevision).findOneByOrFail({
      orderUuid: outboundOrder.orderUuid, revisionNo: finalOrder.editVersion,
    })
    assert.equal(JSON.parse(finalRevision.beforeSnapshotJson).items[0].qty, '2.00')
    assert.deepEqual(JSON.parse(finalRevision.afterSnapshotJson).items, [])
    assert.equal((await o2oPreorderService.detailById(preorder.order.id)).order.totalAmount, '0.00')
    const fullReturnStats = await dashboardService.getStats()
    assert.equal(fullReturnStats.todayOrderCount, 0)
    assert.equal(normalizeMoney(fullReturnStats.todayOrderAmount), '0.00')
    assert.equal((await reportService.query('outbound-flow', { page: 1, pageSize: 20 })).total, 0)
    assert.equal((await reportService.query('walkin', { page: 1, pageSize: 20 })).total, 0)

    const variedProduct = await productService.create({
      productName: `旧待取货退货验证商品-${verifySeed}`, defaultPrice: 10, isActive: true, o2oStatus: 'listed',
      specGroups: [{ name: '款式', values: ['甲', '乙'] }],
      skus: [
        { skuCode: `LEGACY-A-${verifySeed}`, specValues: { 款式: '甲' }, defaultPrice: 7, currentStock: 7, isActive: true },
        { skuCode: `LEGACY-B-${verifySeed}`, specValues: { 款式: '乙' }, defaultPrice: 12.5, currentStock: 9, isActive: true },
      ],
      limitPerUser: 10,
    }, adminActor)
    const returnedSku = variedProduct.skus.find((sku) => Number(sku.defaultPrice) === 7)!
    const pickedSku = variedProduct.skus.find((sku) => Number(sku.defaultPrice) === 12.5)!
    const pending = await o2oPreorderService.submit(clientAuth, {
      clientRequestId: 'discount-price-return-pending',
      items: [{ productId: variedProduct.id, skuId: returnedSku.id, qty: 1 }, { productId: variedProduct.id, skuId: pickedSku.id, qty: 2 }],
      pickupContact: '待取货退货验证', isSystemApplied: false,
    })
    // 当前待取货入口走改单，旧库仍可能有待处理的待取货退货申请。
    const pendingReturn = await AppDataSource.getRepository(O2oReturnRequest).save({
      returnNo: `RO-LEGACY-${verifySeed}`, orderId: pending.order.id, clientUserId: clientAuth.userId,
      verifyCode: randomUUID(), sourceOrderStatus: 'pending', status: 'pending', totalQty: 1,
      reason: '历史待取货退货金额回归',
    })
    await AppDataSource.getRepository(O2oReturnRequestItem).insert({
      returnRequestId: pendingReturn.id, productId: variedProduct.id, skuId: returnedSku.id, qty: 1,
    })
    await o2oPreorderService.verifyByCode(pendingReturn.verifyCode, adminActor)
    const afterPendingReturn = await o2oPreorderService.detailById(pending.order.id)
    assert.equal(afterPendingReturn.order.totalAmount, '25.00')
    assert.equal(afterPendingReturn.items.find((item) => item.skuId === String(returnedSku.id))?.qty, 0)
    assert.equal(afterPendingReturn.items.find((item) => item.skuId === String(returnedSku.id))?.lineAmount, '0.00')
    assert.equal(await AppDataSource.getRepository(BizOutboundOrder).countBy({ sourceDocId: pending.order.id }), 0)
    assert.equal((await AppDataSource.getRepository(O2oPreorder).findOneByOrFail({ id: pending.order.id })).status, 'pending')
    const readSkuStock = async (skuId: string) => {
      const sku = await AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: skuId })
      return [Number(sku.currentStock), Number(sku.preOrderedStock)]
    }
    assert.deepEqual(await readSkuStock(returnedSku.id), [7, 0])
    assert.deepEqual(await readSkuStock(pickedSku.id), [9, 2])
    await o2oPreorderService.verifyByCode(pending.order.verifyCode, adminActor)
    assert.deepEqual(await readSkuStock(returnedSku.id), [7, 0])
    assert.deepEqual(await readSkuStock(pickedSku.id), [7, 0])
    const logs = AppDataSource.getRepository(InventoryLog)
    const releases = await logs.findBy({ refType: 'o2o_return_request', refId: String(pendingReturn.id), changeType: 'preorder_release' })
    const pickups = await logs.findBy({ refType: 'o2o_preorder', refId: pending.order.id, changeType: 'preorder_verify' })
    assert.deepEqual(releases.map((log) => [String(log.skuId), log.changeQty]), [[String(returnedSku.id), 1]])
    assert.deepEqual(pickups.map((log) => [String(log.skuId), log.changeQty]), [[String(pickedSku.id), 2]])
    const pickedOrder = await AppDataSource.getRepository(BizOutboundOrder).findOneByOrFail({ sourceDocId: pending.order.id })
    assert.equal(normalizeMoney(pickedOrder.totalQty), '2.00')
    assert.equal(normalizeMoney(pickedOrder.totalAmount), '25.00')
    const pickedItems = await AppDataSource.getRepository(BizOutboundOrderItem).findBy({ orderId: pickedOrder.id })
    assert.deepEqual(pickedItems.map((item) => [String(item.skuId), item.lineNo, normalizeMoney(item.lineAmount)]),
      [[String(pickedSku.id), 1, '25.00']])
    const pickedReturn = await o2oPreorderService.createReturnRequest(clientAuth, pending.order.id, {
      reason: '取货后继续退回一件', items: [{ productId: variedProduct.id, skuId: pickedSku.id, qty: 1 }],
    })
    await o2oPreorderService.verifyByCode(pickedReturn.verifyCode, adminActor)
    assert.deepEqual(await readSkuStock(pickedSku.id), [8, 0])
    const pickedRevision = await AppDataSource.getRepository(OrderRevision).findOneByOrFail({
      orderUuid: pickedOrder.orderUuid, revisionNo: Number(pickedOrder.editVersion) + 1,
    })
    assert.equal(JSON.parse(pickedRevision.beforeSnapshotJson).totalAmount, '25.00')
    assert.equal(JSON.parse(pickedRevision.afterSnapshotJson).totalAmount, '12.50')
    pass('旧待取货退完一个规格后可继续取货，库存流水、原额及退货修订按剩余规格计算')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    isolation.cleanup()
  }
}

main().catch((error) => {
  console.error(`[o2o-discount-price-verify] 验证失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
