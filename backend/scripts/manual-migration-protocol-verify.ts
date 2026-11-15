/**
 * 文件职责：在专属Docker MySQL及独占SQLite内验证手动持续冻结协议，不连接业务目标。
 * 实现逻辑：每个case独立进程；真实快照/导入/强校验/控制文件，仅用屏障或指定写盘失败注入交错。
 * 维护说明：必须先构建当前后端；本脚本不代表Onebox守护/浏览器矩阵，后者另用真实镜像验收。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createVerificationIsolation } from './verification-isolation.js'
import { createOwnedVerificationDatabase, verificationDatabaseName } from './owned-verification-database.js'
import { readOwnedMysqlContext, withOwnedMysqlFixture } from './owned-mysql-fixture.mjs'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(backendRoot, 'node_modules/tsx/dist/cli.mjs'), file = fileURLToPath(import.meta.url)
const selected = process.argv.find(value => value.startsWith('--case='))?.slice(7)
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok }); return { promise, resolve } }
const waitFor = async (predicate: () => boolean) => {
  const end = Date.now() + 15_000
  while (!predicate()) { if (Date.now() >= end) throw new Error('等待冻结状态超时'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
const timeout = async <T>(promise: Promise<T>, ms = 120_000) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('手动迁移回归超时')), ms) })]) }
  finally { if (timer) clearTimeout(timer) }
}
const cases = ['manual-switch', 'prepared-switch', 'request-worker-drain', 'actor-disabled', 'session-revoked',
  'run-switch-cancel', 'preadmitted-cancel', 'marker-write-failure', 'override-write-failure', 'task-write-failure', 'compensation-failure',
  'startup-terminal-failure', 'legacy-stale', 'legacy-account-stale', 'legacy-session-stale', 'no-id-stale', 'no-id-equal', 'preserve-target',
  'failed-cleanup-crash', 'failed-cleanup-unlink-failure', 'http-proxy-run', 'https-proxy-run', 'copy-completed-before-cancel', 'cancel-accept-write-failure',
  'delete-awaiting-switch', 'delete-preadmitted-cancel', 'delete-cancel-accept-write-failure', 'recovery-expired-session', 'recovery-revoked-session']

if (!selected) {
  const requested = process.env.Y_LINK_MANUAL_VERIFY_CASES?.split(',').filter(Boolean)
  assert.ok(!requested || requested.every(name => cases.includes(name)), '只接受已定义的手动迁移回归case，未知选择不能记为通过')
  const selectedCases = requested ? cases.filter(name => requested.includes(name)) : cases
  assert.ok(selectedCases.length > 0, '不能以空选择宣称手动迁移回归通过')
  console.log(JSON.stringify({ manualProtocolSelection: selectedCases, notRunInThisCommand: cases.filter(name => !selectedCases.includes(name)) }))
  await withOwnedMysqlFixture(async fixture => {
    for (const name of selectedCases) {
      const result = spawnSync(process.execPath, [cli, '--tsconfig', path.join(backendRoot, 'tsconfig.json'), file, `--case=${name}`], {
        cwd: backendRoot, env: { ...process.env, ...fixture.env, DB_NAME: `ylink_sp_${fixture.runId}_auth` },
        encoding: 'utf8', windowsHide: true, timeout: 300_000,
      })
      assert.equal(result.status, 0, `${name}失败（仅隔离随机凭据）\n${result.stdout.slice(-3000)}\n${result.stderr.slice(-3000)}`)
      console.log(`PASS manual protocol ${name}`)
    }
  })
} else if (selected === 'legacy-switch-child') {
  // 历史任务来自旧进程，不能在刚取消同一任务的服务实例内篡改 JSON 来模拟重启。
  readOwnedMysqlContext()
  const context = JSON.parse(process.env.Y_LINK_VERIFICATION_CONTEXT ?? 'null')
  assert.ok(context && fs.readFileSync(path.join(context.rootDir, '.verification-owner'), 'utf8') === context.token)
  process.chdir(context.rootDir)
  const { AppDataSource: source } = await import('../src/config/data-source.js')
  const { assertInheritedVerificationTarget } = await import('./verification-isolation.js')
  await assertInheritedVerificationTarget(source)
  const { databaseMigrationService: migration } = await import('../src/services/database-migration.service.js')
  const { databaseMaintenanceModeService: maintenance } = await import('../src/services/database-maintenance-mode.service.js')
  try {
    await source.initialize()
    const actor = JSON.parse(process.env.Y_LINK_LEGACY_VERIFY_ACTOR!)
    await assert.rejects(migration.applyDatabaseSwitch({ taskId: process.env.Y_LINK_LEGACY_VERIFY_TASK }, actor), /校验未通过/)
    assert.equal(maintenance.isReadOnly(), false)
    assert.equal(fs.existsSync(path.join(context.rootDir, 'runtime/database-runtime-override.json')), false)
    assert.equal(fs.existsSync(path.join(context.rootDir, 'runtime/database-migration-cutover.json')), false)
  } finally { if (source.isInitialized) await source.destroy() }
} else if (['failed-cleanup-fault-child', 'failed-cleanup-restart-child', 'failed-cleanup-reject-child'].includes(selected)) {
  const context = JSON.parse(process.env.Y_LINK_VERIFICATION_CONTEXT ?? 'null')
  assert.ok(context && fs.readFileSync(path.join(context.rootDir, '.verification-owner'), 'utf8') === context.token)
  process.chdir(context.rootDir)
  const { appDataPaths } = await import('../src/config/app-data-paths.js')
  const taskId = process.env.Y_LINK_FAILURE_TASK_ID!
  if (selected !== 'failed-cleanup-fault-child') {
    // 业务env若被提前加载会因非法DB_TYPE拒绝；预检必须仅加载控制面并在bootstrap前完成收尾。
    process.env.DB_TYPE = 'invalid-must-not-load-business-env'
    const { inspectDatabaseStartup } = await import('../src/runtime/database-startup-preflight.js')
    if (selected === 'failed-cleanup-reject-child') {
      await assert.rejects(inspectDatabaseStartup())
      assert.equal(fs.existsSync(appDataPaths.maintenanceStateFile), true)
    } else {
      assert.equal((await inspectDatabaseStartup()).mode, 'normal')
      assert.equal((await inspectDatabaseStartup()).mode, 'normal', '失败补偿启动收尾必须幂等')
      assert.equal(fs.existsSync(appDataPaths.migrationLockFile), false)
      assert.equal(fs.existsSync(appDataPaths.maintenanceStateFile), false)
      assert.equal(JSON.parse(fs.readFileSync(path.join(appDataPaths.migrationTaskDir, taskId + '.json'), 'utf8')).controlPhase, 'failed_recovered')
      const { inspectSqliteForRescue } = await import('../src/runtime/sqlite-rescue-inspection.js')
      assert.equal((await inspectSqliteForRescue(context.target.database)).sha256, process.env.Y_LINK_FAILURE_SOURCE_DIGEST)
    }
  } else {
    const { AppDataSource } = await import('../src/config/data-source.js')
    const { databaseMigrationService } = await import('../src/services/database-migration.service.js')
    const internal = databaseMigrationService as unknown as Record<string, (...args: any[]) => Promise<any>>
    await AppDataSource.initialize()
    const task = await internal.readTaskRecord!(taskId, '隔离故障回归')
    const release = internal.releaseAutomaticMigrationLock!, unlink = fs.unlinkSync
    if (process.env.Y_LINK_FAILURE_KIND === 'crash') internal.releaseAutomaticMigrationLock = async function (...args) {
      await release.apply(this, args)
      process.kill(process.pid, 'SIGKILL')
      await new Promise(() => {})
    }
    else fs.unlinkSync = function (file) {
      if (String(file) === appDataPaths.maintenanceStateFile) throw new Error('MANUAL_MAINTENANCE_UNLINK_FAILURE')
      return unlink(file)
    }
    try { await assert.rejects(internal.finishFailedManualMigration!(task, new Error('MANUAL_EXPECTED_FAILURE')), /MANUAL_MAINTENANCE_UNLINK_FAILURE/) }
    finally { fs.unlinkSync = unlink; if (AppDataSource.isInitialized) await AppDataSource.destroy() }
    assert.equal(fs.existsSync(appDataPaths.migrationLockFile), false)
    assert.equal(fs.existsSync(appDataPaths.maintenanceStateFile), true)
  }
} else if (selected === 'startup' || selected === 'startup-terminal-failure-child') {
  const mysql = readOwnedMysqlContext()
  const context = JSON.parse(process.env.Y_LINK_VERIFICATION_CONTEXT ?? 'null')
  assert.ok(context && fs.readFileSync(path.join(context.rootDir, '.verification-owner'), 'utf8') === context.token)
  process.chdir(context.rootDir)
  process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'false'
  const { inspectDatabaseStartup } = await import('../src/runtime/database-startup-preflight.js')
  const startup = await inspectDatabaseStartup()
  assert.equal(startup.mode, 'cutover')
  const { AppDataSource: source } = await import('../src/config/data-source.js')
  const { databaseMaintenanceModeService: maintenance } = await import('../src/services/database-maintenance-mode.service.js')
  const { databaseMigrationService: migration } = await import('../src/services/database-migration.service.js')
  const { handleDatabaseMigrationCutoverStartupSuccess, completeDatabaseMigrationCutoverStartup } = await import('../src/services/database-migration-cutover.service.js')
  const options = source.options as { type: string; host: string; port: number; database: string }
  assert.equal(options.type, 'mysql'); assert.equal(options.host, mysql.host); assert.equal(options.port, mysql.port)
  assert.equal(options.database, process.env.Y_LINK_MANUAL_EXPECTED_DATABASE)
  try {
    await source.initialize()
    await (await import('../src/database/database-strategy.js')).initializeDatabaseInfrastructure(source)
    const result = await maintenance.runGovernance(startup.taskId!, () => handleDatabaseMigrationCutoverStartupSuccess({ activeDatabaseType: 'mysql' }))
    assert.equal(result.action, 'mysql_finalized')
    assert.equal(maintenance.isReadOnly(), true, '强验收完成也不能在bootstrap前解冻')
    const bootstrap = () => maintenance.runGovernance(startup.taskId!, () => migration.runManualMigrationStartupBootstrap(startup.taskId!, async () => {
      const { initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
      await initializeDatabaseSchemaIfNeeded(source)
    }))
    if (selected === 'startup-terminal-failure-child') {
      const internal = migration as unknown as Record<string, (...args: any[]) => Promise<any>>, original = internal.writeTaskRecordWithoutLock!
      internal.writeTaskRecordWithoutLock = async function (record) { if (record.controlPhase === 'accepted') throw new Error('MANUAL_TERMINAL_WRITE_FAILURE'); return original.call(this, record) }
      await assert.rejects(bootstrap(), /MANUAL_TERMINAL_WRITE_FAILURE/)
      assert.equal(maintenance.isReadOnly(), true)
      assert.equal(JSON.parse(fs.readFileSync(path.join(context.rootDir, 'database-migration/tasks', startup.taskId + '.json'), 'utf8')).controlPhase, 'validated')
      internal.writeTaskRecordWithoutLock = original
    }
    await bootstrap()
    await completeDatabaseMigrationCutoverStartup(startup.taskId!)
    assert.equal(maintenance.isReadOnly(), false)
    const task = await migration.getSQLiteToMySqlTask(startup.taskId!)
    assert.equal(task.status, 'succeeded'); assert.equal(task.result?.runtimeOverrideApplied, true)
    // 新库已开放后，真实新增写入不能被旧SQLite直退丢弃。
    await source.query("UPDATE base_product SET current_stock = current_stock + 1 WHERE product_code = 'MANUAL-FIXTURE'")
    await assert.rejects(migration.rollbackDatabaseSwitch({ taskId: task.id }, {
      userId: '1', username: 'fixture', displayName: '隔离管理员', role: 'admin', permissions: [], status: 'enabled', sessionToken: '', authSource: 'bearer',
    }), /禁止直接回退/)
    console.log('PASS real MySQL startup/terminal/bootstrap/rollback refusal')
  } finally { if (source.isInitialized) await source.destroy() }
} else {
  assert.ok(cases.includes(selected), '未知case')
  const mysql = readOwnedMysqlContext() // 先证明隔离服务器标签/高位回环端口；之后根env不再决定目标。
  const inheritedEnv = { ...process.env }
  const owned = await createOwnedVerificationDatabase(mysql, verificationDatabaseName('ylink_manual'))
  const isolation = createVerificationIsolation('manual-migration-protocol')
  const sqlite = path.join(isolation.rootDir, 'source.sqlite')
  isolation.seal({ type: 'sqlite', database: sqlite })
  Object.assign(process.env, { DB_SYNC: 'false', DB_AUTO_MIGRATE: 'false', INIT_ADMIN_USERNAME: 'manual_admin', INIT_ADMIN_PASSWORD: randomBytes(18).toString('base64url') })
  const [{ AppDataSource: source }, { databaseMigrationService: migration }, { databaseMaintenanceModeService: maintenance },
    { databaseOperationGate: gate }, { SysUser }, { SysUserSession }, { BaseProduct }, { hashSessionToken }, { inspectSqliteForRescue }] = await Promise.all([
    import('../src/config/data-source.js'), import('../src/services/database-migration.service.js'), import('../src/services/database-maintenance-mode.service.js'),
    import('../src/database/operation-gate.js'), import('../src/entities/sys-user.entity.js'), import('../src/entities/sys-user-session.entity.js'),
    import('../src/entities/base-product.entity.js'), import('../src/utils/session-token.js'), import('../src/runtime/sqlite-rescue-inspection.js'),
  ])
  const internal = migration as unknown as Record<string, (...args: any[]) => Promise<any>>
  const target = { ...mysql, database: owned.database, dbSync: false }
  if (selected === 'compensation-failure') {
    const validate = internal.validateAutomaticMigration!
    let validationAttempt = 0
    internal.validateAutomaticMigration = async function (snapshot, destination, ...args) {
      const auditState = async (database: typeof source) => ({
        rows: await database.query('SELECT COUNT(*) AS n, CAST(MAX(id) AS CHAR) AS maximum FROM sys_audit_log'),
        ...(database.options.type === 'sqlite'
          ? { sequence: await database.query("SELECT CAST(seq AS TEXT) AS value FROM sqlite_sequence WHERE name='sys_audit_log'") }
          : { sequence: await database.query("SELECT CAST(auto_increment AS CHAR) AS value FROM information_schema.tables WHERE table_schema=? AND table_name='sys_audit_log'", [database.options.database]),
            liveStatus: await database.query("SHOW TABLE STATUS LIKE 'sys_audit_log'") }),
      })
      const result = await validate.call(this, snapshot, destination, ...args)
      // 仅保留行数、序列与强校验结果，不保存业务审计正文或连接凭证。
      const state = { at: new Date().toISOString(), attempt: ++validationAttempt,
        liveSource: await auditState(source), immutableSnapshot: await auditState(snapshot), destination: await auditState(destination),
        validation: result.items.find((item: { tableName: string }) => item.tableName === 'sys_audit_log') }
      console.log(JSON.stringify({ compensationSequenceDiagnostic: state }))
      return result
    }
  }
  let sourceClosed = false, retainIsolationForDiagnostic = false
  let caseError: unknown, cleanupDiagnostic: ((phase: string, error?: unknown) => void) | undefined
  try {
    await isolation.assertTarget(source)
    const { prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
    prepareDatabaseRuntime()
    await source.initialize()
    await (await import('../src/database/database-strategy.js')).initializeDatabaseInfrastructure(source)
    await source.synchronize()
    const user = await source.getRepository(SysUser).save({ username: 'manual_admin', displayName: '隔离迁移管理员', role: 'admin', status: 'enabled', passwordHash: 'fixture-only' })
    const token = randomBytes(32).toString('hex')
    await source.getRepository(SysUserSession).save({ userId: user.id, sessionToken: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastAccessAt: new Date() })
    const otherUser = await source.getRepository(SysUser).save({ username: 'manual_other', displayName: '隔离账号状态夹具', role: 'operator', status: 'enabled', passwordHash: 'fixture-only' })
    const otherSession = await source.getRepository(SysUserSession).save({ userId: otherUser.id, sessionToken: hashSessionToken(randomBytes(32).toString('hex')), expiresAt: new Date(Date.now() + 3600_000), lastAccessAt: new Date() })
    const actor = { userId: user.id, username: user.username, displayName: user.displayName, role: 'admin' as const,
      permissions: [] as never[], status: 'enabled' as const, sessionToken: token, authSource: 'bearer' as const }
    const product = await source.getRepository(BaseProduct).save({ productCode: 'MANUAL-FIXTURE', productName: '手动一致性夹具', isActive: true, currentStock: 7, preOrderedStock: 0 })
    const create = (options: Record<string, boolean> = {}) => migration.createSQLiteToMySqlTask({ target,
      initializeSchema: true, clearTargetBeforeImport: true, switchAfterSuccess: selected === 'prepared-switch', ...options }, actor)
    let task = await create()
    if (selected === 'http-proxy-run' || selected === 'https-proxy-run') {
      const http = await import('node:http')
      process.env.Y_LINK_TRUST_PROXY = '127.0.0.1/32'
      const app = (await import('../src/app.js')).createApp()
      const server = app.listen(0, '127.0.0.1')
      await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
      const address = server.address(); assert.ok(address && typeof address === 'object')
      const secure = selected === 'https-proxy-run'
      const proxy = http.createServer((request, response) => {
        const outgoing = http.request({ host: '127.0.0.1', port: address.port, path: request.url, method: request.method,
          headers: { ...request.headers, 'x-forwarded-for': '203.0.113.20', 'x-forwarded-proto': secure ? 'https' : 'http' } }, upstream => {
          response.writeHead(upstream.statusCode!, upstream.headers); upstream.pipe(response)
        })
        outgoing.on('error', () => { response.writeHead(502); response.end() }); request.pipe(outgoing)
      }).listen(0, '127.0.0.1')
      await new Promise<void>((resolve, reject) => { proxy.once('listening', resolve); proxy.once('error', reject) })
      const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress === 'object')
      const post = (suffix: string) => fetch(`http://127.0.0.1:${proxyAddress.port}/api/data-maintenance/db-migration/tasks/${task.id}/${suffix}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })
      try {
        const credentialResponse = await post('rescue-credential')
        assert.equal(credentialResponse.status, secure ? 200 : 403)
        const payload = await credentialResponse.json() as { data?: { credential?: string } }
        if (secure) assert.equal(typeof payload.data?.credential, 'string')
        else {
          assert.equal(payload.data?.credential, undefined, '代理HTTP绝不能获得明文救援凭证')
          const local = spawnSync(process.execPath, [cli, '--tsconfig', path.join(backendRoot, 'tsconfig.json'),
            path.join(backendRoot, 'src/runtime/database-rescue-cli.ts'), 'prepare-manual-credential', task.id],
          { cwd: isolation.rootDir, env: { ...process.env }, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
          assert.equal(local.status, 0, '本地准备失败；禁止输出明文凭证')
          assert.equal(JSON.parse(local.stdout).taskId, task.id)
        }
        const run = await post('run'); assert.equal(run.status, 200)
        assert.equal(maintenance.isReadOnly(), true)
        assert.equal((await migration.getSQLiteToMySqlTask(task.id)).status, 'succeeded')
        await migration.rollbackDatabaseSwitch({ taskId: task.id }, actor)
        assert.equal(maintenance.isReadOnly(), false)
      } finally {
        await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    } else if (selected.startsWith('recovery-')) {
      task = await migration.runSQLiteToMySqlTask(task.id, actor)
      await migration.applyDatabaseSwitch({ taskId: task.id }, actor)
      const stateFile = path.join(isolation.rootDir, 'runtime/maintenance-state.json'), before = fs.readFileSync(stateFile)
      await maintenance.runGovernance(task.id, async () => {
        if (selected === 'recovery-expired-session') await source.getRepository(SysUserSession).update({ userId: user.id }, { expiresAt: new Date(0) })
        else await source.getRepository(SysUserSession).delete({ userId: user.id })
      })
      for (const operation of [() => migration.rollbackDatabaseSwitch({ taskId: task.id }, actor), () => migration.clearRuntimeOverride(actor)]) {
        await assert.rejects(operation, (error: unknown) => { assert.ok(error instanceof Error); assert.equal((error as Error & { statusCode: number }).statusCode, 403); assert.match(error.message, /管理员会话或权限已失效/); return true })
      }
      assert.deepEqual(fs.readFileSync(stateFile), before, '过期/撤销会话不得改变维护控制阶段')
      assert.equal(maintenance.isReadOnly(), true)
      assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-recovery-intent.json')), false)
      assert.equal(JSON.parse(fs.readFileSync(path.join(isolation.rootDir, 'runtime/database-runtime-override.json'), 'utf8')).config.DB_TYPE, 'mysql')
    } else if (selected.startsWith('delete-')) {
      // 真实DELETE路由保留Bearer会话/管理员/权限门禁；只为并发时序加fixture屏障。
      const app = (await import('../src/app.js')).createApp(), server = app.listen(0, '127.0.0.1')
      await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
      const address = server.address(); assert.ok(address && typeof address === 'object')
      const remove = async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/data-maintenance/db-migration/runtime-override`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
        })
        return { status: response.status, body: await response.json() as { code: number; data?: { cleared: boolean; restartRequired: boolean } } }
      }
      const entered = deferred(), release = deferred(), admitted = deferred()
      const clear = migration.clearRuntimeOverride, migrate = internal.migrateSingleTableByPrimaryKey!, write = internal.writeTaskRecordWithoutLock!
      let running: Promise<unknown> | undefined, cancelling: Promise<unknown> | undefined, failure: unknown
      try {
        if (selected === 'delete-awaiting-switch') {
          task = await migration.runSQLiteToMySqlTask(task.id, actor)
          assert.equal(maintenance.isReadOnly(), true)
          const result = await remove(); assert.equal(result.status, 200)
          assert.deepEqual(result.body.data, { cleared: false, restartRequired: true })
        } else if (selected === 'delete-preadmitted-cancel') {
          migration.clearRuntimeOverride = async function (...args) { admitted.resolve(); await release.promise; return clear.apply(this, args) }
          cancelling = remove(); void cancelling.catch(() => undefined)
          await timeout(admitted.promise)
          running = migration.runSQLiteToMySqlTask(task.id, actor); void running.catch(() => undefined)
          await waitFor(() => maintenance.isReadOnly())
          release.resolve()
          await assert.rejects(timeout(running))
          const result = await timeout(cancelling) as Awaited<ReturnType<typeof remove>>
          assert.equal(result.status, 200); assert.deepEqual(result.body.data, { cleared: false, restartRequired: true })
        } else {
          internal.migrateSingleTableByPrimaryKey = async function (...args) { entered.resolve(); await release.promise; return migrate.apply(this, args) }
          running = migration.runSQLiteToMySqlTask(task.id, actor); void running.catch(() => undefined)
          await timeout(entered.promise)
          internal.writeTaskRecordWithoutLock = async function (record) {
            if (record.cancelRequestedAt) throw new Error('DELETE_CANCEL_ACCEPT_WRITE_FAILURE')
            return write.call(this, record)
          }
          assert.equal((await remove()).status, 500, 'DELETE取消接受写盘失败必须明确失败')
          assert.equal(maintenance.isReadOnly(), true)
          const durable = JSON.parse(fs.readFileSync(path.join(isolation.rootDir, 'database-migration/tasks', task.id + '.json'), 'utf8'))
          assert.equal(durable.cancelRequestedAt, undefined)
          await assert.rejects(internal.cancelManualBeforeCutover!(durable), /启动续接只能处理已持久接受的取消/)
          release.resolve(); await assert.rejects(timeout(running))
          assert.equal(maintenance.isReadOnly(), true)
          internal.writeTaskRecordWithoutLock = write
          assert.equal((await remove()).status, 200)
        }
        assert.equal(maintenance.isReadOnly(), false)
        assert.equal((await migration.getSQLiteToMySqlTask(task.id)).status, 'rolled_back')
        assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-runtime-override.json')), false)
        assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-migration-cutover.json')), false)
      } catch (error) { failure = error }
      finally {
        release.resolve(); migration.clearRuntimeOverride = clear; internal.migrateSingleTableByPrimaryKey = migrate; internal.writeTaskRecordWithoutLock = write
        try {
          await timeout(Promise.allSettled([...(running ? [running] : []), ...(cancelling ? [cancelling] : [])]), 30_000)
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        } catch (error) { retainIsolationForDiagnostic = true; if (failure) throw new AggregateError([failure, error], 'DELETE主异常与所属执行体/HTTP收口错误均保留'); throw error }
        if (failure) throw failure
      }
    } else if (selected === 'actor-disabled' || selected === 'session-revoked') {
      const ready = deferred(), release = deferred()
      const oldRequest = gate.runOperation(async () => {
        ready.resolve(); await release.promise
        if (selected === 'actor-disabled') await source.getRepository(SysUser).update(user.id, { status: 'disabled' })
        else await source.getRepository(SysUserSession).delete({ userId: user.id })
      })
      await ready.promise
      const running = migration.runSQLiteToMySqlTask(task.id, actor)
      void running.catch(() => undefined)
      await waitFor(() => maintenance.isReadOnly())
      release.resolve(); await oldRequest
      await assert.rejects(timeout(running), /管理员会话或权限已失效/)
      assert.equal(maintenance.isReadOnly(), false)
    } else if (selected === 'preadmitted-cancel') {
      const releaseCancel = deferred(), admitted = deferred()
      const cancel = gate.runOperation(async () => { admitted.resolve(); await releaseCancel.promise; return migration.rollbackDatabaseSwitch({ taskId: task.id }, actor) })
      void cancel.catch(() => undefined)
      await admitted.promise
      const running = migration.runSQLiteToMySqlTask(task.id, actor); void running.catch(() => undefined)
      await waitFor(() => maintenance.isReadOnly())
      releaseCancel.resolve()
      await assert.rejects(timeout(running, 20_000))
      await timeout(cancel, 20_000)
      assert.equal(maintenance.isReadOnly(), false, '冻结前准入的取消请求不能令drain等待自己')
      assert.equal((await migration.getSQLiteToMySqlTask(task.id)).status, 'rolled_back')
    } else if (selected === 'run-switch-cancel') {
      const entered = deferred(), release = deferred(), original = internal.migrateSingleTableByPrimaryKey!
      const traceDir = path.resolve(process.env.Y_LINK_VERIFY_EVIDENCE_DIR ?? path.join(path.dirname(isolation.rootDir), 'manual-cancel-diagnostics'))
      const relativeTraceDir = path.relative(isolation.rootDir, traceDir)
      assert.ok(path.isAbsolute(relativeTraceDir) || relativeTraceDir === '..' || relativeTraceDir.startsWith('..' + path.sep), '诊断目录必须在待清理fixture之外，避免丢失主失败证据')
      fs.mkdirSync(traceDir, { recursive: true })
      const timeline: unknown[] = [], resources: Array<{ kind: string; resource: { isInitialized: boolean } }> = []
      const factories = migration as unknown as Record<string, (...args: any[]) => any>
      const originals = new Map<string, (...args: any[]) => any>()
      let runState = 'not-started', cancelState = 'not-started', primaryError: unknown, cleanupError: unknown
      const describeError = (error: unknown) => {
        const value = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
        return value.replaceAll(mysql.password, '***').replaceAll(token, '***')
      }
      const trace = (phase: string, error?: unknown) => {
        let durable: { status?: string; controlPhase?: string; cancelRequestedAt?: string } | undefined
        try { const record = JSON.parse(fs.readFileSync(path.join(isolation.rootDir, 'database-migration/tasks', task.id + '.json'), 'utf8')); durable = { status: record.status, controlPhase: record.controlPhase, cancelRequestedAt: record.cancelRequestedAt } } catch { /* 未能读到状态同样留在时间线，不能当作取消已接受。 */ }
        timeline.push({ at: new Date().toISOString(), phase, runState, cancelState, durable,
          readOnly: maintenance.isReadOnly(), sourceInitialized: source.isInitialized,
          resources: resources.map(({ kind, resource }) => ({ kind, initialized: resource.isInitialized })),
          ...(error ? { error: describeError(error) } : {}) })
        fs.writeFileSync(path.join(traceDir, task.id + '-cancel.json'), JSON.stringify({ taskId: task.id, timeline }, null, 2) + '\n')
      }
      cleanupDiagnostic = trace
      for (const name of ['createSqliteSnapshotDataSource', 'createMysqlDataSource']) {
        const factory = factories[name]!
        originals.set(name, factory)
        factories[name] = function (...args) { const resource = factory.apply(this, args); resources.push({ kind: name, resource }); trace('resource-created'); return resource }
      }
      const begin = maintenance.beginReadOnly
      maintenance.beginReadOnly = async function (input) {
        trace('beginReadOnly-start:' + input.phase)
        try { await begin.call(this, input); trace('beginReadOnly-end:' + input.phase) }
        catch (error) { trace('beginReadOnly-error:' + input.phase, error); throw error }
      }
      internal.migrateSingleTableByPrimaryKey = async function (...args) { trace('copy-barrier-entered'); entered.resolve(); await release.promise; trace('copy-barrier-released'); return original.apply(this, args) }
      const running = migration.runSQLiteToMySqlTask(task.id, actor)
      runState = 'pending'
      void running.then(() => { runState = 'fulfilled'; trace('run-fulfilled') }, error => { runState = 'rejected'; trace('run-rejected', error) })
      let cancelled: Promise<unknown> | undefined
      try {
        await timeout(entered.promise)
        await assert.rejects(migration.runSQLiteToMySqlTask(task.id, actor), /已有迁移控制操作/)
        await assert.rejects(migration.applyDatabaseSwitch({ taskId: task.id }, actor), /已有迁移控制操作/)
        trace('cancel-call')
        cancelled = migration.rollbackDatabaseSwitch({ taskId: task.id }, actor)
        cancelState = 'pending'
        void cancelled.then(() => { cancelState = 'fulfilled'; trace('cancel-fulfilled') }, error => { cancelState = 'rejected'; trace('cancel-rejected', error) })
        // 取消先持久接受，再释放复制；若取消先失败，保留实际异常而非等待超时遮盖它。
        await Promise.race([waitFor(() => {
          try { return Boolean(JSON.parse(fs.readFileSync(path.join(isolation.rootDir, 'database-migration/tasks', task.id + '.json'), 'utf8')).cancelRequestedAt) }
          catch { return false }
        }), cancelled.then(() => { throw new Error('复制屏障未释放前取消已结束，需检查执行体收口') })])
        trace('cancel-durably-accepted')
        release.resolve()
        await assert.rejects(timeout(running))
        await timeout(cancelled)
        assert.equal(maintenance.isReadOnly(), false)
        assert.equal((await migration.getSQLiteToMySqlTask(task.id)).status, 'rolled_back')
        assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-runtime-override.json')), false)
      } catch (error) { primaryError = error; trace('primary-error', error) }
      finally {
        // 任何断言失败都必须先释放自有屏障、等待真实执行体finally关闭资源，再做目录清理。
        release.resolve(); trace('cleanup-release-barrier')
        try {
          const settled = await timeout(Promise.allSettled([running, ...(cancelled ? [cancelled] : [])]), 30_000)
          trace('cleanup-promises-settled:' + settled.map(result => result.status).join(','))
          assert.ok(resources.every(({ resource }) => !resource.isInitialized), '在途迁移Promise结束后仍有数据源未关闭')
        } catch (error) { cleanupError = error; retainIsolationForDiagnostic = true; trace('cleanup-error-retain-isolation', error) }
        maintenance.beginReadOnly = begin
        internal.migrateSingleTableByPrimaryKey = original
        for (const [name, factory] of originals) factories[name] = factory
        if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], '主验证失败且迁移执行体收口失败；现场保留，不覆盖主异常')
        if (primaryError) throw primaryError
        if (cleanupError) throw cleanupError
      }
    } else if (selected === 'cancel-accept-write-failure') {
      const entered = deferred(), release = deferred(), migrate = internal.migrateSingleTableByPrimaryKey!, write = internal.writeTaskRecordWithoutLock!
      internal.migrateSingleTableByPrimaryKey = async function (...args) { entered.resolve(); await release.promise; return migrate.apply(this, args) }
      const running = migration.runSQLiteToMySqlTask(task.id, actor); void running.catch(() => undefined)
      let failure: unknown
      try {
        await timeout(entered.promise)
        internal.writeTaskRecordWithoutLock = async function (record) {
          if (record.cancelRequestedAt) throw new Error('MANUAL_CANCEL_ACCEPT_WRITE_FAILURE')
          return write.call(this, record)
        }
        await assert.rejects(migration.rollbackDatabaseSwitch({ taskId: task.id }, actor), /MANUAL_CANCEL_ACCEPT_WRITE_FAILURE/)
        assert.equal(maintenance.isReadOnly(), true, '接受持久化失败不能解冻或返回取消成功')
        const durable = JSON.parse(fs.readFileSync(path.join(isolation.rootDir, 'database-migration/tasks', task.id + '.json'), 'utf8'))
        assert.equal(durable.cancelRequestedAt, undefined, '本次失败不能伪造持久接受证据')
        release.resolve()
        await assert.rejects(timeout(running))
        assert.equal(maintenance.isReadOnly(), true)
        assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-runtime-override.json')), false)
        assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-migration-cutover.json')), false)
        internal.writeTaskRecordWithoutLock = write
        await migration.rollbackDatabaseSwitch({ taskId: task.id }, actor)
        assert.equal((await migration.getSQLiteToMySqlTask(task.id)).status, 'rolled_back')
        assert.equal(maintenance.isReadOnly(), false)
      } catch (error) { failure = error }
      finally {
        release.resolve(); internal.writeTaskRecordWithoutLock = write; internal.migrateSingleTableByPrimaryKey = migrate
        try { await timeout(Promise.allSettled([running]), 30_000) }
        catch (error) { retainIsolationForDiagnostic = true; if (failure) throw new AggregateError([failure, error], '取消持久化失败及执行体收口错误均保留'); throw error }
        if (failure) throw failure
      }
    } else {
      let closeHttp: (() => Promise<void>) | undefined, unregisterWorker: (() => void) | undefined
      const release = deferred()
      if (selected === 'request-worker-drain') {
        const express = (await import('express')).default
        const { asyncHandler } = await import('../src/utils/async-handler.js')
        const { databaseMaintenanceWriteBarrier } = await import('../src/middleware/database-maintenance.middleware.js')
        const app = express(); app.use(databaseMaintenanceWriteBarrier)
        app.post('/probe', asyncHandler(async (_req, res) => { res.json({ ok: true }); await release.promise; await source.getRepository(BaseProduct).update(product.id, { currentStock: 9 }) }))
        const server = app.listen(0, '127.0.0.1')
        if (!server.listening) await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
        const address = server.address(); assert.ok(address && typeof address === 'object')
        assert.equal((await fetch(`http://127.0.0.1:${address.port}/probe`, { method: 'POST' })).status, 200)
        closeHttp = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        unregisterWorker = gate.registerWorker({ name: 'manual-fixture-worker', pause() {}, drain: () => release.promise, resume() {} })
      }
      const originalWrite = internal.writeTaskRecordWithoutLock!
      if (selected === 'task-write-failure' || selected === 'compensation-failure') internal.writeTaskRecordWithoutLock = async function (record) {
        if (record.controlPhase === 'restart_pending') throw new Error('MANUAL_RESTART_TASK_WRITE_FAILURE')
        return originalWrite.call(this, record)
      }
      const running = migration.runSQLiteToMySqlTask(task.id, actor); void running.catch(() => undefined)
      if (selected === 'request-worker-drain') {
        await waitFor(() => maintenance.isReadOnly())
        assert.equal(fs.existsSync(path.join(isolation.rootDir, 'database-migration/snapshots', `${task.id}.sqlite`)), false)
        release.resolve()
      }
      try { task = await timeout(running) } finally { unregisterWorker?.(); await closeHttp?.() }
      assert.equal(task.status, 'succeeded'); assert.equal(maintenance.isReadOnly(), true)
      await assert.rejects(gate.runOperation(() => source.getRepository(BaseProduct).update(product.id, { currentStock: 999 })), /只读/)
      if (selected === 'request-worker-drain') assert.equal((await source.getRepository(BaseProduct).findOneByOrFail({ id: product.id })).currentStock, 9)
      if (selected === 'copy-completed-before-cancel') {
        const before = (await inspectSqliteForRescue(sqlite)).sha256
        assert.equal(task.result?.runtimeOverrideApplied, false, '复制完成待人工switch尚不能应用override')
        await migration.rollbackDatabaseSwitch({ taskId: task.id }, actor)
        assert.equal((await migration.getSQLiteToMySqlTask(task.id)).status, 'rolled_back')
        assert.equal(maintenance.isReadOnly(), false)
        assert.equal((await inspectSqliteForRescue(sqlite)).sha256, before)
        assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-runtime-override.json')), false)
        assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-migration-cutover.json')), false)
      } else if (selected.startsWith('failed-cleanup-')) {
        const digest = (await inspectSqliteForRescue(sqlite)).sha256
        await source.destroy(); sourceClosed = true
        const spawnCase = (name: string) => spawnSync(process.execPath, [cli, '--tsconfig', path.join(backendRoot, 'tsconfig.json'), file, `--case=${name}`], {
          cwd: isolation.rootDir, env: { ...process.env, Y_LINK_FAILURE_TASK_ID: task.id, Y_LINK_FAILURE_SOURCE_DIGEST: digest,
            Y_LINK_FAILURE_KIND: selected === 'failed-cleanup-crash' ? 'crash' : 'unlink' }, encoding: 'utf8', windowsHide: true, timeout: 120_000,
        })
        const fault = spawnCase('failed-cleanup-fault-child')
        if (selected === 'failed-cleanup-crash') assert.notEqual(fault.status, 0, '删锁后真实子进程必须被终止')
        else assert.equal(fault.status, 0, fault.stderr.slice(-2000))
        const { appDataPaths } = await import('../src/config/app-data-paths.js')
        assert.equal(fs.existsSync(appDataPaths.migrationLockFile), false)
        assert.equal(fs.existsSync(appDataPaths.maintenanceStateFile), true)
        const taskPath = path.join(appDataPaths.migrationTaskDir, task.id + '.json'), originalTask = fs.readFileSync(taskPath)
        const invalid = JSON.parse(originalTask.toString('utf8')); invalid.controlPhase = 'failed'
        fs.writeFileSync(taskPath, JSON.stringify(invalid))
        assert.equal(spawnCase('failed-cleanup-reject-child').status, 0, '普通failed无锁不能泛化解冻')
        fs.writeFileSync(taskPath, originalTask)
        const bindingPath = path.join(appDataPaths.runtimeDir, 'database-rescue', task.id + '.json')
        const originalBinding = fs.readFileSync(bindingPath), binding = JSON.parse(originalBinding.toString('utf8'))
        delete binding.manualFailureCleanup
        fs.writeFileSync(bindingPath, JSON.stringify(binding))
        assert.equal(spawnCase('failed-cleanup-reject-child').status, 0, '缺少失败补偿证明必须继续救援')
        fs.writeFileSync(bindingPath, originalBinding)
        const invalidDigest = JSON.parse(originalBinding.toString('utf8'))
        invalidDigest.manualFailureCleanup.sourceDigest.sha256 = '0'.repeat(64)
        fs.writeFileSync(bindingPath, JSON.stringify(invalidDigest))
        assert.equal(spawnCase('failed-cleanup-reject-child').status, 0, '源摘要与持久证明不符必须保持冻结')
        fs.writeFileSync(bindingPath, originalBinding)
        const overridePath = appDataPaths.runtimeOverrideFile
        fs.writeFileSync(overridePath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(),
          config: { DB_TYPE: 'sqlite', SQLITE_DB_PATH: sqlite, DB_SYNC: false }, reason: 'fixture-only-unproven-override' }))
        assert.equal(spawnCase('failed-cleanup-reject-child').status, 0, '未恢复原override不能解冻')
        fs.unlinkSync(overridePath)
        const restart = spawnCase('failed-cleanup-restart-child')
        assert.equal(restart.status, 0, restart.stderr.slice(-3000))
        assert.equal((await inspectSqliteForRescue(sqlite)).sha256, digest)
      } else if (['marker-write-failure', 'override-write-failure', 'task-write-failure', 'compensation-failure'].includes(selected)) {
        const originalRename = fs.renameSync
        let overrideWrites = 0
        if (selected === 'compensation-failure') {
          // 先取消已完成复制，再在同一原库显式设置旧SQLite覆盖，生成新任务以验证补偿的写回次序。
          internal.writeTaskRecordWithoutLock = originalWrite
          await migration.rollbackDatabaseSwitch({ taskId: task.id }, actor)
          const { writeDatabaseRuntimeOverride } = await import('../src/config/database-runtime-override.js')
          await writeDatabaseRuntimeOverride({ version: 1, updatedAt: new Date().toISOString(), config: { DB_TYPE: 'sqlite', SQLITE_DB_PATH: sqlite, DB_SYNC: false } })
          task = await create({ allowTargetWithData: true })
          task = await migration.runSQLiteToMySqlTask(task.id, actor)
          internal.writeTaskRecordWithoutLock = async function (record) { if (record.controlPhase === 'restart_pending') throw new Error('MANUAL_RESTART_TASK_WRITE_FAILURE'); return originalWrite.call(this, record) }
        }
        fs.renameSync = function (from, to) {
          const destination = String(to)
          if (destination.endsWith('database-runtime-override.json')) overrideWrites++
          if ((selected === 'marker-write-failure' && destination.endsWith('database-migration-cutover.json'))
            || (selected === 'override-write-failure' && destination.endsWith('database-runtime-override.json'))
            || (selected === 'compensation-failure' && destination.endsWith('database-runtime-override.json') && overrideWrites === 2)) throw new Error('MANUAL_CONTROL_WRITE_FAILURE')
          return originalRename(from, to)
        }
        try { await assert.rejects(migration.applyDatabaseSwitch({ taskId: task.id }, actor)) }
        finally { fs.renameSync = originalRename; internal.writeTaskRecordWithoutLock = originalWrite }
        if (selected === 'compensation-failure') {
          assert.equal(maintenance.isReadOnly(), true, '旧覆盖写回失败必须保留冻结与marker')
          assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-migration-cutover.json')), true)
        } else {
          assert.equal(maintenance.isReadOnly(), false)
          assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-runtime-override.json')), false)
          assert.equal(fs.existsSync(path.join(isolation.rootDir, 'runtime/database-migration-cutover.json')), false)
        }
      } else if (['legacy-stale', 'legacy-account-stale', 'legacy-session-stale', 'no-id-stale', 'no-id-equal', 'preserve-target'].includes(selected)) {
        await migration.rollbackDatabaseSwitch({ taskId: task.id }, actor)
        assert.equal(maintenance.isReadOnly(), false)
        if (selected === 'legacy-account-stale') await source.getRepository(SysUser).update(otherUser.id, { status: 'disabled' })
        else if (selected === 'legacy-session-stale') {
          await source.getRepository(SysUserSession).delete(otherSession.id)
          await source.getRepository(SysUserSession).save({ userId: otherUser.id, sessionToken: hashSessionToken(randomBytes(32).toString('hex')), expiresAt: new Date(Date.now() + 3600_000), lastAccessAt: new Date() })
        } else if (selected.endsWith('stale')) await source.getRepository(BaseProduct).update(product.id, { currentStock: 8 }) // 行数不变
        if (selected.startsWith('legacy-')) {
          const filename = path.join(isolation.rootDir, 'database-migration/tasks', `${task.id}.json`)
          const legacy = JSON.parse(fs.readFileSync(filename, 'utf8'))
          delete legacy.controlProtocol; delete legacy.controlPhase; delete legacy.cancelRequestedAt
          legacy.status = 'succeeded'
          legacy.result.validation.items = legacy.result.validation.items.map(({ tableName, sourceRowCount, targetRowCount, matched, blocking }) => ({ tableName, sourceRowCount, targetRowCount, matched, blocking }))
          fs.writeFileSync(filename, JSON.stringify(legacy))
          await source.destroy(); sourceClosed = true
          const historicalProcess = spawnSync(process.execPath, [cli, '--tsconfig', path.join(backendRoot, 'tsconfig.json'), file, '--case=legacy-switch-child'], {
            cwd: isolation.rootDir, env: { ...process.env, DB_NAME: inheritedEnv.DB_NAME,
              Y_LINK_LEGACY_VERIFY_TASK: task.id, Y_LINK_LEGACY_VERIFY_ACTOR: JSON.stringify(actor) },
            encoding: 'utf8', windowsHide: true, timeout: 120_000,
          })
          assert.equal(historicalProcess.status, 0, historicalProcess.stderr.slice(-3000))
        } else if (selected === 'no-id-stale') await assert.rejects(migration.applyDatabaseSwitch({ target }, actor), /校验未通过/)
        else if (selected === 'no-id-equal') await migration.applyDatabaseSwitch({ target }, actor)
        else {
          const preserve = await create({ allowTargetWithData: true, initializeSchema: false, clearTargetBeforeImport: false })
          await assert.rejects(migration.runSQLiteToMySqlTask(preserve.id, actor))
          const mysqlDriver = (await import('mysql2/promise')).default
          const connection = await mysqlDriver.createConnection({ ...mysql, database: owned.database })
          try { const [rows] = await connection.query("SELECT current_stock AS n FROM base_product WHERE product_code='MANUAL-FIXTURE'"); assert.equal(Number((rows as Array<{ n: number }>)[0]?.n), 7) }
          finally { await connection.end() }
        }
      } else {
        if (!task.result?.runtimeOverrideApplied) await migration.applyDatabaseSwitch({ taskId: task.id }, actor)
        const before = await inspectSqliteForRescue(sqlite)
        await source.destroy(); sourceClosed = true
        const startup = spawnSync(process.execPath, [cli, '--tsconfig', path.join(backendRoot, 'tsconfig.json'), file,
          selected === 'startup-terminal-failure' ? '--case=startup-terminal-failure-child' : '--case=startup'], {
          cwd: isolation.rootDir, env: { ...inheritedEnv, ...process.env, DB_NAME: inheritedEnv.DB_NAME,
            Y_LINK_MANUAL_EXPECTED_DATABASE: owned.database }, encoding: 'utf8', windowsHide: true, timeout: 120_000,
        })
        assert.equal(startup.status, 0, startup.stderr.slice(-4000))
        assert.equal((await inspectSqliteForRescue(sqlite)).sha256, before.sha256, '目标启动不能写回旧SQLite')
      }
    }
  } catch (error) { caseError = error; throw error }
  finally {
    try {
      cleanupDiagnostic?.('outer-source-destroy-start')
      if (!sourceClosed && source.isInitialized) await source.destroy()
      cleanupDiagnostic?.('outer-source-destroy-end')
      if (!retainIsolationForDiagnostic) {
        await owned.cleanup(); cleanupDiagnostic?.('owned-mysql-cleaned')
        isolation.cleanup(); cleanupDiagnostic?.('owned-isolation-cleaned')
      } else console.error('迁移执行体未能收口，保留本轮独占SQLite现场；父fixture按标签清理自有MySQL容器，不清理其他目录')
    } catch (error) {
      cleanupDiagnostic?.('outer-cleanup-error', error)
      if (caseError) throw new AggregateError([caseError, error], '主验证失败及资源清理错误均保留，不能用清理错误覆盖主异常')
      throw error
    }
  }
}
