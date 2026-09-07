/**
 * 模块说明：backend/scripts/mobile-maintenance-regression-verify.ts
 * 文件职责：在隔离 SQLite 库中验证 Mobile Auth 验证码、会话活跃更新和会话清理均遵守数据库维护冻结。
 * 实现逻辑：
 * - 维护期阻断会写入持久风控桶的 Mobile 验证码 GET；
 * - 清理批次在只读期跳过，解除维护后才允许更新过期会话；
 * - 清理 worker 被冻结时停止领取新周期，drain 与 stop 都等待已启动的周期结束。
 * 维护说明：脚本使用系统临时目录下的 SQLite 与维护状态目录，禁止连接业务库或输出敏感配置。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import 'reflect-metadata'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'y-link-mobile-maintenance-'))
const sqlitePath = path.join(tempRoot, 'mobile-maintenance.sqlite')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = 'mobile-maintenance-regression'
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.Y_LINK_DATA_DIR = tempRoot
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath

const delay = (durationMs: number) => new Promise<void>((resolve) => {
  globalThis.setTimeout(resolve, durationMs)
})

const createDeferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const { AppDataSource } = await import('../src/config/data-source.js')
const [
  { initializeDatabaseInfrastructure },
  { initializeDatabaseSchemaIfNeeded },
  { ClientUser },
  { ClientMobileSession },
  { databaseOperationGate },
  { databaseMaintenanceModeService, shouldAllowWriteDuringDatabaseMaintenance },
  { MobileSessionService },
  { generateMobileAccessToken, hashMobileToken },
] = await Promise.all([
  import('../src/database/database-strategy.js'),
  import('../src/config/database-bootstrap.js'),
  import('../src/entities/client-user.entity.js'),
  import('../src/entities/client-mobile-session.entity.js'),
  import('../src/database/operation-gate.js'),
  import('../src/services/database-maintenance-mode.service.js'),
  import('../src/services/mobile-session.service.js'),
  import('../src/utils/mobile-token.js'),
])

let userSequence = 0
const createExpiredSession = async () => {
  userSequence += 1
  const user = await AppDataSource.getRepository(ClientUser).save({
    mobile: `1390000${String(userSequence).padStart(4, '0')}`,
    email: `mobile-maintenance-${userSequence}@example.test`,
    mobileVerifiedAt: new Date(),
    emailVerifiedAt: new Date(),
    passwordHash: 'test-only-password-hash',
    realName: `维护回归用户${userSequence}`,
    departmentName: '',
    departmentNodeId: null,
    accountType: 'personal',
    staffNo: null,
    staffVerified: false,
    status: 'enabled',
    lastLoginAt: null,
  })
  const expiredAt = new Date(Date.now() - 1_000)
  return AppDataSource.getRepository(ClientMobileSession).save({
    clientUserId: user.id,
    deviceId: `00000000-0000-4000-8000-${String(userSequence).padStart(12, '0')}`,
    deviceName: '维护回归设备',
    platform: 'android',
    appVersion: '1.0.0',
    accessTokenHash: 'a'.repeat(64),
    accessExpiresAt: expiredAt,
    refreshTokenHash: 'b'.repeat(64),
    refreshExpiresAt: expiredAt,
    previousRefreshTokenHash: null,
    previousRefreshGraceUntil: null,
    refreshGeneration: 0,
    absoluteExpiresAt: expiredAt,
    lastIp: null,
    lastAccessAt: expiredAt,
    revokedAt: null,
    revokeReason: null,
  })
}

const createStaleActivitySession = async () => {
  userSequence += 1
  const user = await AppDataSource.getRepository(ClientUser).save({
    mobile: `1380000${String(userSequence).padStart(4, '0')}`,
    email: `mobile-activity-${userSequence}@example.test`,
    mobileVerifiedAt: new Date(),
    emailVerifiedAt: new Date(),
    passwordHash: 'test-only-password-hash',
    realName: `活跃时间回归用户${userSequence}`,
    departmentName: '',
    departmentNodeId: null,
    accountType: 'personal',
    staffNo: null,
    staffVerified: false,
    status: 'enabled',
    lastLoginAt: null,
  })
  const staleAt = new Date(Date.now() - 2 * 60 * 1000)
  const accessToken = generateMobileAccessToken()
  const session = await AppDataSource.getRepository(ClientMobileSession).save({
    clientUserId: user.id,
    deviceId: `00000000-0000-4000-8001-${String(userSequence).padStart(12, '0')}`,
    deviceName: '活跃时间回归设备',
    platform: 'android',
    appVersion: '1.0.0',
    accessTokenHash: hashMobileToken(accessToken),
    accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    refreshTokenHash: 'c'.repeat(64),
    refreshExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    previousRefreshTokenHash: null,
    previousRefreshGraceUntil: null,
    refreshGeneration: 0,
    absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastIp: null,
    lastAccessAt: staleAt,
    revokedAt: null,
    revokeReason: null,
  })
  return { accessToken, session, staleAt }
}

try {
  assert.equal(
    shouldAllowWriteDuringDatabaseMaintenance('GET', '/api/v1/mobile-auth/captcha'),
    false,
    'Mobile captcha 会持久化风控桶，维护期必须在请求进入前阻断',
  )

  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)

  const frozenSession = await createExpiredSession()
  const staleActivity = await createStaleActivitySession()
  await databaseMaintenanceModeService.beginReadOnly({
    taskId: 'mobile-maintenance-regression',
    phase: 'snapshot',
  })
  try {
    const service = new MobileSessionService()
    assert.equal(
      await service.cleanupExpiredBatch(),
      0,
      '只读维护期的 Mobile 清理批次必须跳过而非尝试写入',
    )
    const untouched = await AppDataSource.getRepository(ClientMobileSession).findOneByOrFail({ id: frozenSession.id })
    assert.equal(untouched.revokedAt, null, '维护期跳过的会话不得被提前更新')

    const activityService = new MobileSessionService()
    await activityService.resolveAccess(staleActivity.accessToken, 'maintenance-sse-auth')
    const activityDuringMaintenance = await AppDataSource.getRepository(ClientMobileSession).findOneByOrFail({
      id: staleActivity.session.id,
    })
    assert.equal(
      activityDuringMaintenance.lastAccessAt.getTime(),
      staleActivity.staleAt.getTime(),
      '维护期的 SSE 鉴权可继续读取，但不得尝试更新 last_access_at',
    )
  } finally {
    await databaseMaintenanceModeService.finishReadOnly('mobile-maintenance-regression')
  }

  const cleanupService = new MobileSessionService()
  assert.equal(await cleanupService.cleanupExpiredBatch(), 1, '解除维护后清理批次应恢复处理过期会话')
  const revoked = await AppDataSource.getRepository(ClientMobileSession).findOneByOrFail({ id: frozenSession.id })
  assert.equal(revoked.revokeReason, 'expired_cleanup')

  const resumedActivityService = new MobileSessionService()
  await resumedActivityService.resolveAccess(staleActivity.accessToken, 'maintenance-resumed-auth')
  const activityAfterMaintenance = await AppDataSource.getRepository(ClientMobileSession).findOneByOrFail({
    id: staleActivity.session.id,
  })
  assert.ok(
    activityAfterMaintenance.lastAccessAt.getTime() > staleActivity.staleAt.getTime(),
    '解除维护后应恢复 last_access_at 的节流更新',
  )

  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const scheduledCallbacks: Array<() => void> = []
  let timerSequence = 0
  globalThis.setInterval = ((callback: () => void) => {
    scheduledCallbacks.push(callback)
    timerSequence += 1
    return timerSequence as unknown as ReturnType<typeof globalThis.setInterval>
  }) as typeof globalThis.setInterval
  globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval

  const inFlightStarted = createDeferred()
  const allowInFlightFinish = createDeferred()
  const lifecycleService = new MobileSessionService()
  ;(lifecycleService as unknown as { cleanupExpiredBatch: () => Promise<number> }).cleanupExpiredBatch = async () => {
    inFlightStarted.resolve()
    await allowInFlightFinish.promise
    return 0
  }
  try {
    lifecycleService.startCleanupLoop()
    assert.equal(scheduledCallbacks.length, 1, '启动清理器后应登记一个定时周期')
    scheduledCallbacks[0]!()
    await inFlightStarted.promise

    const freeze = databaseOperationGate.freeze({ excludeCurrentOperation: false })
    let drained = false
    const drainPromise = freeze.drain(1_000).then(() => {
      drained = true
    })
    let stopped = false
    const stopPromise = Promise.resolve(lifecycleService.stopCleanupLoop()).then(() => {
      stopped = true
    })
    await delay(20)
    assert.equal(drained, false, '维护 drain 必须等待已启动的 Mobile 清理周期结束')
    assert.equal(stopped, false, '停止清理器必须等待在途周期结束')
    allowInFlightFinish.resolve()
    await stopPromise
    await drainPromise
    freeze.release()
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    await lifecycleService.stopCleanupLoop()
  }

  console.log('mobile-maintenance-regression-verify 全部通过。')
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
