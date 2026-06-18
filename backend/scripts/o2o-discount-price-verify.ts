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
 * - 该脚本只校验折扣结算与公开配置，不覆盖库存、退货和权限全量回归。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `o2o-discount-price-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `o2o-discount-price-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
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

function readCaptchaCode(captchaSvg: string) {
  return captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
}

async function registerAndLoginClient(clientAuthService: typeof import('../src/services/client-auth.service.js').clientAuthService): Promise<ClientAuthContext> {
  const seed = String(Date.now()).slice(-10)
  const password = `Client@${seed.slice(-6)}`
  const registerCaptcha = await clientAuthService.createCaptcha()
  const registerResult = await clientAuthService.register({
    accountType: 'personal',
    account: `1${seed}`,
    username: '折扣验证员',
    password,
    captchaId: registerCaptcha.captchaId,
    captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
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

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(
      `[o2o-discount-price-verify] 临时 SQLite 文件删除失败，已忽略：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
  const { BizOutboundOrderItem } = await import('../src/entities/biz-outbound-order-item.entity.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

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
    })
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
      items: [{ productId: product.id, qty: 1 }],
    })
    await o2oPreorderService.verifyByCode(returnRequest.verifyCode, adminActor)
    const mallConfigAfterVerifiedReturn = await o2oPreorderService.listMallProducts()
    const returnedSoldProduct = mallConfigAfterVerifiedReturn.list.find((item) => item.id === product.id)
    assert.equal(returnedSoldProduct?.soldQty, 1)
    pass('已核销退货按商品扣减商城已售数量')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(`[o2o-discount-price-verify] 验证失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
