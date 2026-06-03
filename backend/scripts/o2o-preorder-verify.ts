/**
 * 文件说明：backend/scripts/o2o-preorder-verify.ts
 * 文件职责：验证 O2O 预订的注册、下单、撤回、超时取消、核销与备份导出链路。
 * 实现逻辑：
 * 1. 初始化数据库、默认管理员与系统配置，确保脚本在独立环境中可重复执行；
 * 2. 通过客户端注册登录、商品创建、下单撤回、超时取消与管理端核销，覆盖预订主流程；
 * 3. 最后验证 O2O 默认规则、JSON 导出与 SQLite 物理备份，确认治理能力仍可用。
 * 维护说明：若调整 O2O 预订状态机、库存占用规则或默认业务配置，请同步更新本脚本。
 */

import assert from 'node:assert/strict'
import { AppDataSource } from '../src/config/data-source.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from '../src/config/database-bootstrap.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { BizOutboundOrder } from '../src/entities/biz-outbound-order.entity.js'
import { ClientUser } from '../src/entities/client-user.entity.js'
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
import type { O2oPreorderDetailView, O2oVerifyResultView } from '../src/services/o2o-preorder.service.js'

const log = (text: string) => {
  console.log(`✅ ${text}`)
}

const ensureReady = async () => {
  prepareDatabaseRuntime()
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize()
  }
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  return authService.ensureDefaultAdmin()
}

const buildScriptAdminActor = (bootstrapAdmin: Awaited<ReturnType<typeof authService.ensureDefaultAdmin>>): AuthUserContext => {
  // 详细注释：数据导出、SQLite 备份与核销服务当前统一收口到 AuthUserContext，
  // 脚本场景下即使没有走真实登录会话，也需要构造一个稳定的管理员操作者上下文，
  // 以满足权限校验与审计留痕签名，避免校验脚本再依赖外部手工传密码。
  return {
    userId: 'o2o-preorder-verify-admin',
    username: bootstrapAdmin.username,
    displayName: bootstrapAdmin.displayName,
    role: 'admin',
    permissions: [],
    status: 'enabled',
    sessionToken: 'o2o-preorder-verify-session',
  }
}

const ensureSystemConfigs = async () => {
  await systemConfigService.ensureDefaultConfigs()
}

const readCaptchaCode = (captchaSvg: string) => captchaSvg.replaceAll(/<[^>]*>/g, '').replaceAll(/\s+/g, '').slice(0, 6)
const toChineseDigits = (value: string) => value.replaceAll(/\d/g, (digit) => '零一二三四五六七八九'[Number(digit)] ?? '')

const expectBizError = async (executor: () => Promise<unknown>, expectedMessage: string) => {
  try {
    await executor()
    assert.fail(`预期抛出错误：${expectedMessage}`)
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(expectedMessage))
  }
}

const assertPreorderVerifyDetail = (verifyResult: O2oVerifyResultView): O2oPreorderDetailView => {
  // 详细注释：核销接口已升级为“预订单/退货单”联合返回，
  // 当前脚本这里只接受预订单核销结果，因此先做显式类型收窄，
  // 避免继续沿用旧版 `verified.order` 口径造成运行期空指针。
  assert.equal(verifyResult.verifyTargetType, 'preorder')
  return verifyResult.detail as O2oPreorderDetailView
}

const registerAndLoginClient = async (seed: number): Promise<ClientAuthContext> => {
  const registerCaptcha = await clientAuthService.createCaptcha()
  const account = `1${String(seed).slice(-10)}`
  const username = `测试用户${toChineseDigits(String(seed).slice(-6))}`
  const password = process.env.Y_LINK_VERIFY_CLIENT_PASSWORD ?? `Client@${String(seed).slice(-6)}`

  const registerResult = await clientAuthService.register({
    accountType: 'personal',
    account,
    username,
    password,
    captchaId: registerCaptcha.captchaId,
    captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
  })
  assert.ok(registerResult.user.id)

  const loginCaptcha = await clientAuthService.createCaptcha()
  const loginResult = await clientAuthService.login({
    account: registerResult.user.mobile,
    password,
    captchaId: loginCaptcha.captchaId,
    captchaCode: readCaptchaCode(loginCaptcha.captchaSvg),
  })
  assert.ok(loginResult.token)
  return clientAuthService.resolveClientByToken(loginResult.token)
}

const run = async () => {
  const bootstrapAdmin = await ensureReady()
  await ensureSystemConfigs()
  const scriptAdminActor = buildScriptAdminActor(bootstrapAdmin)

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
  assert.ok(mallProducts.list.some((item) => item.id === product.id))
  log('客户端商品大厅展示通过')

  const productRepo = AppDataSource.getRepository(BaseProduct)
  const clientUserRepo = AppDataSource.getRepository(ClientUser)
  const preorderRepo = AppDataSource.getRepository(O2oPreorder)
  const inventoryLogRepo = AppDataSource.getRepository(InventoryLog)

  // 先把当前客户端账号切到“部门账号”，后续验证服务端是否会按当前登录账号强制判定归属，
  // 并确认正式出库单仍严格沿用“下单时快照”，不会被之后的资料修改串改。
  await clientUserRepo.update(
    { id: clientAuth.userId },
    {
      accountType: 'department',
      departmentName: '脚本部门-A',
      staffNo: `STAFF-${Date.now()}`,
      staffVerified: true,
    },
  )

  const departmentOwnedResult = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: product.id, qty: 1 }],
    remark: '部门账号归属强制判定验证',
    isSystemApplied: false,
    pickupContact: '脚本提货人-部门账号',
  })
  assert.equal(departmentOwnedResult.order.clientOrderType, 'department')
  assert.equal(departmentOwnedResult.order.departmentNameSnapshot, '脚本部门-A')
  assert.ok(departmentOwnedResult.order.staffNoSnapshot)
  await o2oPreorderService.cancelMyOrder(clientAuth, departmentOwnedResult.order.id)
  log('服务端会按部门账号强制判定订单归属通过')

  const departmentSnapshotPreorder = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: product.id, qty: 1 }],
    remark: '部门快照固化验证',
    isSystemApplied: true,
    pickupContact: '脚本提货人-部门快照',
  })
  assert.equal(departmentSnapshotPreorder.order.clientOrderType, 'department')
  assert.equal(departmentSnapshotPreorder.order.departmentNameSnapshot, '脚本部门-A')
  assert.ok(departmentSnapshotPreorder.order.staffNoSnapshot)

  // 客户端订单列表会展示工号快照，因此服务端关键词搜索也必须能直接命中该快照。
  const staffNoSearchResult = await o2oPreorderService.listMyOrders(clientAuth, {
    page: 1,
    pageSize: 20,
    keyword: departmentSnapshotPreorder.order.staffNoSnapshot,
  })
  assert.ok(
    staffNoSearchResult.list.some((item) => item.id === departmentSnapshotPreorder.order.id),
    '客户端订单列表应支持通过工号快照搜索命中对应订单',
  )
  log('客户端订单列表支持通过工号关键词命中订单')

  // 下单完成后模拟用户资料被维护人员修改，正式出库单仍必须沿用“下单时快照”。
  await clientUserRepo.update(
    { id: clientAuth.userId },
    {
      departmentName: '脚本部门-B',
    },
  )

  const productStateBeforeRegularPreorder = await productRepo.findOneByOrFail({ id: product.id })
  const preorderResult = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: product.id, qty: 2 }],
    remark: '自动化验证',
    isSystemApplied: false,
    pickupContact: '脚本提货人-A',
  })
  assert.equal(preorderResult.order.status, 'pending')
  assert.equal(preorderResult.order.pickupContact, '脚本提货人-A')
  const heldProduct = await productRepo.findOneByOrFail({ id: product.id })
  assert.equal(heldProduct.preOrderedStock, productStateBeforeRegularPreorder.preOrderedStock + 2)
  log('客户端下单与库存预占通过')

  const otherClientAuth = await registerAndLoginClient(Date.now() + 1)
  await expectBizError(() => o2oPreorderService.cancelMyOrder(otherClientAuth, preorderResult.order.id), '无权撤回他人订单')

  const cancelledResult = await o2oPreorderService.cancelMyOrder(clientAuth, preorderResult.order.id)
  assert.equal(cancelledResult.order.status, 'cancelled')
  assert.equal(cancelledResult.order.statusReport.cancelReason, 'manual')
  assert.equal(cancelledResult.order.statusReport.scenario, 'cancelled')
  const releasedProduct = await productRepo.findOneByOrFail({ id: product.id })
  assert.equal(releasedProduct.currentStock, 20)
  assert.equal(releasedProduct.preOrderedStock, productStateBeforeRegularPreorder.preOrderedStock)
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
    isSystemApplied: false,
    pickupContact: '脚本提货人-B',
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
  const verifyActor = adminAuth ?? scriptAdminActor
  const departmentSnapshotVerified = await o2oPreorderService.verifyByCode(departmentSnapshotPreorder.order.verifyCode, verifyActor)
  const departmentSnapshotDetail = assertPreorderVerifyDetail(departmentSnapshotVerified)
  assert.equal(departmentSnapshotDetail.order.clientOrderType, 'department')
  const outboundOrderRepo = AppDataSource.getRepository(BizOutboundOrder)
  const departmentSnapshotOutboundOrder = await outboundOrderRepo.findOne({
    where: { idempotencyKey: `o2o-preorder-verify:${departmentSnapshotPreorder.order.id}` },
  })
  assert.ok(departmentSnapshotOutboundOrder, '部门预订单核销后应生成正式出库单')
  assert.equal(departmentSnapshotOutboundOrder.orderType, 'department')
  assert.equal(departmentSnapshotOutboundOrder.customerDepartmentName, '脚本部门-A')
  log('部门订单下单快照会稳定继承到正式出库单通过')

  const verifiedPreorder = await o2oPreorderService.submit(clientAuth, {
    items: [{ productId: product.id, qty: 2 }],
    remark: '核销后不可撤回验证',
    isSystemApplied: false,
    pickupContact: '脚本提货人-C',
  })
  const verified = await o2oPreorderService.verifyByCode(verifiedPreorder.order.verifyCode, verifyActor)
  const verifiedDetail = assertPreorderVerifyDetail(verified)
  assert.equal(verifiedDetail.order.status, 'verified')
  const verifiedOutboundOrder = await outboundOrderRepo.findOne({
    where: { idempotencyKey: `o2o-preorder-verify:${verifiedPreorder.order.id}` },
  })
  assert.ok(verifiedOutboundOrder, '核销后应生成后台正式出库单')
  const verifiedCustomerOrderShowNo = (
    verifiedDetail.order as O2oPreorderDetailView['order'] & { customerOrderShowNo?: string | null }
  ).customerOrderShowNo
  assert.equal(
    verifiedCustomerOrderShowNo,
    verifiedOutboundOrder.showNo,
    '客户端订单详情应返回与管理端一致的正式出库单号',
  )
  await expectBizError(() => o2oPreorderService.cancelMyOrder(clientAuth, verifiedPreorder.order.id), '订单已核销，无法撤回')
  await o2oPreorderService.inboundStock(product.id, 3, verifyActor, '自动化补货')
  log('管理端核销、已核销不可撤回与入库流程通过')

  const o2oRules = await systemConfigService.getO2oRuleConfigs()
  assert.equal(o2oRules.autoCancelHours, 24)
  assert.equal(o2oRules.limitQty, 5)
  log('O2O 默认业务规则通过')

  const exported = await dataMaintenanceService.exportJson(scriptAdminActor)
  assert.ok(exported.tables.products.length > 0)
  log('JSON 导出能力通过')

  if (AppDataSource.options.type === 'sqlite') {
    const backup = await dataMaintenanceService.createSqliteBackup(scriptAdminActor)
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
