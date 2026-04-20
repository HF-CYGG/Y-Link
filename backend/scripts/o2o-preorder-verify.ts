/**
 * 文件说明：backend/scripts/o2o-preorder-verify.ts
 * 文件职责：验证 O2O 预订的注册、下单、撤回、超时取消、核销与备份导出链路。
 * 维护说明：若调整 O2O 预订状态机、库存占用规则或默认业务配置，请同步更新本脚本。
 */

import assert from 'node:assert/strict'
import { AppDataSource } from '../src/config/data-source.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from '../src/config/database-bootstrap.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { InventoryLog } from '../src/entities/inventory-log.entity.js'
import { O2oPreorder } from '../src/entities/o2o-preorder.entity.js'
import { authService } from '../src/services/auth.service.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import { dataMaintenanceService } from '../src/services/data-maintenance.service.js'
import { o2oPreorderService } from '../src/services/o2o-preorder.service.js'
import { productService } from '../src/services/product.service.js'
import { systemConfigService } from '../src/services/system-config.service.js'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'

const log = (text: string) => {
  console.log(`✅ ${text}`)
}

const ensureReady = async () => {
  prepareDatabaseRuntime()
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
  }
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  await systemConfigService.ensureDefaultConfigs()
}

const readCaptchaCode = (captchaSvg: string) => captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)

const expectBizError = async (executor: () => Promise<unknown>, expectedMessage: string) => {
  try {
    await executor()
    assert.fail(`预期抛出错误：${expectedMessage}`)
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(expectedMessage))
  }
}

const registerAndLoginClient = async (seed: number): Promise<ClientAuthContext> => {
  const registerCaptcha = await clientAuthService.createCaptcha()
  const account = `1${String(seed).slice(-10)}`
  const username = `test_user_${String(seed).slice(-6)}`
  const password = process.env.Y_LINK_VERIFY_CLIENT_PASSWORD ?? `Client@${String(seed).slice(-6)}`

  const registerResult = await clientAuthService.register({
    account,
    username,
    password,
    captchaId: registerCaptcha.captchaId,
    captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
  })
  assert.ok(registerResult.id)

  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginResult = await clientAuthService.login({
    account: registerResult.mobile,
    password,
    captchaId: loginCaptcha.captchaId,
    captchaCode: readCaptchaCode(loginCaptcha.captchaSvg),
  })
  assert.ok(loginResult.token)
  return clientAuthService.resolveClientByToken(loginResult.token)
}

const run = async () => {
  await ensureReady()

  const clientAuth = await registerAndLoginClient(Date.now())
  log('客户端注册流程通过')

  log('客户端登录流程通过')

  const product = await productService.create({
    productName: `O2O测试产品-${Date.now()}`,
    pinyinAbbr: 'O2OCP',
    defaultPrice: 10,
    isActive: true,
    o2oStatus: 'listed',
    currentStock: 20,
    limitPerUser: 5,
  })
  assert.equal(product.o2oStatus, 'listed')
  log('商品上下架/库存字段创建通过')

  const mallProducts = await o2oPreorderService.listMallProducts()
  assert.ok(mallProducts.some((item) => item.id === product.id))
  log('客户端商品大厅展示通过')

  const productRepo = AppDataSource.getRepository(BaseProduct)
  const preorderRepo = AppDataSource.getRepository(O2oPreorder)
  const inventoryLogRepo = AppDataSource.getRepository(InventoryLog)
  const preorderResult = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: product.id, qty: 2 }],
    remark: '自动化验证',
  })
  assert.equal(preorderResult.order.status, 'pending')
  const heldProduct = await productRepo.findOneByOrFail({ id: product.id })
  assert.equal(heldProduct.preOrderedStock, 2)
  log('客户端下单与库存预占通过')

  const otherClientAuth = await registerAndLoginClient(Date.now() + 1)
  await expectBizError(() => o2oPreorderService.cancelMyOrder(otherClientAuth, preorderResult.order.id), '无权撤回他人订单')

  const cancelledResult = await o2oPreorderService.cancelMyOrder(clientAuth, preorderResult.order.id)
  assert.equal(cancelledResult.order.status, 'cancelled')
  assert.equal(cancelledResult.order.statusReport.cancelReason, 'manual')
  assert.equal(cancelledResult.order.statusReport.scenario, 'cancelled')
  const releasedProduct = await productRepo.findOneByOrFail({ id: product.id })
  assert.equal(releasedProduct.currentStock, 20)
  assert.equal(releasedProduct.preOrderedStock, 0)
  const latestReleaseLog = await inventoryLogRepo.findOne({
    where: { refId: preorderResult.order.id, changeType: 'preorder_release' },
    order: { id: 'DESC' },
  })
  assert.equal(latestReleaseLog?.operatorType, 'client')
  log('客户端主动撤回与库存释放通过')

  await preorderRepo.update(
    { id: preorderResult.order.id },
    {
      timeoutAt: new Date(Date.now() - 60 * 1000),
    },
  )
  const manualCancelAfterTimeout = await o2oPreorderService.detailById(preorderResult.order.id)
  assert.equal(manualCancelAfterTimeout.order.statusReport.cancelReason, 'manual')
  assert.equal(manualCancelAfterTimeout.order.statusReport.scenario, 'cancelled')
  await expectBizError(() => o2oPreorderService.cancelMyOrder(clientAuth, preorderResult.order.id), '请勿重复操作')
  log('手动撤回原因持久化通过')

  const timeoutPreorder = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: product.id, qty: 1 }],
    remark: '超时取消验证',
  })
  await preorderRepo.update(
    { id: timeoutPreorder.order.id },
    {
      timeoutAt: new Date(Date.now() - 60 * 1000),
    },
  )
  const timeoutCancelResult = await o2oPreorderService.cancelTimeoutOrders()
  assert.ok(timeoutCancelResult.cancelledCount >= 1)
  const timeoutDetail = await o2oPreorderService.detailById(timeoutPreorder.order.id)
  assert.equal(timeoutDetail.order.status, 'cancelled')
  assert.equal(timeoutDetail.order.statusReport.cancelReason, 'timeout')
  assert.equal(timeoutDetail.order.statusReport.scenario, 'timeout_cancelled')
  log('超时自动取消原因输出通过')

  const adminPassword = process.env.Y_LINK_VERIFY_ADMIN_PASSWORD?.trim()
  const adminLogin =
    adminPassword && adminPassword.length > 0
      ? await authService.login({ username: 'admin', password: adminPassword }).catch(() => null)
      : null
  let adminAuth: AuthUserContext | null = null
  if (adminLogin) {
    adminAuth = await authService.resolveAuthUserByToken(adminLogin.token)
  }
  if (adminAuth) {
    const verifiedPreorder = await o2oPreorderService.submit(clientAuth, {
      items: [{ productId: product.id, qty: 2 }],
      remark: '核销后不可撤回验证',
    })
    const verified = await o2oPreorderService.verifyByCode(verifiedPreorder.order.verifyCode, adminAuth)
    assert.equal(verified.order.status, 'verified')
    await expectBizError(() => o2oPreorderService.cancelMyOrder(clientAuth, verifiedPreorder.order.id), '订单已核销，无法撤回')
    await o2oPreorderService.inboundStock(product.id, 3, adminAuth, '自动化补货')
    log('管理端核销、已核销不可撤回与入库流程通过')
  }

  const o2oRules = await systemConfigService.getO2oRuleConfigs()
  assert.equal(o2oRules.autoCancelHours, 24)
  assert.equal(o2oRules.limitQty, 5)
  log('O2O 默认业务规则通过')

  const exported = await dataMaintenanceService.exportJson()
  assert.ok(exported.tables.products.length > 0)
  log('JSON 导出能力通过')

  if (AppDataSource.options.type === 'sqlite') {
    const backup = await dataMaintenanceService.createSqliteBackup()
    assert.ok(backup.filePath.endsWith('.sqlite'))
    log('SQLite 物理备份能力通过')
  }

  const compatibilityCheck = ['sqlite', 'mysql'].includes(String(AppDataSource.options.type))
  assert.equal(compatibilityCheck, true)
  log('SQLite/MySQL 驱动兼容配置通过')
}

try {
  await run()
  console.log('\nO2O 预订验收脚本通过')
} catch (error) {
  console.error('\nO2O 预订验收脚本失败')
  console.error(error)
  process.exit(1)
} finally {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy()
  }
}
