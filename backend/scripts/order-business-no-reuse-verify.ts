/**
 * 模块说明：Issue #110 订单业务号回收复用专项验证。
 * 文件职责：使用隔离 SQLite 与真实 HTTP 路由验证管理员单张回收、并发唯一性、永久链路、游标校准和密码边界。
 * 实现逻辑：测试数据只写入随机临时库；先构造已永久删除的最后持有人，再分别验证预览、提交、回滚、重复复用和旧路径隔离。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AuthUserContext } from '../src/types/auth.js'

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const backendRoot = process.cwd()
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const sqlitePath = path.resolve(sqliteRoot, `order-business-no-reuse-${verifySeed}.sqlite`)
const adminPassword = `Admin_${verifySeed}_Aa1!`
const operatorPassword = `Operator_${verifySeed}_Aa1!`
const permanentDeletePassword = `Purge_${verifySeed}_Aa1!`

process.env.APP_PROFILE = `order-business-no-reuse-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword
process.env.PERMANENT_DELETE_PASSWORD = permanentDeletePassword

interface AmendmentInput {
  orderId: string
  editVersion: number
  businessNo?: string
  orderType?: 'department' | 'walkin'
  customerDepartmentName?: string | null
  customerName?: string | null
  issuerName?: string | null
  hasCustomerOrder?: boolean
  isSystemApplied?: boolean
  remark?: string | null
  reason?: string
  reclaimBusinessNo?: boolean
}

interface ReclaimCandidate {
  businessNo: string
  firstAssignedAt: string | Date
  lastAssignedAt: string | Date
  reuseCount: number
}

interface AmendmentPreview {
  ready: boolean
  cursorPlans: Array<{
    namespace: 'hyyzjd' | 'hyyz'
    beforeCursor: number
    afterCursor: number
    nextBusinessNo: string | null
  }>
  items: Array<{
    orderId: string
    blockingReasons: string[]
    before: Record<string, unknown>
    after: Record<string, unknown>
    reclaimCandidate: ReclaimCandidate | null
  }>
}

interface ReuseApi {
  previewAmendments(input: { amendments: AmendmentInput[] }, actor: AuthUserContext): Promise<AmendmentPreview>
  commitAmendments(input: { amendments: AmendmentInput[] }, actor: AuthUserContext): Promise<AmendmentPreview>
  reclaimBusinessNo(
    input: { amendment: AmendmentInput },
    actor: AuthUserContext,
    requestMeta?: { ipAddress?: string | null; userAgent?: string | null },
  ): Promise<AmendmentPreview>
}

type JsonPayload = { code?: number; message?: string; data?: unknown }
type CookieSession = { cookie: string; csrfToken: string }

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

const writeHeaders = (session: CookieSession): Record<string, string> => ({
  Cookie: session.cookie,
  'Content-Type': 'application/json',
  'x-csrf-token': session.csrfToken,
})

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const entityModule = await import('../src/entities/order-business-no-reuse-event.entity.js').catch(() => ({}))
  assert.ok('OrderBusinessNoReuseEvent' in entityModule, 'RED：缺少不可变业务号复用事件实体')
  const migrationPath = path.resolve(backendRoot, 'sql', '054_order_business_no_reuse.sql')
  assert.equal(fs.existsSync(migrationPath), true, 'RED：缺少 054_order_business_no_reuse.sql')

  const [
    { createApp },
    { AppDataSource },
    { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime },
    { authService },
    { userService },
    { orderService },
    { systemConfigService },
    { BaseProduct },
    { BaseProductSku },
    { BizOutboundOrder },
    { BusinessSequence },
    { OrderBusinessNoOccupancy },
    { OrderBusinessNoReuseEvent },
    { OrderRevision },
    { SysAuditLog },
    { SysUser },
    { auditService },
    { DEFAULT_ROLE_PERMISSIONS },
    { BizError },
    transactionRunnerModule,
    { AUDIT_ACTION_CATALOG },
  ] = await Promise.all([
    import('../src/app.js'),
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/services/auth.service.js'),
    import('../src/services/user.service.js'),
    import('../src/services/order.service.js'),
    import('../src/services/system-config.service.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/business-sequence.entity.js'),
    import('../src/entities/order-business-no-occupancy.entity.js'),
    import('../src/entities/order-business-no-reuse-event.entity.js'),
    import('../src/entities/order-revision.entity.js'),
    import('../src/entities/sys-audit-log.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/services/audit.service.js'),
    import('../src/constants/auth-permissions.js'),
    import('../src/utils/errors.js'),
    import('../src/config/transaction-runner.js'),
    import('../src/constants/audit-action-catalog.js'),
  ])

  const resolveTransactionIsolation = (
    transactionRunnerModule as {
      resolveTransactionIsolation?: (
        databaseType: 'sqlite' | 'mysql',
        options?: { mysqlIsolationLevel?: 'READ COMMITTED' },
      ) => 'READ COMMITTED' | undefined
    }
  ).resolveTransactionIsolation
  assert.equal(typeof resolveTransactionIsolation, 'function', 'RED：统一事务入口缺少按数据库选择隔离级别的可验证策略')
  assert.equal(resolveTransactionIsolation?.('mysql', { mysqlIsolationLevel: 'READ COMMITTED' }), 'READ COMMITTED')
  assert.equal(resolveTransactionIsolation?.('mysql'), undefined, '普通 MySQL 事务未显式请求时必须保持既有默认隔离语义')
  assert.equal(resolveTransactionIsolation?.('sqlite', { mysqlIsolationLevel: 'READ COMMITTED' }), undefined, 'SQLite 必须保持原事务调用兼容')
  assert.deepEqual(AUDIT_ACTION_CATALOG['order.business_no_reclaim'], {
    label: '回收并复用已永久删除订单业务号',
    category: 'order_outbound',
  }, 'RED：业务号回收动作必须登记到审计目录')

  const api = orderService as unknown as ReuseApi
  assert.equal(typeof api.reclaimBusinessNo, 'function', '订单服务必须暴露专用单张回收提交方法')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  let server: Server | null = null
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()
    const adminProfile = await authService.ensureDefaultAdmin()
    const adminUser = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: adminProfile.username })
    const adminActor: AuthUserContext = {
      userId: String(adminUser.id),
      username: adminUser.username,
      displayName: adminUser.displayName,
      role: 'admin',
      permissions: [...DEFAULT_ROLE_PERMISSIONS.admin],
      status: 'enabled',
      sessionToken: 'issue110-admin-service',
      authSource: 'bearer',
    }
    const operatorProfile = await userService.create({
      username: `issue110_operator_${verifySeed}`,
      password: operatorPassword,
      displayName: 'Issue110操作员',
      role: 'operator',
    }, adminActor)
    const operatorActor: AuthUserContext = {
      userId: String(operatorProfile.id),
      username: operatorProfile.username,
      displayName: operatorProfile.displayName,
      role: 'operator',
      permissions: [...DEFAULT_ROLE_PERMISSIONS.operator],
      status: 'enabled',
      sessionToken: 'issue110-operator-service',
      authSource: 'bearer',
    }

    const productRepo = AppDataSource.getRepository(BaseProduct)
    const product = await productRepo.save(productRepo.create({
      productCode: `ISSUE110-${verifySeed}`,
      productName: 'Issue110验证商品',
      pinyinAbbr: 'ISSUE',
      defaultPrice: '9.90',
      currentStock: 1000,
      preOrderedStock: 0,
      isActive: true,
    }))
    const sku = await AppDataSource.getRepository(BaseProductSku).save({
      productId: product.id,
      skuCode: `ISSUE110-SKU-${verifySeed}`,
      specValuesJson: '{}',
      specText: '默认规格',
      defaultPrice: '9.90',
      discountRate: '10.0',
      currentStock: 1000,
      preOrderedStock: 0,
      isActive: true,
      isCurrent: true,
      o2oRecommended: false,
      thumbnail: null,
      sortOrder: 0,
    })

    let orderIndex = 0
    const submitOrder = async (orderType: 'department' | 'walkin') => {
      orderIndex += 1
      return orderService.submit({
        idempotencyKey: `issue110-${verifySeed}-${orderIndex}`,
        orderType,
        customerDepartmentName: orderType === 'department' ? `Issue110部门-${orderIndex}` : undefined,
        customerName: orderType === 'walkin' ? `Issue110散客-${orderIndex}` : undefined,
        hasCustomerOrder: orderType === 'department',
        isSystemApplied: orderType === 'department',
        items: [{ productId: product.id, skuId: sku.id, qty: 1, unitPrice: 9.9 }],
      }, adminActor)
    }
    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const occupancyRepo = AppDataSource.getRepository(OrderBusinessNoOccupancy)
    const eventRepo = AppDataSource.getRepository(OrderBusinessNoReuseEvent)
    const revisionRepo = AppDataSource.getRepository(OrderRevision)
    const sequenceRepo = AppDataSource.getRepository(BusinessSequence)
    const auditRepo = AppDataSource.getRepository(SysAuditLog)
    const setWalkinBusinessCursorFixture = async (currentValue: number) => {
      await sequenceRepo.update({ sequenceKey: 'order.business.walkin' }, { currentValue })
      await AppDataSource.query(
        'UPDATE "system_configs" SET "config_value" = ? WHERE "config_key" = ?',
        [String(currentValue), 'order.business.walkin.current'],
      )
    }

    const assignBusinessNo = async (orderId: string, businessNo: string) => {
      const entity = await orderRepo.findOneByOrFail({ id: orderId })
      await api.commitAmendments({ amendments: [{
        orderId,
        editVersion: Number(entity.editVersion),
        businessNo,
        reason: `Issue110 夹具重编 ${businessNo}`,
      }] }, adminActor)
      return orderRepo.findOneByOrFail({ id: orderId })
    }

    const purgeAsLegacy = async (orderId: string) => {
      const entity = await orderRepo.findOneByOrFail({ id: orderId })
      entity.inventoryMode = 'legacy_none'
      await orderRepo.save(entity)
      if (!entity.isDeleted) await orderService.softDeleteById(orderId, adminActor, entity.businessNo)
      await orderService.purgeById(orderId, adminActor, entity.businessNo)
      assert.equal(await orderRepo.existsBy({ id: orderId }), false)
      return entity
    }

    // 100（被永久删除来源）/029（目标旧号）/101（物理仍存在最大号）：回收后游标应校准到 101。
    const target029 = await submitOrder('walkin')
    const source100 = await submitOrder('walkin')
    const existing101 = await submitOrder('walkin')
    const target029Entity = await assignBusinessNo(String(target029.order.id), 'hyyz000029')
    const source100Entity = await assignBusinessNo(String(source100.order.id), 'hyyz000100')
    await assignBusinessNo(String(existing101.order.id), 'hyyz000101')
    await purgeAsLegacy(String(source100.order.id))

    const source100Occupancy = await occupancyRepo.findOneByOrFail({ businessNo: 'hyyz000100' })
    assert.equal(source100Occupancy.orderUuid, source100Entity.orderUuid, '首次持有人 UUID 不得改写')
    assert.equal(source100Occupancy.lastAssignedOrderUuid, source100Entity.orderUuid, '存量/首次分配必须回填最后持有人')
    assert.equal(Number(source100Occupancy.reuseCount), 0)

    await setWalkinBusinessCursorFixture(99)
    const occupancyCountBeforeSuggestion = await occupancyRepo.count()
    const suggestion = await orderService.suggestAmendmentBusinessNos({ orderType: 'walkin', count: 1, exclude: [] })
    assert.equal(suggestion.businessNos[0], 'hyyz000102', '自动建议必须继续跳过可回收但仍永久占用的 100/101')
    assert.equal(await occupancyRepo.count(), occupancyCountBeforeSuggestion, '建议不得产生占用写入')
    await assert.rejects(
      () => submitOrder('walkin'),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '自动开单在 cursor + 1 命中可回收占用号时仍必须 409，不得自动复用或跳号',
    )

    const reclaimInput: AmendmentInput = {
      orderId: String(target029.order.id),
      editVersion: Number(target029Entity.editVersion),
      businessNo: 'hyyz000100',
      reason: 'Issue110 首次回收',
    }
    const normalPreview = await api.previewAmendments({ amendments: [reclaimInput] }, adminActor)
    assert.equal(normalPreview.ready, false, '普通预览遇到占用号仍必须阻断')
    assert.match(normalPreview.items[0]?.blockingReasons.join('；') ?? '', /永久占用/)
    assert.equal(normalPreview.items[0]?.reclaimCandidate?.businessNo, 'hyyz000100', '管理员普通预览应获得非敏感回收候选')
    assert.equal(normalPreview.items[0]?.reclaimCandidate?.reuseCount, 0)

    const operatorPreview = await api.previewAmendments({ amendments: [reclaimInput] }, operatorActor)
    assert.equal(operatorPreview.ready, false)
    assert.equal(operatorPreview.items[0]?.reclaimCandidate, null, '非管理员不得看到回收候选')

    const occupancyBeforePreview = await occupancyRepo.findOneByOrFail({ businessNo: 'hyyz000100' })
    const eventCountBeforePreview = await eventRepo.count()
    const revisionCountBeforePreview = await revisionRepo.count()
    const reclaimPreview = await api.previewAmendments({ amendments: [{ ...reclaimInput, reclaimBusinessNo: true }] }, adminActor)
    assert.equal(reclaimPreview.ready, true, '管理员单张显式回收预览应通过')
    assert.deepEqual(reclaimPreview.cursorPlans, [{
      namespace: 'hyyz',
      beforeCursor: 99,
      afterCursor: 101,
      nextBusinessNo: 'hyyz000102',
    }])
    assert.deepEqual(await occupancyRepo.findOneByOrFail({ businessNo: 'hyyz000100' }), occupancyBeforePreview, '预览不得转移最后持有人')
    assert.equal(await eventRepo.count(), eventCountBeforePreview, '预览不得写复用事件')
    assert.equal(await revisionRepo.count(), revisionCountBeforePreview, '预览不得写 revision')

    await assert.rejects(
      () => api.commitAmendments({ amendments: [{ ...reclaimInput, reclaimBusinessNo: true }] }, adminActor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '普通改单提交接口不得接受回收授权',
    )

    await setWalkinBusinessCursorFixture(101)
    const batchOther = await submitOrder('walkin')
    const batchOtherEntity = await assignBusinessNo(String(batchOther.order.id), 'hyyz000030')
    const batchPreview = await api.previewAmendments({ amendments: [
      { ...reclaimInput, reclaimBusinessNo: true },
      {
        orderId: String(batchOther.order.id),
        editVersion: 1,
        remark: '批量回收不应生效',
        reason: '批量回收阻断',
      },
    ] }, adminActor)
    assert.equal(batchPreview.ready, false, '回收模式不得用于批量修订')
    assert.match(batchPreview.items.flatMap((item) => item.blockingReasons).join('；'), /单张|批量/)

    const departmentSource = await submitOrder('department')
    const departmentSourceEntity = await assignBusinessNo(String(departmentSource.order.id), 'hyyzjd000300')
    await purgeAsLegacy(String(departmentSource.order.id))
    const typeSwitchPreview = await api.previewAmendments({ amendments: [{
      orderId: String(batchOther.order.id),
      editVersion: Number(batchOtherEntity.editVersion),
      orderType: 'department',
      businessNo: 'hyyzjd000300',
      customerDepartmentName: 'Issue110类型切换',
      reclaimBusinessNo: true,
      reason: '不允许跨类型回收',
    }] }, adminActor)
    assert.equal(typeSwitchPreview.ready, false)
    assert.match(typeSwitchPreview.items[0]?.blockingReasons.join('；') ?? '', /订单类型|跨类型|同类型/)
    assert.equal((await occupancyRepo.findOneByOrFail({ businessNo: 'hyyzjd000300' })).lastAssignedOrderUuid, departmentSourceEntity.orderUuid)

    const activeHolder = await submitOrder('walkin')
    const activeHolderEntity = await assignBusinessNo(String(activeHolder.order.id), 'hyyz000040')
    const activeTarget = await submitOrder('walkin')
    const activeTargetEntity = await orderRepo.findOneByOrFail({ id: activeTarget.order.id })
    const activePreview = await api.previewAmendments({ amendments: [{
      orderId: String(activeTarget.order.id), editVersion: 1, businessNo: 'hyyz000040', reclaimBusinessNo: true, reason: '正常订单不可回收',
    }] }, adminActor)
    assert.equal(activePreview.ready, false, '正常持有人仍存在时不可回收')
    await orderService.softDeleteById(String(activeHolder.order.id), adminActor, activeHolderEntity.businessNo)
    const softDeletedPreview = await api.previewAmendments({ amendments: [{
      orderId: String(activeTarget.order.id), editVersion: 1, businessNo: 'hyyz000040', reclaimBusinessNo: true, reason: '软删除订单不可回收',
    }] }, adminActor)
    assert.equal(softDeletedPreview.ready, false, '软删除持有人仍存在时不可回收')
    assert.equal((await orderRepo.findOneByOrFail({ id: activeTarget.order.id })).businessNo, activeTargetEntity.businessNo)

    // 真实 HTTP：operator 即使具备 orders:update 也被 admin 角色门禁拦截，错误永久删除密码也不得进入服务层。
    const app = createApp()
    server = app.listen(0)
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.once('listening', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const [adminSession, operatorSession] = await Promise.all([
      loginCookieSession(baseUrl, adminUser.username, adminPassword),
      loginCookieSession(baseUrl, operatorProfile.username, operatorPassword),
    ])
    const routeBody = {
      amendment: { ...reclaimInput, reclaimBusinessNo: true },
      permanentDeletePassword,
    }
    const nonAdminResponse = await fetch(`${baseUrl}/api/orders/amendments/reclaim-business-no`, {
      method: 'POST', headers: writeHeaders(operatorSession), body: JSON.stringify(routeBody),
    })
    assert.equal(nonAdminResponse.status, 403, '非管理员必须被角色门禁拦截')
    const wrongPasswordResponse = await fetch(`${baseUrl}/api/orders/amendments/reclaim-business-no`, {
      method: 'POST',
      headers: writeHeaders(adminSession),
      body: JSON.stringify({ ...routeBody, permanentDeletePassword: 'wrong-password-value' }),
    })
    assert.equal(wrongPasswordResponse.status, 403, '错误永久删除密码必须在路由层拦截')
    assert.equal((await orderRepo.findOneByOrFail({ id: target029.order.id })).businessNo, 'hyyz000029')

    const departmentCursorBefore = Number((await sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.department' })).currentValue)
    const originalReclaimBusinessNo = api.reclaimBusinessNo
    let capturedRouteServiceInput: { amendment: AmendmentInput } | null = null
    api.reclaimBusinessNo = async (...args) => {
      capturedRouteServiceInput = args[0]
      return originalReclaimBusinessNo.call(api, ...args)
    }
    let committed: AmendmentPreview
    try {
      const successResponse = await fetch(`${baseUrl}/api/orders/amendments/reclaim-business-no`, {
        method: 'POST',
        headers: writeHeaders(adminSession),
        body: JSON.stringify(routeBody),
      })
      const successPayload = await readJson(successResponse)
      assert.equal(successResponse.status, 200, `正确永久删除密码的 HTTP 回收应成功：${JSON.stringify(successPayload)}`)
      committed = successPayload.data as AmendmentPreview
    } finally {
      api.reclaimBusinessNo = originalReclaimBusinessNo
    }
    assert.ok(capturedRouteServiceInput, '真实 HTTP 成功路径必须进入订单服务')
    assert.deepEqual(Object.keys(capturedRouteServiceInput), ['amendment'], '路由向服务只传 amendment 包装，不得传永久删除密码')
    assert.equal(JSON.stringify(capturedRouteServiceInput).includes(permanentDeletePassword), false, '路由不得把永久删除密码传入订单服务')
    assert.equal(committed.ready, true)
    assert.deepEqual(committed.cursorPlans, [{
      namespace: 'hyyz',
      beforeCursor: 104,
      afterCursor: 104,
      nextBusinessNo: 'hyyz000105',
    }], '正式提交必须保留事务时点业务号单调高水位，不得因物理占用降低游标')
    const targetAfterFirstReuse = await orderRepo.findOneByOrFail({ id: target029.order.id })
    assert.equal(targetAfterFirstReuse.businessNo, 'hyyz000100')
    assert.equal(Number(targetAfterFirstReuse.editVersion), Number(target029Entity.editVersion) + 1)
    const occupancyAfterFirstReuse = await occupancyRepo.findOneByOrFail({ businessNo: 'hyyz000100' })
    assert.equal(occupancyAfterFirstReuse.orderUuid, source100Entity.orderUuid, '首次持有人必须保持不变')
    assert.equal(occupancyAfterFirstReuse.lastAssignedOrderUuid, targetAfterFirstReuse.orderUuid)
    assert.equal(Number(occupancyAfterFirstReuse.reuseCount), 1)
    assert.equal(Number((await sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.walkin' })).currentValue), 104)
    assert.equal(Number((await sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.department' })).currentValue), departmentCursorBefore, '另一命名空间游标不得变化')
    const firstEvent = await eventRepo.findOneByOrFail({ businessNo: 'hyyz000100', reuseCount: 1 })
    assert.equal(firstEvent.fromOrderUuid, source100Entity.orderUuid)
    assert.equal(firstEvent.toOrderUuid, targetAfterFirstReuse.orderUuid)
    assert.equal(firstEvent.targetOrderIdSnapshot, String(targetAfterFirstReuse.id))
    assert.equal(firstEvent.targetSystemNoSnapshot, targetAfterFirstReuse.systemNo)
    await assert.rejects(
      () => eventRepo.update({ id: firstEvent.id }, { reason: '不应允许篡改' }),
      /ORDER_BUSINESS_NO_REUSE_EVENT_APPEND_ONLY/,
      '复用事件必须禁止更新',
    )
    await assert.rejects(
      () => eventRepo.delete({ id: firstEvent.id }),
      /ORDER_BUSINESS_NO_REUSE_EVENT_APPEND_ONLY/,
      '复用事件必须禁止删除',
    )
    const firstRevision = await revisionRepo.findOneByOrFail({ orderUuid: targetAfterFirstReuse.orderUuid, revisionNo: Number(targetAfterFirstReuse.editVersion) })
    const firstAudit = await auditRepo.findOneByOrFail({ actionType: 'order.business_no_reclaim', targetId: String(targetAfterFirstReuse.id) })
    const sensitiveDump = `${firstRevision.beforeSnapshotJson}${firstRevision.afterSnapshotJson}${firstRevision.reason}${firstAudit.detailJson}${JSON.stringify(firstEvent)}`
    assert.equal(sensitiveDump.includes(permanentDeletePassword), false, 'revision/audit/reuse event 不得记录永久删除密码')
    assert.equal(firstAudit.targetCode, targetAfterFirstReuse.businessNo, '审计 targetCode 必须使用事件时 businessNo')

    // 多次复用链：第一次目标永久删除后，第二个目标可继续回收同一号码，事件链必须连续。
    await purgeAsLegacy(String(targetAfterFirstReuse.id))
    const chainTarget = activeTarget
    const chainTargetEntity = await orderRepo.findOneByOrFail({ id: chainTarget.order.id })
    await api.reclaimBusinessNo({ amendment: {
      orderId: String(chainTarget.order.id),
      editVersion: Number(chainTargetEntity.editVersion),
      businessNo: 'hyyz000100',
      reclaimBusinessNo: true,
      reason: 'Issue110 第二次回收',
    } }, adminActor)
    const occupancyAfterSecondReuse = await occupancyRepo.findOneByOrFail({ businessNo: 'hyyz000100' })
    assert.equal(Number(occupancyAfterSecondReuse.reuseCount), 2)
    assert.equal(occupancyAfterSecondReuse.lastAssignedOrderUuid, (await orderRepo.findOneByOrFail({ id: chainTarget.order.id })).orderUuid)
    const chainEvents = await eventRepo.find({ where: { businessNo: 'hyyz000100' }, order: { reuseCount: 'ASC' } })
    assert.equal(chainEvents.length, 2)
    assert.equal(chainEvents[1]?.fromOrderUuid, targetAfterFirstReuse.orderUuid)
    assert.equal(chainEvents[1]?.toOrderUuid, occupancyAfterSecondReuse.lastAssignedOrderUuid)

    // 失败回滚：审计异常必须连同订单、占用转移、事件和 revision 全部回滚。
    await setWalkinBusinessCursorFixture(699)
    const rollbackSource = await submitOrder('walkin')
    const rollbackSourceEntity = await assignBusinessNo(String(rollbackSource.order.id), 'hyyz000500')
    await purgeAsLegacy(String(rollbackSource.order.id))
    const rollbackTarget = await submitOrder('walkin')
    const rollbackTargetBefore = await orderRepo.findOneByOrFail({ id: rollbackTarget.order.id })
    const originalAuditRecord = auditService.record.bind(auditService)
    ;(auditService as { record: typeof auditService.record }).record = async () => {
      throw new Error('issue110-audit-rollback')
    }
    try {
      await assert.rejects(() => api.reclaimBusinessNo({ amendment: {
        orderId: String(rollbackTarget.order.id),
        editVersion: Number(rollbackTargetBefore.editVersion),
        businessNo: 'hyyz000500',
        reclaimBusinessNo: true,
        reason: 'Issue110 回滚验证',
      } }, adminActor), /issue110-audit-rollback/)
    } finally {
      ;(auditService as { record: typeof auditService.record }).record = originalAuditRecord
    }
    const rollbackOccupancy = await occupancyRepo.findOneByOrFail({ businessNo: 'hyyz000500' })
    assert.equal(rollbackOccupancy.lastAssignedOrderUuid, rollbackSourceEntity.orderUuid)
    assert.equal(Number(rollbackOccupancy.reuseCount), 0)
    assert.equal((await orderRepo.findOneByOrFail({ id: rollbackTarget.order.id })).businessNo, rollbackTargetBefore.businessNo)
    assert.equal(await eventRepo.count({ where: { businessNo: 'hyyz000500' } }), 0)

    // 同号并发争抢：SQLite 写事务队列下也必须仅一笔成功，失败方不得留下局部痕迹。
    const concurrentSource = await submitOrder('walkin')
    await assignBusinessNo(String(concurrentSource.order.id), 'hyyz000600')
    await purgeAsLegacy(String(concurrentSource.order.id))
    const concurrentA = await submitOrder('walkin')
    const concurrentB = await submitOrder('walkin')
    const concurrentAEntity = await orderRepo.findOneByOrFail({ id: concurrentA.order.id })
    const concurrentBEntity = await orderRepo.findOneByOrFail({ id: concurrentB.order.id })
    const concurrentResults = await Promise.allSettled([
      api.reclaimBusinessNo({ amendment: {
        orderId: String(concurrentA.order.id), editVersion: Number(concurrentAEntity.editVersion), businessNo: 'hyyz000600', reclaimBusinessNo: true, reason: 'Issue110 并发 A',
      } }, adminActor),
      api.reclaimBusinessNo({ amendment: {
        orderId: String(concurrentB.order.id), editVersion: Number(concurrentBEntity.editVersion), businessNo: 'hyyz000600', reclaimBusinessNo: true, reason: 'Issue110 并发 B',
      } }, adminActor),
    ])
    assert.equal(concurrentResults.filter((item) => item.status === 'fulfilled').length, 1, '同号并发只能一笔成功')
    assert.equal(concurrentResults.filter((item) => item.status === 'rejected').length, 1)
    assert.equal(await eventRepo.count({ where: { businessNo: 'hyyz000600' } }), 1)
    assert.equal(await orderRepo.countBy({ businessNo: 'hyyz000600' }), 1)

    const migrationSource = fs.readFileSync(migrationPath, 'utf8')
    assert.match(migrationSource, /last_assigned_order_uuid/)
    assert.match(migrationSource, /last_assigned_at/)
    assert.match(migrationSource, /reuse_count/)
    assert.match(migrationSource, /order_business_no_reuse_event/)
    assert.match(migrationSource, /last_assigned_order_uuid`\s*=\s*`order_uuid`/i, '054 必须回填存量最后持有人')
    assert.match(migrationSource, /reuse_count`\s*=\s*0/i, '054 必须回填存量复用次数')

    const routeSource = fs.readFileSync(path.resolve(backendRoot, 'src/routes/order.routes.ts'), 'utf8')
    assert.match(routeSource, /'\/amendments\/reclaim-business-no'[\s\S]*requirePermission\('orders:update'\)[\s\S]*requireRole\('admin'\)/)
    assert.match(routeSource, /assertPermanentDeletePassword\([^)]*permanentDeletePassword[^)]*\)[\s\S]*reclaimBusinessNo\(/, '路由必须先验永久删除密码，且服务调用不得接收密码')

    const amendmentServiceSource = fs.readFileSync(path.resolve(backendRoot, 'src/services/order-amendment.service.ts'), 'utf8')
    assert.match(
      amendmentServiceSource,
      /RECLAIM_TRANSACTION_OPTIONS\s*=\s*\{\s*mysqlIsolationLevel:\s*'READ COMMITTED'\s*\}[\s\S]*runInTransaction\([\s\S]*RECLAIM_TRANSACTION_OPTIONS\)/,
      'MySQL 回收事务必须显式选择 READ COMMITTED，确保序列锁后的物理最大号查询使用当前读快照',
    )

    const dialogSource = fs.readFileSync(path.resolve(backendRoot, '..', 'src/views/order-list/components/OrderAmendmentDialog.vue'), 'utf8')
    assert.match(dialogSource, /reclaimBusinessNo/)
    assert.match(dialogSource, /回收并提交/)
    assert.match(dialogSource, /inputType:\s*'password'/)
    assert.match(dialogSource, /authStore\.currentUser\?\.role\s*===\s*'admin'/)

    console.log('✅ Issue #110 订单业务号回收复用专项验证通过')
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()))
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanup()
  }
}

main().catch(async (error) => {
  console.error('❌ Issue #110 订单业务号回收复用专项验证失败', error)
  try {
    const { AppDataSource } = await import('../src/config/data-source.js')
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  } catch {
    // 初始化前失败时无数据源可关闭。
  }
  cleanup()
  process.exitCode = 1
})
