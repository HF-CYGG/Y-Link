/**
 * 文件说明：管理端与客户端 Web 会话活跃节流及过期回收专项验收。
 * 实现逻辑：真实执行鉴权、更新和回收，以受控时间验证心跳、写入边界、并发、维护和撤权。
 * 维护说明：默认使用系统临时 SQLite；MySQL 模式仅接受专用参数、本机高位端口和显式测试实例确认，
 * 创建随机临时库并在 finally 删除。不会连接通用 DB_* 指向的业务库，不启动 HTTP 端口。
 * 执行：在 backend 目录运行 node --import tsx scripts/auth-activity-throttle-verify.ts。
 * MySQL：另设 AUTH_ACTIVITY_VERIFY_DB=mysql、AUTH_ACTIVITY_MYSQL_CONFIRM_TEST_SERVER=true，
 * 以及 AUTH_ACTIVITY_MYSQL_HOST/PORT/USER/PASSWORD；要求真实 MySQL 8.4。
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mock } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Request, Response } from 'express'
import type { Connection } from 'mysql2/promise'
import type { AuthenticatedRequest } from '../src/types/auth.js'

const mode = process.env.AUTH_ACTIVITY_VERIFY_DB ?? 'sqlite'
assert.ok(mode === 'sqlite' || mode === 'mysql', '验证模式必须为 sqlite 或 mysql')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'y-link-auth-activity-'))
const databaseName = `y_link_auth_activity_${randomUUID().replaceAll('-', '')}`
const emptyEnvPath = path.join(tempRoot, 'verify.env')
fs.writeFileSync(emptyEnvPath, '')
Object.assign(process.env, {
  NODE_ENV: 'test', APP_PROFILE: databaseName, ENV_FILE: emptyEnvPath,
  Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true', Y_LINK_DATA_DIR: tempRoot,
  DB_TYPE: mode, DB_SYNC: 'false', SQLITE_DB_PATH: path.join(tempRoot, 'activity.sqlite'),
  REDIS_URL: '', Y_LINK_MULTI_INSTANCE: 'false', AUTH_SESSION_IDLE_TIMEOUT_MINUTES: '720',
})

let mysqlAdmin: Connection | undefined
let databaseCreated = false
let destroyDataSource: (() => Promise<void>) | undefined
let leaveMaintenance: (() => Promise<void>) | undefined
let stopCleanup: (() => Promise<void>) | undefined

try {
  if (mode === 'mysql') {
    assert.equal(process.env.AUTH_ACTIVITY_MYSQL_CONFIRM_TEST_SERVER, 'true', '必须显式确认隔离测试实例')
    const host = process.env.AUTH_ACTIVITY_MYSQL_HOST
    const port = Number(process.env.AUTH_ACTIVITY_MYSQL_PORT)
    const user = process.env.AUTH_ACTIVITY_MYSQL_USER
    const password = process.env.AUTH_ACTIVITY_MYSQL_PASSWORD ?? ''
    assert.equal(host, '127.0.0.1', '仅允许本机隔离 MySQL')
    assert.ok(Number.isInteger(port) && port >= 10_000 && port <= 65_535, '必须使用隔离高位端口')
    assert.ok(user, '必须提供专用测试数据库用户')
    const { createConnection } = await import('mysql2/promise')
    mysqlAdmin = await createConnection({ host, port, user, password, multipleStatements: false })
    const [rows] = await mysqlAdmin.query('SELECT VERSION() AS version')
    assert.match((rows as Array<{ version: string }>)[0].version, /^8\.4(?:\.|-)/, '要求真实 MySQL 8.4')
    await mysqlAdmin.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    databaseCreated = true
    Object.assign(process.env, {
      DB_HOST: host, DB_PORT: String(port), DB_USER: user, DB_PASSWORD: password, DB_NAME: databaseName,
      DB_SSL_MODE: 'disabled',
    })
  }

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { SysUserSession } = await import('../src/entities/sys-user-session.entity.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { ClientUserSession } = await import('../src/entities/client-user-session.entity.js')
  const activitySql: string[] = []
  const clientActivitySql: string[] = []
  const clientIdentifierSql: string[] = []
  AppDataSource.setOptions({
    entities: [SysUser, SysUserSession, ClientUser, ClientUserSession], logging: ['query'],
    logger: {
      logQuery(query) {
        const normalized = query.replaceAll(String.fromCharCode(96), '').replaceAll('"', '')
        if (/^UPDATE sys_user_session SET /i.test(normalized) && normalized.includes('last_access_at')) {
          activitySql.push(normalized)
        }
        if (/^UPDATE client_user_session SET /i.test(normalized) && normalized.includes('last_access_at')) {
          clientActivitySql.push(normalized)
        }
        if (/FROM client_user user WHERE /i.test(normalized)) clientIdentifierSql.push(normalized)
      },
      logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {},
    },
  })
  await AppDataSource.initialize()
  destroyDataSource = async () => { await AppDataSource.destroy() }
  // 专用临时 schema 允许历史空值夹具；生产实体及 schema 不作任何更改。
  AppDataSource.getMetadata(SysUserSession).findColumnWithPropertyName('lastAccessAt')!.isNullable = true
  AppDataSource.getMetadata(ClientUserSession).findColumnWithPropertyName('lastAccessAt')!.isNullable = true
  await AppDataSource.synchronize()
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  await initializeDatabaseInfrastructure(AppDataSource)
  const { authService } = await import('../src/services/auth.service.js')
  const { clientAuthService } = await import('../src/services/client-auth.service.js')
  const { startWebSessionCleanup, stopWebSessionCleanup } = await import('../src/services/web-session-cleanup.service.js')
  stopCleanup = stopWebSessionCleanup
  const { requireAuth } = await import('../src/middleware/auth.middleware.js')
  const { hashSessionToken } = await import('../src/utils/session-token.js')
  const { databaseMaintenanceModeService } = await import('../src/services/database-maintenance-mode.service.js')
  const { customerServiceRealtimeService } = await import('../src/services/customer-service-realtime.service.js')
  leaveMaintenance = () => databaseMaintenanceModeService.finishReadOnly('auth-activity-verify')
  const users = AppDataSource.getRepository(SysUser)
  const sessions = AppDataSource.getRepository(SysUserSession)
  const now = Date.UTC(2026, 9, 30, 12)
  mock.timers.enable({ apis: ['Date', 'setInterval'], now })
  let sequence = 0
  const createSession = async (lastAccessAt: Date | null = new Date(now)) => {
    sequence += 1
    const user = await users.save({
      username: `activity-${sequence}`, displayName: '活跃节流验收',
      passwordHash: 'test-only-unused-hash', role: 'admin', status: 'enabled',
    })
    const token = randomBytes(32).toString('hex')
    const session = sessions.create({
      userId: user.id, sessionToken: hashSessionToken(token),
      expiresAt: new Date(now + 24 * 60 * 60 * 1000),
      // 历史 nullable 数据的真实 SQL 回归，仅测试 schema 放宽。
      lastAccessAt: lastAccessAt as Date,
    })
    await sessions.save(session)
    return { user, token, session }
  }
  const authenticate = async (token: string) => {
    const req = { headers: { authorization: `Bearer ${token}` } } as Request
    let called = false
    let failure: unknown
    await requireAuth(req, {} as Response, (error?: unknown) => { called = true; failure = error })
    assert.equal(called, true, '必须继续中间件或返回错误')
    if (failure) throw failure
    return (req as AuthenticatedRequest).auth
  }
  const readActivity = async (id: string) => (await sessions.findOneByOrFail({ id })).lastAccessAt?.getTime()

  const fresh = await createSession()
  activitySql.length = 0
  for (let index = 0; index < 10; index += 1) await authenticate(fresh.token)
  assert.equal(activitySql.length, 0, '窗口内重复鉴权不能向驱动发送 UPDATE')
  mock.timers.setTime(now + 60_000)
  await authenticate(fresh.token)
  assert.equal(activitySql.length, 0, '恰好 60 秒仍沿用严格小于的 SQL 边界')
  mock.timers.setTime(now + 61_000)
  const auth = await authenticate(fresh.token)
  assert.equal(activitySql.length, 1, '超过窗口执行一次实际 UPDATE')
  assert.equal(await readActivity(fresh.session.id), now + 61_000)
  assert.deepEqual(Object.keys(auth).sort(), [
    'authSource', 'displayName', 'permissions', 'role', 'sessionToken', 'status', 'userId', 'username',
  ].sort(), '内部活跃时间不得新增到可序列化上下文')
  assert.equal(authService.isSessionActivityUpdateDue({ ...auth }), true, '外部 actor fixture 无快照时不误跳过 touch')

  // 不改心跳路由：直接调用其原有 touch(token, 1000) 路径，验证真实 SQL 边界。
  mock.timers.setTime(now + 62_000)
  await authService.touchSessionActivity(fresh.token, 1_000)
  assert.equal(await readActivity(fresh.session.id), now + 61_000, '心跳恰好 1 秒不更新')
  mock.timers.setTime(now + 63_000)
  await authenticate(fresh.token)
  await authService.touchSessionActivity(fresh.token, 1_000)
  assert.equal(await readActivity(fresh.session.id), now + 63_000, '心跳超过 1 秒照常更新')
  mock.timers.setTime(now + 64_000)
  const legacy = await createSession(null)
  activitySql.length = 0
  await authenticate(legacy.token)
  assert.equal(activitySql.length, 1, '历史空活跃时间不能跳过更新')
  assert.equal(await readActivity(legacy.session.id), now + 64_000)

  const concurrent = await createSession(new Date(now))
  const contexts = await Promise.all([
    authService.resolveAuthUserByToken(concurrent.token), authService.resolveAuthUserByToken(concurrent.token),
  ])
  assert.ok(contexts.every((context) => authService.isSessionActivityUpdateDue(context)))
  await authService.touchSessionActivity(concurrent.token)
  mock.timers.setTime(now + 65_000)
  await authService.touchSessionActivity(concurrent.token)
  assert.equal(await readActivity(concurrent.session.id), now + 64_000, '第二个旧快照的 SQL 必须被数据库条件拦住')

  const frozen = await createSession(new Date(now))
  await databaseMaintenanceModeService.beginReadOnly({ taskId: 'auth-activity-verify', phase: 'snapshot' })
  try {
    activitySql.length = 0
    await authenticate(frozen.token)
    assert.equal(activitySql.length, 0, '维护期不能尝试发送活动 UPDATE')
  } finally {
    await leaveMaintenance()
  }
  await authenticate(frozen.token)
  assert.equal(await readActivity(frozen.session.id), now + 65_000, '解除维护后恢复活跃更新')

  const failedTouch = await createSession(new Date(now))
  const originalTouch = authService.touchSessionActivity
  authService.touchSessionActivity = async () => { throw new Error('测试注入的活动写入失败') }
  try {
    await authenticate(failedTouch.token)
    await databaseMaintenanceModeService.beginReadOnly({ taskId: 'auth-activity-verify', phase: 'drain' })
    await leaveMaintenance()
  } finally {
    authService.touchSessionActivity = originalTouch
  }

  const ticket = customerServiceRealtimeService.captureOwnerGeneration('service', fresh.user.id, fresh.token)
  await customerServiceRealtimeService.assertOwnerCanRegister(ticket, fresh.token)
  await users.update(fresh.user.id, { role: 'supplier' })
  const changed = await authenticate(fresh.token)
  assert.equal(changed.role, 'supplier', '即使不 touch 也必须读取最新角色')
  assert.ok(!changed.permissions.includes('customer_service:view'))
  await assert.rejects(customerServiceRealtimeService.assertOwnerCanRegister(ticket, fresh.token), /失效/)
  await users.update(fresh.user.id, { status: 'disabled' })
  await assert.rejects(authenticate(fresh.token), /停用/)
  const revoked = await createSession()
  await sessions.delete(revoked.session.id)
  await assert.rejects(authenticate(revoked.token), /失效/)
  const expired = await createSession()
  await sessions.update(expired.session.id, { expiresAt: new Date(now + 65_000) })
  await assert.rejects(authenticate(expired.token), /失效/)
  const idle = await createSession(new Date(now - 721 * 60_000))
  const idleTicket = customerServiceRealtimeService.captureOwnerGeneration('service', idle.user.id, idle.token)
  await assert.rejects(customerServiceRealtimeService.assertOwnerCanRegister(idleTicket, idle.token), /失效/)
  await assert.rejects(authenticate(idle.token), /长时间未操作/)
  assert.equal(await sessions.existsBy({ id: idle.session.id }), false, '空闲过期会话不能被 touch 复活')

  const clientUsers = AppDataSource.getRepository(ClientUser)
  const clientSessions = AppDataSource.getRepository(ClientUserSession)
  await clientUsers.save({ realName: 'StaffAlias', passwordHash: 'fixture-only' })
  const client = await clientUsers.save({ realName: 'FiXtUrE', staffNo: 'StaffAlias', passwordHash: 'fixture-only' })
  assert.equal(await clientAuthService.resolveLoginRiskSubject('StaffAlias'), `uid:${client.id}`, '工号必须优先于历史同名')
  clientIdentifierSql.length = 0
  assert.equal(await clientAuthService.resolveLoginRiskSubject('fixture'), `uid:${client.id}`)
  assert.ok(clientIdentifierSql.some((sql) => mode === 'mysql'
    ? /WHERE user\.real_name = /i.test(sql)
    : /WHERE LOWER\(user\.real_name\) = /i.test(sql)), '使用当前数据库对应的姓名索引查询')
  const createClientSession = async (lastAccessAt: Date | null) => {
    const token = randomBytes(32).toString('hex')
    const session = await clientSessions.save({
      sessionToken: hashSessionToken(token), userId: client.id,
      expiresAt: new Date(now + 24 * 60 * 60_000), lastAccessAt: lastAccessAt as Date,
    })
    return { token, session }
  }
  const recentClient = await createClientSession(null)
  clientActivitySql.length = 0
  await Promise.all(Array.from({ length: 8 }, () => clientAuthService.resolveClientByToken(recentClient.token)))
  assert.equal(clientActivitySql.length, 1, '同一客户端会话并发只发送一个活动写入')
  assert.match(clientActivitySql[0]!, /last_access_at IS NULL OR last_access_at < /i, 'SQL 重验旧快照')
  assert.equal((await clientSessions.findOneByOrFail({ id: recentClient.session.id })).lastAccessAt.getTime(), now + 65_000)
  await clientSessions.update(recentClient.session.id, { lastAccessAt: new Date(now) })
  clientActivitySql.length = 0
  await clientAuthService.resolveClientByToken(recentClient.token)
  assert.equal(clientActivitySql.length, 0, '即使读取到旧活动时间，同一会话的成功写入仍有进程内窗口')

  const failedClient = await createClientSession(null)
  await AppDataSource.query(mode === 'mysql'
    ? "CREATE TRIGGER reject_client_activity BEFORE UPDATE ON client_user_session FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture rejection'"
    : "CREATE TRIGGER reject_client_activity BEFORE UPDATE ON client_user_session BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END")
  try {
    await assert.rejects(clientAuthService.resolveClientByToken(failedClient.token), /fixture rejection/)
  } finally {
    await AppDataSource.query('DROP TRIGGER reject_client_activity')
  }
  await clientAuthService.resolveClientByToken(failedClient.token)
  assert.equal((await clientSessions.findOneByOrFail({ id: failedClient.session.id })).lastAccessAt.getTime(), now + 65_000, '失败后下一次请求可重试')
  await clientSessions.delete(recentClient.session.id)
  await assert.rejects(clientAuthService.resolveClientByToken(recentClient.token), /失效/, '节流不能缓存鉴权结果')

  const expiredClient = await createClientSession(new Date(now))
  await clientSessions.update(expiredClient.session.id, { expiresAt: new Date(now) })
  const expiredAdmin = await createSession()
  await sessions.update(expiredAdmin.session.id, { expiresAt: new Date(now) })
  const equalCutoffAdmin = await createSession()
  const highSessionCases = [
    { repository: sessions, userId: expiredAdmin.session.userId },
    { repository: clientSessions, userId: expiredClient.session.userId },
  ].map((item) => ({
    ...item, expiredHash: hashSessionToken(randomUUID()), activeHash: hashSessionToken(randomUUID()),
  }))
  for (const { repository, userId, expiredHash, activeHash } of highSessionCases) {
    // 两个相邻主键在 JavaScript Number 中会折叠为同一值。
    await repository.createQueryBuilder().insert().values([
      { id: () => '9007199254740992', userId, sessionToken: activeHash,
        expiresAt: new Date(now + 24 * 60 * 60_000), lastAccessAt: new Date(now) },
      { id: () => '9007199254740993', userId, sessionToken: expiredHash,
        expiresAt: new Date(now), lastAccessAt: new Date(now) },
    ]).updateEntity(false).execute()
  }
  await databaseMaintenanceModeService.beginReadOnly({ taskId: 'auth-activity-verify', phase: 'snapshot' })
  try {
    startWebSessionCleanup()
    mock.timers.tick(10 * 60_000)
    assert.equal(await sessions.existsBy({ id: expiredAdmin.session.id }), true, '维护冻结期间不得回收')
  } finally {
    await leaveMaintenance()
  }
  await sessions.update(equalCutoffAdmin.session.id, { expiresAt: new Date(Date.now() + 10 * 60_000) })
  mock.timers.tick(10 * 60_000)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!await clientSessions.existsBy({ id: expiredClient.session.id })
      && !await sessions.existsBy({ id: expiredAdmin.session.id })) break
    await delay(20)
  }
  await stopWebSessionCleanup()
  assert.equal(await sessions.existsBy({ id: expiredAdmin.session.id }), false, '回收超过有效期的管理端会话')
  assert.equal(await clientSessions.existsBy({ id: expiredClient.session.id }), false, '回收超过有效期的客户端会话')
  assert.equal(await sessions.existsBy({ id: equalCutoffAdmin.session.id }), true, '回收保留等于当前批次截止时间的会话')
  assert.equal(await clientSessions.existsBy({ id: failedClient.session.id }), true, '回收保留活跃会话')
  for (const { repository, expiredHash, activeHash } of highSessionCases) {
    assert.equal(await repository.existsBy({ sessionToken: expiredHash }), false, '必须清理超过安全整数范围的过期主键')
    assert.equal(await repository.existsBy({ sessionToken: activeHash }), true, '必须保留相邻高位主键的有效会话')
  }
  console.log(`[auth-activity] ${mode}：真实 SQL 节流、旧快照、回收和账号解析验收通过`)
} finally {
  try {
    await stopCleanup?.()
    await leaveMaintenance?.()
  } finally {
    mock.timers.reset()
    try {
      await destroyDataSource?.()
    } finally {
      try {
        if (databaseCreated) await mysqlAdmin!.query(`DROP DATABASE ${databaseName}`)
      } finally {
        await mysqlAdmin?.end()
        fs.rmSync(tempRoot, { recursive: true, force: true })
      }
    }
  }
}
