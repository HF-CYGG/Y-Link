/**
 * 模块说明：backend/scripts/mobile-auth-contract-verify.ts
 * 文件职责：在 SQLite 或受控 MySQL 临时库中执行 Mobile Auth G-1～G-7 专项集成验收。
 * 实现逻辑：脚本按环境动态装载 DataSource，真实执行并发 refresh、CAS rotation、previous grace、
 * replay 撤销、登出/改密跨表事务与停用账号拒绝；MySQL 模式自行创建并销毁专用临时库。
 * 维护说明：订单流水并发不能替代本脚本；新增 Auth 状态不变量时必须在这里增加独立断言。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { inspect } from 'node:util'
import path from 'node:path'
import { createConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'

const MYSQL_DATABASE = 'y_link_verify_mobile_auth'
const SQLITE_FILE = path.resolve(process.cwd(), 'data/local-dev/mobile-auth-contract-verify.sqlite')
const VERIFY_MODE = process.env.MOBILE_AUTH_VERIFY_DB === 'mysql' ? 'mysql' : 'sqlite'
const CONCURRENT_REFRESH_COUNT = 10
const ROTATION_RATE_LIMIT = 20

const pass = (gate: string, message: string) => console.log(`✅ ${gate} ${message}`)

const readMysqlConfig = () => ({
  host: process.env.VERIFY_DB_CONCURRENCY_MYSQL_HOST ?? process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.VERIFY_DB_CONCURRENCY_MYSQL_PORT ?? process.env.DB_PORT ?? 3306),
  user: process.env.VERIFY_DB_CONCURRENCY_MYSQL_USER ?? process.env.DB_USER ?? 'root',
  password: process.env.VERIFY_DB_CONCURRENCY_MYSQL_PASSWORD ?? process.env.DB_PASSWORD ?? '',
})

const configureRuntime = () => {
  process.env.NODE_ENV = 'test'
  process.env.APP_PROFILE = `mobile-auth-contract-${VERIFY_MODE}`
  process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
  process.env.DB_TYPE = VERIFY_MODE
  process.env.DB_SYNC = 'true'
  process.env.MOBILE_REFRESH_GRACE_SECONDS = '1'
  process.env.MOBILE_REFRESH_ROTATION_RATE_LIMIT = String(ROTATION_RATE_LIMIT)
  process.env.MOBILE_REFRESH_ROTATION_RATE_WINDOW_SECONDS = '60'
  process.env.MOBILE_MAX_ACTIVE_SESSIONS = '10'
  if (VERIFY_MODE === 'sqlite') {
    process.env.SQLITE_DB_PATH = SQLITE_FILE
    return
  }
  const config = readMysqlConfig()
  process.env.DB_HOST = config.host
  process.env.DB_PORT = String(config.port)
  process.env.DB_USER = config.user
  process.env.DB_PASSWORD = config.password
  process.env.DB_NAME = MYSQL_DATABASE
}

const recreateMysqlDatabase = async () => {
  const config = readMysqlConfig()
  const connection = await createConnection({ ...config, multipleStatements: false })
  try {
    const [versionRows] = await connection.query<Array<RowDataPacket & { version: string }>>('SELECT VERSION() AS version')
    const mysqlVersion = versionRows[0]?.version ?? ''
    assert.match(mysqlVersion, /^8\.4(?:\.|-)/, `MySQL Auth Gate 必须运行在 8.4，实际版本：${mysqlVersion || 'unknown'}`)
    console.log(`[mobile-auth-mysql] server-version=${mysqlVersion}`)
    await connection.query(`DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\``)
    await connection.query(
      `CREATE DATABASE \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
  } finally {
    await connection.end()
  }
}

const dropMysqlDatabase = async () => {
  const config = readMysqlConfig()
  const connection = await createConnection({ ...config, multipleStatements: false })
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\``)
  } finally {
    await connection.end()
  }
}

const removeSqliteFiles = () => {
  for (const suffix of ['', '-shm', '-wal']) {
    const filePath = `${SQLITE_FILE}${suffix}`
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
}

configureRuntime()
if (VERIFY_MODE === 'mysql') await recreateMysqlDatabase()
else {
  fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true })
  removeSqliteFiles()
}

const [
  { AppDataSource },
  { initializeDatabaseInfrastructure },
  { initializeDatabaseSchemaIfNeeded },
  { ClientMobileSession },
  { ClientUser },
  { ClientUserSession },
  { SysAuditLog },
  { NotificationEvent },
  { SystemConfig },
  { AuthRiskState },
  { hashPassword, verifyPassword },
  { hashSessionToken },
  { mobileSessionService, configureMobileSessionContractVerificationHooks },
  { mobileAuthService },
  { authSecurityService },
  { clientUserManageService },
  { clientAuthService },
  { systemConfigService },
  { VerificationCodeService },
  { requireClientAuth },
  { requireMobileAuth },
  { BizError },
  { errorHandler },
  { QueryFailedError },
] = await Promise.all([
  import('../src/config/data-source.js'),
  import('../src/database/database-strategy.js'),
  import('../src/config/database-bootstrap.js'),
  import('../src/entities/client-mobile-session.entity.js'),
  import('../src/entities/client-user.entity.js'),
  import('../src/entities/client-user-session.entity.js'),
  import('../src/entities/sys-audit-log.entity.js'),
  import('../src/entities/notification-event.entity.js'),
  import('../src/entities/system-config.entity.js'),
  import('../src/entities/auth-risk-state.entity.js'),
  import('../src/utils/password.js'),
  import('../src/utils/session-token.js'),
  import('../src/services/mobile-session.service.js'),
  import('../src/services/mobile-auth.service.js'),
  import('../src/services/auth-security.service.js'),
  import('../src/services/client-user-manage.service.js'),
  import('../src/services/client-auth.service.js'),
  import('../src/services/system-config.service.js'),
  import('../src/services/verification-code.service.js'),
  import('../src/middleware/client-auth.middleware.js'),
  import('../src/middleware/mobile-auth.middleware.js'),
  import('../src/utils/errors.js'),
  import('../src/middleware/error-handler.js'),
  import('typeorm'),
])

const device = (suffix: number) => ({
  deviceId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
  deviceName: `Contract Device ${suffix}`,
  platform: 'android' as const,
  appVersion: '1.0.0',
})

let userSequence = 0
const createUser = async (realName?: string) => {
  userSequence += 1
  const repository = AppDataSource.getRepository(ClientUser)
  return repository.save(repository.create({
    mobile: `139${String(Date.now()).slice(-7)}${userSequence % 10}`,
    email: `mobile-auth-${Date.now()}-${userSequence}@example.test`,
    mobileVerifiedAt: new Date(),
    emailVerifiedAt: new Date(),
    passwordHash: await hashPassword('StrongPass123!'),
    realName: realName ?? `验收用户${userSequence}`,
    departmentName: '',
    accountType: 'personal',
    staffNo: null,
    staffVerified: false,
    status: 'enabled',
    lastLoginAt: null,
  }))
}

const loadSessionWithSecrets = (id: string) => AppDataSource.getRepository(ClientMobileSession)
  .createQueryBuilder('session')
  .addSelect(['session.accessTokenHash', 'session.refreshTokenHash', 'session.previousRefreshTokenHash'])
  .where('session.id = :id', { id })
  .getOneOrFail()

const expectBizErrorCode = (code: number) => (error: unknown) => (
  error instanceof BizError && error.code === code
)

const invokeMiddleware = async (
  middleware: (req: never, res: never, next: (error?: unknown) => void) => unknown,
  request: Record<string, unknown>,
) => new Promise<unknown>((resolve) => {
  void middleware(request as never, {} as never, (error?: unknown) => resolve(error))
})

console.log(`[mobile-auth-contract] mode=${VERIFY_MODE} database=${String(AppDataSource.options.database ?? '')}`)
await AppDataSource.initialize()
try {
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  const tableCount: Array<{ total: number | string }> = VERIFY_MODE === 'mysql'
    ? await AppDataSource.query(
      `SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_mobile_session'`,
    )
    : await AppDataSource.query(
      `SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'client_mobile_session'`,
    )
  assert.equal(Number(tableCount[0]?.total), 1)
  const mobileSessionMetadata = AppDataSource.getMetadata(ClientMobileSession)
  assert.equal(mobileSessionMetadata.findColumnWithPropertyName('deviceName')?.length, '64')
  assert.equal(mobileSessionMetadata.findColumnWithPropertyName('platform')?.isNullable, false)
  pass('Schema', `${VERIFY_MODE} client_mobile_session 表已由正式入口创建`)

  await systemConfigService.ensureDefaultConfigs()
  const loginUser = await createUser()
  const loginResult = await mobileAuthService.login({
    account: loginUser.email ?? '',
    password: 'StrongPass123!',
    device: device(10),
  })
  assert.equal(loginResult.generation, 0)
  const loginAuth = await mobileSessionService.resolveAccess(loginResult.accessToken, 'contract-login')
  assert.equal(loginAuth.userId, loginUser.id)
  await assert.rejects(mobileSessionService.resolveAccess('malformed-bearer'), expectBizErrorCode(40100))
  pass('Login', `${VERIFY_MODE} 真实密码校验、Mobile 签发与 access authentication 通过`)

  const expiryUser = await createUser()
  const accessExpiry = await mobileSessionService.createForUser(expiryUser, device(11))
  await AppDataSource.getRepository(ClientMobileSession).update(accessExpiry.session.id, {
    accessExpiresAt: new Date(Date.now() - 1_000),
  })
  await assert.rejects(mobileSessionService.resolveAccess(accessExpiry.accessToken), expectBizErrorCode(40102))

  const absoluteExpiry = await mobileSessionService.createForUser(expiryUser, device(12))
  await AppDataSource.getRepository(ClientMobileSession).update(absoluteExpiry.session.id, {
    absoluteExpiresAt: new Date(Date.now() - 1_000),
  })
  await assert.rejects(
    mobileSessionService.refresh(
      absoluteExpiry.refreshToken,
      { deviceId: device(12).deviceId },
      { ipAddress: '127.0.0.1', userAgent: 'mobile-auth-contract' },
    ),
    expectBizErrorCode(40112),
  )
  const absoluteExpiryAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'mobile_session_revoked', targetId: absoluteExpiry.session.id },
    order: { id: 'DESC' },
  })
  assert.deepEqual(JSON.parse(absoluteExpiryAudit.detailJson ?? '{}'), {
    revokeReason: 'expired_cleanup',
    initiatedBy: 'refresh',
    expiryKind: 'absolute',
  })
  pass('Expiry', 'access expiry 与 absolute expiry 使用独立错误码且 absolute 不被 rotation 延长')

  const activityUser = await createUser()
  const activityCredentials = await mobileSessionService.createForUser(activityUser, device(13))
  const activityBefore = (await AppDataSource.getRepository(ClientMobileSession).findOneByOrFail({
    id: activityCredentials.session.id,
  })).lastAccessAt.getTime()
  await mobileSessionService.resolveAccess(activityCredentials.accessToken, 'activity-throttle-fast')
  const activityWithoutWrite = (await AppDataSource.getRepository(ClientMobileSession).findOneByOrFail({
    id: activityCredentials.session.id,
  })).lastAccessAt.getTime()
  assert.equal(activityWithoutWrite, activityBefore)
  await AppDataSource.getRepository(ClientMobileSession).update(activityCredentials.session.id, {
    lastAccessAt: new Date(Date.now() - 120_000),
  })
  await mobileSessionService.resolveAccess(activityCredentials.accessToken, 'activity-throttle-slow')
  const activityAfter = (await AppDataSource.getRepository(ClientMobileSession).findOneByOrFail({
    id: activityCredentials.session.id,
  })).lastAccessAt.getTime()
  assert.ok(activityAfter > activityBefore - 120_000)
  pass('Activity', '60 秒内纯读不写 last_access_at，超过阈值才节流更新')

  const lockStateUser = await createUser()
  const lockStateInitial = await mobileSessionService.createForUser(lockStateUser, device(19))
  configureMobileSessionContractVerificationHooks({
    onRefreshLockAcquired: async (sessionId) => {
      assert.equal(sessionId, lockStateInitial.session.id)
      await new Promise((resolve) => setTimeout(resolve, 1_100))
    },
  })
  let lockStateResult
  try {
    lockStateResult = await mobileSessionService.refresh(lockStateInitial.refreshToken, {
      deviceId: device(19).deviceId,
    })
  } finally {
    configureMobileSessionContractVerificationHooks(null)
  }
  assert.equal(lockStateResult.generation, 1)
  pass('Strict', 'refresh authorization 只取决于获得锁后的真实 CUR/PREV，不依赖 HTTP 到达时间')

  const concurrencyUser = await createUser()
  const initial = await mobileSessionService.createForUser(concurrencyUser, device(1))
  let refreshCriticalSections = 0
  let maximumConcurrentCriticalSections = 0
  const refreshLockAcquiredAtMs: number[] = []
  configureMobileSessionContractVerificationHooks({
    onRefreshLockAcquired: async (sessionId) => {
      assert.equal(sessionId, initial.session.id)
      refreshLockAcquiredAtMs.push(Date.now())
      refreshCriticalSections += 1
      maximumConcurrentCriticalSections = Math.max(maximumConcurrentCriticalSections, refreshCriticalSections)
      await new Promise((resolve) => setTimeout(resolve, 20))
      refreshCriticalSections -= 1
    },
  })
  let concurrentResults: PromiseSettledResult<Awaited<ReturnType<typeof mobileSessionService.refresh>>>[]
  try {
    concurrentResults = await Promise.allSettled(
      Array.from({ length: CONCURRENT_REFRESH_COUNT }, () => (
        mobileSessionService.refresh(initial.refreshToken, { deviceId: device(1).deviceId })
      )),
    )
  } finally {
    configureMobileSessionContractVerificationHooks(null)
  }
  assert.equal(concurrentResults.length, CONCURRENT_REFRESH_COUNT)
  assert.equal(maximumConcurrentCriticalSections, 1)
  const observedLockSerializationMs = refreshLockAcquiredAtMs.slice(1).reduce((maximum, acquiredAt, index) => (
    Math.max(maximum, acquiredAt - (refreshLockAcquiredAtMs[index] ?? acquiredAt))
  ), 0)
  if (VERIFY_MODE === 'mysql') {
    assert.ok(observedLockSerializationMs >= 15, `MySQL 行锁等待未被观测到：${observedLockSerializationMs}ms`)
  }
  const successfulRefreshes = concurrentResults.flatMap((result) => (
    result.status === 'fulfilled' ? [result.value] : []
  ))
  const failedRefreshes = concurrentResults.flatMap((result) => (
    result.status === 'rejected' ? [result.reason as unknown] : []
  ))
  assert.ok(successfulRefreshes.length >= 1)
  assert.ok(successfulRefreshes.length <= 2)
  assert.equal(failedRefreshes.length, CONCURRENT_REFRESH_COUNT - successfulRefreshes.length)
  for (const error of failedRefreshes) {
    assert.ok(error instanceof BizError)
    assert.ok(error.code === 40110 || error.code === 40113)
  }
  const successfulGenerations = successfulRefreshes.map((item) => item.generation).sort((a, b) => a - b)
  assert.equal(new Set(successfulGenerations).size, successfulGenerations.length)
  assert.deepEqual(
    successfulGenerations,
    Array.from({ length: successfulRefreshes.length }, (_, index) => index + 1),
  )
  const afterConcurrent = await loadSessionWithSecrets(initial.session.id)
  assert.equal(afterConcurrent.refreshGeneration, successfulGenerations.at(-1))
  const newestSuccessfulRefresh = [...successfulRefreshes].sort((a, b) => b.generation - a.generation)[0]
  assert.ok(newestSuccessfulRefresh)
  assert.equal(afterConcurrent.refreshTokenHash, hashSessionToken(newestSuccessfulRefresh.refreshToken))
  const previousSuccessfulRefresh = successfulRefreshes.find((item) => (
    item.generation === newestSuccessfulRefresh.generation - 1
  ))
  assert.equal(
    afterConcurrent.previousRefreshTokenHash,
    hashSessionToken(previousSuccessfulRefresh?.refreshToken ?? initial.refreshToken),
  )
  assert.equal(await AppDataSource.getRepository(ClientMobileSession).count({
    where: { refreshTokenHash: afterConcurrent.refreshTokenHash },
  }), 1)
  const concurrencyReplayAudits = await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'refresh_replay_detected', targetId: initial.session.id },
  })
  if (afterConcurrent.revokedAt) {
    assert.equal(afterConcurrent.revokeReason, 'refresh_replay_detected')
    assert.ok(concurrencyReplayAudits >= 1)
  }
  pass('G-1', `${VERIFY_MODE} 行锁/单写队列临界区无重叠，CAS 未丢更新，锁获取间隔=${observedLockSerializationMs}ms`)
  pass('G-2', `同 token 10-way storm 安全收敛：success=${successfulRefreshes.length}, failed=${failedRefreshes.length}`)
  console.log(
    `[mobile-auth-concurrency] mode=${VERIFY_MODE} success=${successfulRefreshes.length} failed=${failedRefreshes.length}`
    + ` state=${afterConcurrent.revokedAt ? 'revoked' : 'active'} generation=${afterConcurrent.refreshGeneration}`
    + ` replayAudit=${concurrencyReplayAudits}`,
  )
  const rotationRateUser = await createUser()
  let stormContinuation = await mobileSessionService.createForUser(rotationRateUser, device(20))
  for (let generation = 1; generation <= ROTATION_RATE_LIMIT; generation += 1) {
    stormContinuation = await mobileSessionService.refresh(stormContinuation.refreshToken, {
      deviceId: device(20).deviceId,
    })
    assert.equal(stormContinuation.generation, generation)
  }
  await assert.rejects(
    mobileSessionService.refresh(stormContinuation.refreshToken, { deviceId: device(20).deviceId }),
    expectBizErrorCode(40113),
  )
  assert.equal((await loadSessionWithSecrets(stormContinuation.session.id)).revokeReason, 'refresh_replay_detected')
  pass('RG-10 Count', 'rotation burst 只统计成功 generation 增量，不把 strict storm 失败请求计入阈值')

  const rotationUser = await createUser()
  const rotationInitial = await mobileSessionService.createForUser(rotationUser, device(18))
  const rotationCurrent = await mobileSessionService.refresh(rotationInitial.refreshToken, {
    deviceId: device(18).deviceId,
  })
  const afterRotation = await loadSessionWithSecrets(rotationInitial.session.id)
  assert.equal(afterRotation.refreshTokenHash, hashSessionToken(rotationCurrent.refreshToken))
  assert.equal(afterRotation.previousRefreshTokenHash, hashSessionToken(rotationInitial.refreshToken))
  assert.ok(afterRotation.previousRefreshGraceUntil)
  assert.ok(afterRotation.previousRefreshGraceUntil.getTime() > Date.now())
  assert.equal(afterRotation.refreshGeneration, 1)
  pass('G-3', 'CUR/PREV/grace/generation 单条 rotation 后数据库状态一致且无明文 token')

  const sessionRateStateCountBefore = await AppDataSource.getRepository(AuthRiskState).count()
  const sessionRateUser = await createUser()
  const sessionRateInitial = await mobileSessionService.createForUser(sessionRateUser, device(23))
  const sessionRateFirst = await mobileSessionService.refresh(sessionRateInitial.refreshToken, {
    deviceId: device(23).deviceId,
  })
  await mobileSessionService.refresh(sessionRateFirst.refreshToken, { deviceId: device(23).deviceId })
  const sessionRateStateCountAfter = await AppDataSource.getRepository(AuthRiskState).count()
  assert.equal(
    sessionRateStateCountAfter - sessionRateStateCountBefore,
    2,
    '同一 session 连续 rotation 应只复用一个稳定 refresh 限流桶和一个 RG-10 桶',
  )
  pass('T-50', 'refresh 按稳定 session id 分桶，token rotation 不会重置 60 次/小时计数')

  const casRetryUser = await createUser()
  const casRetryInitial = await mobileSessionService.createForUser(casRetryUser, device(24))
  let forceSingleCasConflict = true
  configureMobileSessionContractVerificationHooks({
    forceRefreshCasConflict: () => {
      const shouldConflict = forceSingleCasConflict
      forceSingleCasConflict = false
      return shouldConflict
    },
  })
  let casRetryResult
  try {
    casRetryResult = await mobileSessionService.refresh(casRetryInitial.refreshToken, {
      deviceId: device(24).deviceId,
    })
  } finally {
    configureMobileSessionContractVerificationHooks(null)
  }
  assert.equal(casRetryResult.generation, 1)
  pass('CAS Retry', 'affected=0 时重新执行完整锁内 CUR/PREV 判定，不向客户端泄漏 500')

  const rollbackUser = await createUser()
  const rollbackInitial = await mobileSessionService.createForUser(rollbackUser, device(14))
  const rollbackBefore = await loadSessionWithSecrets(rollbackInitial.session.id)
  configureMobileSessionContractVerificationHooks({
    afterRefreshCas: () => {
      throw new Error('contract-forced-rollback-after-cas')
    },
  })
  try {
    await assert.rejects(
      mobileSessionService.refresh(rollbackInitial.refreshToken, { deviceId: device(14).deviceId }),
      /contract-forced-rollback-after-cas/,
    )
  } finally {
    configureMobileSessionContractVerificationHooks(null)
  }
  const rollbackAfter = await loadSessionWithSecrets(rollbackInitial.session.id)
  assert.equal(rollbackAfter.refreshTokenHash, rollbackBefore.refreshTokenHash)
  assert.equal(rollbackAfter.previousRefreshTokenHash, rollbackBefore.previousRefreshTokenHash)
  assert.equal(rollbackAfter.previousRefreshGraceUntil, rollbackBefore.previousRefreshGraceUntil)
  assert.equal(rollbackAfter.refreshGeneration, rollbackBefore.refreshGeneration)
  const rollbackRetry = await mobileSessionService.refresh(rollbackInitial.refreshToken, {
    deviceId: device(14).deviceId,
  })
  assert.equal(rollbackRetry.generation, 1)
  pass('T-71', 'CAS 后强制回滚时 CUR/PREV/grace/generation 全部不变，原 token 可重试')

  const graceResult = await mobileSessionService.refresh(rotationInitial.refreshToken, {
    deviceId: device(18).deviceId,
    appVersion: '1.0.1',
  })
  assert.equal(graceResult.generation, 2)
  const graceAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'mobile_refresh', targetId: rotationInitial.session.id },
    order: { id: 'DESC' },
  })
  assert.equal(JSON.parse(graceAudit.detailJson ?? '{}').viaGrace, true)
  pass('G-4', 'previous refresh 在 grace 窗口内向前 rotation，审计标记 viaGrace=true')

  const graceBoundaryUser = await createUser()
  const graceBoundaryInitial = await mobileSessionService.createForUser(graceBoundaryUser, device(21))
  await mobileSessionService.refresh(graceBoundaryInitial.refreshToken, { deviceId: device(21).deviceId })
  await AppDataSource.getRepository(ClientMobileSession).update(graceBoundaryInitial.session.id, {
    previousRefreshGraceUntil: new Date(Date.now() + 100),
  })
  configureMobileSessionContractVerificationHooks({
    onRefreshLockAcquired: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    },
  })
  try {
    await assert.rejects(
      mobileSessionService.refresh(graceBoundaryInitial.refreshToken, { deviceId: device(21).deviceId }),
      expectBizErrorCode(40113),
    )
  } finally {
    configureMobileSessionContractVerificationHooks(null)
  }
  const graceBoundaryAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'refresh_replay_detected', targetId: graceBoundaryInitial.session.id },
    order: { id: 'DESC' },
  })
  assert.equal(typeof JSON.parse(graceBoundaryAudit.detailJson ?? '{}').graceExpiredBySeconds, 'number')
  pass('G-4 Boundary', 'PREV 在锁等待期间过期时 fail-closed，并记录 graceExpiredBySeconds')

  const replayUser = await createUser()
  const replayInitial = await mobileSessionService.createForUser(replayUser, device(2))
  const replayLatest = await mobileSessionService.refresh(replayInitial.refreshToken, { deviceId: device(2).deviceId })
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  await assert.rejects(
    mobileSessionService.refresh(replayInitial.refreshToken, { deviceId: device(2).deviceId }),
    expectBizErrorCode(40113),
  )
  const replaySession = await loadSessionWithSecrets(replayInitial.session.id)
  assert.equal(replaySession.revokeReason, 'refresh_replay_detected')
  assert.ok(replaySession.revokedAt)
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'refresh_replay_detected', targetId: replaySession.id },
  }), 1)
  assert.equal(await AppDataSource.getRepository(NotificationEvent).count({
    where: { eventType: 'mobile_refresh_replay_detected', sourceId: replaySession.id },
  }), 1)
  await assert.rejects(mobileSessionService.resolveAccess(replayLatest.accessToken), expectBizErrorCode(40101))
  await assert.rejects(
    mobileSessionService.refresh(replayLatest.refreshToken, { deviceId: device(2).deviceId }),
    expectBizErrorCode(40110),
  )
  pass('G-5', 'grace 外 previous 重放会撤销会话、写审计并落安全告警 Outbox')

  const replayPriorityUser = await createUser()
  const replayPriorityInitial = await mobileSessionService.createForUser(replayPriorityUser, device(25))
  const replayPriorityMeta = { ipAddress: '127.0.0.1', userAgent: 'mobile-auth-contract' }
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    await authSecurityService.guardMobileRefreshRequest(
      replayPriorityMeta,
      replayPriorityInitial.session.id,
    )
  }
  await assert.rejects(
    mobileSessionService.refresh(
      replayPriorityInitial.refreshToken,
      { deviceId: device(25).deviceId },
      replayPriorityMeta,
    ),
    expectBizErrorCode(42900),
  )
  const rateLimitedSession = await loadSessionWithSecrets(replayPriorityInitial.session.id)
  assert.equal(rateLimitedSession.revokedAt, null)
  assert.equal(rateLimitedSession.refreshGeneration, 0)
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: {
      actionType: 'mobile_auth.guard.refresh',
      targetCode: replayPriorityInitial.session.id,
    },
  }), 1)
  let replayPriorityTransitionApplied = false
  configureMobileSessionContractVerificationHooks({
    afterRefreshPreflight: async (sessionId) => {
      if (replayPriorityTransitionApplied) return
      replayPriorityTransitionApplied = true
      await AppDataSource.getRepository(ClientMobileSession).createQueryBuilder()
        .update(ClientMobileSession)
        .set({
          previousRefreshTokenHash: hashSessionToken(replayPriorityInitial.refreshToken),
          refreshTokenHash: hashSessionToken(`concurrent-refresh-${sessionId}`),
          previousRefreshGraceUntil: new Date(Date.now() - 1_000),
          refreshGeneration: () => 'refresh_generation + 1',
        })
        .where('id = :sessionId', { sessionId })
        .execute()
    },
  })
  try {
    await assert.rejects(
      mobileSessionService.refresh(
        replayPriorityInitial.refreshToken,
        { deviceId: device(25).deviceId },
        replayPriorityMeta,
      ),
      expectBizErrorCode(40113),
    )
  } finally {
    configureMobileSessionContractVerificationHooks(null)
  }
  const replayPrioritySession = await loadSessionWithSecrets(replayPriorityInitial.session.id)
  assert.equal(replayPrioritySession.revokeReason, 'refresh_replay_detected')
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'refresh_replay_detected', targetId: replayPriorityInitial.session.id },
  }), 1)
  pass('T-51', '限流桶已满且预检后 token 变成过期 PREV 时，重放撤销与审计仍优先于 429')

  const unknownRefreshAuditCount = await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'refresh_replay_detected' },
  })
  const replayRevokedCount = await AppDataSource.getRepository(ClientMobileSession).count({
    where: { revokeReason: 'refresh_replay_detected' },
  })
  await assert.rejects(
    mobileSessionService.refresh(`ylmr_${'a'.repeat(64)}`, { deviceId: device(2).deviceId }),
    expectBizErrorCode(40110),
  )
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count({
    where: { actionType: 'refresh_replay_detected' },
  }), unknownRefreshAuditCount)
  assert.equal(await AppDataSource.getRepository(ClientMobileSession).count({
    where: { revokeReason: 'refresh_replay_detected' },
  }), replayRevokedCount)
  pass('T-15', '未知 refresh token 返回 40110，且不撤销任何会话、不写重放审计')

  const unknownFloodAuditCount = await AppDataSource.getRepository(SysAuditLog).count()
  const unknownFloodToken = `ylmr_${'c'.repeat(64)}`
  for (let attempt = 1; attempt <= 601; attempt += 1) {
    await assert.rejects(
      mobileSessionService.refresh(
        unknownFloodToken,
        { deviceId: device(2).deviceId },
        { ipAddress: '198.51.100.77', userAgent: 'mobile-auth-contract' },
      ),
      attempt <= 600 ? expectBizErrorCode(40110) : expectBizErrorCode(42900),
    )
  }
  assert.equal(await AppDataSource.getRepository(SysAuditLog).count(), unknownFloodAuditCount)
  pass('T-15 Rate', '未知 refresh flood 受 IP fallback 限流，但不会形成逐请求审计写放大')

  const sensitiveHash = 'f'.repeat(64)
  const queryFailure = new QueryFailedError(
    'INSERT INTO client_mobile_session (refresh_token_hash) VALUES (?)',
    [sensitiveHash],
    { code: 'ER_DUP_ENTRY', errno: 1062, message: `Duplicate entry '${sensitiveHash}'` },
  )
  const databaseLogs: unknown[][] = []
  const originalConsoleError = console.error
  let databaseResponseStatus = 0
  try {
    console.error = (...args: unknown[]) => {
      databaseLogs.push(args)
    }
    errorHandler(queryFailure, {} as never, {
      headersSent: false,
      setHeader: () => undefined,
      status(statusCode: number) {
        databaseResponseStatus = statusCode
        return this
      },
      json() {
        return this
      },
    } as never, () => undefined)
  } finally {
    console.error = originalConsoleError
  }
  const renderedDatabaseLogs = inspect(databaseLogs, { depth: 8 })
  assert.equal(databaseResponseStatus, 409)
  assert.equal(renderedDatabaseLogs.includes(sensitiveHash), false)
  assert.equal(renderedDatabaseLogs.includes('INSERT INTO client_mobile_session'), false)

  const unmappedFailure = new QueryFailedError(
    'SELECT refresh_token_hash FROM client_mobile_session WHERE refresh_token_hash = ?',
    [sensitiveHash],
    { code: 'ER_PARSE_ERROR', errno: 1064, message: `parse failed near '${sensitiveHash}'` },
  )
  databaseLogs.length = 0
  try {
    console.error = (...args: unknown[]) => {
      databaseLogs.push(args)
    }
    errorHandler(unmappedFailure, {} as never, {
      headersSent: false,
      setHeader: () => undefined,
      status(statusCode: number) {
        databaseResponseStatus = statusCode
        return this
      },
      json() {
        return this
      },
    } as never, () => undefined)
  } finally {
    console.error = originalConsoleError
  }
  const renderedUnmappedLogs = inspect(databaseLogs, { depth: 8 })
  assert.equal(databaseResponseStatus, 500)
  assert.equal(renderedUnmappedLogs.includes(sensitiveHash), false)
  assert.equal(renderedUnmappedLogs.includes('SELECT refresh_token_hash'), false)
  pass('Logging', '数据库异常日志不包含 SQL、参数、完整 token hash 或 driver message')

  const crossGenerationUser = await createUser()
  let crossGenerationCredentials = await mobileSessionService.createForUser(crossGenerationUser, device(17))
  const generationZeroRefresh = crossGenerationCredentials.refreshToken
  for (let generation = 1; generation <= 3; generation += 1) {
    crossGenerationCredentials = await mobileSessionService.refresh(crossGenerationCredentials.refreshToken, {
      deviceId: device(17).deviceId,
    })
  }
  await assert.rejects(
    mobileSessionService.refresh(generationZeroRefresh, { deviceId: device(17).deviceId }),
    expectBizErrorCode(40110),
  )
  assert.equal((await loadSessionWithSecrets(crossGenerationCredentials.session.id)).revokedAt, null)
  pass('T-16', '跨代旧 refresh 不会被当成 current/previous 接受')

  const revokeUser = await createUser()
  const revokeInitial = await mobileSessionService.createForUser(revokeUser, device(3))
  await mobileSessionService.resolveAccess(revokeInitial.accessToken, 'contract-revoke')
  await mobileSessionService.revokeByAccessToken(revokeInitial.accessToken)
  await mobileSessionService.revokeByAccessToken(revokeInitial.accessToken)
  await assert.rejects(
    mobileSessionService.resolveAccess(revokeInitial.accessToken),
    expectBizErrorCode(40101),
  )

  const passwordUser = await createUser()
  const passwordInitial = await mobileSessionService.createForUser(passwordUser, device(4))
  const passwordOtherDevice = await mobileSessionService.createForUser(passwordUser, device(15))
  await AppDataSource.getRepository(ClientUserSession).save({
    userId: passwordUser.id,
    sessionToken: hashSessionToken('web-session-contract-token'),
    expiresAt: new Date(Date.now() + 60_000),
    lastAccessAt: new Date(),
  })
  const passwordAuth = await mobileSessionService.resolveAccess(passwordInitial.accessToken, 'change-password')
  const reissued = await mobileAuthService.changePassword(passwordAuth, {
    currentPassword: 'StrongPass123!',
    newPassword: 'NewStrongPass456!',
    device: device(4),
  })
  assert.equal(reissued.generation, 0)
  assert.equal((await loadSessionWithSecrets(reissued.session.id)).previousRefreshTokenHash, null)
  assert.equal(await AppDataSource.getRepository(ClientUserSession).count({ where: { userId: passwordUser.id } }), 0)
  const oldPasswordSession = await loadSessionWithSecrets(passwordInitial.session.id)
  assert.equal(oldPasswordSession.revokeReason, 'password_changed')
  assert.equal((await loadSessionWithSecrets(passwordOtherDevice.session.id)).revokeReason, 'password_changed')
  const passwordUserWithHash = await AppDataSource.getRepository(ClientUser)
    .createQueryBuilder('user')
    .addSelect('user.passwordHash')
    .where('user.id = :id', { id: passwordUser.id })
    .getOneOrFail()
  assert.equal(await verifyPassword('NewStrongPass456!', passwordUserWithHash.passwordHash), true)
  await mobileSessionService.resolveAccess(reissued.accessToken, 'after-change-password')
  pass('G-6', '幂等登出与改密跨表事务生效，全部旧设备失效且当前设备获得 generation=0 新会话')

  const multiDeviceUser = await createUser()
  const multiDeviceCredentials = []
  for (let index = 20; index < 31; index += 1) {
    multiDeviceCredentials.push(await mobileSessionService.createForUser(multiDeviceUser, device(index)))
  }
  const firstMultiSession = await loadSessionWithSecrets(multiDeviceCredentials[0]?.session.id ?? '')
  assert.equal(firstMultiSession.revokeReason, 'session_limit_evicted')
  const latestMulti = multiDeviceCredentials.at(-1)
  assert.ok(latestMulti)
  const latestMultiAuth = await mobileSessionService.resolveAccess(latestMulti.accessToken, 'multi-device')
  const sessionList = await mobileSessionService.listSessions(latestMultiAuth)
  assert.equal(sessionList.sessions.length, 10)
  assert.equal(sessionList.maxActiveSessions, 10)
  const revokeTarget = sessionList.sessions.find((item) => !item.isCurrent)
  assert.ok(revokeTarget)
  await mobileSessionService.revokeOwnedSession(latestMultiAuth, revokeTarget.id)
  assert.equal((await loadSessionWithSecrets(revokeTarget.id)).revokeReason, 'user_revoke_device')
  const logoutOthers = await mobileSessionService.logoutAll(latestMultiAuth, 'others')
  assert.ok(logoutOthers.revokedCount > 0)
  assert.equal(logoutOthers.currentSessionRevoked, false)
  await mobileSessionService.resolveAccess(latestMulti.accessToken, 'after-logout-others')
  const logoutAll = await mobileSessionService.logoutAll(latestMultiAuth, 'all')
  assert.equal(logoutAll.currentSessionRevoked, true)
  await assert.rejects(mobileSessionService.resolveAccess(latestMulti.accessToken), expectBizErrorCode(40101))
  pass('Device', '多设备列表、LRU=10、指定撤销、logout others 与 logout all 语义通过')

  const profileUser = await createUser('移动验收用户')
  const profileCredentials = await mobileSessionService.createForUser(profileUser, device(31))
  const profileAuth = await mobileSessionService.resolveAccess(profileCredentials.accessToken, 'profile')
  const updatedProfile = await mobileAuthService.updateProfile(profileAuth, {
    username: '移动验收用户更新',
    mobile: profileUser.mobile ?? '',
    email: '',
    currentPassword: 'StrongPass123!',
  }, { ipAddress: '127.0.0.1', userAgent: 'mobile-auth-contract' })
  assert.equal(updatedProfile.email, '')
  const profileAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'client_user.update_profile', targetId: profileUser.id },
    order: { id: 'DESC' },
  })
  assert.deepEqual(JSON.parse(profileAudit.detailJson ?? '{}').changedFields, ['username', 'email'])
  assert.equal(profileAudit.actorUserId, profileUser.id)
  pass('Profile', 'Mobile 用户名/邮箱变更与安全审计在同一事务提交且不撤销会话')

  const resetUser = await createUser()
  const resetMobile = await mobileSessionService.createForUser(resetUser, device(40))
  await AppDataSource.getRepository(ClientUserSession).save({
    userId: resetUser.id,
    sessionToken: hashSessionToken('reset-web-session-contract-token'),
    expiresAt: new Date(Date.now() + 60_000),
    lastAccessAt: new Date(),
  })
  const configRepo = AppDataSource.getRepository(SystemConfig)
  for (const [configKey, configValue] of [
    ['verification.mobile.enabled', '1'],
    ['verification.mobile.api_url', 'https://verification.example.test/mobile'],
    ['verification.email.enabled', '1'],
    ['verification.email.api_url', 'https://verification.example.test/email'],
  ] as const) {
    await configRepo.update({ configKey }, { configValue })
  }
  const verificationService = new VerificationCodeService(async () => ({
    statusCode: 200,
    headers: {},
    body: Buffer.from('ok'),
  }))
  ;(verificationService as unknown as { buildCode: () => string }).buildCode = () => '123456'
  await verificationService.sendCode({
    channel: 'email',
    target: resetUser.email ?? '',
    scene: 'forgot_password',
  })
  const resetTicket = await mobileAuthService.verifyForgotPassword({
    account: resetUser.email ?? '',
    verificationCode: '123456',
  })
  await assert.rejects(
    mobileAuthService.resetPassword({
      account: 'wrong-account@example.com',
      resetToken: resetTicket.resetToken,
      newPassword: 'ResetStrong789!',
    }),
    (error: unknown) => error instanceof BizError && error.statusCode === 404,
  )
  const resetResult = await mobileAuthService.resetPassword({
    account: resetUser.email ?? '',
    resetToken: resetTicket.resetToken,
    newPassword: 'ResetStrong789!',
  })
  assert.deepEqual(resetResult, { ok: true })
  await assert.rejects(
    mobileAuthService.resetPassword({
      account: resetUser.email ?? '',
      resetToken: resetTicket.resetToken,
      newPassword: 'ResetStrong789!',
    }),
    (error: unknown) => error instanceof BizError && error.statusCode === 400,
  )
  const resetAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'password_changed', targetId: resetUser.id },
    order: { id: 'DESC' },
  })
  assert.equal(resetAudit.actorUserId, resetUser.id)
  assert.equal(resetAudit.actorDisplayName, resetUser.realName)
  assert.equal(await AppDataSource.getRepository(ClientUserSession).count({ where: { userId: resetUser.id } }), 0)
  assert.equal((await loadSessionWithSecrets(resetMobile.session.id)).revokeReason, 'password_reset')
  await assert.rejects(mobileSessionService.resolveAccess(resetMobile.accessToken), expectBizErrorCode(40101))
  pass('Reset', 'forgot/reset 完整票据路径撤销全部 Web/Mobile 会话且不自动重签')

  const disabledUser = await createUser()
  const disabledSession = await mobileSessionService.createForUser(disabledUser, device(5))
  const disabledOtherSession = await mobileSessionService.createForUser(disabledUser, device(16))
  await clientUserManageService.updateStatus(disabledUser.id, 'disabled', {
    userId: '1',
    username: 'contract-admin',
    displayName: '契约验收管理员',
    role: 'admin',
    permissions: ['users:manage'],
    status: 'enabled',
    sessionToken: 'contract-admin-session',
    authSource: 'bearer',
  })
  await assert.rejects(
    mobileSessionService.resolveAccess(disabledSession.accessToken, 'disabled-check'),
    expectBizErrorCode(40300),
  )
  const disabledStoredSession = await loadSessionWithSecrets(disabledSession.session.id)
  assert.equal(disabledStoredSession.revokeReason, 'account_disabled')
  const disabledSessions = await AppDataSource.getRepository(ClientMobileSession).find({
    where: { clientUserId: disabledUser.id },
  })
  assert.equal(disabledSessions.length, 2)
  assert.equal(disabledSessions.every((session) => (
    session.revokedAt !== null && session.revokeReason === 'account_disabled'
  )), true)
  await assert.rejects(
    mobileSessionService.refresh(disabledOtherSession.refreshToken, { deviceId: device(16).deviceId }),
    expectBizErrorCode(40300),
  )
  pass('G-7', '后台停用与 Mobile 会话撤销同事务完成，旧 access/refresh 均不可用')

  const webBoundaryUser = await createUser()
  const webToken = 'web-cookie-boundary-token'
  await AppDataSource.getRepository(ClientUserSession).save({
    userId: webBoundaryUser.id,
    sessionToken: hashSessionToken(webToken),
    expiresAt: new Date(Date.now() + 60_000),
    lastAccessAt: new Date(),
  })
  const mobileBoundaryUser = await createUser()
  const mobileBoundary = await mobileSessionService.createForUser(mobileBoundaryUser, device(50))
  const cookieOnlyRequest = {
    headers: { cookie: `y_link_client_session=${webToken}` },
    path: '/client-auth/me',
  }
  assert.equal(await invokeMiddleware(requireClientAuth as never, cookieOnlyRequest), undefined)
  assert.equal((cookieOnlyRequest as { clientAuth?: { userId: string } }).clientAuth?.userId, webBoundaryUser.id)
  const invalidBearerWithCookie = {
    headers: {
      cookie: `y_link_client_session=${webToken}`,
      authorization: 'Bearer invalid-bearer-token',
    },
    path: '/client-auth/me',
  }
  const invalidBearerError = await invokeMiddleware(requireClientAuth as never, invalidBearerWithCookie)
  assert.ok(invalidBearerError instanceof BizError)
  assert.equal((invalidBearerWithCookie as { clientAuth?: unknown }).clientAuth, undefined)
  const historicalWebBearer = {
    headers: { authorization: `Bearer ${webToken}` },
    path: '/client-auth/me',
  }
  assert.equal(await invokeMiddleware(requireClientAuth as never, historicalWebBearer), undefined)
  assert.equal((historicalWebBearer as { clientAuth?: { userId: string } }).clientAuth?.userId, webBoundaryUser.id)
  const revokedMobileBoundary = await mobileSessionService.createForUser(mobileBoundaryUser, device(51))
  await mobileSessionService.revokeByAccessToken(revokedMobileBoundary.accessToken)
  const revokedMobileWithCookie = {
    headers: {
      cookie: `y_link_client_session=${webToken}`,
      authorization: `Bearer ${revokedMobileBoundary.accessToken}`,
    },
    path: '/client-auth/me',
  }
  const revokedMobileError = await invokeMiddleware(requireClientAuth as never, revokedMobileWithCookie)
  assert.ok(revokedMobileError instanceof BizError)
  assert.equal((revokedMobileWithCookie as { clientAuth?: unknown }).clientAuth, undefined)
  for (const authorization of ['Basic xxx', 'Bearer', '']) {
    const failClosedRequest = {
      headers: { cookie: `y_link_client_session=${webToken}`, authorization },
      path: '/client-auth/me',
    }
    const failClosedError = await invokeMiddleware(requireClientAuth as never, failClosedRequest)
    assert.ok(failClosedError instanceof BizError)
    assert.equal((failClosedRequest as { clientAuth?: unknown }).clientAuth, undefined)
  }
  const emptyBearerWithCookie = {
    headers: {
      cookie: `y_link_client_session=${webToken}`,
      authorization: '',
    },
    path: '/client-auth/me',
  }
  const emptyBearerError = await invokeMiddleware(requireClientAuth as never, emptyBearerWithCookie)
  assert.ok(emptyBearerError instanceof BizError)
  assert.equal((emptyBearerWithCookie as { clientAuth?: unknown }).clientAuth, undefined)
  const mobileBearerWins = {
    headers: {
      cookie: `y_link_client_session=${webToken}`,
      authorization: `Bearer ${mobileBoundary.accessToken}`,
    },
    path: '/o2o/mall/preorders',
  }
  assert.equal(await invokeMiddleware(requireClientAuth as never, mobileBearerWins), undefined)
  assert.equal((mobileBearerWins as { clientAuth?: { userId: string } }).clientAuth?.userId, mobileBoundaryUser.id)
  const mobileCookieOnly = {
    headers: { cookie: `y_link_client_session=${mobileBoundary.accessToken}` },
    path: '/me',
  }
  const mobileCookieError = await invokeMiddleware(requireMobileAuth as never, mobileCookieOnly)
  assert.ok(mobileCookieError instanceof BizError)
  assert.equal(mobileCookieError.code, 40100)
  for (const authorization of [
    'Bearer',
    'Bearer  ',
    'Basic xxx',
    `Bearer ${'a'.repeat(4096)}`,
    'Bearer abc\u0000',
    `Bearer ylmr_${'b'.repeat(64)}`,
  ]) {
    const malformedMobileRequest = { headers: { authorization }, path: '/me' }
    const malformedMobileError = await invokeMiddleware(requireMobileAuth as never, malformedMobileRequest)
    assert.ok(malformedMobileError instanceof BizError)
    assert.equal(malformedMobileError.code, 40100)
  }
  pass('Boundary', 'T-W1～T-W8 与畸形 Bearer 守门通过；Authorization 存在即独占且 Mobile 路由拒绝 Cookie')

  await AppDataSource.getRepository(ClientMobileSession).update(revokeInitial.session.id, {
    revokedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
  })
  await mobileSessionService.cleanupExpiredBatch()
  assert.equal(await AppDataSource.getRepository(ClientMobileSession).findOneBy({
    id: revokeInitial.session.id,
  }), null)
  pass('Cleanup', '已撤销会话保留 30 天后由分批清理任务物理回收')

  console.log(`\nmobile-auth:contract:verify (${VERIFY_MODE}) 全部通过。`)
} finally {
  mobileSessionService.stopCleanupLoop()
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  if (VERIFY_MODE === 'mysql') await dropMysqlDatabase()
  else removeSqliteFiles()
}
