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
import { randomUUID } from 'node:crypto'
import { AppDataSource } from '../src/config/data-source.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from '../src/config/database-bootstrap.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { BizOutboundOrder } from '../src/entities/biz-outbound-order.entity.js'
import { ClientUser } from '../src/entities/client-user.entity.js'
import { InventoryLog } from '../src/entities/inventory-log.entity.js'
import { O2oPreorder } from '../src/entities/o2o-preorder.entity.js'
import { O2oReturnRequest } from '../src/entities/o2o-return-request.entity.js'
import { SysAuditLog } from '../src/entities/sys-audit-log.entity.js'
import { authService } from '../src/services/auth.service.js'
import { clientAuthService } from '../src/services/client-auth.service.js'
import { dataMaintenanceService } from '../src/services/data-maintenance.service.js'
import { o2oPreorderService } from '../src/services/o2o-preorder.service.js'
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
    // 本脚本会构造多条相互独立的撤销、竞态和依赖订单，限购值仅用于避免测试夹具互相干扰。
    limitPerUser: 30,
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
    const preorder = await o2oPreorderService.submit(clientAuth, {
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

  const departmentOwnedResult = await o2oPreorderService.submit(clientAuth, {
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
  await o2oPreorderService.cancelMyOrder(clientAuth, departmentOwnedResult.order.id)
  log('服务端会按部门账号强制判定订单归属通过')

  const departmentSnapshotPreorder = await o2oPreorderService.submit(clientAuth, {
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

  const timeoutPreorder = await o2oPreorderService.submit(clientAuth, {
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
  const timeoutRacePreorder = await o2oPreorderService.submit(clientAuth, {
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

  const adminTimeoutRacePreorder = await o2oPreorderService.submit(clientAuth, {
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
  const adminCancelPreorder = await o2oPreorderService.submit(clientAuth, {
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
  const batchPurgeOne = await o2oPreorderService.submit(clientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-001', items: [{ productId: product.id, qty: 1 }], remark: '批量删除一', isSystemApplied: false, pickupContact: '脚本提货人-批删一',
  })
  const batchPurgeTwo = await o2oPreorderService.submit(clientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-002', items: [{ productId: product.id, qty: 1 }], remark: '批量删除二', isSystemApplied: false, pickupContact: '脚本提货人-批删二',
  })
  const batchPurgeMismatch = await o2oPreorderService.submit(clientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-003', items: [{ productId: product.id, qty: 1 }], remark: '批量删除确认错误', isSystemApplied: false, pickupContact: '脚本提货人-批删确认',
  })
  const batchPurgePending = await o2oPreorderService.submit(clientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-004', items: [{ productId: product.id, qty: 1 }], remark: '批量删除跨状态', isSystemApplied: false, pickupContact: '脚本提货人-批删跨状态',
  })
  // RED：已取消订单即便关联正式出库单，也不能被批量永久删除，避免跨单据数据被误删。
  const batchDependencyClientAuth = await registerAndLoginClient(Date.now() + 2)
  const batchPurgeOutboundLinked = await o2oPreorderService.submit(batchDependencyClientAuth, {
    clientRequestId: 'o2o-verify-batch-purge-outbound-001', items: [{ productId: product.id, qty: 1 }], remark: '批量删除出库依赖', isSystemApplied: false, pickupContact: '脚本提货人-批删出库依赖',
  })
  await o2oPreorderService.cancelMyOrder(clientAuth, batchPurgeOne.order.id)
  await o2oPreorderService.cancelMyOrder(clientAuth, batchPurgeTwo.order.id)
  await o2oPreorderService.cancelMyOrder(clientAuth, batchPurgeMismatch.order.id)
  await o2oPreorderService.cancelMyOrder(batchDependencyClientAuth, batchPurgeOutboundLinked.order.id)
  await outboundOrderRepo.save(outboundOrderRepo.create({
    orderUuid: randomUUID(), showNo: `O2O-LINK-${Date.now()}`, orderType: 'walkin', hasCustomerOrder: false, isSystemApplied: false,
    issuerName: scriptAdminActor.displayName, customerDepartmentName: null,
    idempotencyKey: `o2o-preorder-verify:${batchPurgeOutboundLinked.order.id}`,
    customerName: '批删依赖测试', remark: '仅用于验证已取消订单的关联出库单保护', totalQty: '1.00', totalAmount: '10.00',
    isDeleted: false, deletedAt: null, deletedByUserId: null, deletedByUsername: null, deletedByDisplayName: null,
    creatorUserId: scriptAdminActor.userId, creatorUsername: scriptAdminActor.username, creatorDisplayName: scriptAdminActor.displayName,
  }))
  const productBeforeBatchPurge = await productRepo.findOneByOrFail({ id: product.id })
  const batchPurge = await o2oPreorderService.batchPurgeCancelledOrders({
    orders: [
      { id: batchPurgeOne.order.id, confirmShowNo: batchPurgeOne.order.showNo },
      { id: batchPurgeTwo.order.id, confirmShowNo: batchPurgeTwo.order.showNo },
      { id: batchPurgeMismatch.order.id, confirmShowNo: '错误订单号' },
      { id: batchPurgePending.order.id, confirmShowNo: batchPurgePending.order.showNo },
      { id: batchPurgeOutboundLinked.order.id, confirmShowNo: batchPurgeOutboundLinked.order.showNo },
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
  const batchSummaryAuditFaultOrder = await o2oPreorderService.submit(clientAuth, {
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
      orders: [{ id: batchSummaryAuditFaultOrder.order.id, confirmShowNo: batchSummaryAuditFaultOrder.order.showNo }],
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
    orders: [{ id: batchPurgeOne.order.id, confirmShowNo: batchPurgeOne.order.showNo }],
    actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
  })
  assert.equal(repeatedBatchPurge.summary.deleted, 0)
  assert.equal(repeatedBatchPurge.summary.failed, 1)
  assert.equal((await productRepo.findOneByOrFail({ id: product.id })).preOrderedStock, productBeforeBatchPurge.preOrderedStock)
  await expectBizError(() => o2oPreorderService.batchPurgeCancelledOrders({
    orders: [
      { id: batchPurgeMismatch.order.id, confirmShowNo: batchPurgeMismatch.order.showNo },
      { id: batchPurgeMismatch.order.id, confirmShowNo: batchPurgeMismatch.order.showNo },
    ],
    actor: scriptAdminActor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null },
  }), '订单 ID 不可重复')
  await expectBizError(() => o2oPreorderService.batchPurgeCancelledOrders({
    orders: Array.from({ length: 51 }, (_, index) => ({ id: `over-limit-${index}`, confirmShowNo: `over-limit-${index}` })),
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
  const departmentSnapshotDetail = assertPreorderVerifyDetail(departmentSnapshotVerified)
  assert.equal(departmentSnapshotDetail.order.clientOrderType, 'department')
  const departmentSnapshotOutboundOrder = await outboundOrderRepo.findOne({
    where: { idempotencyKey: `o2o-preorder-verify:${departmentSnapshotPreorder.order.id}` },
  })
  assert.ok(departmentSnapshotOutboundOrder, '部门预订单核销后应生成正式出库单')
  assert.equal(departmentSnapshotOutboundOrder.orderType, 'department')
  assert.equal(departmentSnapshotOutboundOrder.customerDepartmentName, '脚本部门-A')
  log('部门订单下单快照会稳定继承到正式出库单通过')

  const verifiedPreorder = await o2oPreorderService.submit(clientAuth, {
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
