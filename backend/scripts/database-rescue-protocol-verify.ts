/** 隔离 SQLite 恢复日志故障注入：每次子进程使用独立目录，无业务模块/生产文件访问。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeControlFile } from '../src/runtime/durable-control-file.js'

const step = process.argv[2]
if (!step) {
  for (const scenario of ['PREPARED', 'TASK_CANCELLED', 'SQLITE_OVERRIDE', 'ROLLBACK_MARKER', 'RESTART_READY', 'cancel_write', 'normal', 'finalization']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), scenario], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    assert.equal(result.status, 0, `${scenario}: ${result.stderr || result.stdout}`)
  }
  console.log('[database-rescue-protocol] 5 个持久化中断点、凭证/nonce/幂等、源完整性与跨任务边界通过')
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-rescue-protocol-'))
  process.env.Y_LINK_DATA_DIR = directory
  process.env.APP_PROFILE = 'verify-db-migration'
  process.env.Y_LINK_DB_MIGRATION_E2E = 'true'
  if (step === 'cancel_write') process.env.Y_LINK_DB_MIGRATION_E2E_FAIL_CANCEL_TASK_WRITE = 'true'
  const { appDataPaths } = await import('../src/config/app-data-paths.js')
  const control = await import('../src/runtime/database-rescue-control.js')
  const { inspectDatabaseRuntimeOverride } = await import('../src/config/database-runtime-override.js')
  const sqlite = (await import('sqlite3')).default
  const source = path.join(directory, 'source.sqlite')
  const snapshot = path.join(appDataPaths.migrationSnapshotDir, 'fixture.sqlite')
  fs.mkdirSync(appDataPaths.migrationSnapshotDir, { recursive: true })
  const db = await new Promise<InstanceType<typeof sqlite.Database>>((resolve, reject) => {
    const connection = new sqlite.Database(source, (error) => error ? reject(error) : resolve(connection))
  })
  const run = (sql: string) => new Promise<void>((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()))
  await run(`CREATE TABLE fixture (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT); INSERT INTO fixture (content) VALUES ('稳定基线'); VACUUM INTO '${snapshot.replaceAll("'", "''")}'`)
  await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()))
  const taskId = 'fixture_task'
  const timestamp = new Date().toISOString()
  writeControlFile(path.join(appDataPaths.migrationTaskDir, `${taskId}.json`), {
    id: taskId, mode: 'automatic', status: 'restart_pending', source: { sqlitePath: source }, progress: { currentStage: '测试', tableResults: [] },
  })
  writeControlFile(appDataPaths.maintenanceStateFile, { version: 1, taskId, readOnly: true, phase: 'verifying', message: '维护', startedAt: timestamp, updatedAt: timestamp })
  writeControlFile(appDataPaths.migrationLockFile, { version: 1, taskId, acquiredAt: timestamp, pid: process.pid })
  fs.writeFileSync(appDataPaths.migrationCutoverFile, '{broken-marker')
  const credential = control.issueDatabaseRescueCredential(taskId)
  assert.equal(control.authenticateDatabaseRescueCredential(credential.credential), taskId)
  assert.throws(() => control.authenticateDatabaseRescueCredential(`${credential.credential}x`))
  const credentialFile = fs.readFileSync(path.join(appDataPaths.runtimeDir, 'database-rescue', `${taskId}.json`), 'utf8')
  assert.ok(!credentialFile.includes(credential.credential), '磁盘只能保存凭证散列')
  const snapshotBinding = control.bindDatabaseRescueSnapshot(taskId, snapshot)
  const rotatedCredential = control.issueDatabaseRescueCredential(taskId)
  await snapshotBinding
  assert.equal(control.authenticateDatabaseRescueCredential(rotatedCredential.credential), taskId,
    '快照异步绑定不能覆盖已轮换的凭证')
  assert.throws(() => control.authenticateDatabaseRescueCredential(credential.credential), /RESCUE_UNAUTHORIZED/,
    '旧凭证不能因其他控制文件更新而复活')
  const authorityPath = path.join(appDataPaths.runtimeDir, 'database-rescue', `${taskId}.credential.json`)
  const authority = fs.readFileSync(authorityPath, 'utf8')
  for (const invalid of ['missing', 'corrupted', 'expired', 'wrong_task']) {
    if (invalid === 'missing') fs.unlinkSync(authorityPath)
    else if (invalid === 'corrupted') fs.writeFileSync(authorityPath, '{')
    else writeControlFile(authorityPath, { ...JSON.parse(authority), ...(invalid === 'expired'
      ? { expiresAt: '2000-01-01T00:00:00.000Z' } : { taskId: 'another_task' }) })
    assert.throws(() => control.authenticateDatabaseRescueCredential(rotatedCredential.credential), /RESCUE_UNAUTHORIZED/)
    assert.throws(() => control.authenticateDatabaseRescueCredential(credential.credential), /RESCUE_UNAUTHORIZED/)
    fs.writeFileSync(authorityPath, authority)
  }
  assert.deepEqual(control.databaseRescueStatus(taskId).allowedActions, ['prepare_rollback'])
  const validLock = fs.readFileSync(appDataPaths.migrationLockFile, 'utf8')
  writeControlFile(appDataPaths.migrationLockFile, { version: 2, taskId })
  assert.deepEqual(control.databaseRescueStatus(taskId).allowedActions, [])
  assert.throws(() => control.prepareDatabaseRescueRollback(taskId), /RESCUE_CONTROL_OWNERSHIP_UNPROVEN/)
  fs.writeFileSync(appDataPaths.migrationLockFile, validLock)
  const { nonce } = control.prepareDatabaseRescueRollback(taskId)
  await assert.rejects(control.beginDatabaseRescueRollback(taskId, 'wrong', 'operation_test_123456'))
  if (!['normal', 'finalization'].includes(step)) process.env.Y_LINK_RESCUE_TEST_INTERRUPT_AFTER = step
  if (['normal', 'finalization'].includes(step)) await control.beginDatabaseRescueRollback(taskId, nonce, 'operation_test_123456')
  else await assert.rejects(control.beginDatabaseRescueRollback(taskId, nonce, 'operation_test_123456'))
  assert.equal(control.hasPendingRecoveryIntent(), true)
  delete process.env.Y_LINK_RESCUE_TEST_INTERRUPT_AFTER
  await control.replayDatabaseRecoveryIntent()
  const override = inspectDatabaseRuntimeOverride()
  assert.ok(override.state === 'healthy' && override.value.config.DB_TYPE === 'sqlite' && override.value.config.SQLITE_DB_PATH === source)
  const replay = await control.beginDatabaseRescueRollback(taskId, 'consumed', 'operation_test_123456')
  assert.equal(replay.phase, 'RESTART_READY')
  await assert.rejects(control.beginDatabaseRescueRollback('different_task', nonce, 'operation_test_123456'))
  await assert.rejects(control.beginDatabaseRescueRollback(taskId, nonce, 'another_operation_123456'))
  const startup = await control.prepareRecoveryStartup()
  assert.equal(startup?.phase, 'VERIFYING')
  assert.equal(startup?.sqliteRestartAttempts, 1)
  if (step === 'finalization') {
    const taskFile = path.join(appDataPaths.migrationTaskDir, `${taskId}.json`)
    const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'))
    writeControlFile(taskFile, { ...task, status: 'rolled_back' })
    fs.unlinkSync(appDataPaths.migrationLockFile)
    control.markRecoveryFinalizing(taskId)
    fs.unlinkSync(appDataPaths.migrationCutoverFile)
    const resumed = await control.prepareRecoveryStartup()
    assert.equal(resumed?.phase, 'FINALIZING')
    assert.equal(resumed?.sqliteRestartAttempts, 1, '收尾重放不消耗 SQLite 失败重试次数')
    assert.equal(JSON.parse(fs.readFileSync(taskFile, 'utf8')).status, 'rolled_back')
    assert.ok(fs.existsSync(appDataPaths.migrationCutoverFile), '维护尚未解除时可重建本任务 marker')
    control.completeRecoveryIntent(taskId)
    fs.unlinkSync(appDataPaths.migrationCutoverFile)
    const { inspectDatabaseStartup } = await import('../src/runtime/database-startup-preflight.js')
    assert.deepEqual(await inspectDatabaseStartup(), { mode: 'cutover', taskId })
    assert.ok(fs.existsSync(appDataPaths.migrationCutoverFile))
    console.log('[database-rescue-protocol] 最终审计后、marker 清理后与维护解除前的收尾重放通过')
    process.exit(0)
  }
  const secondStartup = await control.prepareRecoveryStartup()
  assert.equal(secondStartup?.sqliteRestartAttempts, 2)
  await assert.rejects(control.prepareRecoveryStartup(), /RESCUE_RESTART_LIMIT/)
  console.log(`[database-rescue-protocol] ${step} 通过`)
}
