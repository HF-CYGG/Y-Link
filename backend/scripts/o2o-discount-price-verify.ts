/**
 * 文件说明：backend/scripts/o2o-discount-price-verify.ts
 * 文件职责：验证 O2O 商品折扣、折后价结算、订单明细价格快照与核销出库金额的一致性。
 * 实现逻辑：
 * 1. 创建带折扣的线上商品，确认商品接口返回原价、几折与折后价；
 * 2. 客户端下单后，确认预订单明细固化下单时原价、折扣、折后单价和小计；
 * 3. 修改商品当前折扣后复查历史订单，确认订单金额不会被商品现价串改；
 * 4. 核销预订单后，确认正式出库单沿用订单明细快照金额。
 * 维护说明：若后续改动折扣取整规则或订单金额字段命名，需要同步更新本脚本的断言。
 */

import assert from 'node:assert/strict'
import { AppDataSource } from '../src/config/data-source.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from '../src/config/database-bootstrap.js'
import { BizOutboundOrder } from '../src/entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../src/entities/biz-outbound-order-item.entity.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import { o2oPreorderService } from '../src/services/o2o-preorder.service.js'
import { productService } from '../src/services/product.service.js'
import { systemConfigService } from '../src/services/system-config.service.js'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'
import type { O2oPreorderDetailView, O2oVerifyResultView } from '../src/services/o2o-preorder.service.js'

const adminActor: AuthUserContext = {
  userId: 'o2o-discount-price-verify-admin',
  username: 'o2o-discount-price-verify-admin',
  displayName: 'O2O折扣验证管理员',
  role: 'admin',
  permissions: [],
  status: 'enabled',
  sessionToken: 'o2o-discount-price-verify-session',
}

const pass = (title: string) => {
  console.log(`✅ ${title}`)
}

const readCaptchaCode = (captchaSvg: string) => captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)

const toMoneyText = (value: string | number | null | undefined) => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

async function ensureReady() {
  prepareDatabaseRuntime()
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
  }
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
}

async function registerAndLoginClient(seed: number): Promise<ClientAuthContext> {
  const registerCaptcha = await clientAuthService.createCaptcha()
  const account = `1${String(seed).slice(-10)}`
  const username = `discount_client_${String(seed).slice(-6)}`
  const password = `Client@${String(seed).slice(-6)}`

  const registerResult = await clientAuthService.register({
    account,
    username,
    password,
    captchaId: registerCaptcha.captchaId,
    captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
  })

  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginResult = await clientAuthService.login({
    account: registerResult.mobile,
    password,
    captchaId: loginCaptcha.captchaId,
    captchaCode: readCaptchaCode(loginCaptcha.captchaSvg),
  })

  return clientAuthService.resolveClientByToken(loginResult.token)
}

function assertPreorderVerifyDetail(verifyResult: O2oVerifyResultView): O2oPreorderDetailView {
  assert.equal(verifyResult.verifyTargetType, 'preorder')
  return verifyResult.detail as O2oPreorderDetailView
}

async function main() {
  await ensureReady()
  const clientAuth = await registerAndLoginClient(Date.now())

  const product = await productService.create({
    productName: `折扣验证商品-${Date.now()}`,
    pinyinAbbr: 'ZKYZ',
    defaultPrice: 19.99,
    discountRate: 8.5,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 30,
    limitPerUser: 10,
  } as Parameters<typeof productService.create>[0] & { discountRate: number })

  assert.equal((product as unknown as { discountRate?: string }).discountRate, '8.50')
  assert.equal((product as unknown as { discountedPrice?: string }).discountedPrice, '16.99')
  pass('商品接口返回原价、几折和折后价')

  const mallProducts = await o2oPreorderService.listMallProducts()
  const mallProduct = mallProducts.find((item) => item.id === product.id) as
    | (typeof mallProducts[number] & { discountRate?: string; discountedPrice?: string })
    | undefined
  assert.ok(mallProduct)
  assert.equal(mallProduct.defaultPrice, '19.99')
  assert.equal(mallProduct.discountRate, '8.50')
  assert.equal(mallProduct.discountedPrice, '16.99')
  pass('商城商品列表返回折扣价格信息')

  const preorder = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: product.id, qty: 3 }],
    remark: '折扣价格验证',
    clientOrderType: 'walkin',
    isSystemApplied: false,
    pickupContact: '折扣验证提货人',
  })

  const preorderItem = preorder.items[0] as typeof preorder.items[number] & {
    originalPrice?: string
    discountRate?: string
    unitPrice?: string
    lineAmount?: string
  }
  assert.equal(preorder.order.totalAmount, '50.97')
  assert.equal(preorderItem.originalPrice, '19.99')
  assert.equal(preorderItem.discountRate, '8.50')
  assert.equal(preorderItem.unitPrice, '16.99')
  assert.equal(preorderItem.lineAmount, '50.97')
  assert.equal(preorderItem.subTotal, '50.97')
  pass('下单后订单明细固化折扣价格快照')

  await productService.update(product.id, {
    discountRate: 5,
  } as Parameters<typeof productService.update>[1] & { discountRate: number })
  const snapshotDetail = await o2oPreorderService.detailById(preorder.order.id)
  const snapshotItem = snapshotDetail.items[0] as typeof snapshotDetail.items[number] & {
    discountRate?: string
    unitPrice?: string
    lineAmount?: string
  }
  assert.equal(snapshotDetail.order.totalAmount, '50.97')
  assert.equal(snapshotItem.discountRate, '8.50')
  assert.equal(snapshotItem.unitPrice, '16.99')
  assert.equal(snapshotItem.lineAmount, '50.97')
  pass('商品折扣后续变化不会串改历史订单金额')

  const verifyResult = await o2oPreorderService.verifyByCode(preorder.order.verifyCode, adminActor)
  const verifiedDetail = assertPreorderVerifyDetail(verifyResult)
  assert.equal(verifiedDetail.order.status, 'verified')

  const outboundOrder = await AppDataSource.getRepository(BizOutboundOrder).findOneByOrFail({
    idempotencyKey: `o2o-preorder-verify:${preorder.order.id}`,
  })
  const outboundItems = await AppDataSource.getRepository(BizOutboundOrderItem).find({
    where: { orderId: outboundOrder.id },
  })
  assert.equal(toMoneyText(outboundOrder.totalAmount), '50.97')
  assert.equal(toMoneyText(outboundItems[0]?.unitPrice), '16.99')
  assert.equal(toMoneyText(outboundItems[0]?.lineAmount), '50.97')
  pass('核销生成的正式出库单沿用订单折扣价快照')
}

try {
  await main()
  console.log('\nO2O 折扣价格验证通过。')
} catch (error) {
  console.error('\nO2O 折扣价格验证失败：')
  console.error(error)
  process.exit(1)
} finally {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy()
  }
}
