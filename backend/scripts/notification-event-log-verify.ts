/**
 * 文件说明：backend/scripts/notification-event-log-verify.ts
 * 文件职责：通知事件分类与按事件聚合展示专项验收（Issue #70）。
 * 实现逻辑：
 * 1. 使用临时 SQLite 与模拟外发通道，覆盖飞书暂时失败后重试成功、多规则共用同一 Webhook、触发时机拦截、邮箱无效终态失败；
 * 2. 断言外发审计结果状态反映真实外发结果、共用 Webhook 时不漏写外发审计、重试时已发送目标不重复计为发送；
 * 3. 断言通知事件主列表每个 eventId 只有一条记录，处理结果推导、业务分类/事件类型/处理结果/外发渠道/时间/事件 ID 筛选正确；
 * 4. 断言详情中外发目标与失败原因已脱敏、规则命中按处理轮次分组、兼容历史数值型 eventId 审计记录，且不透出客服消息正文。
 * 维护说明：调整通知外发审计口径或处理结果推导时，必须同步更新本脚本。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runId = `${process.pid}-${Date.now()}`
const runtimeDir = path.join(os.tmpdir(), `ylink-notification-event-log-${runId}`)
const sqlitePath = path.join(runtimeDir, 'event-log.sqlite')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `notification-event-log-${runId}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.INIT_ADMIN_USERNAME = 'event_log_admin'
process.env.INIT_ADMIN_PASSWORD = `EventLog_${runId}_Aa1!`
process.env.INIT_ADMIN_DISPLAY_NAME = '通知事件专项管理员'

fs.mkdirSync(runtimeDir, { recursive: true })

const WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/verify-secret-hook-abcdef'

const main = async () => {
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { NotificationEvent } = await import('../src/entities/notification-event.entity.js')
  const { NotificationDispatch } = await import('../src/entities/notification-dispatch.entity.js')
  const { NotificationRule } = await import('../src/entities/notification-rule.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { auditService } = await import('../src/services/audit.service.js')
  const { notificationService } = await import('../src/services/notification.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const {
    deriveNotificationEventResult,
    notificationEventLogService,
  } = await import('../src/services/notification-event-log.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  await systemConfigService.ensureDefaultConfigs()
  await notificationService.ensureDefaultRules()

  const eventRepo = AppDataSource.getRepository(NotificationEvent)
  const dispatchRepo = AppDataSource.getRepository(NotificationDispatch)
  const ruleRepo = AppDataSource.getRepository(NotificationRule)
  const auditRepo = AppDataSource.getRepository(SysAuditLog)
  const admin = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: 'event_log_admin' })

  // 模拟外发通道：只替换对外 HTTP 发送，规则命中、去重、重试与审计仍走真实处理链路。
  let feishuShouldSucceed = false
  let feishuSendCount = 0
  const patchedService = notificationService as unknown as {
    sendFeishuWebhook: (...args: unknown[]) => Promise<{ status: number; ok: boolean; errorMessage?: string }>
    sendEmailByVerificationProvider: (...args: unknown[]) => Promise<{ status: number; ok: boolean; errorMessage?: string }>
  }
  patchedService.sendFeishuWebhook = async () => {
    feishuSendCount += 1
    return feishuShouldSucceed
      ? { status: 200, ok: true }
      : { status: 500, ok: false, errorMessage: `模拟飞书暂时失败 ${WEBHOOK_URL} 联系 ops@example.com` }
  }
  patchedService.sendEmailByVerificationProvider = async () => ({ status: 200, ok: true })

  const resetRule = async (eventType: string, patch: Partial<InstanceType<typeof NotificationRule>>) => {
    const rule = await ruleRepo.findOneByOrFail({ eventType })
    await ruleRepo.update({ id: rule.id }, {
      enabled: 1,
      recipientUserIdsJson: '[]',
      emailRecipientAdminUserIdsJson: '[]',
      emailRecipientSupplierUserIdsJson: '[]',
      emailEnabled: 0,
      feishuEnabled: 0,
      feishuWebhookUrl: null,
      feishuSignSecret: null,
      externalTriggerMode: 'all_management_offline',
      watchedUserIdsJson: '[]',
      ...patch,
    })
    return ruleRepo.findOneByOrFail({ id: rule.id })
  }

  // 场景 A：新预订单，两条规则共用同一飞书 Webhook，首轮暂时失败、次轮成功。
  const preorderRule = await resetRule('o2o_preorder_created', {
    feishuEnabled: 1,
    feishuWebhookUrl: WEBHOOK_URL,
    recipientUserIdsJson: JSON.stringify([String(admin.id)]),
  })
  const secondPreorderRule = await ruleRepo.save(ruleRepo.create({
    ...preorderRule,
    id: undefined as unknown as string,
    ruleCode: `verify_shared_webhook_${runId}`.slice(0, 64),
    ruleName: '共用 Webhook 验收规则',
  }))
  await notificationService.emitEvent({
    eventType: 'o2o_preorder_created',
    sourceType: 'o2o_preorder',
    sourceId: `preorder-${runId}`,
    payload: { showNo: 'hyyz000070', sourceUserDisplayName: '验收客户' },
  })
  const orderEvent = await eventRepo.findOneByOrFail({ sourceId: `preorder-${runId}` })
  assert.equal(await notificationService.runOutboxOnce(), 1)
  assert.equal(feishuSendCount, 1, '多规则共用同一 Webhook 时同一轮只允许外发一次')
  const firstRoundEvent = await eventRepo.findOneByOrFail({ id: orderEvent.id })
  assert.equal(firstRoundEvent.status, 'pending')
  assert.equal(firstRoundEvent.attemptCount, 1)

  const firstRoundDispatchAudits = await auditRepo.find({ where: { actionType: 'notification.external.dispatch' }, order: { id: 'ASC' } })
  assert.equal(firstRoundDispatchAudits.length, 2, '共用 Webhook 的第二条规则也必须写外发审计，不能被 continue 跳过')
  const firstRoundByRule = new Map(firstRoundDispatchAudits.map((audit) => [String(audit.targetId), audit]))
  assert.equal(firstRoundByRule.get(String(preorderRule.id))?.resultStatus, 'failed', '外发失败时审计结果必须为 failed')
  assert.equal(firstRoundByRule.get(String(secondPreorderRule.id))?.resultStatus, 'success')
  assert.equal(JSON.parse(firstRoundByRule.get(String(preorderRule.id))!.detailJson!).attemptNo, 1)
  const matchedAudits = await auditRepo.find({ where: { actionType: 'notification.rule.matched' } })
  assert.equal(matchedAudits.length, 2)
  assert.ok(matchedAudits.every((audit) => audit.resultStatus === 'success'))

  const retryingList = await notificationEventLogService.listEvents({ page: 1, pageSize: 20, resultStatus: 'retrying' })
  assert.deepEqual(retryingList.list.map((item) => item.id), [String(orderEvent.id)], '暂时失败待重试的事件必须显示为重试中')

  feishuShouldSucceed = true
  await eventRepo.update({ id: orderEvent.id }, { nextAttemptAt: new Date(Date.now() - 1000) })
  assert.equal(await notificationService.runOutboxOnce(), 1)
  assert.equal(feishuSendCount, 2)
  assert.equal((await eventRepo.findOneByOrFail({ id: orderEvent.id })).status, 'processed')
  const secondRoundAudit = (await auditRepo.find({ where: { actionType: 'notification.external.dispatch', targetId: String(preorderRule.id) }, order: { id: 'DESC' }, take: 1 }))[0]!
  const secondRoundDetail = JSON.parse(secondRoundAudit.detailJson!)
  assert.equal(secondRoundAudit.resultStatus, 'success')
  assert.equal(secondRoundDetail.feishuSent, 1)
  assert.equal(secondRoundDetail.attemptNo, 2)

  // 模拟重启后重复拾取：已发送目标只能计入 alreadySent，不能重复计为发送。
  await eventRepo.update({ id: orderEvent.id }, { status: 'pending', processedAt: null, nextAttemptAt: null })
  assert.equal(await notificationService.runOutboxOnce(), 1)
  assert.equal(feishuSendCount, 2, '已发送的外发目标不得重复发送')
  const replayAudit = (await auditRepo.find({ where: { actionType: 'notification.external.dispatch', targetId: String(preorderRule.id) }, order: { id: 'DESC' }, take: 1 }))[0]!
  const replayDetail = JSON.parse(replayAudit.detailJson!)
  assert.equal(replayDetail.feishuSent, 0, '重复处理时不得把此前已发送目标计为本轮发送')
  assert.equal(replayDetail.feishuAlreadySent, 1)

  // 场景 B：客服消息，规则配置了外发但触发时机不满足，只生成站内处理结果。
  await resetRule('customer_service_client_message_created', {
    feishuEnabled: 1,
    feishuWebhookUrl: WEBHOOK_URL,
    externalTriggerMode: 'watched_accounts_offline',
    watchedUserIdsJson: '[]',
  })
  await notificationService.emitEvent({
    eventType: 'customer_service_client_message_created',
    sourceType: 'client_feedback_conversation',
    sourceId: `feedback-${runId}`,
    payload: { conversationNo: 'FB-070', summary: '这是一段不应出现在通知事件列表中的客服消息正文', sourceUserDisplayName: '验收客户' },
  })
  const serviceEvent = await eventRepo.findOneByOrFail({ sourceId: `feedback-${runId}` })
  assert.equal(await notificationService.runOutboxOnce(), 1)
  const skippedAudit = (await auditRepo.find({ where: { actionType: 'notification.external.dispatch' }, order: { id: 'DESC' }, take: 1 }))[0]!
  assert.equal(JSON.parse(skippedAudit.detailJson!).skipped, 'trigger_mode_blocked', '外发被触发时机拦截时必须留痕')

  // 场景 C：安全告警，邮件接收人未配置有效邮箱，终态失败。
  await resetRule('mobile_refresh_replay_detected', {
    emailEnabled: 1,
    emailRecipientAdminUserIdsJson: JSON.stringify([String(admin.id)]),
  })
  await AppDataSource.getRepository(SysUser).update({ id: admin.id }, { email: null })
  await notificationService.emitEvent({
    eventType: 'mobile_refresh_replay_detected',
    sourceType: 'client_mobile_session',
    sourceId: `mobile-${runId}`,
    payload: { generation: 3, trigger: 'burst' },
  })
  const securityEvent = await eventRepo.findOneByOrFail({ sourceId: `mobile-${runId}` })
  assert.equal(await notificationService.runOutboxOnce(), 1)
  assert.equal((await eventRepo.findOneByOrFail({ id: securityEvent.id })).status, 'failed')

  // 历史数据：早期审计 detail 中 eventId 为数值写法，详情仍需能关联。
  await auditService.record({
    actionType: 'notification.rule.matched',
    actionLabel: '通知规则命中',
    targetType: 'notification_rule',
    targetId: String(preorderRule.id),
    targetCode: preorderRule.ruleCode,
    detail: { eventId: Number(serviceEvent.id), eventType: 'customer_service_client_message_created', recipientCount: 0 },
  })

  // 列表：每个事件一条主记录，处理结果与筛选口径正确。
  const allEvents = await notificationEventLogService.listEvents({ page: 1, pageSize: 20 })
  assert.equal(allEvents.total, 3, '通知事件主列表必须按 eventId 聚合，每个业务事件只有一条记录')
  const resultById = new Map(allEvents.list.map((item) => [item.id, item]))
  assert.equal(resultById.get(String(orderEvent.id))?.resultStatus, 'success')
  assert.equal(resultById.get(String(orderEvent.id))?.categoryLabel, '订单通知')
  assert.deepEqual(resultById.get(String(orderEvent.id))?.dispatchSummary.feishu, { total: 1, sent: 1, failed: 0, pending: 0 })
  assert.equal(resultById.get(String(serviceEvent.id))?.resultStatus, 'internal_only')
  assert.equal(resultById.get(String(serviceEvent.id))?.categoryLabel, '客服通知')
  assert.ok(!JSON.stringify(resultById.get(String(serviceEvent.id))).includes('客服消息正文'), '通知事件列表不得透出客服消息正文')
  assert.equal(resultById.get(String(securityEvent.id))?.resultStatus, 'failed')
  assert.equal(resultById.get(String(securityEvent.id))?.categoryLabel, '安全告警')

  const expectIds = async (query: Omit<Parameters<typeof notificationEventLogService.listEvents>[0], 'page' | 'pageSize'>, expected: unknown[], message: string) => {
    const result = await notificationEventLogService.listEvents({ page: 1, pageSize: 20, ...query })
    assert.deepEqual(result.list.map((item) => item.id).sort(), expected.map(String).sort(), message)
  }
  await expectIds({ category: 'order' }, [orderEvent.id], '业务分类筛选错误')
  await expectIds({ category: 'system' }, [], '系统通知分类应只包含未登记事件类型')
  await expectIds({ eventType: 'mobile_refresh_replay_detected' }, [securityEvent.id], '事件类型筛选错误')
  await expectIds({ resultStatus: 'success' }, [orderEvent.id], '外发成功筛选错误')
  await expectIds({ resultStatus: 'internal_only' }, [serviceEvent.id], '仅站内筛选错误')
  await expectIds({ resultStatus: 'failed' }, [securityEvent.id], '处理失败筛选错误')
  await expectIds({ resultStatus: 'partial_failed' }, [], '部分失败筛选错误')
  await expectIds({ channel: 'feishu' }, [orderEvent.id], '飞书渠道筛选错误')
  await expectIds({ channel: 'email' }, [securityEvent.id], '邮件渠道筛选错误')
  await expectIds({ eventId: String(serviceEvent.id) }, [serviceEvent.id], '事件 ID 筛选错误')
  await expectIds({ startAt: new Date(Date.now() + 60_000) }, [], '时间范围筛选错误')

  // 详情：脱敏、处理轮次与历史兼容。
  const orderDetail = await notificationEventLogService.getEventDetail(String(orderEvent.id))
  const detailText = JSON.stringify(orderDetail)
  assert.ok(!detailText.includes('verify-secret-hook'), '详情不得透出完整飞书 Webhook')
  assert.equal(orderDetail.dispatches.length, 1)
  assert.equal(orderDetail.dispatches[0]!.status, 'sent')
  assert.ok(orderDetail.processingAttempts.length >= 2, '规则命中与外发执行必须按处理轮次分组')
  assert.equal(orderDetail.processingAttempts[0]!.rules.length, 2)
  assert.equal(orderDetail.processingAttempts[0]!.rules.find((rule) => rule.ruleId === String(preorderRule.id))?.dispatch?.feishuFailed, 1)

  const securityDetail = await notificationEventLogService.getEventDetail(String(securityEvent.id))
  assert.equal(securityDetail.dispatches[0]!.channel, 'email')
  assert.ok(!securityDetail.dispatches[0]!.target.includes('event_log_admin'), '邮件目标必须脱敏')
  assert.equal(securityDetail.failureAudits.length, 1, '终态失败必须保留失败留痕')

  const serviceDetail = await notificationEventLogService.getEventDetail(String(serviceEvent.id))
  const legacyMatched = serviceDetail.processingAttempts.flatMap((attempt) => attempt.rules)
  assert.ok(legacyMatched.length >= 1, '历史数值型 eventId 审计记录必须能关联到事件详情')

  await assert.rejects(() => notificationEventLogService.getEventDetail('999999999'), /通知事件不存在/)

  // 纯函数：处理结果推导与 SQL 筛选口径一致。
  const empty = { total: 0, sent: 0, failed: 0, pending: 0 }
  assert.equal(deriveNotificationEventResult({ status: 'pending', attemptCount: 0 }, { email: empty, feishu: empty }), 'pending')
  assert.equal(deriveNotificationEventResult({ status: 'processed', attemptCount: 0 }, { email: { total: 2, sent: 1, failed: 1, pending: 0 }, feishu: empty }), 'partial_failed')

  const sanitizedDispatch = await dispatchRepo.findOneByOrFail({ eventId: orderEvent.id })
  assert.ok(sanitizedDispatch.target.includes('***'), '外发记录入库目标必须已脱敏')

  await notificationService.stopOutboxWorker()
  await AppDataSource.destroy()
  console.log('OK 通知事件分类、按事件聚合、外发审计口径、筛选与详情脱敏验收通过')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })
