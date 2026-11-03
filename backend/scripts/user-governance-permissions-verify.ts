/**
 * 模块说明：管理端治理权限隔离专项；由统一 QA 运行，支持 SQLite 与显式隔离 MySQL 8.4。
 * 文件职责：验证真实服务/HTTP 的角色上界、默认/空集合、旧会话、审计及三组并发恢复保底。
 * 维护说明：MySQL 仅接受明确确认的 loopback 高位测试实例，创建随机新库并只清理本次资源。
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { QueryRunner } from 'typeorm'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { createConnection } from 'mysql2/promise'
import type { AuthUserContext, UserRole, UserSafeProfile } from '../src/types/auth.js'
import type { PermissionCode } from '../src/constants/auth-permissions.js'
import { requestLocalHttp } from './support/local-http-request.js'

const databaseType = process.env.Y_LINK_PERMISSION_VERIFY_DB_TYPE === 'mysql' ? 'mysql' : 'sqlite'
const seed = randomUUID().replaceAll('-', '')
const databaseName = `y_link_user_governance_${seed}`
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-user-governance-'))
const sqlitePath = path.join(tempRoot, 'permissions.sqlite')
const mysqlConfig = databaseType === 'mysql' ? {
  host: process.env.Y_LINK_PERMISSION_MYSQL_HOST?.trim(),
  port: Number(process.env.Y_LINK_PERMISSION_MYSQL_PORT),
  user: process.env.Y_LINK_PERMISSION_MYSQL_USER?.trim(),
  password: process.env.Y_LINK_PERMISSION_MYSQL_PASSWORD ?? '',
} : null
if (mysqlConfig) {
  assert.equal(process.env.Y_LINK_PERMISSION_MYSQL_CONFIRM_TEST_SERVER, 'true', '必须明确确认隔离测试实例')
  assert.equal(mysqlConfig.host, '127.0.0.1', '禁止连接非 loopback MySQL')
  assert.ok(Number.isInteger(mysqlConfig.port) && mysqlConfig.port >= 10000 && mysqlConfig.port <= 65535, '必须使用隔离高位端口')
  assert.ok(mysqlConfig.user, '必须显式提供测试 MySQL 用户')
}
delete process.env.ENV_FILE
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.APP_PROFILE = `user-governance-${seed}`
process.env.DB_TYPE = databaseType
process.env.DB_SYNC = 'false'
process.env.DB_AUTO_MIGRATE = 'false'
// 不接入用户 Redis/外发基础设施，测试会话及风险状态只落本次隔离库。
process.env.REDIS_URL = ''
if (mysqlConfig) {
  process.env.DB_HOST = mysqlConfig.host!
  process.env.DB_PORT = String(mysqlConfig.port)
  process.env.DB_USER = mysqlConfig.user!
  process.env.DB_PASSWORD = mysqlConfig.password
  process.env.DB_NAME = databaseName
  delete process.env.SQLITE_DB_PATH
} else {
  process.env.SQLITE_DB_PATH = sqlitePath
  delete process.env.DB_NAME
}

let mysqlCreated = false
let server: Server | undefined
let source: import('typeorm').DataSource | undefined
try {
  if (mysqlConfig) {
    const connection = await createConnection(mysqlConfig)
    try {
      const [versionRows] = await connection.query('SELECT VERSION() AS version')
      const version = (versionRows as Array<{ version: string }>)[0]?.version
      console.log(`真实 MySQL 版本：${version}`)
      // 不使用 IF NOT EXISTS，随机库碰撞时立即停止，不能清理调用者已有库。
      await connection.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
      mysqlCreated = true
    } finally { await connection.end() }
  }
  const [data, entities, sessions, auth, users, permissions, token, bootstrap, audit, clientUsers] = await Promise.all([
    import('../src/config/data-source.js'), import('../src/entities/sys-user.entity.js'),
    import('../src/entities/sys-user-session.entity.js'), import('../src/services/auth.service.js'),
    import('../src/services/user.service.js'), import('../src/constants/auth-permissions.js'),
    import('../src/utils/session-token.js'), import('../src/config/database-bootstrap.js'),
    import('../src/entities/sys-audit-log.entity.js'), import('../src/services/client-user-manage.service.js'),
  ])
  source = data.AppDataSource
  assert.equal(source.options.type, databaseType)
  if (mysqlConfig) assert.equal((source.options as { database?: string }).database, databaseName)
  else assert.equal((source.options as { database?: string }).database, sqlitePath)
  await source.initialize()
  await source.synchronize()
  const repo = source.getRepository(entities.SysUser)
  const sessionRepo = source.getRepository(sessions.SysUserSession)
  const makeUser = async (username: string, role: UserRole) => repo.save(repo.create({
    username, displayName: username, role, status: 'enabled', passwordHash: 'isolated-session-fixture', governancePermissionsJson: null,
  }))
  const first = await makeUser('governance_a', 'admin')
  const second = await makeUser('governance_b', 'admin')
  const target = await makeUser('governance_target', 'operator')
  const supplier = await makeUser('governance_supplier', 'supplier')
  if (databaseType === 'sqlite') {
    // 仅本次新库模拟旧结构，启动补列不得改动已存在的用户数据。
    await source.query('ALTER TABLE sys_user DROP COLUMN governance_permissions_json')
    await bootstrap.initializeDatabaseSchemaIfNeeded(source)
    assert.equal(await repo.count(), 4)
    assert.equal((await repo.findOneByOrFail({ id: first.id })).governancePermissionsJson, null)
  }
  if (mysqlConfig) {
    // 真实执行新增列脚本两次，验证幂等、NULL 历史兼容及 MySQL 8.4 列结构。
    // PREPARE 与 SET 必须使用同一连接，不能散落到池内不同连接。
    const { splitSqlStatements } = await import('../src/config/mysql-migration-runner.js')
    const migration = fs.readFileSync(new URL('../sql/063_sys_user_governance_permissions.sql', import.meta.url), 'utf8')
    const runner = source.createQueryRunner()
    await runner.connect()
    try {
      await runner.query('ALTER TABLE sys_user DROP COLUMN governance_permissions_json')
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const statement of splitSqlStatements(migration)) await runner.query(statement)
      }
      const columns = await runner.query("SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_user' AND COLUMN_NAME = 'governance_permissions_json'") as Array<{ DATA_TYPE: string; IS_NULLABLE: string }>
      assert.deepEqual(columns.map((column) => [column.DATA_TYPE, column.IS_NULLABLE]), [['text', 'YES']])
    } finally { await runner.release() }
    assert.equal(await repo.count(), 4)
    assert.equal((await repo.findOneByOrFail({ id: first.id })).governancePermissionsJson, null)
  }
  const actorFor = async (userId: string) => {
    const bearer = randomUUID() + randomUUID()
    await sessionRepo.save(sessionRepo.create({ userId, sessionToken: token.hashSessionToken(bearer),
      expiresAt: new Date(Date.now() + 3600000), lastAccessAt: new Date() }))
    return auth.authService.resolveAuthUserByToken(bearer)
  }
  const expectStatus = async (work: () => Promise<unknown>, status: number) => {
    await assert.rejects(work, (error: unknown) => typeof error === 'object' && error !== null
      && 'statusCode' in error && error.statusCode === status)
  }
  const actor = await actorFor(first.id)
  const defaults = permissions.resolvePermissionsByRole('operator')
  let result = await users.userService.update(target.id, { displayName: '默认兼容' }, actor)
  assert.deepEqual(result.permissions, defaults)
  assert.equal(result.governancePermissions, null)
  const oldTargetActor = await actorFor(target.id)
  result = await users.userService.update(target.id, { governancePermissions: [] }, actor)
  assert.deepEqual(result.governancePermissions, [])
  assert.ok(result.permissions.includes('orders:create'), '取消治理权限不得丢失普通业务权限')
  assert.ok(!result.permissions.includes('reports:view'))
  await expectStatus(() => auth.authService.resolveAuthUserByToken(oldTargetActor.sessionToken), 401)
  // 空集合及 default 在角色升降后保持各自语义；未传字段不覆盖现有配置。
  result = await users.userService.update(target.id, { role: 'admin' }, actor)
  assert.deepEqual(result.governancePermissions, [])
  assert.ok(!result.permissions.includes('users:update'))
  await users.userService.update(target.id, { governancePermissions: null }, actor)
  result = await users.userService.update(target.id, { role: 'operator' }, actor)
  assert.equal(result.governancePermissions, null)
  assert.deepEqual(result.permissions, defaults)
  await users.userService.update(target.id, { role: 'admin', governancePermissions: ['users:update', 'reports:view'] }, actor)
  result = await users.userService.update(target.id, { role: 'operator' }, actor)
  assert.deepEqual(result.governancePermissions, ['reports:view'])
  result = await users.userService.update(target.id, { role: 'supplier' }, actor)
  assert.deepEqual(result.governancePermissions, [])
  assert.deepEqual(result.permissions, permissions.resolvePermissionsByRole('supplier'))
  await users.userService.update(target.id, { role: 'operator', governancePermissions: null }, actor)
  await expectStatus(() => users.userService.update(target.id, { governancePermissions: ['users:update'] }, actor), 400)
  await expectStatus(() => users.userService.update(target.id, { governancePermissions: ['orders:create'] }, actor), 400)
  await expectStatus(() => users.userService.update(target.id, { governancePermissions: ['unknown:grant' as PermissionCode] }, actor), 400)
  await expectStatus(() => users.userService.update(first.id, { governancePermissions: [] }, actor), 400)
  await expectStatus(() => users.userService.update(first.id, { role: 'operator' }, actor), 400)
  await expectStatus(() => users.userService.updateStatus(first.id, 'disabled', actor), 400)
  const operator = await actorFor(target.id)
  await expectStatus(() => users.userService.update(second.id, { governancePermissions: null }, { ...operator, role: 'admin', permissions: actor.permissions }), 403)
  // malformed 持久化收窄：不恢复治理默认，也不影响非治理日常业务权限。
  for (const invalid of ['{', '{}', 'null', '["unknown:grant"]', '["orders:create"]']) {
    await repo.update(target.id, { governancePermissionsJson: invalid })
    const actual = await actorFor(target.id)
    assert.ok(!actual.permissions.some((permission) => permissions.GOVERNANCE_PERMISSION_CODES.includes(permission)))
    assert.ok(actual.permissions.includes('orders:create'))
  }
  await repo.update(target.id, { governancePermissionsJson: null })
  const { createApp } = await import('../src/app.js')
  server = createApp().listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const call = async (context: AuthUserContext, body: Record<string, unknown>, id = target.id) => requestLocalHttp(
    `http://127.0.0.1:${address.port}/api/users/${id}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${context.sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
  // 创建使用真实 HTTP 与本轮隔离库，不以创建后 PATCH 模拟原子授权。
  const create = async (context: AuthUserContext, body: Record<string, unknown>) => requestLocalHttp(
    `http://127.0.0.1:${address.port}/api/users`, {
      method: 'POST', headers: { Authorization: `Bearer ${context.sessionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
  const auditRepo = source.getRepository(audit.SysAuditLog)
  let createIndex = 0
  const createInput = (role: UserRole = 'operator') => ({
    username: `create_fixture_${++createIndex}`, displayName: '隔离创建权限', role,
    password: 'IsolatedCreate!77Zz',
  })
  const successfulCreates = async () => auditRepo.count({ where: { actionType: 'user.create', resultStatus: 'success' } })
  const assertCreate = async (role: UserRole, selection: PermissionCode[] | null | undefined, extra: Record<string, unknown> = {}) => {
    const input = createInput(role)
    const response = await create(actor, { ...input, ...extra, ...(selection === undefined ? {} : { governancePermissions: selection }) })
    assert.equal(response.status, 200)
    const profile = (await response.json() as { data: UserSafeProfile }).data
    const persisted = await repo.findOneByOrFail({ id: profile.id })
    const canonical = selection == null ? null : permissions.GOVERNANCE_PERMISSION_CODES.filter((code) => selection.includes(code))
    assert.equal(persisted.governancePermissionsJson, canonical === null ? null : JSON.stringify(canonical))
    assert.deepEqual(profile.governancePermissions, canonical)
    assert.equal(profile.role, role)
    assert.equal(profile.status, 'enabled', '省略状态仍沿用创建默认值')
    const expected = permissions.resolvePermissionsByRole(role).filter((code) => canonical === null
      || !permissions.GOVERNANCE_PERMISSION_CODES.includes(code) || canonical.includes(code))
    assert.deepEqual(profile.permissions, expected)
    const context = await actorFor(profile.id)
    assert.deepEqual(context.permissions, expected, '新会话必须立即采用创建时的真实授权')
    const me = await requestLocalHttp(`http://127.0.0.1:${address.port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${context.sessionToken}` },
    })
    assert.equal(me.status, 200)
    const effective = (await me.json() as { data: UserSafeProfile }).data
    assert.deepEqual(effective.permissions, expected)
    assert.deepEqual(effective.governancePermissions, canonical)
    const logs = await auditRepo.find({ where: { actionType: 'user.create', targetId: profile.id, resultStatus: 'success' } })
    assert.equal(logs.length, 1, '一个创建只写一条成功审计')
    assert.equal(logs[0]!.actorUserId, actor.userId)
    assert.equal(logs[0]!.targetCode, input.username)
    assert.deepEqual(JSON.parse(logs[0]!.detailJson!), {
      role, status: 'enabled', displayName: input.displayName, governancePermissions: canonical,
    })
    assert.ok(!JSON.stringify(profile).includes('passwordHash'))
    assert.ok(!logs[0]!.detailJson!.includes(input.password))
    // 仅隔离 fixture 停用，避免新增 admin 改变后续最后可治理管理员场景。
    await repo.update(profile.id, { status: 'disabled' })
  }
  for (const role of ['admin', 'operator', 'supplier'] as const) {
    await assertCreate(role, undefined)
    await assertCreate(role, null)
    await assertCreate(role, [])
  }
  await assertCreate('admin', ['users:view', 'reports:view'])
  await assertCreate('operator', ['reports:view'])
  // 兼容旧接口忽略无关顶层字段；这些字段不能覆盖真正的授权入参。
  await assertCreate('operator', undefined, { unknownField: true, permissions: actor.permissions, governancePermissionsJson: '[]' })
  const assertCreateRejected = async (context: AuthUserContext, body: Record<string, unknown>, status: number) => {
    const before = { users: await repo.count(), audit: await successfulCreates() }
    assert.equal((await create(context, body)).status, status)
    assert.equal(await repo.count(), before.users, '失败创建不能留下半账号')
    assert.equal(await successfulCreates(), before.audit, '失败创建不能记录成功审计')
  }
  for (const body of [
    { ...createInput('operator'), governancePermissions: ['users:update'] },
    { ...createInput('supplier'), governancePermissions: ['reports:view'] },
    { ...createInput(), governancePermissions: ['unknown:grant'] },
    { ...createInput(), governancePermissions: ['orders:create'] },
    { ...createInput(), governancePermissions: '[]' },
  ]) await assertCreateRejected(actor, body, 400)
  const missingRole: Record<string, unknown> = createInput()
  delete missingRole.role
  await assertCreateRejected(actor, missingRole, 400)
  for (const nonAdmin of [await actorFor(target.id), await actorFor(supplier.id)]) {
    await assertCreateRejected(nonAdmin, { ...createInput(), governancePermissions: null }, 403)
    const before = await repo.count()
    await expectStatus(() => users.userService.create(createInput(), { ...nonAdmin, role: 'admin', permissions: actor.permissions }), 403)
    assert.equal(await repo.count(), before, '伪造调用方权限不能绕过锁后 actor 复核')
  }
  // 绕过 HTTP 的内部调用同样必须校验角色上界及未知权限。
  for (const code of ['users:update', 'unknown:grant', 'orders:create'] as PermissionCode[]) {
    const before = await repo.count()
    await expectStatus(() => users.userService.create({ ...createInput(), governancePermissions: [code] }, actor), 400)
    assert.equal(await repo.count(), before)
  }
  await assertCreateRejected(actor, { ...createInput(), username: first.username }, 409)
  // 故障注入只替换审计写入；真实事务在账号已插入、审计失败时必须回滚。
  const { auditService } = await import('../src/services/audit.service.js')
  const originalRecord = auditService.record
  const beforeAuditFailure = { users: await repo.count(), audit: await successfulCreates() }
  const rollbackInput = createInput('admin')
  let sawInsertedAccount = false
  auditService.record = async function (input, manager) {
    if (input.actionType === 'user.create') {
      assert.ok(manager, '成功审计必须使用创建事务 manager')
      sawInsertedAccount = Boolean(await manager.getRepository(entities.SysUser).findOneBy({ username: rollbackInput.username }))
      throw new Error('隔离审计故障注入')
    }
    return originalRecord.call(this, input, manager)
  }
  try {
    await assert.rejects(() => users.userService.create({ ...rollbackInput, governancePermissions: [] }, actor), /隔离审计故障注入/)
  } finally { auditService.record = originalRecord }
  assert.equal(sawInsertedAccount, true, '故障必须发生于事务内账号插入后')
  assert.equal(await repo.count(), beforeAuditFailure.users)
  assert.equal(await successfulCreates(), beforeAuditFailure.audit)
  assert.equal(await repo.findOneBy({ username: rollbackInput.username }), null)
  for (const nonAdmin of [await actorFor(target.id), await actorFor(supplier.id)]) {
    assert.equal((await call(nonAdmin, { governancePermissions: [] })).status, 403)
  }
  for (const body of [
    { governancePermissions: ['users:update'] }, { governancePermissions: ['unknown:grant'] },
    { governancePermissions: ['orders:create'] }, { permissions: actor.permissions },
  ]) assert.equal((await call(actor, body)).status, 400)
  assert.equal((await call(actor, { governancePermissions: [] })).status, 200)
  assert.equal((await call(actor, { governancePermissions: null })).status, 200)
  const stale = await actorFor(second.id)
  await users.userService.update(second.id, { governancePermissions: [] }, actor)
  assert.equal((await call(stale, { displayName: '旧会话不应写入' })).status, 401)
  // 即使伪造调用方旧权限快照，锁后也必须拒绝用户与客户端用户生命周期写。
  await expectStatus(() => users.userService.update(target.id, { displayName: '拒绝旧权限' }, stale), 403)
  const usersBeforeStaleCreate = await repo.count()
  await expectStatus(() => users.userService.create({ ...createInput(), governancePermissions: null }, stale), 403)
  assert.equal(await repo.count(), usersBeforeStaleCreate)
  await expectStatus(() => users.userService.resetPassword(target.id, { newPassword: 'IsolatedReset!77Zz' }, stale), 403)
  await expectStatus(() => clientUsers.clientUserManageService.deactivate('999999999', { reason: '隔离验证' }, stale), 403)
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const serial = { start: 1, current: 0, width: 6 }
  const identifierInput = {
    system: { department: serial, walkin: serial },
    preorder: { department: serial, walkin: serial },
    business: { department: serial, walkin: serial },
  }
  // stale 拥有旧 system_configs:update，但数据库覆盖已移除；必须在锁后、改号前拒绝。
  const beforeSequences = await source.query('SELECT COUNT(*) AS total FROM business_sequence')
  await expectStatus(() => systemConfigService.updateOrderIdentifierConfigs(identifierInput, stale), 403)
  assert.deepEqual(await source.query('SELECT COUNT(*) AS total FROM business_sequence'), beforeSequences)
  await users.userService.update(second.id, { governancePermissions: null }, actor)
  // F1：授权检查必须位于既有账号锁之后、任何业务写入之前。
  await systemConfigService.ensureDefaultConfigs()
  await systemConfigService.ensureClientDepartmentOptions(['F1隔离部门'], actor)
  await users.userService.update(second.id, { governancePermissions: ['users:view', 'users:update', 'users:create'] }, actor)
  const provisionActor = await actorFor(second.id)
  const managedClient = await clientUsers.clientUserManageService.createProfile({
    profileKind: 'personal', username: 'F1客户端', email: 'f1-isolated@example.invalid',
    password: 'FixtureClient!88Zz', departmentName: 'F1隔离部门', status: 'enabled',
  }, provisionActor)
  // 正向：合法开户/编辑不需要另授 system_configs:update，部门仅作只读校验。
  await clientUsers.clientUserManageService.updateProfile(managedClient.id, {
    username: 'F1客户端', email: 'f1-isolated@example.invalid', departmentName: 'F1隔离部门', status: 'enabled',
  }, provisionActor)
  await expectStatus(() => systemConfigService.ensureClientDepartmentOptions(['不应新增'], provisionActor), 403)
  await users.userService.update(second.id, { governancePermissions: null }, actor)
  const positiveActor = await actorFor(second.id)
  await clientUsers.clientUserManageService.resetPassword(managedClient.id, { newPassword: 'AcceptedReset!99Zz' }, positiveActor)
  await clientUsers.clientUserManageService.updateStatus(managedClient.id, 'disabled', positiveActor)
  await clientUsers.clientUserManageService.updateStatus(managedClient.id, 'enabled', positiveActor)
  const o2oInput = {
    autoCancelEnabled: true, autoCancelHours: 24, limitEnabled: true, limitQty: 5,
    clientPreorderUpdateLimit: 3, storeBusinessHoursText: '09:00-18:00', mallAnnouncementText: 'F1正向配置',
  }
  const positiveConfig = await systemConfigService.updateO2oRuleConfigs(o2oInput, positiveActor)
  assert.equal(positiveConfig.config.mallAnnouncementText, 'F1正向配置')
  const [{ ClientUserSession }, { ClientMobileSession }, { initializeDatabaseInfrastructure }] = await Promise.all([
    import('../src/entities/client-user-session.entity.js'), import('../src/entities/client-mobile-session.entity.js'),
    import('../src/database/database-strategy.js'),
  ])
  const clientWebRepo = source.getRepository(ClientUserSession)
  const clientMobileRepo = source.getRepository(ClientMobileSession)
  const expires = new Date(Date.now() + 3600000)
  await clientWebRepo.save(clientWebRepo.create({ userId: managedClient.id, sessionToken: token.hashSessionToken(randomUUID()),
    expiresAt: expires, lastAccessAt: new Date() }))
  await clientMobileRepo.save(clientMobileRepo.create({
    clientUserId: managedClient.id, deviceId: 'f1-isolated-device', platform: 'android',
    accessTokenHash: token.hashSessionToken(randomUUID()), refreshTokenHash: token.hashSessionToken(randomUUID()),
    accessExpiresAt: expires, refreshExpiresAt: expires, absoluteExpiresAt: expires, lastAccessAt: new Date(),
  }))
  const snapshotProtectedState = async () => ({
    client: await source!.query('SELECT * FROM client_user WHERE id = ?', [managedClient.id]),
    web: await source!.query('SELECT * FROM client_user_session WHERE user_id = ? ORDER BY id', [managedClient.id]),
    mobile: await source!.query('SELECT * FROM client_mobile_session WHERE client_user_id = ? ORDER BY id', [managedClient.id]),
    configs: await source!.query('SELECT * FROM system_configs ORDER BY id'),
    successfulActions: await source!.query("SELECT * FROM sys_audit_log WHERE actor_user_id = ? AND result_status = 'success' ORDER BY id", [second.id]),
  })
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
  const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 10000) })]) }
    finally { clearTimeout(timer) }
  }
  const coordinator = await initializeDatabaseInfrastructure(source)
  for (const scene of ['client-reset', 'client-status', 'o2o-config'] as const) {
    await users.userService.update(second.id, { governancePermissions: null }, actor)
    const queuedActor = await actorFor(second.id)
    const before = await snapshotProtectedState()
    const db = source
    const context = new AsyncLocalStorage<'revocation' | 'old-request'>()
    const acquired = gate(), release = gate(), attempted = gate()
    const ids = new Map<string, number>()
    const firstAccountRead = new Set<string>()
    const original = db.createQueryRunner
    db.createQueryRunner = function (this: typeof db, ...args: Parameters<typeof original>) {
      const runner = original.apply(this, args)
      const role = context.getStore(), query = runner.query.bind(runner)
      if (role) runner.query = (async (...queryArgs: Parameters<QueryRunner['query']>) => {
        const sql = String(queryArgs[0])
        if (/^\s*SELECT/i.test(sql) && /FROM\s+[`"]?sys_user[`"]?\s/i.test(sql) && !firstAccountRead.has(role)) {
          firstAccountRead.add(role)
          if (databaseType === 'mysql') {
            const rows = await query('SELECT CONNECTION_ID() AS id')
            ids.set(role, Number(rows[0].id))
            assert.match(sql, /FOR UPDATE/i, '必须观察生产服务真正的账号锁定读取')
          }
          if (role === 'old-request') attempted.resolve()
          const rows = await query(...queryArgs)
          if (role === 'revocation') { acquired.resolve(); await release.promise }
          return rows
        }
        return query(...queryArgs)
      }) as QueryRunner['query']
      return runner
    }
    let revoking: Promise<unknown> | undefined, pending: Promise<unknown> | undefined
    try {
      revoking = context.run('revocation', () => users.userService.update(second.id, { governancePermissions: [] }, actor))
      void revoking.catch(() => acquired.resolve())
      await bounded(acquired.promise, `${scene} 撤权未取得账号锁`)
      pending = context.run('old-request', () => scene === 'client-reset'
        ? clientUsers.clientUserManageService.resetPassword(managedClient.id, { newPassword: 'DeniedReset!77Zz' }, queuedActor)
        : scene === 'client-status'
          ? clientUsers.clientUserManageService.updateStatus(managedClient.id, 'disabled', queuedActor)
          : systemConfigService.updateO2oRuleConfigs({ ...o2oInput, mallAnnouncementText: '不应提交' }, queuedActor))
      // 立即挂接拒绝处理，避免在等待真实数据库阻塞证据时产生未处理 rejection。
      const pendingOutcome = pending.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }))
      void pending.catch(() => attempted.resolve())
      let observedWait = false
      if (databaseType === 'mysql') {
        await bounded(attempted.promise, `${scene} 旧请求未尝试账号锁`)
        assert.notEqual(ids.get('revocation'), ids.get('old-request'), '必须是不同 MySQL 连接')
        for (let poll = 0; poll < 100 && !observedWait; poll++) {
          const rows = await db.query(`SELECT r.PROCESSLIST_ID AS requester, b.PROCESSLIST_ID AS blocker
            FROM performance_schema.data_lock_waits w
            JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID
            JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID
            WHERE r.PROCESSLIST_ID = ? AND b.PROCESSLIST_ID = ?`, [ids.get('old-request'), ids.get('revocation')])
          observedWait = rows.length > 0
          if (!observedWait) await new Promise((done) => setTimeout(done, 20))
        }
        assert.ok(observedWait, `${scene} 必须取得真实 InnoDB 等锁证据，不能只凭延时`)
      } else {
        for (let poll = 0; poll < 100 && !observedWait; poll++) {
          observedWait = coordinator.snapshot().pendingWrites > 0
          if (!observedWait) await new Promise((done) => setTimeout(done, 20))
        }
        assert.ok(observedWait, `${scene} 必须观察到旧请求进入真实 SQLite 单写队列`)
      }
      console.log(JSON.stringify({ scene, databaseType, revokerConnection: ids.get('revocation'), oldConnection: ids.get('old-request'), observedWait }))
      release.resolve()
      await bounded(revoking, `${scene} 撤权提交超时`)
      const outcome = await bounded(pendingOutcome, `${scene} 旧请求未结束`)
      assert.equal(outcome.ok, false, `${scene} 撤权提交后旧请求不得写入`)
      if (!outcome.ok) assert.equal((outcome.error as { statusCode: number }).statusCode, 403)
      assert.deepEqual(await snapshotProtectedState(), before, `${scene} 拒绝后目标、Web/Mobile 会话、配置及成功审计均不得改变`)
    } finally {
      release.resolve()
      await Promise.allSettled([revoking, pending].filter((task): task is Promise<unknown> => Boolean(task)))
      db.createQueryRunner = original
    }
  }
  // 已传 manager 与空输入也不是绕过显式配置治理权限的凭证。
  const deniedActor = await actorFor(second.id)
  await expectStatus(() => systemConfigService.ensureClientDepartmentOptions([], deniedActor), 403)
  const { runInTransaction } = await import('../src/config/transaction-runner.js')
  await expectStatus(() => runInTransaction((manager) => systemConfigService.ensureClientDepartmentOptions(['不应新增'], deniedActor, undefined, manager)), 403)
  const restorePair = async () => {
    // 测试 fixture 重置仅发生在本次新库；业务路径始终通过服务操作。
    for (const id of [first.id, second.id]) await repo.update(id, { role: 'admin', status: 'enabled', governancePermissionsJson: null })
    return Promise.all([actorFor(first.id), actorFor(second.id)])
  }
  for (const scenario of ['permissions', 'status', 'role'] as const) {
    const [left, right] = await restorePair()
    const apply = (id: string, caller: AuthUserContext) => scenario === 'status'
      ? users.userService.updateStatus(id, 'disabled', caller)
      : users.userService.update(id, scenario === 'role' ? { role: 'operator' } : { governancePermissions: [] }, caller)
    const outcomes = await Promise.allSettled([apply(second.id, left), apply(first.id, right)])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1, `${scenario} 互相治理只能成功一方`)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult
    assert.ok([403, 409].includes((rejected.reason as { statusCode: number }).statusCode), '失败必须是锁后权限/恢复保底拒绝，不能用死锁等数据库错误冒充成功')
    assert.equal((await repo.find()).filter(permissions.isUserGovernanceAdmin).length, 1, `${scenario} 并发后必须保留一个可治理管理员`)
  }
  const [last, restricted] = await restorePair()
  await repo.update(second.id, { governancePermissionsJson: JSON.stringify(['users:update', 'users:status', 'users:deactivate']) })
  const limited = { ...restricted, permissions: actor.permissions }
  // 第二个 admin 角色存在但缺 users:view，不能计入恢复人数。
  await expectStatus(() => users.userService.update(first.id, { governancePermissions: [] }, limited), 409)
  await expectStatus(() => users.userService.update(first.id, { role: 'operator' }, limited), 409)
  await expectStatus(() => users.userService.updateStatus(first.id, 'disabled', limited), 409)
  await expectStatus(() => users.userService.deactivate(first.id, { reason: '隔离验证' }, limited), 409)
  // 本人可以调整其他选项，恢复入口仍保留；响应明确通知撤销会话。
  result = await users.userService.update(first.id, { governancePermissions: ['users:view', 'users:update'] }, last)
  assert.equal(result.sessionsRevoked, true)
  await expectStatus(() => auth.authService.resolveAuthUserByToken(last.sessionToken), 401)
  const logs = await source.getRepository(audit.SysAuditLog).find({ where: { actionType: 'user.update' } })
  assert.ok(logs.some((log) => log.detailJson?.includes('governancePermissionsAfter')))
  console.log(`通过：${databaseType} 真实创建/编辑服务与路由、默认/空集合/子集原子持久化、effective profile、拒绝与审计回滚、角色切换、旧会话及三组并发保底`)
} finally {
  try {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  } finally {
    try { if (source?.isInitialized) await source.destroy() }
    finally {
      if (mysqlConfig && mysqlCreated) {
        assert.match(databaseName, /^y_link_user_governance_[a-f0-9]{32}$/)
        const connection = await createConnection(mysqlConfig)
        try { await connection.query(`DROP DATABASE \`${databaseName}\``) } finally { await connection.end() }
      }
      // 路径来自本次 mkdtemp；不清理任何既有库或其他容器。
      assert.equal(path.dirname(sqlitePath), tempRoot)
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  }
}
