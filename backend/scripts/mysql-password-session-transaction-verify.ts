/**
 * 模块说明：backend/scripts/mysql-password-session-transaction-verify.ts
 * 文件职责：在已核对所有权的独占MySQL中验证真实Web/Mobile改密、撤销和refresh事务交错。
 * 实现逻辑：通过测试侧QueryRunner观察/暂停真实SQL，使用另一真实服务连接竞争；
 * performance_schema确认数据库锁等待，不模拟事务、密码、会话或refresh结果。
 * 维护说明：不输出SQL参数、密码、token或完整hash；失败保留脱敏连接/锁序证据，禁止指向业务库。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { QueryRunner } from 'typeorm'
import type { MobileSessionCredentials } from '../src/services/mobile-session.service.js'
import { readOwnedMysqlContext } from './owned-mysql-fixture.mjs'

const owned = readOwnedMysqlContext()
assert.match(owned.database, /_auth$/)
assert.equal(process.env.NODE_ENV, 'test')
assert.equal(process.env.DB_TYPE, 'mysql')
assert.ok(process.env.ENV_FILE && fs.readFileSync(process.env.ENV_FILE, 'utf8') === '')
process.env.APP_PROFILE = 'mysql-password-session-verify'
process.env.REDIS_URL = ''
process.env.ALIYUN_DYPNS_MNS_ENABLED = 'false'

const { AppDataSource: db } = await import('../src/config/data-source.js')
const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
const { initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { getCurrentTransactionManager } = await import('../src/database/transaction-coordinator.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const { ClientUserSession } = await import('../src/entities/client-user-session.entity.js')
const { ClientMobileSession } = await import('../src/entities/client-mobile-session.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
const { AuthRiskState } = await import('../src/entities/auth-risk-state.entity.js')
const { hashSessionToken } = await import('../src/utils/session-token.js')
const { hashPassword, verifyPassword } = await import('../src/utils/password.js')
const { BizError } = await import('../src/utils/errors.js')
const { clientAuthService } = await import('../src/services/client-auth.service.js')
const { mobileAuthService } = await import('../src/services/mobile-auth.service.js')
const { mobileSessionService } = await import('../src/services/mobile-session.service.js')
const { auditService } = await import('../src/services/audit.service.js')
const { createConnection } = await import('mysql2/promise')

const oldPassword = 'CurrentVerifyA1!'
const newPassword = 'NextVerifyB2!'
const wrongPassword = 'WrongVerifyC3!'
type Kind = 'account' | 'web-session' | 'mobile-session'
type Event = { kind: Kind; phase: 'attempt' | 'acquired'; connectionId: number; lock: boolean }
type Trace = { events: Event[]; outcome?: { status: string; errorType?: string; code?: string; driverCode?: string } }
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }
const context = new AsyncLocalStorage<Trace>()
const traces = new Map<string, Trace>()
const inFlight: Promise<unknown>[] = []
const results: Array<{ name: string; status: string; traces: Record<string, Event[]>; outcomes?: Record<string, Trace['outcome']>; error?: string }> = []
assert.ok(process.env.Y_LINK_MYSQL_VERIFY_EVIDENCE_DIR, '必须提供容器清理后仍保留的独占证据目录')
const evidenceDirectory = path.resolve(process.env.Y_LINK_MYSQL_VERIFY_EVIDENCE_DIR)
assert.ok(!evidenceDirectory.startsWith(path.resolve(process.env.Y_LINK_DATA_DIR!) + path.sep), '证据不得放在稍后删除的运行目录内')
fs.mkdirSync(evidenceDirectory, { recursive: true })
const evidenceFile = path.join(evidenceDirectory, 'mysql-password-session-results.json')
const originalCreateRunner = db.createQueryRunner

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const pauses: Array<{ trace: Trace; phase: Event['phase']; used: boolean; entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }> = []
function pauseAccount(label: string, phase: Event['phase']) {
  const trace = { events: [] }
  traces.set(label, trace)
  const pause = { trace, phase, used: false, entered: deferred(), released: deferred() }
  pauses.push(pause)
  return pause
}

function launch<T>(label: string, operation: () => Promise<T>): Promise<Settled<T>> {
  const trace: Trace = traces.get(label) ?? { events: [] }
  traces.set(label, trace)
  const settled = context.run(trace, operation).then(
    value => {
      trace.outcome = { status: 'fulfilled' }
      return { status: 'fulfilled' as const, value }
    },
    reason => {
      const error = reason as { name?: string; code?: unknown; driverError?: { code?: unknown } }
      const safeCode = (value: unknown) => /^[A-Z_0-9]+$/.test(String(value)) ? String(value) : undefined
      trace.outcome = { status: 'rejected', errorType: error?.name ?? 'Unknown', code: safeCode(error?.code), driverCode: safeCode(error?.driverError?.code) }
      return { status: 'rejected' as const, reason }
    },
  )
  inFlight.push(settled)
  return settled
}

async function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 12_000)
    })])
  } finally { clearTimeout(timer) }
}

function queryKind(sql: string): Kind | undefined {
  const table = /\b(?:FROM|UPDATE|INTO)\s+`?(client_user_session|client_mobile_session|client_user)`?\b/i.exec(sql)?.[1]
  return table === 'client_user' ? 'account' : table === 'client_user_session' ? 'web-session'
    : table === 'client_mobile_session' ? 'mobile-session' : undefined
}

async function observe(trace: Trace, event: Event) {
  trace.events.push(event)
  const pause = pauses.find(item => !item.used && item.trace === trace && item.phase === event.phase && event.kind === 'account' && event.lock)
  if (pause) {
    pause.used = true
    pause.entered.resolve()
    await pause.released.promise
  }
}

db.createQueryRunner = function (...args: Parameters<typeof originalCreateRunner>) {
  const runner = originalCreateRunner.apply(this, args)
  const query = runner.query
  runner.query = (async function (this: QueryRunner, ...parameters: Parameters<typeof query>) {
    const trace = context.getStore()
    const sql = parameters[0]
    const kind = queryKind(sql)
    if (!trace || !kind) return query.apply(this, parameters)
    const connection = await this.connect()
    const connectionId = Number(connection.threadId)
    assert.ok(Number.isInteger(connectionId) && connectionId > 0, '必须观察真实MySQL连接')
    const event = { kind, connectionId, lock: /^\s*SELECT\b/i.test(sql) && /\bFOR UPDATE\b/i.test(sql) }
    await observe(trace, { ...event, phase: 'attempt' })
    const value = await query.apply(this, parameters)
    await observe(trace, { ...event, phase: 'acquired' })
    return value
  }) as typeof runner.query
  return runner
}

const monitor = await createConnection(owned)
let sequence = 0
async function fixture() {
  sequence += 1
  const user = await db.getRepository(ClientUser).save({
    realName: '隔离改密验证', email: `mysql-${randomUUID()}@example.test`,
    passwordHash: await hashPassword(oldPassword), accountType: 'personal' as const,
    departmentName: '', status: 'enabled' as const, staffVerified: false,
  })
  const device = { deviceId: randomUUID(), platform: 'android' as const }
  const credentials = await mobileSessionService.createForUser(user, device)
  const mobileAuth = await mobileSessionService.resolveAccess(credentials.accessToken)
  const webToken = randomBytes(32).toString('hex')
  const webSession = await db.getRepository(ClientUserSession).save({
    userId: user.id, sessionToken: hashSessionToken(webToken),
    expiresAt: new Date(Date.now() + 60_000), lastAccessAt: new Date(),
  })
  const webAuth = await clientAuthService.resolveClientByToken(webToken)
  const meta = { ipAddress: `198.18.0.${sequence}`, userAgent: 'isolated-mysql', clientRiskBrowserId: randomUUID(), clientRiskSessionId: randomUUID() }
  return { user, device, credentials, mobileAuth, webAuth, webToken, webSession, meta }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function change(item: Fixture, mobile: boolean, currentPassword = oldPassword) {
  return mobile
    ? mobileAuthService.changePassword(item.mobileAuth, { currentPassword, newPassword, device: item.device }, item.meta)
    : clientAuthService.changePassword(item.webAuth, { currentPassword, newPassword }, item.meta)
}

async function passwordIs(item: Fixture, expected: string) {
  const user = await db.getRepository(ClientUser).createQueryBuilder('user').addSelect('user.passwordHash')
    .where('user.id = :id', { id: item.user.id }).getOneOrFail()
  assert.equal(await verifyPassword(expected, user.passwordHash), true)
}

const isUnauthorized = (error: unknown) => error instanceof BizError && error.statusCode === 401
function rejectedUnauthorized<T>(result: Settled<T>) {
  assert.equal(result.status, 'rejected', '旧认证快照必须被拒绝')
  if (result.status === 'rejected') assert.ok(isUnauthorized(result.reason), '必须是会话失效401，不能用SQL错误替代')
}

async function successCount(item: Fixture) {
  return db.getRepository(SysAuditLog).countBy({ actionType: 'password_changed', targetType: 'client_user', targetId: item.user.id })
}

function assertPasswordLockOrder(label: string, mobile: boolean) {
  const locked = traces.get(label)!.events.filter(event => event.phase === 'acquired' && event.lock)
  assert.equal(locked[0]?.kind, 'account', '改密必须先锁账号')
  assert.equal(locked[1]?.kind, mobile ? 'mobile-session' : 'web-session', '取得账号锁后必须重查对应会话')
  assert.equal(locked[0]?.connectionId, locked[1]?.connectionId, '账号和会话必须使用同一事务连接')
}

async function waitForLockWait(label: string, kind: Kind) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const events = traces.get(label)?.events ?? []
    const event = events.find(entry => entry.kind === kind && entry.phase === 'attempt' && entry.lock)
    if (event) {
      const [rows] = await monitor.query(
        'SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID = ?',
        [event.connectionId],
      )
      if (Number((rows as Array<{ waiting: number }>)[0]?.waiting) > 0) return event.connectionId
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('未观察到受控交错的真实MySQL锁等待：' + label)
}

async function committed(item: Fixture, mobile: boolean, credentials?: MobileSessionCredentials | void) {
  await passwordIs(item, newPassword)
  await assert.rejects(clientAuthService.resolveClientByToken(item.webToken), isUnauthorized)
  await assert.rejects(mobileSessionService.resolveAccess(item.credentials.accessToken), isUnauthorized)
  await assert.rejects(mobileSessionService.refresh(item.credentials.refreshToken, item.device, item.meta), isUnauthorized)
  const sessions = await db.getRepository(ClientMobileSession).findBy({ clientUserId: item.user.id })
  assert.equal(sessions.filter(session => !session.revokedAt).length, mobile ? 1 : 0)
  assert.equal(sessions.length, mobile ? 2 : 1, '失败/竞争路径不能多签会话')
  assert.equal(await successCount(item), 1, '成功审计必须与密码、撤销、重签一起仅提交一次')
  if (mobile) {
    assert.ok(credentials)
    await mobileSessionService.resolveAccess(credentials.accessToken)
    const rotated = await mobileSessionService.refresh(credentials.refreshToken, item.device, item.meta)
    await mobileSessionService.resolveAccess(rotated.accessToken)
  }
}

async function scenario(name: string, operation: () => Promise<void>) {
  const labelsBefore = new Set(traces.keys())
  const result = { name, status: 'running', traces: {} as Record<string, Event[]>, outcomes: {} as Record<string, Trace['outcome']>, error: undefined as string | undefined }
  results.push(result)
  const save = () => fs.writeFileSync(evidenceFile, JSON.stringify({ database: '本批独占随机auth库', results }, null, 2) + '\n')
  try {
    await operation()
    result.status = 'passed'
    console.log('PASS ' + name)
  } catch (error) {
    result.status = 'failed'
    // SQL错误可能携带参数，证据只记类型/代码，业务断言只记固定文本。
    result.error = error instanceof assert.AssertionError ? error.message
      : error instanceof Error ? error.name + ':' + String((error as { code?: string }).code ?? '受控场景失败') : '未知失败'
    throw new Error('MySQL改密受控场景失败：' + name + '；见脱敏结果文件')
  } finally {
    for (const pause of pauses) pause.released.resolve()
    await deadline(Promise.allSettled(inFlight), '受控SQL未排空')
    result.traces = Object.fromEntries([...traces].filter(([label]) => !labelsBefore.has(label)).map(([label, trace]) => [label, trace.events]))
    result.outcomes = Object.fromEntries([...traces].filter(([label]) => !labelsBefore.has(label)).map(([label, trace]) => [label, trace.outcome]))
    save()
  }
}

try {
  await db.initialize()
  await initializeDatabaseInfrastructure(db)
  await initializeDatabaseSchemaIfNeeded(db)
  const [isolationRows] = await monitor.query('SELECT @@transaction_isolation AS isolation')
  assert.equal((isolationRows as Array<{ isolation: string }>)[0]?.isolation, 'REPEATABLE-READ')

  for (const mobile of [false, true]) {
    const channel = mobile ? 'Mobile' : 'Web'
    for (const invalidation of ['logout', 'expiry'] as const) {
      await scenario(`${channel}-${invalidation}-before-session-recheck`, async () => {
        const item = await fixture()
        const label = `${channel}-${invalidation}-change`
        const pause = pauseAccount(label, 'attempt')
        const changing = launch(label, () => change(item, mobile))
        await deadline(pause.entered.promise, '改密没有到达账号锁边界')
        const revokeLabel = `${channel}-${invalidation}-competing`
        const invalidated = await launch(revokeLabel, () => invalidation === 'logout'
          ? mobile ? mobileSessionService.revokeCurrent(item.mobileAuth, item.meta) : clientAuthService.logout(item.webAuth)
          : mobile ? db.getRepository(ClientMobileSession).update(item.credentials.session.id, { accessExpiresAt: new Date(0) })
            : db.getRepository(ClientUserSession).update(item.webSession.id, { expiresAt: new Date(0) }))
        assert.equal(invalidated.status, 'fulfilled')
        const firstId = traces.get(label)!.events[0]!.connectionId
        assert.ok(traces.get(revokeLabel)!.events.some(event => event.connectionId !== firstId), '撤销/过期必须由另一条真实连接提交')
        pause.released.resolve()
        rejectedUnauthorized(await changing)
        assertPasswordLockOrder(label, mobile)
        await passwordIs(item, oldPassword)
        assert.equal(await successCount(item), 0)
        assert.equal(await db.getRepository(ClientMobileSession).countBy({ clientUserId: item.user.id }), 1)
      })
    }

    await scenario(`${channel}-same-session-two-password-transactions`, async () => {
      const item = await fixture(), label = `${channel}-password-first`, second = `${channel}-password-second`
      const pause = pauseAccount(label, 'acquired')
      const firstChange = launch(label, () => change(item, mobile))
      await deadline(pause.entered.promise, '首个改密没有持有账号锁')
      const secondChange = launch(second, () => change(item, mobile))
      const waitingId = await waitForLockWait(second, 'account')
      assert.notEqual(waitingId, traces.get(label)!.events[0]!.connectionId)
      pause.released.resolve()
      const first = await firstChange
      assert.equal(first.status, 'fulfilled')
      rejectedUnauthorized(await secondChange)
      assertPasswordLockOrder(label, mobile)
      assertPasswordLockOrder(second, mobile)
      await committed(item, mobile, first.status === 'fulfilled' ? first.value : undefined)
    })

    await scenario(`${channel}-password-lock-versus-real-refresh`, async () => {
      const item = await fixture(), label = `${channel}-change-before-refresh`, refreshLabel = `${channel}-refresh-waits`
      const pause = pauseAccount(label, 'acquired')
      const changing = launch(label, () => change(item, mobile))
      await deadline(pause.entered.promise, '改密没有持有账号锁')
      const refreshing = launch(refreshLabel, () => mobileSessionService.refresh(item.credentials.refreshToken, item.device, item.meta))
      const waitingId = await waitForLockWait(refreshLabel, 'mobile-session')
      assert.notEqual(waitingId, traces.get(label)!.events[0]!.connectionId)
      pause.released.resolve()
      const changed = await changing
      assert.equal(changed.status, 'fulfilled', '真实refresh竞争不能使有效改密泄露SQL失败')
      rejectedUnauthorized(await refreshing)
      assertPasswordLockOrder(label, mobile)
      await committed(item, mobile, changed.status === 'fulfilled' ? changed.value : undefined)
    })

    await scenario(`${channel}-audit-failure-rolls-back-all-password-writes`, async () => {
      const item = await fixture(), originalRecord = auditService.record
      auditService.record = async function (...args: Parameters<typeof originalRecord>) {
        const value = await originalRecord.apply(this, args)
        if (args[0].actionType === 'password_changed' && args[0].targetId === item.user.id) throw new Error('fixture-password-audit-failure')
        return value
      }
      try { await assert.rejects(change(item, mobile), /fixture-password-audit-failure/) }
      finally { auditService.record = originalRecord }
      await passwordIs(item, oldPassword)
      await clientAuthService.resolveClientByToken(item.webToken)
      await mobileSessionService.resolveAccess(item.credentials.accessToken)
      assert.equal(await db.getRepository(ClientMobileSession).countBy({ clientUserId: item.user.id }), 1, '回滚必须移除已重签会话')
      assert.equal(await successCount(item), 0)
      const refreshed = await mobileSessionService.refresh(item.credentials.refreshToken, item.device, item.meta)
      await mobileSessionService.resolveAccess(refreshed.accessToken)
    })

    await scenario(`${channel}-wrong-password-keeps-risk-outside-rollback`, async () => {
      const item = await fixture(), originalRecord = auditService.record
      let failureOutsideTransaction = false
      auditService.record = async function (...args: Parameters<typeof originalRecord>) {
        if (args[0].actionType === 'client.auth.reauth_failed' && args[0].targetId === item.user.id) {
          failureOutsideTransaction = !getCurrentTransactionManager(db)
        }
        return originalRecord.apply(this, args)
      }
      try { await assert.rejects(change(item, mobile, wrongPassword), (error: unknown) => error instanceof BizError && error.message === '原密码错误') }
      finally { auditService.record = originalRecord }
      assert.equal(failureOutsideTransaction, true)
      await passwordIs(item, oldPassword)
      await clientAuthService.resolveClientByToken(item.webToken)
      await mobileSessionService.resolveAccess(item.credentials.accessToken)
      const bucketDigest = createHash('sha256').update(`login_failure:client-login:account:uid:${item.user.id}`).digest('hex')
      const state = await db.getRepository(AuthRiskState).findOneByOrFail({ bucketDigest, stateType: 'login_failure' })
      assert.equal(state.failureCount, 1, '风控失败次数不得随改密事务回滚')
      assert.equal(await db.getRepository(SysAuditLog).countBy({ actionType: 'client.auth.reauth_failed', targetId: item.user.id }), 1)
      assert.equal(await successCount(item), 0)
    })
  }

  await scenario('Mobile-real-refresh-invalidates-in-flight-old-access', async () => {
    const item = await fixture(), label = 'Mobile-stale-access-change'
    const pause = pauseAccount(label, 'attempt')
    const changing = launch(label, () => change(item, true))
    await deadline(pause.entered.promise, '旧Access改密没有到达账号锁边界')
    const refreshed = await launch('Mobile-refresh-first', () => mobileSessionService.refresh(item.credentials.refreshToken, item.device, item.meta))
    assert.equal(refreshed.status, 'fulfilled')
    if (refreshed.status === 'fulfilled') {
      assert.equal(refreshed.value.generation, item.credentials.generation + 1)
      await mobileSessionService.resolveAccess(refreshed.value.accessToken)
    }
    pause.released.resolve()
    rejectedUnauthorized(await changing)
    assertPasswordLockOrder(label, true)
    await assert.rejects(mobileSessionService.resolveAccess(item.credentials.accessToken), isUnauthorized)
    await passwordIs(item, oldPassword)
    assert.equal(await successCount(item), 0)
    assert.equal(await db.getRepository(ClientMobileSession).countBy({ clientUserId: item.user.id }), 1)
  })
} finally {
  for (const pause of pauses) pause.released.resolve()
  await deadline(Promise.allSettled(inFlight), '最终事务未排空')
  db.createQueryRunner = originalCreateRunner
  await monitor.end()
  if (db.isInitialized) await db.destroy()
}
