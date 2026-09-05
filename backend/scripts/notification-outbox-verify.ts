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

const runId = `${process.pid}-${Date.now()}`
const runtimeDir = path.join(os.tmpdir(), `ylink-notification-outbox-${runId}`)
const sqlitePath = path.join(runtimeDir, 'outbox.sqlite')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `notification-outbox-${runId}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.INIT_ADMIN_USERNAME = 'outbox_admin'
process.env.INIT_ADMIN_PASSWORD = `Outbox_${runId}_Aa1!`
process.env.INIT_ADMIN_DISPLAY_NAME = '通知专项管理员'

fs.mkdirSync(runtimeDir, { recursive: true })

const main = async () => {
  const { AppDataSource } = await import('../src/config/data-source.js')
  const {
    initializeDatabaseSchemaIfNeeded,
    prepareDatabaseRuntime,
  } = await import('../src/config/database-bootstrap.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { NotificationEvent } = await import('../src/entities/notification-event.entity.js')
  const { NotificationInbox } = await import('../src/entities/notification-inbox.entity.js')
  const { authService } = await import('../src/services/auth.service.js')
  const { databaseMaintenanceModeService } = await import('../src/services/database-maintenance-mode.service.js')
  const { notificationService } = await import('../src/services/notification.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await authService.ensureDefaultAdmin()
  await systemConfigService.ensureDefaultConfigs()
  await notificationService.ensureDefaultRules()

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

  await notificationService.stopOutboxWorker()
  await AppDataSource.destroy()
  console.log('OK 通知 Outbox 热路径解耦、崩溃恢复、幂等与维护期暂停验收通过')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })
