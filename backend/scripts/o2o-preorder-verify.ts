/**
 * 文件说明：backend/scripts/o2o-preorder-verify.ts
 * 文件职责：验证 O2O 预订的注册、下单、撤回、超时取消、核销与备份导出链路。
 * 实现逻辑：
 * 1. 初始化数据库、默认管理员与系统配置，确保写事务使用可复核的真实账号；
 * 2. 通过客户端注册登录、商品创建、下单撤回、超时取消与管理端核销，覆盖预订主流程；
 * 3. 最后验证 O2O 默认规则、JSON 导出与 SQLite 物理备份，确认治理能力仍可用。
 * 维护说明：若调整 O2O 预订状态机、库存占用规则或默认业务配置，请同步更新本脚本。
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { AppDataSource } from '../src/config/data-source.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from '../src/config/database-bootstrap.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { IsNull, Not } from 'typeorm'
import { BizOutboundOrder } from '../src/entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../src/entities/biz-outbound-order-item.entity.js'
import { ClientUser } from '../src/entities/client-user.entity.js'
import { InventoryLog } from '../src/entities/inventory-log.entity.js'
import { O2oPreorder } from '../src/entities/o2o-preorder.entity.js'
import { O2oReturnRequest } from '../src/entities/o2o-return-request.entity.js'
import { OrderRevision } from '../src/entities/order-revision.entity.js'
import { SysAuditLog } from '../src/entities/sys-audit-log.entity.js'
import { SysUser } from '../src/entities/sys-user.entity.js'
import { authService } from '../src/services/auth.service.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import { installCaptchaServiceForTesting } from '../src/services/captcha.service.js'
import { dataMaintenanceService } from '../src/services/data-maintenance.service.js'
import { o2oPreorderService } from '../src/services/o2o-preorder.service.js'
import { orderBusinessNoService } from '../src/services/order-business-no.service.js'
import { auditService } from '../src/services/audit.service.js'
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
  const userRepo = AppDataSource.getRepository(SysUser)
  const userCountBefore = await userRepo.count()
  const bootstrapAdmin = await authService.ensureDefaultAdmin()
  const persistedAdmin = await userRepo.findOneByOrFail({ username: bootstrapAdmin.username })
  assert.equal(persistedAdmin.status, 'enabled', 'O2O 专项必须使用当前启用的默认管理员')
  assert.equal(
    await userRepo.count(),
    userCountBefore + Number(bootstrapAdmin.initialized),
    'O2O 专项不得在默认管理员之外额外持久化 SysUser',
  )
  return persistedAdmin
}

const buildScriptAdminActor = (bootstrapAdmin: SysUser): AuthUserContext => {
  // 详细注释：数据导出、SQLite 备份与核销服务当前统一收口到 AuthUserContext，
  // 脚本场景下即使没有走真实登录会话，也必须从已持久化且启用的 SysUser 构造操作者上下文，
  // 以覆盖事务内账号复核与审计留痕，不能使用仅存在于内存的伪造 ID。
  return {
    userId: bootstrapAdmin.id,
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

const configureVerificationProviderForTesting = async (actor: AuthUserContext) => {
  await systemConfigService.updateVerificationProviderConfigs(
    {
      mobile: {
        enabled: true,
        httpMethod: 'POST',
        apiUrl: 'https://verification.example.com/mobile',
        headersTemplate: '{}',
        bodyTemplate: '{"target":"{{target}}","code":"{{code}}"}',
        successMatch: 'ok',
      },
      email: {
        enabled: false,
        httpMethod: 'POST',
        apiUrl: '',
        headersTemplate: '{}',
        bodyTemplate: '',
        successMatch: '',
      },
    },
    actor,
  )
}

const TEST_CAPTCHA_CODE = 'ABC123'
installCaptchaServiceForTesting({ createCode: () => TEST_CAPTCHA_CODE })
const readCaptchaCode = (_captchaSvg: string) => TEST_CAPTCHA_CODE
const toChineseDigits = (value: string) => value.replaceAll(/\d/g, (digit) => '零一二三四五六七八九'[Number(digit)] ?? '')

type CapturedVerification = {
  channel: 'mobile' | 'email'
  target: string
  code: string
}

const createVerificationRequestStub = (captured: CapturedVerification[]) => {
  return async (_input: string | URL, init?: { body?: string | Buffer }) => {
    const bodyText = String(init?.body ?? '{}')
    const payload = JSON.parse(bodyText) as Partial<CapturedVerification>
    assert.equal(typeof payload.code, 'string', '验证码平台请求体应包含 code')
    assert.equal(typeof payload.target, 'string', '验证码平台请求体应包含 target')
    captured.push({
      channel: String(payload.target).includes('@') ? 'email' : 'mobile',
      target: String(payload.target),
      code: String(payload.code),
    })
    return {
      statusCode: 200,
      headers: {},
      body: Buffer.from('ok'),
    }
  }
}

const expectBizError = async (executor: () => Promise<unknown>, expectedMessage: string) => {
  try {
    await executor()
    assert.fail(`预期抛出错误：${expectedMessage}`)
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes(expectedMessage))
  }
}

// Issue #96：部门单必须携带到店取货时间。脚本统一使用同一个固定时间提交，
// 保证同一 clientRequestId 的幂等重试载荷完全一致，不会被服务端判为“同键不同参数”。
const SCRIPT_PICKUP_AT = new Date(Date.now() + 30 * 60 * 1000).toISOString()
const submitPreorderWithPickup = (
  auth: ClientAuthContext,
  input: Parameters<typeof o2oPreorderService.submit>[1],
) => o2oPreorderService.submit(auth, { pickupAt: SCRIPT_PICKUP_AT, ...input })

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
  await clientAuthService.verifyCaptchaBeforeVerificationSend({
    channel: 'mobile',
    target: account,
    scene: 'register',
    captchaId: registerCaptcha.captchaId,
    captchaCode: readCaptchaCode(registerCaptcha.captchaSvg),
  })
  const capturedVerifications: CapturedVerification[] = []
  const { VerificationCodeService } = await import('../src/services/verification-code.service.js')
  const verificationCodeService = new VerificationCodeService(createVerificationRequestStub(capturedVerifications))
  await verificationCodeService.sendCode({
    channel: 'mobile',
    target: account,
    scene: 'register',
  })
  const verificationCode = [...capturedVerifications].reverse().find((item) => item.target === account)?.code
  assert.ok(verificationCode, '应捕获个人注册短信验证码')

  const registerResult = await clientAuthService.register({
    accountType: 'personal',
    account,
    username,
    password,
    verificationCode,
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
  await configureVerificationProviderForTesting(scriptAdminActor)

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
    // 本脚本会构造多条相互独立的撤销、竞态和依赖订单，限购值仅用于避免测试夹具互相干扰。
    limitPerUser: 30,
  }, scriptAdminActor)
  assert.equal(product.o2oStatus, 'listed')
  log('商品上下架/库存字段创建通过')

  const mallProducts = await o2oPreorderService.listMallProducts()
  assert.ok(mallProducts.list.some((item) => item.id === product.id))
  log('客户端商品大厅展示通过')

  const productRepo = AppDataSource.getRepository(BaseProduct)
  const clientUserRepo = AppDataSource.getRepository(ClientUser)
  const preorderRepo = AppDataSource.getRepository(O2oPreorder)
  const inventoryLogRepo = AppDataSource.getRepository(InventoryLog)
  const auditLogRepo = AppDataSource.getRepository(SysAuditLog)
  const outboundOrderRepo = AppDataSource.getRepository(BizOutboundOrder)
  const expectedDepartmentPickupContact = clientAuth.realName
  const requestMeta = { ipAddress: '127.0.0.1', userAgent: 'o2o-preorder-verify', clientRiskBrowserId: null, clientRiskSessionId: null }

  const assertTimedOutOperationCommits = async (input: {
    requestId: string
    remark: string
    expectedError: string
    invoke: (order: O2oPreorderDetailView['order']) => Promise<unknown>
  }) => {
    const productBeforeSubmit = await productRepo.findOneByOrFail({ id: product.id })
    const preorder = await submitPreorderWithPickup(clientAuth, {
      clientRequestId: input.requestId,
      items: [{ productId: product.id, qty: 1 }],
      remark: input.remark,
      isSystemApplied: false,
      pickupContact: `脚本提货人-${input.remark}`,
    })
    const productWhileHeld = await productRepo.findOneByOrFail({ id: product.id })
    assert.equal(productWhileHeld.preOrderedStock, productBeforeSubmit.preOrderedStock + 1)
    await preorderRepo.update({ id: preorder.order.id }, { timeoutAt: new Date(Date.now() - 60 * 1000) })
    await expectBizError(() => input.invoke(preorder.order), input.expectedError)

    const persistedOrder = await preorderRepo.findOneByOrFail({ id: preorder.order.id })
    const productAfterReject = await productRepo.findOneByOrFail({ id: product.id })
    assert.equal(persistedOrder.status, 'cancelled')
    assert.equal(persistedOrder.cancelReason, 'timeout')
    assert.equal(persistedOrder.cancellationSource, 'system')
    assert.equal(productAfterReject.currentStock, productBeforeSubmit.currentStock)
    assert.equal(productAfterReject.preOrderedStock, productBeforeSubmit.preOrderedStock)
    assert.equal(await inventoryLogRepo.count({
      where: { refId: preorder.order.id, changeType: 'preorder_release' },
    }), 1)
    assert.equal(await auditLogRepo.count({
      where: { actionType: 'o2o.preorder.cancel_by_system', targetId: preorder.order.id },
    }), 1)
    return preorder
  }

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

  // Issue #96：部门单到店取货时间必填，且必须落在“当前时间 ~ 自动取消时间”窗口内。
  const pickupRules = await systemConfigService.getO2oRuleConfigs()
  const productBeforePickupRejects = await productRepo.findOneByOrFail({ id: product.id })
  await expectBizError(() => o2oPreorderService.submit(clientAuth, {
    clientRequestId: 'o2o-verify-pickup-missing-01',
    items: [{ productId: product.id, qty: 1 }],
    isSystemApplied: false,
    pickupContact: '脚本提货人-缺少取货时间',
  }), '请选择到店取货时间')
  await expectBizError(() => o2oPreorderService.submit(clientAuth, {
    clientRequestId: 'o2o-verify-pickup-past-01',
    items: [{ productId: product.id, qty: 1 }],
    isSystemApplied: false,
    pickupContact: '脚本提货人-过去取货时间',
    pickupAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  }), '到店取货时间不能早于当前时间')
  const beyondWindowPickupAt = pickupRules.autoCancelEnabled
    ? new Date(Date.now() + (pickupRules.autoCancelHours + 1) * 60 * 60 * 1000)
    : new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)
  await expectBizError(() => o2oPreorderService.submit(clientAuth, {
    clientRequestId: 'o2o-verify-pickup-beyond-01',
    items: [{ productId: product.id, qty: 1 }],
    isSystemApplied: false,
    pickupContact: '脚本提货人-超出可选范围',
    pickupAt: beyondWindowPickupAt.toISOString(),
  }), '到店取货时间不能晚于')
  const productAfterPickupRejects = await productRepo.findOneByOrFail({ id: product.id })
  assert.equal(
    productAfterPickupRejects.preOrderedStock,
    productBeforePickupRejects.preOrderedStock,
    '到店取货时间校验失败必须整单回滚，不得占用库存',
  )
  assert.equal(
    await preorderRepo.count({ where: { clientRequestId: 'o2o-verify-pickup-missing-01' } }),
    0,
    '缺少到店取货时间的请求不得落库',
  )
  log('部门单到店取货时间必填与可选范围校验通过')

  const departmentOwnedResult = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-department-owned-01',
    items: [{ productId: product.id, qty: 1 }],
    remark: '部门账号归属强制判定验证',
    isSystemApplied: false,
    pickupContact: '脚本提货人-部门账号',
  })
  assert.equal(departmentOwnedResult.order.clientOrderType, 'department')
  assert.equal(departmentOwnedResult.order.departmentNameSnapshot, '脚本部门-A')
  assert.ok(departmentOwnedResult.order.staffNoSnapshot)
  assert.equal(departmentOwnedResult.order.pickupContact, expectedDepartmentPickupContact)
  assert.equal(
    departmentOwnedResult.order.pickupAt?.toISOString(),
    SCRIPT_PICKUP_AT,
    '部门单必须原样保存客户端选择的到店取货时间',
  )
  await o2oPreorderService.cancelMyOrder(clientAuth, departmentOwnedResult.order.id)
  log('服务端会按部门账号强制判定订单归属通过')

  const departmentSnapshotPreorder = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-department-snapshot-01',
    items: [{ productId: product.id, qty: 1 }],
    remark: '部门快照固化验证',
    isSystemApplied: true,
    pickupContact: '脚本提货人-部门快照',
  })
  assert.equal(departmentSnapshotPreorder.order.clientOrderType, 'department')
  assert.equal(departmentSnapshotPreorder.order.departmentNameSnapshot, '脚本部门-A')
  assert.ok(departmentSnapshotPreorder.order.staffNoSnapshot)
  assert.equal(departmentSnapshotPreorder.order.pickupContact, expectedDepartmentPickupContact)

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
  const idempotentSubmitPayload = {
    clientRequestId: 'o2o-verify-manual-cancel-0001',
    items: [{ productId: product.id, qty: 2 }],
    remark: '自动化验证',
    isSystemApplied: false,
    pickupContact: '脚本提货人-A',
    // 并发幂等下单必须逐次提交完全相同的载荷，因此取货时间也使用脚本级固定值。
    pickupAt: SCRIPT_PICKUP_AT,
  }
  const idempotentSubmitResults = await Promise.all(
    Array.from({ length: 10 }, () => o2oPreorderService.submit(clientAuth, idempotentSubmitPayload)),
  )
  const preorderResult = idempotentSubmitResults[0]
  assert.ok(preorderResult)
  assert.equal(new Set(idempotentSubmitResults.map((item) => item.order.id)).size, 1)
  assert.equal(await preorderRepo.count({
    where: {
      clientUserId: clientAuth.userId,
      clientRequestId: idempotentSubmitPayload.clientRequestId,
    },
  }), 1)
  await expectBizError(
    () => o2oPreorderService.submit(clientAuth, {
      ...idempotentSubmitPayload,
      items: [{ productId: product.id, qty: 3 }],
    }),
    '请求键已被其他内容使用',
  )
  assert.equal(preorderResult.order.status, 'pending')
  assert.equal(preorderResult.order.pickupContact, expectedDepartmentPickupContact)
  const heldProduct = await productRepo.findOneByOrFail({ id: product.id })
  assert.equal(heldProduct.preOrderedStock, productStateBeforeRegularPreorder.preOrderedStock + 2)
  log('客户端并发幂等下单与单次库存预占通过')

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

  // 历史取消记录没有新治理字段时必须保留未知，不能按当前时间或场景
  // 臆测为客户端撤回、管理端取消或系统超时取消。
  await preorderRepo.update({ id: preorderResult.order.id }, {
    cancelReason: 'manual',
    cancellationSource: null,
    cancellationRemark: null,
    cancelledAt: null,
  })
  const legacyManualCancellation = await o2oPreorderService.detailById(preorderResult.order.id)
  assert.equal(legacyManualCancellation.order.statusReport.cancelReason, 'manual')
  assert.equal(legacyManualCancellation.order.statusReport.cancellationSource, null)
  assert.equal(legacyManualCancellation.order.statusReport.cancellationRemark, null)
  assert.equal(legacyManualCancellation.order.statusReport.cancelledAt, null)
  await preorderRepo.update({ id: preorderResult.order.id }, { cancelReason: null })
  const legacyUnknownCancellation = await o2oPreorderService.detailById(preorderResult.order.id)
  assert.equal(legacyUnknownCancellation.order.statusReport.scenario, 'cancelled')
  assert.equal(legacyUnknownCancellation.order.statusReport.cancelReason, null)
  assert.equal(legacyUnknownCancellation.order.statusReport.cancellationSource, null)
  log('历史取消记录保持未知来源且不按当前超时时间误判')

  const timeoutPreorder = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-timeout-cancel-001',
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
  const timeoutCancelResults = await Promise.all(
    Array.from({ length: 5 }, () => o2oPreorderService.cancelTimeoutOrders()),
  )
  assert.ok(timeoutCancelResults.some((result) => result.cancelledCount >= 1))
  const timeoutDetail = await o2oPreorderService.detailById(timeoutPreorder.order.id)
  assert.equal(timeoutDetail.order.status, 'cancelled')
  assert.equal(timeoutDetail.order.statusReport.cancelReason, 'timeout')
  assert.equal(timeoutDetail.order.statusReport.scenario, 'timeout_cancelled')
  assert.equal(await inventoryLogRepo.count({
    where: {
      refId: timeoutPreorder.order.id,
      changeType: 'preorder_release',
    },
  }), 1)
  assert.equal(await auditLogRepo.count({
    where: { actionType: 'o2o.preorder.cancel_by_system', targetId: timeoutPreorder.order.id },
  }), 1)
  log('超时订单并发回收 CAS 与单次库存释放通过')

  // RED：撤回请求在事务内发现已超时时，接口虽应返回 409，
  // 但超时取消和库存释放必须先提交，不能被随后抛出的 409 一并回滚。
  const timeoutRacePreorder = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-timeout-race-001',
    items: [{ productId: product.id, qty: 1 }],
    remark: '超时撤回竞态验证',
    isSystemApplied: false,
    pickupContact: '脚本提货人-超时竞态',
  })
  await preorderRepo.update({ id: timeoutRacePreorder.order.id }, { timeoutAt: new Date(Date.now() - 60 * 1000) })
  await expectBizError(() => o2oPreorderService.cancelMyOrder(clientAuth, timeoutRacePreorder.order.id), '订单已超时取消')
  const timeoutRaceOrder = await preorderRepo.findOneByOrFail({ id: timeoutRacePreorder.order.id })
  assert.equal(timeoutRaceOrder.status, 'cancelled')
  assert.equal(timeoutRaceOrder.cancelReason, 'timeout')
  assert.equal(timeoutRaceOrder.cancellationSource, 'system')
  assert.equal(await inventoryLogRepo.count({
    where: { refId: timeoutRacePreorder.order.id, changeType: 'preorder_release' },
  }), 1)
  log('超时撤回竞态会提交系统取消并仅释放一次库存')

  const adminTimeoutRacePreorder = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-admin-timeout-race-001', items: [{ productId: product.id, qty: 1 }], remark: '管理员超时竞态验证', isSystemApplied: false, pickupContact: '脚本提货人-管理员超时竞态',
  })
  await preorderRepo.update({ id: adminTimeoutRacePreorder.order.id }, { timeoutAt: new Date(Date.now() - 60 * 1000) })
  await expectBizError(() => o2oPreorderService.cancelOrderByAdmin({
    orderId: adminTimeoutRacePreorder.order.id, reason: '管理员取消与超时竞争', actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
  }), '订单已超时取消')
  assert.equal((await preorderRepo.findOneByOrFail({ id: adminTimeoutRacePreorder.order.id })).cancellationSource, 'system')
  assert.equal(await inventoryLogRepo.count({ where: { refId: adminTimeoutRacePreorder.order.id, changeType: 'preorder_release' } }), 1)
  log('管理员取消与超时竞争会提交系统取消并仅释放一次库存')

  await assertTimedOutOperationCommits({
    requestId: 'o2o-verify-timeout-update-my-001',
    remark: '客户端改单超时竞态',
    expectedError: '订单已超时取消，无法修改',
    invoke: (order) => o2oPreorderService.updateMyOrder(clientAuth, order.id, {
      items: [{ productId: product.id, qty: 1 }],
      remark: '不应落库的客户端改单',
    }),
  })
  await assertTimedOutOperationCommits({
    requestId: 'o2o-verify-timeout-update-onsite-001',
    remark: '现场改单超时竞态',
    expectedError: '订单已超时取消，无法现场改单',
    invoke: (order) => o2oPreorderService.updateOrderOnsite(scriptAdminActor, {
      orderId: order.id,
      items: [{ productId: product.id, qty: 1 }],
      remark: '不应落库的现场改单',
    }),
  })
  await assertTimedOutOperationCommits({
    requestId: 'o2o-verify-timeout-return-create-001',
    remark: '退货申请超时竞态',
    expectedError: '订单已超时取消，无法申请退货',
    invoke: (order) => o2oPreorderService.createReturnRequest(clientAuth, order.id, {
      reason: '不应创建的退货申请',
      items: [{ productId: product.id, qty: 1 }],
    }),
  })
  await assertTimedOutOperationCommits({
    requestId: 'o2o-verify-timeout-preorder-verify-001',
    remark: '预订单核销超时竞态',
    expectedError: '预订单已超时取消',
    invoke: (order) => o2oPreorderService.verifyByCode(order.verifyCode, scriptAdminActor),
  })
  await assertTimedOutOperationCommits({
    requestId: 'o2o-verify-timeout-return-verify-001',
    remark: '历史待取货退货核销超时竞态',
    expectedError: '原订单已超时取消',
    invoke: async (order) => {
      const returnRequestRepo = AppDataSource.getRepository(O2oReturnRequest)
      const returnRequest = await returnRequestRepo.save(returnRequestRepo.create({
        returnNo: `RT-LEGACY-${Date.now()}`,
        orderId: order.id,
        clientUserId: clientAuth.userId,
        verifyCode: randomUUID(),
        status: 'pending',
        sourceOrderStatus: 'pending',
        reason: '历史待取货退货申请',
        totalQty: 1,
        handledAt: null,
        handledBy: null,
        rejectedReason: null,
        verifiedAt: null,
        verifiedBy: null,
      }))
      return o2oPreorderService.verifyByCode(returnRequest.verifyCode, scriptAdminActor)
    },
  })
  log('改单、退货与核销入口的超时取消均先提交状态、库存流水和系统审计')

  // RED：管理员取消必须走独立的后台语义，持久化来源、面向用户的原因与取消时间，
  // 同时复用状态 CAS，只释放预占库存，并留下不暴露给客户端的操作审计。
  const adminCancelPreorder = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-admin-cancel-001',
    items: [{ productId: product.id, qty: 1 }],
    remark: '管理员取消验证',
    isSystemApplied: false,
    pickupContact: '脚本提货人-管理员取消',
  })
  const productBeforeAdminCancel = await productRepo.findOneByOrFail({ id: product.id })
  const adminCancelled = await o2oPreorderService.cancelOrderByAdmin({
    orderId: adminCancelPreorder.order.id,
    reason: '库存盘点需要暂时关闭该订单',
    actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: 'o2o-preorder-verify', clientRiskBrowserId: null, clientRiskSessionId: null },
  })
  assert.equal(adminCancelled.order.status, 'cancelled')
  assert.equal(adminCancelled.order.statusReport.cancellationSource, 'admin')
  assert.equal(adminCancelled.order.statusReport.cancellationRemark, '库存盘点需要暂时关闭该订单')
  assert.ok(adminCancelled.order.statusReport.cancelledAt instanceof Date)
  const productAfterAdminCancel = await productRepo.findOneByOrFail({ id: product.id })
  assert.equal(productAfterAdminCancel.currentStock, productBeforeAdminCancel.currentStock)
  assert.equal(productAfterAdminCancel.preOrderedStock, productBeforeAdminCancel.preOrderedStock - 1)
  assert.equal(await inventoryLogRepo.count({
    where: { refId: adminCancelPreorder.order.id, changeType: 'preorder_release', operatorType: 'admin' },
  }), 1)
  assert.ok(await auditLogRepo.findOne({
    where: { actionType: 'o2o.preorder.cancel_by_admin', targetId: adminCancelPreorder.order.id },
  }))
  await expectBizError(
    () => o2oPreorderService.cancelOrderByAdmin({
      orderId: adminCancelPreorder.order.id,
      reason: '再次取消',
      actor: scriptAdminActor,
      requestMeta: { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
    }),
    '订单已取消',
  )
  log('管理员取消来源、库存和审计约束通过')
  await expectBizError(() => o2oPreorderService.cancelOrderByAdmin({
    orderId: adminCancelPreorder.order.id, reason: 'a', actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
  }), '取消原因长度应为 2-200 个字符')
  await expectBizError(() => o2oPreorderService.cancelOrderByAdmin({
    orderId: adminCancelPreorder.order.id, reason: 'a'.repeat(201), actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
  }), '取消原因长度应为 2-200 个字符')

  // RED：批量永久删除只允许已取消且无业务依赖的订单；每项独立结算，
  // 混合批次不能重改库存，重复执行也必须保持幂等可审计。
  const batchPurgeOne = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-001', items: [{ productId: product.id, qty: 1 }], remark: '批量删除一', isSystemApplied: false, pickupContact: '脚本提货人-批删一',
  })
  const batchPurgeTwo = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-002', items: [{ productId: product.id, qty: 1 }], remark: '批量删除二', isSystemApplied: false, pickupContact: '脚本提货人-批删二',
  })
  const batchPurgeMismatch = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-003', items: [{ productId: product.id, qty: 1 }], remark: '批量删除确认错误', isSystemApplied: false, pickupContact: '脚本提货人-批删确认',
  })
  const batchPurgePending = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-004', items: [{ productId: product.id, qty: 1 }], remark: '批量删除跨状态', isSystemApplied: false, pickupContact: '脚本提货人-批删跨状态',
  })
  // RED：已取消订单即便关联正式出库单，也不能被批量永久删除，避免跨单据数据被误删。
  const batchDependencyClientAuth = await registerAndLoginClient(Date.now() + 2)
  const batchPurgeOutboundLinked = await submitPreorderWithPickup(batchDependencyClientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-outbound-001', items: [{ productId: product.id, qty: 1 }], remark: '批量删除出库依赖', isSystemApplied: false, pickupContact: '脚本提货人-批删出库依赖',
  })
  await o2oPreorderService.cancelMyOrder(clientAuth, batchPurgeOne.order.id)
  await o2oPreorderService.cancelMyOrder(clientAuth, batchPurgeTwo.order.id)
  await o2oPreorderService.cancelMyOrder(clientAuth, batchPurgeMismatch.order.id)
  await o2oPreorderService.cancelMyOrder(batchDependencyClientAuth, batchPurgeOutboundLinked.order.id)
  await AppDataSource.transaction(async (manager) => {
    const orderUuid = randomUUID()
    const businessNo = await orderBusinessNoService.allocate('walkin', orderUuid, manager)
    await manager.getRepository(BizOutboundOrder).save({
      orderUuid, systemNo: `O2O-LINK-${Date.now()}`, businessNo, editVersion: 1,
      orderType: 'walkin', hasCustomerOrder: false, isSystemApplied: false,
      issuerName: scriptAdminActor.displayName, customerDepartmentName: null,
      idempotencyKey: `o2o-preorder-verify:${batchPurgeOutboundLinked.order.id}`,
      sourceDocType: 'o2o_preorder', sourceDocId: batchPurgeOutboundLinked.order.id,
      sourceDocNo: batchPurgeOutboundLinked.order.preorderNo, inventoryMode: 'o2o_preapplied',
      customerName: '批删依赖测试', remark: '仅用于验证已取消订单的关联出库单保护', totalQty: '1.00', totalAmount: '10.00',
      isDeleted: false, deletedAt: null, deletedByUserId: null, deletedByUsername: null, deletedByDisplayName: null,
      creatorUserId: scriptAdminActor.userId, creatorUsername: scriptAdminActor.username, creatorDisplayName: scriptAdminActor.displayName,
    })
  })
  const productBeforeBatchPurge = await productRepo.findOneByOrFail({ id: product.id })
  const batchPurge = await o2oPreorderService.batchPurgeCancelledOrders({
    orders: [
      { id: batchPurgeOne.order.id, confirmPreorderNo: batchPurgeOne.order.preorderNo },
      { id: batchPurgeTwo.order.id, confirmPreorderNo: batchPurgeTwo.order.preorderNo },
      { id: batchPurgeMismatch.order.id, confirmPreorderNo: '错误订单号' },
      { id: batchPurgePending.order.id, confirmPreorderNo: batchPurgePending.order.preorderNo },
      { id: batchPurgeOutboundLinked.order.id, confirmPreorderNo: batchPurgeOutboundLinked.order.preorderNo },
    ],
    actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: 'o2o-preorder-verify', clientRiskBrowserId: null, clientRiskSessionId: null },
  })
  assert.equal(batchPurge.summary.requested, 5)
  assert.equal(batchPurge.summary.deleted, 2)
  assert.equal(batchPurge.summary.skipped, 2)
  assert.equal(batchPurge.summary.failed, 1)
  assert.ok(batchPurge.results.some((item) => item.id === batchPurgeOutboundLinked.order.id && item.code === 'OUTBOUND_ORDER_EXISTS'))
  assert.equal(await preorderRepo.countBy({ id: batchPurgeOutboundLinked.order.id }), 1)
  assert.ok(batchPurge.batchId)
  assert.equal(await preorderRepo.countBy({ id: batchPurgeOne.order.id }), 0)
  assert.equal(await preorderRepo.countBy({ id: batchPurgeTwo.order.id }), 0)
  assert.equal((await productRepo.findOneByOrFail({ id: product.id })).currentStock, productBeforeBatchPurge.currentStock)
  assert.equal((await productRepo.findOneByOrFail({ id: product.id })).preOrderedStock, productBeforeBatchPurge.preOrderedStock)

  // 汇总审计是批次辅助索引。模拟其底层写入失败时，已经逐单提交的删除结果
  // 仍必须返回给客户端，避免重试后只能得到“订单不存在”而丢失首次结果。
  const batchSummaryAuditFaultOrder = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-batch-summary-audit-fault-001',
    items: [{ productId: product.id, qty: 1 }],
    remark: '批量汇总审计故障注入',
    isSystemApplied: false,
    pickupContact: '脚本提货人-批量汇总审计故障',
  })
  await o2oPreorderService.cancelMyOrder(clientAuth, batchSummaryAuditFaultOrder.order.id)
  const originalAuditRecord = auditService.record.bind(auditService)
  auditService.record = (async (input, manager) => {
    if (input.actionType === 'o2o.preorder.purge_cancelled_batch') {
      throw new Error('脚本模拟批量汇总审计写入失败')
    }
    return originalAuditRecord(input, manager)
  }) as typeof auditService.record
  let batchSummaryAuditFaultResult: Awaited<ReturnType<typeof o2oPreorderService.batchPurgeCancelledOrders>>
  try {
    batchSummaryAuditFaultResult = await o2oPreorderService.batchPurgeCancelledOrders({
      orders: [{ id: batchSummaryAuditFaultOrder.order.id, confirmPreorderNo: batchSummaryAuditFaultOrder.order.preorderNo }],
      actor: scriptAdminActor,
      requestMeta,
    })
  } finally {
    auditService.record = originalAuditRecord
  }
  assert.equal(batchSummaryAuditFaultResult.summary.deleted, 1)
  assert.equal(batchSummaryAuditFaultResult.results[0]?.outcome, 'deleted')
  assert.equal(await preorderRepo.countBy({ id: batchSummaryAuditFaultOrder.order.id }), 0)
  log('批量删除汇总审计失败时仍返回已提交的逐单结果')

  const repeatedBatchPurge = await o2oPreorderService.batchPurgeCancelledOrders({
    orders: [{ id: batchPurgeOne.order.id, confirmPreorderNo: batchPurgeOne.order.preorderNo }],
    actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
  })
  assert.equal(repeatedBatchPurge.summary.deleted, 0)
  assert.equal(repeatedBatchPurge.summary.failed, 1)
  assert.equal((await productRepo.findOneByOrFail({ id: product.id })).preOrderedStock, productBeforeBatchPurge.preOrderedStock)
  await expectBizError(() => o2oPreorderService.batchPurgeCancelledOrders({
    orders: [
      { id: batchPurgeMismatch.order.id, confirmPreorderNo: batchPurgeMismatch.order.preorderNo },
      { id: batchPurgeMismatch.order.id, confirmPreorderNo: batchPurgeMismatch.order.preorderNo },
    ],
    actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
  }), '订单 ID 不可重复')
  await expectBizError(() => o2oPreorderService.batchPurgeCancelledOrders({
    orders: Array.from({ length: 51 }, (_, index) => ({ id: `over-limit-${index}`, confirmPreorderNo: `over-limit-${index}` })),
    actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
  }), '批量永久删除订单数量应为 1-50 项')
  log('已取消订单批量永久删除、混合结果与库存不变约束通过')

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
  const printedDepartmentOrder = await o2oPreorderService.markCustomerOrderPrintedByClient(clientAuth, departmentSnapshotPreorder.order.id)
  assert.equal(printedDepartmentOrder.detail.order.hasCustomerOrder, true, '已核销的有效部门订单仍应支持补打出库单')
  assert.equal((await o2oPreorderService.markCustomerOrderPrintedByClient(clientAuth, departmentSnapshotPreorder.order.id)).printedNow, false, '重复打印上报必须幂等')
  await expectBizError(() => o2oPreorderService.markCustomerOrderPrintedByClient(clientAuth, departmentOwnedResult.order.id), '已取消订单不可标记已打印')
  const departmentSnapshotDetail = assertPreorderVerifyDetail(departmentSnapshotVerified)
  assert.equal(departmentSnapshotDetail.order.clientOrderType, 'department')
  const departmentSnapshotOutboundOrder = await outboundOrderRepo.findOne({
    where: { idempotencyKey: `o2o-preorder-verify:${departmentSnapshotPreorder.order.id}` },
  })
  assert.ok(departmentSnapshotOutboundOrder, '部门预订单核销后应生成正式出库单')
  assert.equal(departmentSnapshotOutboundOrder.orderType, 'department')
  assert.equal(departmentSnapshotOutboundOrder.customerDepartmentName, '脚本部门-A')
  assert.match(departmentSnapshotOutboundOrder.businessNo, /^hyyzjd\d{6}$/)
  // #70：来源预订单写入结构化来源快照，主单与明细备注不再自动写入预订单号。
  assert.equal(departmentSnapshotOutboundOrder.sourceDocType, 'o2o_preorder', '核销生成的正式出库单必须写入来源单据类型')
  assert.equal(String(departmentSnapshotOutboundOrder.sourceDocId), String(departmentSnapshotPreorder.order.id), '来源单据 ID 必须指向核销的预订单')
  assert.equal(departmentSnapshotOutboundOrder.sourceDocNo, departmentSnapshotPreorder.order.preorderNo, '来源单据号必须保留预订单号快照')
  assert.equal(departmentSnapshotOutboundOrder.remark, null, '核销生成的正式出库单主单备注不得自动写入来源文案')
  assert.equal(
    await AppDataSource.getRepository(BizOutboundOrderItem).count({
      where: { orderId: departmentSnapshotOutboundOrder.id, remark: Not(IsNull()) },
    }),
    0,
    '核销生成的正式出库单明细备注不得自动写入来源文案',
  )
  assert.equal(departmentSnapshotOutboundOrder.editVersion, 2, '客户端打印联动必须推进正式单据版本')
  assert.equal(
    await AppDataSource.getRepository(OrderRevision).countBy({ orderUuid: departmentSnapshotOutboundOrder.orderUuid }),
    1,
    '客户端打印联动必须保留正式单据 revision',
  )
  assert.equal(
    printedDepartmentOrder.detail.order.customerOrderBusinessNo,
    departmentSnapshotOutboundOrder.businessNo,
    'O2O 继续以 showNo 关联，但客户端应展示正式单据 businessNo',
  )
  log('部门订单下单快照会稳定继承到正式出库单通过')

  const verifiedPreorder = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-completed-order-001',
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
    verifiedOutboundOrder.systemNo,
    '客户端订单详情应返回与管理端一致的正式出库单号',
  )
  assert.equal(verifiedDetail.order.customerOrderBusinessNo, verifiedOutboundOrder.businessNo)

  const operatorVerifiedPreorder = await submitPreorderWithPickup(clientAuth, {
    clientRequestId: 'o2o-verify-operator-audit-001',
    items: [{ productId: product.id, qty: 1 }],
    remark: '普通操作员核销审计验证',
    isSystemApplied: false,
    pickupContact: '脚本提货人-普通操作员核销',
  })
  const operatorVerifyActor: AuthUserContext = { ...verifyActor, role: 'operator' }
  const operatorVerified = await o2oPreorderService.verifyByCode(
    operatorVerifiedPreorder.order.verifyCode,
    operatorVerifyActor,
    { ipAddress: '127.0.0.1', userAgent: 'o2o-operator-audit-verify', clientRiskBrowserId: null, clientRiskSessionId: null },
  )
  const operatorVerifiedDetail = assertPreorderVerifyDetail(operatorVerified)
  assert.equal('customerOrderSystemNo' in operatorVerifiedDetail.order, false, '普通操作员核销响应不得返回正式单 systemNo')
  assert.equal('customerOrderShowNo' in operatorVerifiedDetail.order, false, '普通操作员核销响应不得返回旧 systemNo 别名')
  const operatorVerifiedOutbound = await outboundOrderRepo.findOneOrFail({
    where: { sourceDocType: 'o2o_preorder', sourceDocId: operatorVerifiedPreorder.order.id },
  })
  const operatorVerifyAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'o2o.preorder.verify', targetId: operatorVerifiedPreorder.order.id },
    order: { id: 'DESC' },
  })
  const operatorVerifyAuditDetail = JSON.parse(operatorVerifyAudit.detailJson ?? '{}') as Record<string, unknown>
  assert.equal(operatorVerifyAudit.targetCode, operatorVerifiedOutbound.businessNo, '核销审计 targetCode 必须优先使用正式单 businessNo')
  assert.equal(operatorVerifyAuditDetail.preorderNo, operatorVerifiedPreorder.order.preorderNo, '核销审计必须保留 preorderNo')
  assert.equal(operatorVerifyAuditDetail.outboundOrderBusinessNo, operatorVerifiedOutbound.businessNo, '核销审计必须保留正式单 businessNo')
  assert.equal(operatorVerifyAuditDetail.outboundOrderSystemNo, operatorVerifiedOutbound.systemNo, '核销审计内部技术快照必须保留 systemNo')
  assert.equal('outboundOrderShowNo' in operatorVerifyAuditDetail, false, '新核销审计不得继续写入含混 legacy showNo')
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
  process.exitCode = 1
} finally {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy()
  }
}
