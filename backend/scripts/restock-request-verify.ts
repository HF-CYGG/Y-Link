/**
 * 补货闭环专项：使用任务独立 SQLite，或显式提供的隔离 MySQL 容器端口。
 * 覆盖真实 HTTP 权限、事务去重、状态门禁、原子性、到期派生、历史排名与库存不变。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRestockTestRuntime } from './restock-test-runtime.js'

const runtime = await createRestockTestRuntime({ mysql: process.argv.includes('--mysql') })
const { AppDataSource: db, clientFeedbackService: feedback, dashboardService: dashboard, products: p, entities: e } = runtime
const requestRepo = db.getRepository(e.ClientRestockRequest)
const { server, baseUrl } = await runtime.listen()
const { auditService } = await import('../src/services/audit.service.js')
const { notificationService } = await import('../src/services/notification.service.js')
const { customerServiceRealtimeService: realtime } = await import('../src/services/customer-service-realtime.service.js')
const { runInTransaction } = await import('../src/config/transaction-runner.js')
const { lockActiveSysAccountForBusiness } = await import('../src/services/account-business-guard.service.js')
const events: Array<{ conversationId: string; eventType: string }> = []
const originalPublish = realtime.publishConversationEvent
realtime.publishConversationEvent = function (event) { events.push({ conversationId: event.conversationId, eventType: event.eventType }); return originalPublish.call(this, event) }
const future = () => new Date(Math.ceil((Date.now() + 3600000) / 60000) * 60000).toISOString()
let seq = 0
const input = (product = p.empty, sku = p.emptySku, overrides: Record<string, unknown> = {}) => ({ productId: String(product.id), skuId: String(sku.id), quantity: 1, latestPickupAt: future(), clientRequestId: `restock_verify_${++seq}`, ...overrides })
const pass = (name: string) => console.log(`✅ 补货：${name}`)

async function http(url: string, token: string | null, method = 'GET', body?: unknown, status = 200): Promise<any> {
  const response = await fetch(`${baseUrl}/api${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.json() as { code: number; data: unknown; message: string }
  assert.equal(response.status, status, `${method} ${url}：${JSON.stringify(payload)}`)
  if (status === 200) assert.equal(payload.code, 0)
  return payload.data
}
const create = (payload = input(), client = runtime.client) => http('/client-feedback/restock-requests', client.token, 'POST', payload)
const take = (id: string, operator = runtime.operator) => http(`/customer-service/conversations/${id}/assignee`, operator.token, 'PATCH', { assigneeUserId: operator.auth.userId })
async function counts() {
  return {
    requests: await requestRepo.count(), keys: await db.getRepository(e.ClientRestockRequestKey).count(),
    conversations: await db.getRepository(e.ClientFeedbackConversation).count(), messages: await db.getRepository(e.ClientFeedbackMessage).count(),
    audit: await db.getRepository(e.SysAuditLog).count(), notifications: await db.getRepository(e.NotificationEvent).count(), events: events.length,
  }
}
async function stock() {
  return { products: await db.getRepository(e.BaseProduct).find({ select: ['id', 'currentStock', 'preOrderedStock'], order: { id: 'ASC' } }),
    skus: await db.getRepository(e.BaseProductSku).find({ select: ['id', 'currentStock', 'preOrderedStock'], order: { id: 'ASC' } }),
    logs: await db.getRepository(e.InventoryLog).count(), preorders: await db.getRepository(e.O2oPreorder).count() }
}

try {
  if (process.argv.includes('--mysql')) {
    const { splitSqlStatements, assertMysqlRequiredSchemaExists } = await import('../src/config/mysql-migration-runner.js')
    const runSql = async (sql: string) => {
      const runner = db.createQueryRunner()
      await runner.connect()
      try { for (const statement of splitSqlStatements(sql)) await runner.query(statement) }
      finally { await runner.release() }
    }
    // 只补自己创建的空随机库基线；实体同步无法表达既有045的MySQL CHECK，不能删除全库启动断言。
    await runSql(fs.readFileSync(path.resolve('sql/045_order_merge_governance.sql'), 'utf8'))
    // 同步实体不表达账号追加保护触发器；仅在自己创建的空测试库复用既存 044 的四条触发器 DDL。
    const accountSql = fs.readFileSync(path.resolve('sql/044_account_lifecycle_governance.sql'), 'utf8')
    const triggerStatements = splitSqlStatements(accountSql).filter((statement) => /^(DROP|CREATE)\s+TRIGGER\s/i.test(statement.replace(/--[^\r\n]*/g, '').trim()))
    assert.equal(triggerStatements.length, 4, '既存 044 的账号保护触发器设置发生变化，需要重新核实测试初始化')
    for (const statement of triggerStatements) await db.query(statement)
    const sql = fs.readFileSync(path.resolve('sql/061_client_restock_requests.sql'), 'utf8')
    const checkViolation = (name: string) => (error: any) => (error.driverError?.code ?? error.code) === 'ER_CHECK_CONSTRAINT_VIOLATED' && String(error.message).includes(name)
    // 模拟先由同步建表、尚无CHECK的状态，构造非法历史数据验证060只失败关闭、不改写数据。
    const existingChecks = await db.query("SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'client_restock_request' AND CONSTRAINT_TYPE = 'CHECK'") as Array<{ name: string }>
    for (const { name } of existingChecks) {
      assert.ok(['ck_restock_quantity_positive', 'ck_restock_status'].includes(name))
      await db.query(`ALTER TABLE client_restock_request DROP CHECK \`${name}\``)
    }
    const checkConversation = await feedback.createConversation({ subject: '补货约束隔离夹具', content: '仅供非法历史数据验证' }, runtime.client.auth)
    const fixture = { conversationId: String(checkConversation.conversation.id), clientUserId: runtime.client.auth.userId, productId: String(p.empty.id), skuId: String(p.emptySku.id),
      productNameSnapshot: p.empty.productName, productCodeSnapshot: p.empty.productCode, skuCodeSnapshot: p.emptySku.skuCode, specTextSnapshot: p.emptySku.specText,
      latestPickupAt: new Date(future()), clientRequestId: 'check_invalid_history', payloadDigest: '0'.repeat(64), handledAt: null, remark: null }
    const badQuantity = await requestRepo.save(requestRepo.create({ ...fixture, quantity: 0, status: 'requested' }))
    await assert.rejects(() => runSql(sql), checkViolation('ck_restock_quantity_positive'))
    assert.equal((await requestRepo.findOneByOrFail({ id: badQuantity.id })).quantity, 0, '非法历史数量不能被迁移静默修正或删除')
    await requestRepo.delete({ id: badQuantity.id })
    const badStatus = await requestRepo.save(requestRepo.create({ ...fixture, quantity: 1, status: 'invalid' as any }))
    await assert.rejects(() => runSql(sql), checkViolation('ck_restock_status'))
    assert.equal((await requestRepo.findOneByOrFail({ id: badStatus.id })).status, 'invalid', '非法历史状态不能被迁移静默修正或删除')
    await requestRepo.delete({ id: badStatus.id })
    await runSql(sql)
    await runSql(sql)
    await assertMysqlRequiredSchemaExists(db)
    pass('060补齐同步先建表的CHECK、重复执行幂等，非法历史数量/状态失败关闭且保留原值')
    await db.query('DROP TABLE client_restock_request_key')
    await db.query('DROP TABLE client_restock_request')
    await assert.rejects(() => assertMysqlRequiredSchemaExists(db), /061_client_restock_requests\.sql/)
    for (let round = 0; round < 2; round += 1) await runSql(sql)
    await assertMysqlRequiredSchemaExists(db)
    await assert.rejects(() => requestRepo.insert({ ...fixture, quantity: 0, status: 'requested' }), checkViolation('ck_restock_quantity_positive'))
    await assert.rejects(() => requestRepo.insert({ ...fixture, quantity: 1, status: 'invalid' as any }), checkViolation('ck_restock_status'))
    const { normalizeStaticCheckClause } = await import('../src/utils/mysql-check-clause.js')
    const checks = await db.query(`SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
      FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'client_restock_request' AND tc.CONSTRAINT_TYPE = 'CHECK'`) as Array<{ name: string; clause: string }>
    assert.equal(checks.length, 2)
    for (const check of checks) {
      const entityCheck = db.getMetadata(e.ClientRestockRequest).checks.find((item) => item.name === check.name)
      assert.ok(entityCheck)
      assert.ok(normalizeStaticCheckClause(entityCheck.expression))
      assert.equal(normalizeStaticCheckClause(check.clause), normalizeStaticCheckClause(entityCheck.expression))
    }
    fs.writeFileSync(path.join(runtime.runtimeDir, 'mysql-restock-check-metadata.json'), JSON.stringify(checks, null, 2))
    pass('真实 MySQL 061 增量脚本可重放，默认不开自动迁移时缺表阻断启动')

    // 强制两名不同账号均完成空当前读，再一起竞争同商品锁；同账号锁无法掩盖 RR gap-lock 环。
    const isolation = await db.query('SELECT @@transaction_isolation AS isolationLevel') as Array<{ isolationLevel: string }>
    assert.equal(isolation[0]?.isolationLevel, 'REPEATABLE-READ', '跨账号交错专项必须使用真实RR隔离级别')
    const privateFeedback = feedback as unknown as { findRestockInTransaction: (...args: any[]) => Promise<any>; buildConversationNo: (...args: any[]) => Promise<string> }
    for (const distinctSku of [false, true]) {
      const product = await runtime.productService.create({ productName: `跨账号交错${distinctSku ? '不同规格' : '相同规格'}`, defaultPrice: 10, isActive: true, o2oStatus: 'listed',
        specGroups: [{ name: '颜色', values: ['红色', '蓝色'] }], skus: [
          { specValues: { 颜色: '红色' }, currentStock: 0, defaultPrice: 10 },
          { specValues: { 颜色: '蓝色' }, currentStock: 0, defaultPrice: 10 },
        ] }, runtime.admin.auth)
      const skus = await db.getRepository(e.BaseProductSku).find({ where: { productId: product.id, isCurrent: true }, order: { id: 'ASC' } })
      // 每个场景都使用新账号，空键与活跃查询位于所有既有账号之后的同一supremum gap。
      const actors = [
        await runtime.createClient(distinctSku ? '13900000903' : '13900000901', '跨账号交错客户甲'),
        await runtime.createClient(distinctSku ? '13900000904' : '13900000902', '跨账号交错客户乙'),
      ]
      const initialCounts = await counts()
      const initialStock = await stock()
      const originalFind = privateFeedback.findRestockInTransaction
      let releaseReaders!: () => void
      const allReaders = new Promise<void>((resolve) => { releaseReaders = resolve })
      const firstReads = new Set<string>()
      const connections = new Set<string>()
      let completedFirstReads = 0
      let readAttempts = 0
      privateFeedback.findRestockInTransaction = async function (manager, clientId, filter, now) {
        const result = await originalFind.call(this, manager, clientId, filter, now)
        readAttempts += 1
        if (!firstReads.has(clientId)) {
          firstReads.add(clientId)
          const connection = (await manager.query('SELECT CONNECTION_ID() AS id, @@transaction_isolation AS isolationLevel'))[0]
          assert.equal(connection.isolationLevel, 'REPEATABLE-READ')
          connections.add(String(connection.id))
          completedFirstReads += 1
          if (completedFirstReads === 2) { assert.equal(connections.size, 2, '跨账号交错必须持有两条真实事务连接'); releaseReaders() }
          await allReaders
        }
        return result
      }
      try {
        const results = await Promise.all([
          feedback.createRestockRequest(input(product, skus[0]!), actors[0]!.auth),
          feedback.createRestockRequest(input(product, skus[distinctSku ? 1 : 0]!), actors[1]!.auth),
        ])
        assert.ok(results.every((result) => result.created))
        assert.equal(new Set(results.map((result) => String(result.conversation.id))).size, 2)
        assert.ok(readAttempts > 2, '交错场景必须实际触发完整事务重放，不能只做非交错成功请求')
        console.log(`真实RR交错${distinctSku ? '不同SKU' : '同SKU'}：connections=${connections.size}，activeReads=${readAttempts}`)
        const completedCounts = await counts()
        for (const key of ['requests', 'keys', 'conversations', 'messages', 'audit', 'notifications', 'events'] as const) assert.equal(completedCounts[key] - initialCounts[key], 2)
        assert.deepEqual(await stock(), initialStock)
      } finally { privateFeedback.findRestockInTransaction = originalFind; releaseReaders() }
    }
    pass('真实 MySQL RR跨账号首次同商品/不同SKU交错，死锁后完整事务重放且每账号仅计一次')

    // 输入仍是未来的合法分钟；仅在真实编号行锁等待后推进服务端时钟，避免验收固定等待一分钟。
    const deadlineProduct = await runtime.productService.create({ productName: '编号锁截止测试商品', defaultPrice: 10, currentStock: 0, isActive: true, o2oStatus: 'listed' }, runtime.admin.auth)
    const deadlineSku = await db.getRepository(e.BaseProductSku).findOneByOrFail({ productId: deadlineProduct.id, isCurrent: true })
    let releaseNumberLock!: () => void
    let numberLocked!: () => void
    const heldNumberLock = new Promise<void>((resolve) => { numberLocked = resolve })
    const releaseNumber = new Promise<void>((resolve) => { releaseNumberLock = resolve })
    const blocker = runInTransaction(async (manager) => {
      await manager.query('SELECT conversation_no FROM client_feedback_conversation ORDER BY conversation_no DESC LIMIT 1 FOR UPDATE')
      numberLocked()
      await releaseNumber
    })
    await heldNumberLock
    const beforeDeadline = await counts()
    let numberEntered!: () => void
    const enteredNumber = new Promise<void>((resolve) => { numberEntered = resolve })
    let numberFinished = false
    const originalNumber = privateFeedback.buildConversationNo
    privateFeedback.buildConversationNo = async function (...args) {
      const pending = originalNumber.apply(this, args)
      numberEntered()
      const value = await pending
      numberFinished = true
      return value
    }
    const originalNow = Date.now
    const deadlinePayload = input(deadlineProduct, deadlineSku)
    const deadlineCreation = feedback.createRestockRequest(deadlinePayload, runtime.client.auth)
    const deadlineFailure = assert.rejects(() => deadlineCreation, /最晚取货时间已到/)
    try {
      await enteredNumber
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(numberFinished, false, '创建必须实际等待编号锁')
      Date.now = () => Date.parse(deadlinePayload.latestPickupAt)
      releaseNumberLock()
      await blocker
      await deadlineFailure
    } finally { Date.now = originalNow; privateFeedback.buildConversationNo = originalNumber; releaseNumberLock(); await blocker }
    assert.deepEqual(await counts(), beforeDeadline, '编号等待跨截止必须完整回滚，不产生需求、键、会话、消息、审计、通知或SSE')
    pass('真实编号锁等待后跨未来分钟截止，创建拒绝且无持久副作用')
  }

  await http('/client-feedback/restock-requests/active?skuId=1', null, 'GET', undefined, 401)
  await http('/dashboard/restock-ranking', runtime.supplier.token, 'GET', undefined, 403)
  await http('/customer-service/conversations/1/restock', runtime.supplier.token, 'PATCH', { status: 'accepted' }, 403)
  for (const invalid of [0, -1, 1.5, '2', 2147483648]) await http('/client-feedback/restock-requests', runtime.client.token, 'POST', input(p.empty, p.emptySku, { quantity: invalid }), 400)
  for (const invalid of ['2020-01-01T10:00:00+08:00', future().slice(0, -1), '2028-02-31T12:00:00+08:00', future().replace(':00.000Z', ':01.000Z')]) {
    await http('/client-feedback/restock-requests', runtime.client.token, 'POST', input(p.empty, p.emptySku, { latestPickupAt: invalid }), 400)
  }
  await http('/client-feedback/restock-requests', runtime.client.token, 'POST', input(p.stocked, p.stockedSku), 409)
  await http('/client-feedback/restock-requests', runtime.client.token, 'POST', input(p.empty, p.stockedSku), 409)
  await db.getRepository(e.BaseProductSku).update({ id: p.emptySku.id }, { isActive: false })
  await http('/client-feedback/restock-requests', runtime.client.token, 'POST', input(), 409)
  await db.getRepository(e.BaseProductSku).update({ id: p.emptySku.id }, { isActive: true, isCurrent: false })
  await http('/client-feedback/restock-requests', runtime.client.token, 'POST', input(), 409)
  await db.getRepository(e.BaseProductSku).update({ id: p.emptySku.id }, { isCurrent: true })
  await db.getRepository(e.BaseProduct).update({ id: p.empty.id }, { o2oStatus: 'unlisted' })
  await http('/client-feedback/restock-requests', runtime.client.token, 'POST', input(), 409)
  await db.getRepository(e.BaseProduct).update({ id: p.empty.id }, { o2oStatus: 'listed' })
  await http('/client-feedback/conversations', runtime.client.token, 'POST', { issueType: 'restock', subject: '伪造补货', content: '伪造补货' }, 400)
  pass('权限、商品/SKU/当前规格、缺货和数量时间校验')

  const inventoryBefore = await stock()
  const beforeCreate = await counts()
  const messageDeadline = new Date(Date.now() + 3 * 86400_000)
  messageDeadline.setUTCHours(16, 20, 0, 0)
  const payload = input(p.empty, p.emptySku, { quantity: 3, remark: '请保留蓝色包装', latestPickupAt: messageDeadline.toISOString() })
  const created = await create(payload)
  const id = String(created.conversation.id)
  assert.equal(created.created, true)
  const expectedPickupTime = new Date(messageDeadline.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
  assert.ok(created.message.content.includes(`最晚取货时间 ${expectedPickupTime}（UTC+8）`), '跨UTC日期的公开首消息必须明确UTC+8分钟时间')
  assert.equal(new Date(created.conversation.restock.latestPickupAt).toISOString(), messageDeadline.toISOString(), '消息展示不改变DTO与存储的ISO时刻')
  assert.equal(created.conversation.fields.issueType, 'restock')
  assert.equal(created.conversation.restock.quantity, 3)
  assert.equal(created.conversation.restock.effectiveStatus, 'requested')
  assert.equal(created.conversation.restock.specTextSnapshot, '默认规格')
  assert.ok(created.serverNow && created.conversation.serverNow)
  const afterCreate = await counts()
  for (const key of ['requests', 'keys', 'conversations', 'messages', 'audit', 'notifications', 'events'] as const) assert.equal(afterCreate[key] - beforeCreate[key], 1, `新建只应增加一条 ${key}`)
  const retry = await create(payload)
  assert.equal(retry.created, false)
  assert.equal(String(retry.conversation.id), id)
  assert.equal(retry.message, null)
  assert.deepEqual(await counts(), afterCreate)
  await http('/client-feedback/restock-requests', runtime.client.token, 'POST', { ...payload, quantity: 4 }, 409)
  const alias = input(p.empty, p.emptySku, { quantity: 9 })
  const duplicate = await create(alias)
  assert.equal(duplicate.created, false)
  assert.equal(String(duplicate.conversation.id), id)
  assert.deepEqual(await counts(), { ...afterCreate, keys: afterCreate.keys + 1 })
  await http('/client-feedback/restock-requests', runtime.client.token, 'POST', { ...alias, quantity: 10 }, 409)
  const active = await http(`/client-feedback/restock-requests/active?skuId=${p.emptySku.id}`, runtime.client.token)
  assert.equal(String(active.restock.conversationId), id)
  assert.equal((await http(`/client-feedback/restock-requests/active?skuId=${p.emptySku.id}`, runtime.otherClient.token)).restock, null)
  await http(`/client-feedback/conversations/${id}`, runtime.otherClient.token, 'GET', undefined, 404)
  const concurrentBefore = await counts()
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => create(input(p.multi, p.multiEmptySku))))
  assert.equal(new Set(concurrent.map((result) => String(result.conversation.id))).size, 1)
  assert.equal(concurrent.filter((result) => result.created).length, 1)
  assert.equal((await counts()).requests - concurrentBefore.requests, 1)
  assert.equal((await counts()).messages - concurrentBefore.messages, 1)
  assert.equal((await counts()).notifications - concurrentBefore.notifications, 1)
  assert.deepEqual(await stock(), inventoryBefore)
  // 库存恢复以后仍必须先返回原需求，而不是被新建库存门禁挡住。
  await db.getRepository(e.BaseProductSku).update({ id: p.emptySku.id }, { currentStock: 2 })
  assert.equal(String((await create(input())).conversation.id), id)
  assert.equal(String((await http(`/client-feedback/restock-requests/active?skuId=${p.emptySku.id}`, runtime.client.token)).restock.conversationId), id)
  await db.getRepository(e.BaseProductSku).update({ id: p.emptySku.id }, { currentStock: 0 })
  pass('同键/异键/并发去重、账号隔离、库存恢复后回读原需求，库存与预订单完全不变')

  await http(`/customer-service/conversations/${id}/restock`, runtime.operator.token, 'PATCH', { status: 'accepted' }, 400)
  await take(id)
  const beforeSkippedAccept = await counts()
  await http(`/customer-service/conversations/${id}/restock`, runtime.operator.token, 'PATCH', { status: 'restocked' }, 409)
  assert.deepEqual(await counts(), beforeSkippedAccept, 'requested不能跳过accepted，拒绝时不留状态/消息/审计/SSE')
  assert.equal((await requestRepo.findOneByOrFail({ conversationId: id })).status, 'requested')
  await http(`/customer-service/conversations/${id}/restock`, runtime.otherOperator.token, 'PATCH', { status: 'accepted' }, 400)
  await http(`/customer-service/conversations/${id}/status`, runtime.operator.token, 'PATCH', { status: 'resolved' }, 409)
  await http(`/customer-service/conversations/${id}/fields`, runtime.operator.token, 'PATCH', { issueType: 'bug' }, 409)
  const beforeAccept = await counts()
  const accepted = await http(`/customer-service/conversations/${id}/restock`, runtime.operator.token, 'PATCH', { status: 'accepted', publicNote: '已安排补货' })
  assert.equal(accepted.conversation.restock.effectiveStatus, 'accepted')
  assert.equal(accepted.conversation.status, 'processing')
  assert.match(accepted.message.content, /已安排补货/)
  const afterAccept = await counts()
  assert.equal(afterAccept.messages - beforeAccept.messages, 1)
  assert.equal(afterAccept.audit - beforeAccept.audit, 1)
  const repeatedAccept = await http(`/customer-service/conversations/${id}/restock`, runtime.operator.token, 'PATCH', { status: 'accepted' })
  assert.equal(repeatedAccept.changed, false)
  assert.deepEqual(await counts(), afterAccept, '重复accepted保持无副作用幂等')
  await http(`/client-feedback/conversations/${id}/messages`, runtime.client.token, 'POST', { content: '谢谢，请继续跟进' })
  const detail = await http(`/client-feedback/conversations/${id}`, runtime.client.token)
  assert.equal(detail.conversation.restock.effectiveStatus, 'accepted')
  assert.equal('internalRemark' in detail, false)
  await http(`/customer-service/conversations/${id}/internal-remark`, runtime.operator.token, 'PUT', { content: '内部敏感协同文字' })
  assert.equal(JSON.stringify(await http(`/client-feedback/conversations/${id}`, runtime.client.token)).includes('内部敏感协同文字'), false)
  const restocked = await http(`/customer-service/conversations/${id}/restock`, runtime.operator.token, 'PATCH', { status: 'restocked', publicNote: '请回商城查看并下单' })
  assert.equal(restocked.conversation.restock.effectiveStatus, 'restocked')
  assert.equal(restocked.conversation.status, 'resolved')
  assert.match(restocked.message.content, /返回商城.*按现有流程下单/, '到货通知不能误导为已有订单或库存预留')
  await http(`/client-feedback/conversations/${id}/confirm-resolved`, runtime.client.token, 'PATCH')
  await http(`/customer-service/conversations/${id}/status`, runtime.operator.token, 'PATCH', { status: 'open' }, 409)
  assert.deepEqual(await stock(), inventoryBefore)
  pass('当前负责人处理、公开说明、聊天独立状态、完成门禁与内部信息隔离')

  // 注入事务末端失败，确认需求状态、消息、审计和提交后 SSE 都不留下半成功。
  const atomic = await create(input(), runtime.otherClient)
  const atomicId = String(atomic.conversation.id)
  await take(atomicId)
  const beforeFailure = await counts()
  const originalAudit = auditService.record
  auditService.record = async function (entry, manager) {
    if (entry.actionType === 'customer_service.restock_status') throw new Error('restock-verify-injected-audit-failure')
    return originalAudit.call(this, entry, manager)
  }
  try { await assert.rejects(() => feedback.updateRestockRequest(atomicId, { status: 'accepted' }, runtime.operator.auth), /injected-audit-failure/) }
  finally { auditService.record = originalAudit }
  assert.deepEqual(await counts(), beforeFailure)
  assert.equal((await requestRepo.findOneByOrFail({ conversationId: atomicId })).status, 'requested')
  const originalNotify = notificationService.emitEvent
  notificationService.emitEvent = async function () { throw new Error('restock-verify-injected-notification-failure') }
  try { await assert.rejects(() => feedback.createRestockRequest(input(p.multi, p.multiEmptySku), runtime.otherClient.auth), /injected-notification-failure/) }
  finally { notificationService.emitEvent = originalNotify }
  assert.deepEqual(await counts(), beforeFailure)
  pass('消息/状态/审计/通知原子提交与失败不发 SSE')

  const atomicRequest = await requestRepo.findOneByOrFail({ conversationId: atomicId })
  await requestRepo.update({ id: atomicRequest.id }, { latestPickupAt: new Date(Date.now() + 100) })
  let releaseBlock!: () => void
  let enteredBlock!: () => void
  const entered = new Promise<void>((resolve) => { enteredBlock = resolve })
  const blocked = new Promise<void>((resolve) => { releaseBlock = resolve })
  const blocker = runInTransaction(async (manager) => { await lockActiveSysAccountForBusiness(manager, runtime.operator.auth.userId); enteredBlock(); await blocked })
  await entered
  const lateUpdate = feedback.updateRestockRequest(atomicId, { status: 'accepted' }, runtime.operator.auth)
  const expectedLateFailure = assert.rejects(() => lateUpdate, /过期/)
  await new Promise((resolve) => setTimeout(resolve, 160))
  releaseBlock()
  await blocker
  await expectedLateFailure
  assert.equal((await http(`/client-feedback/conversations/${atomicId}`, runtime.otherClient.token)).conversation.restock.effectiveStatus, 'expired')
  assert.equal((await http(`/client-feedback/restock-requests/active?skuId=${p.emptySku.id}`, runtime.otherClient.token)).restock, null)
  await http(`/client-feedback/conversations/${atomicId}/withdraw`, runtime.otherClient.token, 'PATCH')
  assert.equal((await requestRepo.findOneByOrFail({ id: atomicRequest.id })).status, 'requested', '关闭过期需求不能改成 cancelled')
  const next = await create(input(), runtime.otherClient)
  assert.notEqual(String(next.conversation.id), atomicId)
  await http(`/client-feedback/conversations/${next.conversation.id}/withdraw`, runtime.otherClient.token, 'PATCH')
  assert.equal((await requestRepo.findOneByOrFail({ conversationId: String(next.conversation.id) })).status, 'cancelled')
  const aliasReplay = await create(alias)
  assert.equal(String(aliasReplay.conversation.id), id)
  assert.equal(aliasReplay.conversation.restock.effectiveStatus, 'restocked')
  pass('锁等待后到期复核、自然释放资格、过期撤回保留expired、未到期撤回cancelled及历史键重放')

  // 同商品不同 SKU 各记一次；实际数量不参与“申请次数”统计，终态不从历史计次中移除。
  await db.getRepository(e.BaseProductSku).update({ id: p.multiStockedSku.id }, { currentStock: 0 })
  await create(input(p.multi, p.multiStockedSku, { quantity: 20 }))
  for (let index = 0; index < 5; index += 1) {
    const product = await runtime.productService.create({ productName: `补货榜截断商品${index}`, defaultPrice: 10, isActive: true, o2oStatus: 'listed', currentStock: 0 }, runtime.admin.auth)
    const sku = await db.getRepository(e.BaseProductSku).findOneByOrFail({ productId: product.id, isCurrent: true })
    await create(input(product, sku))
  }
  const finalInventory = await stock()
  const rows = await requestRepo.find({ order: { id: 'ASC' } })
  const rangeStart = new Date(2026, 0, 1)
  const rangeEnd = new Date(2026, 0, 31, 23, 59, 59, 999)
  for (const [index, row] of rows.entries()) await requestRepo.update({ id: row.id }, { createdAt: index === 0 ? rangeStart : rangeEnd })
  await db.getRepository(e.ClientFeedbackConversation).update({ id: rows[0]!.conversationId }, { createdAt: new Date(2025, 11, 31, 23, 59, 59, 999) })
  const ranking = await http('/dashboard/restock-ranking?dateRange=2026-01-01,2026-01-31&orderType=walkin', runtime.admin.token)
  const expectedCounts = new Map<string, number>()
  rows.forEach((row) => expectedCounts.set(String(row.productId), (expectedCounts.get(String(row.productId)) ?? 0) + 1))
  assert.deepEqual(ranking.list.map((row: any) => [row.productId, row.requestCount]), [...expectedCounts].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, 5))
  assert.equal(JSON.stringify(ranking).includes('clientUserId'), false)
  assert.equal(JSON.stringify(ranking).includes('clientAccount'), false)
  for (const rank of ranking.list) {
    const drilldown = await http(`/customer-service/conversations?issueType=restock&productId=${rank.productId}&dateRange=2026-01-01,2026-01-31&pageSize=100`, runtime.operator.token)
    assert.equal(drilldown.total, rank.requestCount, '排行与下钻统一使用需求createdAt，跨午夜会话时间不丢记录')
  }
  const midnightDrilldown = await http(`/customer-service/conversations?issueType=restock&productId=${rows[0]!.productId}&dateRange=2026-01-01,2026-01-01&pageSize=100`, runtime.operator.token)
  assert.ok(midnightDrilldown.list.some((row: any) => String(row.id) === String(rows[0]!.conversationId)))
  assert.deepEqual((await http('/dashboard/restock-ranking?dateRange=2026-02-01,2026-02-28', runtime.admin.token)).list, [])
  await http('/dashboard/restock-ranking?dateRange=2026-02-31,2026-03-01', runtime.admin.token, 'GET', undefined, 400)
  await http('/dashboard/restock-ranking?dateRange=2026-02-01', runtime.admin.token, 'GET', undefined, 400)
  const current = await http('/dashboard/restock-ranking', runtime.admin.token)
  assert.equal(current.range.isDefault, true)
  assert.equal(current.range.startDate.slice(8), '01')
  const filtered = await http(`/customer-service/conversations?issueType=restock&restockStatus=expired&productId=${p.empty.id}&pageSize=100`, runtime.operator.token)
  assert.ok(filtered.list.length >= 1)
  assert.ok(filtered.list.every((row: any) => row.restock.effectiveStatus === 'expired' && row.restock.productId === String(p.empty.id)))
  const dateFiltered = await http('/customer-service/conversations?issueType=restock&dateRange=2020-01-01,2020-01-02', runtime.operator.token)
  assert.equal(dateFiltered.total, 0)
  const normal = await http('/client-feedback/conversations', runtime.client.token, 'POST', { issueType: 'suggestion', subject: '普通反馈', content: '普通反馈内容' })
  assert.equal(normal.conversation.restock, null)
  await db.getRepository(e.ClientFeedbackConversation).update({ id: String(normal.conversation.id) }, { createdAt: new Date(2025, 11, 31, 23, 59, 59, 999) })
  const ordinaryRange = await http('/customer-service/conversations?issueType=suggestion&dateRange=2025-12-31,2025-12-31&pageSize=100', runtime.operator.token)
  assert.ok(ordinaryRange.list.some((row: any) => String(row.id) === String(normal.conversation.id)), '普通反馈仍按会话日期过滤')
  await http(`/customer-service/conversations/${normal.conversation.id}/fields`, runtime.operator.token, 'PATCH', { issueType: 'restock' }, 409)
  await assert.rejects(() => runtime.productService.delete(String(p.empty.id), runtime.admin.auth), /补货需求/)
  await assert.rejects(() => db.getRepository(e.BaseProductSku).delete({ id: p.emptySku.id }), /FOREIGN KEY|foreign key/i)
  await db.getRepository(e.BaseProductSku).update({ id: p.multiEmptySku.id }, { isCurrent: false, isActive: false })
  const multiRequest = rows.find((row) => String(row.skuId) === String(p.multiEmptySku.id))!
  assert.ok((await http(`/client-feedback/conversations/${multiRequest.conversationId}`, runtime.client.token)).conversation.restock.specTextSnapshot)
  assert.deepEqual(await stock(), finalInventory)
  pass('排行合并/真实次数/日期边界/默认本月/隐私与精确筛选、普通反馈兼容、商品/SKU历史保留')
  console.log(`补货专项通过：${runtime.env.DB_TYPE}；隔离运行目录 ${runtime.runtimeDir}`)
} finally {
  realtime.publishConversationEvent = originalPublish
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await runtime.close()
}
