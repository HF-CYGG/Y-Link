/**
 * 文件说明：backend/scripts/task123-o2o-enhance-verify.ts
 * 文件职责：验证 O2O 商家已完结状态、退货拒绝以及门店现场改单三项后端能力。
 * 实现逻辑：
 * - 通过“建商品 -> 下单/核销 -> 申请退货/拒绝 -> 现场改单 -> 再核销”的顺序覆盖核心事务链路；
 * - 重点断言商家特殊状态不覆盖主状态、拒绝退货必须留痕、现场改单会同步调整预订库存与后续核销依据；
 * - 脚本优先跑 SQLite 本地库，便于开发态快速回归。
 * 维护说明：若后续继续扩展 O2O 退货结果或现场改单规则，请同步更新本脚本断言与提示文案。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppDataSource } from '../src/config/data-source.js'
import { env } from '../src/config/env.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime, resolveSqliteDatabasePath } from '../src/config/database-bootstrap.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { InventoryLog } from '../src/entities/inventory-log.entity.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import { o2oPreorderService } from '../src/services/o2o-preorder.service.js'
import { productService } from '../src/services/product.service.js'
import { systemConfigService } from '../src/services/system-config.service.js'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')

const adminActor: AuthUserContext = {
  userId: '900123',
  username: 'task123-verify-admin',
  displayName: 'Task123验证管理员',
  role: 'admin',
  permissions: [],
  status: 'enabled',
  sessionToken: 'task123-verify-session',
}

function pass(title: string) {
  console.log(`✅ ${title}`)
}

function resetVerifyDatabase() {
  if (env.DB_TYPE !== 'sqlite') {
    return
  }
  const sqlitePath = path.isAbsolute(env.SQLITE_DB_PATH)
    ? resolveSqliteDatabasePath()
    : path.resolve(backendRoot, env.SQLITE_DB_PATH)
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })
  if (fs.existsSync(sqlitePath)) {
    fs.rmSync(sqlitePath, { force: true })
  }
}

const readCaptchaCode = (captchaSvg: string) => captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)

async function expectBizError(executor: () => Promise<unknown>, expectedMessage: string) {
  try {
    await executor()
    assert.fail(`预期抛出错误：${expectedMessage}`)
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(expectedMessage))
  }
}

async function registerAndLoginClient(seed: number): Promise<ClientAuthContext> {
  const registerCaptcha = await clientAuthService.createCaptcha()
  const account = `1${String(seed).slice(-10)}`
  const username = `task123_client_${String(seed).slice(-6)}`
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

async function ensureReady() {
  resetVerifyDatabase()
  prepareDatabaseRuntime()
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
  }
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
}

async function main() {
  await ensureReady()

  const productRepo = AppDataSource.getRepository(BaseProduct)
  const inventoryLogRepo = AppDataSource.getRepository(InventoryLog)
  const clientAuth = await registerAndLoginClient(Date.now())

  const adjustBaseProduct = await productService.create({
    productName: `现场改单原商品-${Date.now()}`,
    pinyinAbbr: 'XGYP',
    defaultPrice: 12,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 20,
    limitPerUser: 10,
  })
  const adjustExtraProduct = await productService.create({
    productName: `现场改单新增商品-${Date.now()}`,
    pinyinAbbr: 'XGXZ',
    defaultPrice: 18,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 20,
    limitPerUser: 10,
  })
  const returnProduct = await productService.create({
    productName: `退货拒绝商品-${Date.now()}`,
    pinyinAbbr: 'THJJ',
    defaultPrice: 25,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 20,
    limitPerUser: 10,
  })
  pass('验证商品准备完成')

  const onsiteOrder = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: adjustBaseProduct.id, qty: 2 }],
    remark: '待现场改单',
  })
  const onsiteAdjusted = await o2oPreorderService.updateOrderOnsite(adminActor, {
    orderId: onsiteOrder.order.id,
    items: [
      { productId: adjustBaseProduct.id, qty: 1 },
      { productId: adjustExtraProduct.id, qty: 3 },
    ],
    remark: '门店按实际领取调整',
  })
  assert.equal(onsiteAdjusted.order.status, 'pending')
  assert.equal(onsiteAdjusted.order.totalQty, 4)
  assert.equal(onsiteAdjusted.order.updateCount, 0)
  assert.equal(onsiteAdjusted.order.remark, '门店按实际领取调整')
  assert.deepEqual(
    onsiteAdjusted.items.map((item) => ({ productId: item.productId, qty: item.qty })),
    [
      { productId: String(adjustBaseProduct.id), qty: 1 },
      { productId: String(adjustExtraProduct.id), qty: 3 },
    ],
  )
  const adjustedBaseProduct = await productRepo.findOneByOrFail({ id: adjustBaseProduct.id })
  const adjustedExtraProduct = await productRepo.findOneByOrFail({ id: adjustExtraProduct.id })
  assert.equal(adjustedBaseProduct.preOrderedStock, 1)
  assert.equal(adjustedExtraProduct.preOrderedStock, 3)
  const onsiteAdjustLogs = await inventoryLogRepo.find({
    where: { refId: onsiteOrder.order.id, operatorType: 'admin' },
    order: { id: 'ASC' },
  })
  assert.equal(onsiteAdjustLogs.length >= 2, true)
  pass('门店现场改单会回写订单明细、备注与预订库存')

  const onsiteVerified = await o2oPreorderService.verifyByCode(onsiteAdjusted.order.verifyCode, adminActor)
  assert.equal(onsiteVerified.verifyTargetType, 'preorder')
  assert.equal(onsiteVerified.detail.order.status, 'verified')
  const verifiedBaseProduct = await productRepo.findOneByOrFail({ id: adjustBaseProduct.id })
  const verifiedExtraProduct = await productRepo.findOneByOrFail({ id: adjustExtraProduct.id })
  assert.equal(verifiedBaseProduct.currentStock, 19)
  assert.equal(verifiedBaseProduct.preOrderedStock, 0)
  assert.equal(verifiedExtraProduct.currentStock, 17)
  assert.equal(verifiedExtraProduct.preOrderedStock, 0)
  await expectBizError(
    () =>
      o2oPreorderService.updateOrderOnsite(adminActor, {
        orderId: onsiteOrder.order.id,
        items: [{ productId: adjustBaseProduct.id, qty: 1 }],
      }),
    '订单已核销，无法现场改单',
  )
  pass('现场改单后的核销会以修改后明细为准，且非待核销订单不可再改单')

  const returnOrder = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: returnProduct.id, qty: 2 }],
    remark: '待退货拒绝验证',
  })
  const verifiedReturnOrder = await o2oPreorderService.verifyByCode(returnOrder.order.verifyCode, adminActor)
  assert.equal(verifiedReturnOrder.verifyTargetType, 'preorder')
  assert.equal(verifiedReturnOrder.detail.order.status, 'verified')
  const returnRequest = await o2oPreorderService.createReturnRequest(clientAuth, verifiedReturnOrder.detail.order.id, {
    reason: '尺码不符',
    items: [{ productId: returnProduct.id, qty: 1 }],
  })
  await expectBizError(
    () =>
      o2oPreorderService.rejectReturnRequest(
        {
          returnRequestId: returnRequest.id,
          rejectReason: '   ',
        },
        adminActor,
      ),
    '请填写拒绝原因',
  )
  const rejectedReturnRequest = await o2oPreorderService.rejectReturnRequest(
    {
      returnRequestId: returnRequest.id,
      rejectReason: '商品已拆封，当前不满足退货条件',
    },
    adminActor,
  )
  assert.equal(rejectedReturnRequest.status, 'rejected')
  assert.equal(rejectedReturnRequest.rejectedReason, '商品已拆封，当前不满足退货条件')
  assert.equal(rejectedReturnRequest.handledBy, adminActor.displayName)
  assert.ok(rejectedReturnRequest.handledAt)
  assert.equal(rejectedReturnRequest.verifiedAt, null)
  const rejectedVerifyDetail = await o2oPreorderService.getVerifyDetail(rejectedReturnRequest.verifyCode)
  assert.equal(rejectedVerifyDetail.verifyTargetType, 'return_request')
  assert.equal(rejectedVerifyDetail.detail.status, 'rejected')
  await expectBizError(
    () => o2oPreorderService.verifyByCode(rejectedReturnRequest.verifyCode, adminActor),
    '退货申请已拒绝，不可继续回库核销',
  )
  pass('退货拒绝会强制校验原因、保留处理轨迹，并阻止后续回库核销')

  const completedOrder = await o2oPreorderService.updateBusinessStatus({
    orderId: verifiedReturnOrder.detail.order.id,
    businessStatus: 'completed',
  })
  assert.equal(completedOrder.order.businessStatus, 'completed')
  assert.equal(completedOrder.order.status, 'verified')
  pass('商家已完结状态可独立设置，且不会覆盖订单主状态')
}

try {
  await main()
  console.log('\nTask1-Task3 O2O 后端增强验证通过。')
} catch (error) {
  console.error('\nTask1-Task3 O2O 后端增强验证失败：')
  console.error(error)
  process.exit(1)
} finally {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy()
  }
}
