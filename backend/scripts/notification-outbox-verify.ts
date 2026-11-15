/**
 * 通知 Outbox 专项验收：
 * - emitEvent 只落 pending 事件，不同步展开收件箱；
 * - Worker 处理后事件完成且收件箱幂等；
 * - 数据库只读维护期不领取事件，解除维护后可继续处理。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promises as dns, type LookupAddress } from 'node:dns'
import { AsyncResource } from 'node:async_hooks'

const runId = `${process.pid}-${Date.now()}`
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-notification-outbox-'))
const sqlitePath = path.join(runtimeDir, 'outbox.sqlite')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `notification-outbox-${runId}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DATA_DIR = runtimeDir
const ownedEnvFile = path.join(runtimeDir, 'isolated.env')
fs.writeFileSync(ownedEnvFile, '', { flag: 'wx', mode: 0o600 })
process.env.ENV_FILE = ownedEnvFile
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.REDIS_URL = ''
process.env.ALIYUN_DYPNS_MNS_ENABLED = 'false'
process.env.Y_LINK_OUTBOUND_REDIRECT_POLICY = 'compat'
process.env.Y_LINK_OUTBOUND_REDIRECT_ALLOWED_ORIGINS = '[]'
process.env.INIT_ADMIN_USERNAME = 'outbox_admin'
process.env.INIT_ADMIN_PASSWORD = `Outbox_${runId}_Aa1!`
process.env.INIT_ADMIN_DISPLAY_NAME = '通知专项管理员'

fs.mkdirSync(runtimeDir, { recursive: true })
let closeRuntime = async () => {}

const main = async () => {
  const { AppDataSource } = await import('../src/config/data-source.js')
  const {
    initializeDatabaseSchemaIfNeeded,
    prepareDatabaseRuntime,
  } = await import('../src/config/database-bootstrap.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { NotificationEvent } = await import('../src/entities/notification-event.entity.js')
  const { NotificationInbox } = await import('../src/entities/notification-inbox.entity.js')
  const { NotificationRule } = await import('../src/entities/notification-rule.entity.js')
  const { NotificationDispatch } = await import('../src/entities/notification-dispatch.entity.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { databaseMaintenanceModeService } = await import('../src/services/database-maintenance-mode.service.js')
  const { notificationService } = await import('../src/services/notification.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { VerificationCodeService } = await import('../src/services/verification-code.service.js')
  closeRuntime = async () => {
    await notificationService.stopOutboxWorker()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  }

  assert.equal(AppDataSource.options.type, 'sqlite')
  assert.equal(path.resolve(String(AppDataSource.options.database)), sqlitePath, '只能初始化本次独占 SQLite')
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  await systemConfigService.ensureDefaultConfigs()
  await notificationService.ensureDefaultRules()

  for (const [message, status] of [['出站请求超过总超时上限', 504], ['出站响应未完整接收', 502]] as const) {
    const sender = new VerificationCodeService(async () => { throw new Error(message) })
    await assert.rejects(sender.sendTest({ channel: 'email', target: 'fixture@example.test', config: {
      enabled: true, httpMethod: 'POST', apiUrl: 'https://verification.example.test/send',
      headersTemplate: '{}', bodyTemplate: '{"target":"{{target}}"}', successMatch: '',
    } }), error => error instanceof Error && (error as { statusCode?: number }).statusCode === status)
  }

  const eventRepo = AppDataSource.getRepository(NotificationEvent)
  const inboxRepo = AppDataSource.getRepository(NotificationInbox)
  const firstSourceId = `preorder-${runId}`
  await notificationService.emitEvent({
    eventType: 'o2o_preorder_created',
    sourceType: 'o2o_preorder',
    sourceId: firstSourceId,
    payload: { showNo: `PO-${runId}` },
  })

  const pending = await eventRepo.findOneByOrFail({ sourceId: firstSourceId })
  assert.equal(pending.status, 'pending')
  assert.equal(pending.attemptCount, 0)
  assert.equal(await inboxRepo.count({ where: { eventId: pending.id } }), 0)

  assert.equal(await notificationService.runOutboxOnce(), 1)
  const processed = await eventRepo.findOneByOrFail({ id: pending.id })
  assert.equal(processed.status, 'processed')
  assert.equal(processed.attemptCount, 0, '成功处理不应消耗失败重试额度')
  assert.ok(processed.processedAt instanceof Date)
  assert.equal(await inboxRepo.count({ where: { eventId: pending.id } }), 1)

  // 模拟重启后重新拾取同一事件；唯一键 + orIgnore 必须保证收件箱仍只有一条。
  await eventRepo.update(
    { id: pending.id },
    { status: 'pending', processedAt: null, nextAttemptAt: null },
  )
  assert.equal(await notificationService.runOutboxOnce(), 1)
  assert.equal(await inboxRepo.count({ where: { eventId: pending.id } }), 1)

  // 兼容旧 Worker 在第 5 次“领取”后立即崩溃的遗留状态：领取不等于失败，
  // stale recovery 必须重新执行事件，不能在尚未创建收件箱时直接判死。
  const crashSourceId = `crash-after-claim-${runId}`
  await notificationService.emitEvent({
    eventType: 'customer_service_client_message_created',
    sourceType: 'client_feedback_conversation',
    sourceId: crashSourceId,
    payload: { conversationNo: `CRASH-${runId}`, summary: '第五次领取后崩溃恢复' },
  })
  const crashEvent = await eventRepo.findOneByOrFail({ sourceId: crashSourceId })
  await eventRepo.update(
    { id: crashEvent.id },
    {
      status: 'processing',
      attemptCount: 5,
      processingOwner: 'crashed-legacy-worker',
      processingStartedAt: new Date(Date.now() - 11 * 60_000),
      nextAttemptAt: null,
    },
  )
  assert.equal(await notificationService.runOutboxOnce(), 1)
  const recoveredCrashEvent = await eventRepo.findOneByOrFail({ id: crashEvent.id })
  assert.equal(recoveredCrashEvent.status, 'processed')
  assert.equal(await inboxRepo.count({ where: { eventId: crashEvent.id } }), 1)

  const maintenanceSourceId = `maintenance-${runId}`
  await notificationService.emitEvent({
    eventType: 'customer_service_client_message_created',
    sourceType: 'client_feedback_conversation',
    sourceId: maintenanceSourceId,
    payload: { conversationNo: `FB-${runId}`, summary: '维护期验收' },
  })
  const maintenanceEvent = await eventRepo.findOneByOrFail({ sourceId: maintenanceSourceId })
  const maintenanceTaskId = `notification-outbox-verify-${runId}`
  await databaseMaintenanceModeService.beginReadOnly({ taskId: maintenanceTaskId, phase: 'verify' })
  try {
    assert.equal(await notificationService.runOutboxOnce(), 0)
    assert.equal((await eventRepo.findOneByOrFail({ id: maintenanceEvent.id })).status, 'pending')
  } finally {
    await databaseMaintenanceModeService.finishReadOnly(maintenanceTaskId)
  }
  assert.equal(await notificationService.runOutboxOnce(), 1)
  assert.equal((await eventRepo.findOneByOrFail({ id: maintenanceEvent.id })).status, 'processed')

  // 真实 outbox + 真实安全 HTTP，仅把 DNS 边界停住：总 deadline 必须释放维护租约和投递领取状态。
  const ruleRepo = AppDataSource.getRepository(NotificationRule)
  const rule = await ruleRepo.findOneByOrFail({ eventType: 'o2o_preorder_created' })
  await ruleRepo.update({ id: rule.id }, {
    enabled: 1, feishuEnabled: 1, emailEnabled: 0, externalTriggerMode: 'always',
    feishuWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/outbox-timeout-fixture',
  })
  const timeoutSource = `outbound-timeout-${runId}`
  await notificationService.emitEvent({ eventType: 'o2o_preorder_created', sourceType: 'o2o_preorder', sourceId: timeoutSource, payload: { showNo: 'OUTBOUND-TIMEOUT-FIXTURE' } })
  const originalLookup = dns.lookup
  let resolveDns!: (addresses: LookupAddress[]) => void
  let signalLookup!: () => void
  const lookupStarted = new Promise<void>(resolve => { signalLookup = resolve })
  dns.lookup = (async () => { signalLookup(); return new Promise<LookupAddress[]>(resolve => { resolveDns = resolve }) }) as typeof dns.lookup
  const freezeId = `outbox-deadline-${runId}`
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const workerScope = new AsyncResource('outbox-deadline-fixture')
  try {
    const work = workerScope.runInAsyncScope(() => notificationService.runOutboxOnce())
    const bounded = new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error('外发总时限/维护租约未在 15 秒内收口')), 15_000) })
    await Promise.race([lookupStarted, work.then(() => { throw new Error('通知投递未进入 DNS 夹具') }), bounded])
    let drained = false
    const freeze = databaseMaintenanceModeService.beginReadOnly({ taskId: freezeId, phase: 'outbound-deadline-verify' }).then(() => { drained = true })
    // 后续仍统一 await 原 Promise 传播错误；先挂处理，避免下面跨 turn 断言制造未处理拒绝。
    void freeze.catch(() => undefined)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(drained, false, '总 deadline 收口前维护冻结必须等待当前外发租约')
    await Promise.race([Promise.all([work, freeze]), bounded])
    const failed = await eventRepo.findOneByOrFail({ sourceId: timeoutSource })
    assert.equal(failed.status, 'pending', '外发超时应安排重试')
    assert.equal(failed.processingOwner, null, '事件领取必须释放')
    assert.equal(failed.processingStartedAt, null)
    const dispatch = await AppDataSource.getRepository(NotificationDispatch).findOneByOrFail({ eventId: failed.id, channel: 'feishu' })
    assert.equal(dispatch.status, 'failed')
    assert.equal(dispatch.attemptCount, 1, '超时只计一次完成失败')
    assert.equal(databaseMaintenanceModeService.isReadOnly(), true, '维护冻结已排空外发所持租约')
  } finally {
    clearTimeout(watchdog)
    dns.lookup = originalLookup
    resolveDns?.([{ address: '8.8.8.8', family: 4 }])
    await databaseMaintenanceModeService.finishReadOnly(freezeId)
    workerScope.emitDestroy()
  }

  await notificationService.stopOutboxWorker()
  await AppDataSource.destroy()
  console.log('OK 通知 Outbox 热路径解耦、崩溃恢复、幂等、维护期暂停与外发超时租约释放验收通过')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeRuntime()
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })
