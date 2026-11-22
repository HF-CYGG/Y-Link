/** 使用独占 SQLite 和随机口令验证数据库治理安全不变量，无外部数据库连接。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createVerificationIsolation } from './verification-isolation.js'

const isolation = createVerificationIsolation('database-governance-security')
const sqlite = path.join(isolation.rootDir, 'source.sqlite')
isolation.seal({ type: 'sqlite', database: sqlite })
process.env.Y_LINK_AUTOMATIC_DB_MIGRATION_ENABLED = 'true'
const { AppDataSource } = await import('../src/config/data-source.js')
const { env } = await import('../src/config/env.js')
const { appDataPaths } = await import('../src/config/app-data-paths.js')
const { authService } = await import('../src/services/auth.service.js')
const { authSecurityService } = await import('../src/services/auth-security.service.js')
const { databaseMigrationService: migration } = await import('../src/services/database-migration.service.js')
const { databaseMaintenanceModeService: maintenance } = await import('../src/services/database-maintenance-mode.service.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { hashPassword } = await import('../src/utils/password.js')
const override = await import('../src/config/database-runtime-override.js')
const { writeControlFile } = await import('../src/runtime/durable-control-file.js')
const { inspectDatabaseStartup } = await import('../src/runtime/database-startup-preflight.js')
const { recordDatabaseRescueAttempt } = await import('../src/routes/database-rescue.routes.js')
const codeIs = (status: number) => (error: unknown) => (error as { statusCode?: number }).statusCode === status

try {
  await isolation.assertTarget(AppDataSource)
  await AppDataSource.initialize()
  await (await import('../src/database/database-strategy.js')).initializeDatabaseInfrastructure(AppDataSource)
  await AppDataSource.synchronize()
  const password = randomBytes(18).toString('base64url')
  const user = await AppDataSource.getRepository(SysUser).save({
    username: 'governance_admin', displayName: '治理隔离管理员', role: 'admin', status: 'enabled', passwordHash: await hashPassword(password),
  })
  const actor = { userId: user.id, username: user.username, displayName: user.displayName, role: 'admin' as const,
    status: 'enabled' as const, authSource: 'bearer' as const, sessionToken: '', permissions: [] }

  const purpose = 'database_migration.rollback_switch'
  const meta = { ipAddress: '127.0.0.1', userAgent: null, clientRiskBrowserId: null, clientRiskSessionId: null }
  const check = (input: string) => authService.verifyStepUpPassword(actor, input, meta, purpose, true)
  const ordinaryFailure = () => authSecurityService.recordAdminLoginFailure(meta, user.username)
  const ordinaryGuard = () => authSecurityService.assertAdminPasswordReauthAllowed(meta, user.username)
  await check(password)
  for (let count = 0; count < 4; count += 1) await ordinaryFailure()
  await maintenance.beginReadOnly({ taskId: 'step-up-test', phase: 'manual_awaiting_switch' })
  const readDatabaseFiles = () => [sqlite, `${sqlite}-wal`].map(file => fs.existsSync(file) ? fs.readFileSync(file) : null)
  const dataBefore = readDatabaseFiles()
  // 本人复核成功沿用原语义，不清除登录失败；冻结接续此前四次，且主库和 WAL 字节不变。
  await check(password)
  await assert.rejects(check('fixture-password-mismatch'), codeIs(400))
  await assert.rejects(check(password), codeIs(429))
  assert.deepEqual(readDatabaseFiles(), dataBefore)
  await maintenance.finishReadOnly('step-up-test')
  await assert.rejects(ordinaryGuard(), codeIs(429), '普通密码复核继续继承只读期间触发的锁定')
  const module = import.meta.resolve('../src/services/database-migration-password-risk.ts')
  const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
    const { readMigrationPasswordFailures } = await import(${JSON.stringify(module)});
    const [state] = readMigrationPasswordFailures(['admin-login:user:governance_admin'], Date.now(), 900_000);
    if (state?.count !== 5 || state.lockedUntil <= Date.now()) process.exit(1);
  `], { cwd: isolation.rootDir, env: process.env, timeout: 15_000, windowsHide: true })
  assert.equal(child.status, 0, '独立进程应重读同一已合并的控制文件锁定')
  const realNow = Date.now
  try {
    const expired = realNow() + 16 * 60_000
    Date.now = () => expired
    await ordinaryGuard()
    await maintenance.beginReadOnly({ taskId: 'step-up-test', phase: 'manual_awaiting_switch' })
    for (let count = 0; count < 4; count += 1) await assert.rejects(check('fixture-password-mismatch'), codeIs(400))
    await maintenance.finishReadOnly('step-up-test')
    await ordinaryGuard()
    await ordinaryFailure()
    await assert.rejects(ordinaryGuard(), codeIs(429), '解冻后的普通失败接续只读期间四次失败')

    Date.now = () => expired + 16 * 60_000
    await maintenance.beginReadOnly({ taskId: 'step-up-test', phase: 'manual_awaiting_switch' })
    await assert.rejects(check('fixture-password-mismatch'), codeIs(400))
    await maintenance.finishReadOnly('step-up-test')
    assert.equal((await authSecurityService.guardAdminLoginRequest(meta, user.username)).captchaRequired, true)
    await authSecurityService.clearAdminLoginFailures(meta, user.username)
    assert.equal((await authSecurityService.guardAdminLoginRequest(meta, user.username)).captchaRequired, false)
  } finally {
    Date.now = realNow
  }

  await maintenance.beginReadOnly({ taskId: 'step-up-test', phase: 'manual_awaiting_switch' })
  const rename = fs.renameSync
  try {
    fs.renameSync = (from, to) => {
      if (String(to).endsWith('database-migration-password-risk.json')) throw new Error('FIXTURE_CONTROL_WRITE_FAILURE')
      return rename(from, to)
    }
    await assert.rejects(check('fixture-password-mismatch'), /FIXTURE_CONTROL_WRITE_FAILURE/)
  } finally {
    fs.renameSync = rename
    await maintenance.finishReadOnly('step-up-test')
  }

  const rolledBack = await migration.rollbackDatabaseSwitch({}, actor)
  assert.equal(rolledBack.activeOverride?.config?.SQLITE_DB_PATH, fs.realpathSync(sqlite))
  const previous = fs.readFileSync(appDataPaths.runtimeOverrideFile)
  const unusableBackup = path.join(appDataPaths.migrationBackupDir, 'y-link-backup-before-mysql-migration-fixture.sqlite')
  fs.mkdirSync(path.dirname(unusableBackup), { recursive: true })
  fs.writeFileSync(unusableBackup, 'standalone test marker')
  await assert.rejects(migration.rollbackDatabaseSwitch({ sqlitePath: unusableBackup }, actor), codeIs(409))
  assert.deepEqual(fs.readFileSync(appDataPaths.runtimeOverrideFile), previous)
  const backup = path.join(appDataPaths.migrationBackupDir, 'y-link-backup-before-mysql-migration-valid.sqlite')
  await AppDataSource.query(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
  await migration.clearRuntimeOverride(actor)
  const implementation = migration as unknown as { resolveDirectSqliteRollbackPath: (...args: unknown[]) => Promise<string> }
  const resolvePath = implementation.resolveDirectSqliteRollbackPath
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  implementation.resolveDirectSqliteRollbackPath = async (...args) => {
    enter()
    await held
    return resolvePath.apply(migration, args)
  }
  const rollback = migration.rollbackDatabaseSwitch({ sqlitePath: backup }, actor)
  try {
    await Promise.race([entered, rollback])
    assert.equal(JSON.parse(fs.readFileSync(appDataPaths.migrationLockFile, 'utf8')).purpose, 'direct_override')
    assert.equal(fs.existsSync(appDataPaths.runtimeOverrideFile), false)
    const target = { host: '127.0.0.1', port: 1, user: 'fixture', password: '', database: 'fixture' }
    await assert.rejects(migration.createAutomaticSQLiteToMySqlTask({ target }, actor), /已有自动数据库迁移任务/)
    await assert.rejects(migration.runSQLiteToMySqlTask('fixture-manual', actor), codeIs(409))
  } finally {
    release()
    implementation.resolveDirectSqliteRollbackPath = resolvePath
    await rollback
  }
  assert.equal((await rollback).activeOverride?.config?.SQLITE_DB_PATH, fs.realpathSync(backup))
  assert.equal(fs.existsSync(appDataPaths.migrationLockFile), false)

  // 重启时回收无迁移状态的本地占位，保留已经提交的覆盖；活跃控制状态和占位并存时保留文件并拒绝猜测。
  const reservation = { version: 1, taskId: 'direct-fixture', acquiredAt: new Date().toISOString(), pid: process.pid, purpose: 'direct_override' }
  writeControlFile(appDataPaths.migrationLockFile, reservation)
  assert.deepEqual(await inspectDatabaseStartup(), { mode: 'normal' })
  assert.equal(fs.existsSync(appDataPaths.migrationLockFile), false)
  assert.equal(override.readDatabaseRuntimeOverride()?.config.SQLITE_DB_PATH, fs.realpathSync(backup))
  writeControlFile(appDataPaths.migrationLockFile, reservation)
  await maintenance.beginReadOnly({ taskId: 'step-up-test', phase: 'manual_awaiting_switch' })
  await assert.rejects(inspectDatabaseStartup(), /DATABASE_CONTROL_MISMATCH/)
  assert.ok(fs.existsSync(appDataPaths.migrationLockFile))
  fs.unlinkSync(appDataPaths.migrationLockFile)
  await maintenance.finishReadOnly('step-up-test')

  const flag = env as { Y_LINK_MANUAL_DB_MIGRATION_ENABLED: boolean }
  flag.Y_LINK_MANUAL_DB_MIGRATION_ENABLED = false
  try {
    const target = { host: '127.0.0.1', port: 1, user: 'fixture', password: '', database: 'fixture' }
    await assert.rejects(migration.createSQLiteToMySqlTask({ target }, actor), /禁用创建手动/)
    await migration.rollbackDatabaseSwitch({}, actor)
  } finally {
    flag.Y_LINK_MANUAL_DB_MIGRATION_ENABLED = true
  }

  // 密码可准确包含加密标记前缀和空格；旧文件升级保留连接语义，且磁盘仅保留密文。
  const mysqlPassword = `ylenc:v1:${randomBytes(18).toString('base64url')} `
  const legacy = {
    version: 1 as const, updatedAt: new Date().toISOString(),
    config: { DB_TYPE: 'mysql' as const, DB_HOST: '127.0.0.1', DB_PORT: 3306, DB_USER: 'fixture', DB_NAME: 'fixture', DB_PASSWORD: mysqlPassword },
  }
  writeControlFile(appDataPaths.runtimeOverrideFile, legacy)
  assert.ok(override.loadDatabaseRuntimeOverrideEnvValues()?.DB_PASSWORD === mysqlPassword)
  override.upgradeLegacyDatabaseRuntimeOverride()
  const onDisk = fs.readFileSync(appDataPaths.runtimeOverrideFile, 'utf8')
  assert.ok(!onDisk.includes(mysqlPassword))
  assert.equal(JSON.parse(onDisk).version, 2)
  assert.ok(override.readDatabaseRuntimeOverride()?.config.DB_PASSWORD === mysqlPassword)
  assert.equal(override.maskDatabaseRuntimeOverride(override.readDatabaseRuntimeOverride())?.config?.DB_PASSWORD, '***')

  const taskId = 'legacy_password_test'
  const taskSecretFile = path.join(appDataPaths.migrationSecretDir, `${taskId}.json`)
  writeControlFile(taskSecretFile, { version: 1, taskId, password: mysqlPassword })
  await migration.upgradeLegacyActiveTaskPassword(taskId)
  const taskOnDisk = JSON.parse(fs.readFileSync(taskSecretFile, 'utf8'))
  assert.equal(taskOnDisk.version, 2)
  assert.ok(!('password' in taskOnDisk))
  assert.ok(override.openDatabaseControlPassword(`database-migration:target-password:${taskId}`, taskOnDisk.passwordSealed) === mysqlPassword)

  const now = Date.now()
  for (let index = 0; index < 1024; index += 1) assert.equal(recordDatabaseRescueAttempt(`source-${index}`, now), 0)
  assert.equal(recordDatabaseRescueAttempt('new-operator', now), 0)
  for (let count = 1; count < 120; count += 1) assert.equal(recordDatabaseRescueAttempt('new-operator', now), 0)
  assert.equal(recordDatabaseRescueAttempt('new-operator', now + 1000), 59)
  assert.equal(recordDatabaseRescueAttempt('new-operator', now + 60_000), 0)
  console.log('[database-governance-security] 冻结密码复核、回退文件边界、凭据密封和救援容量验证通过')
} finally {
  if (maintenance.isReadOnly()) await maintenance.finishReadOnly('step-up-test')
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  isolation.cleanup()
}
