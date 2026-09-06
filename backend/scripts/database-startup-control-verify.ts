/** 启动前控制文件语义损坏必须拒绝业务装载，终态收尾也必须验证真实目标归属。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.Y_LINK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-startup-control-'))
const { appDataPaths: paths } = await import('../src/config/app-data-paths.js')
const { writeControlFile, removeControlFile } = await import('../src/runtime/durable-control-file.js')
const { inspectDatabaseStartup } = await import('../src/runtime/database-startup-preflight.js')
const timestamp = new Date().toISOString()
const taskId = 'fixture_task'
const taskFile = path.join(paths.migrationTaskDir, `${taskId}.json`)
const source = path.join(paths.rootDir, 'source.sqlite')
const target = { host: 'mysql-test', port: 3306, user: 'fixture', database: 'fixture' }
const task = { id: taskId, mode: 'automatic', status: 'running', source: { sqlitePath: source }, target }
const lock = { version: 1, taskId, acquiredAt: timestamp, pid: 123 }
const maintenance = { version: 1, taskId, readOnly: true, phase: 'verifying', message: '维护', startedAt: timestamp, updatedAt: timestamp }
const marker = { version: 1, taskId, sourceSqlitePath: source, attempts: 0, status: 'verifying', createdAt: timestamp, lastError: null }
assert.deepEqual(await inspectDatabaseStartup(), { mode: 'normal' })
writeControlFile(taskFile, task)
writeControlFile(paths.migrationLockFile, lock)
writeControlFile(paths.maintenanceStateFile, maintenance)
assert.deepEqual(await inspectDatabaseStartup(), { mode: 'resume', taskId })
for (const [file, valid, invalid] of [
  [paths.migrationLockFile, lock, { ...lock, version: 2 }],
  [paths.migrationLockFile, lock, { ...lock, acquiredAt: 'invalid' }],
  [paths.maintenanceStateFile, maintenance, { ...maintenance, phase: null }],
  [paths.maintenanceStateFile, maintenance, { ...maintenance, updatedAt: 'invalid' }],
  [paths.migrationCutoverFile, marker, { ...marker, attempts: undefined }],
  [paths.migrationCutoverFile, marker, { ...marker, createdAt: 'invalid' }],
] as const) {
  writeControlFile(file, invalid)
  await assert.rejects(inspectDatabaseStartup(), /DATABASE_CONTROL_CORRUPTED/)
  writeControlFile(file, valid)
  if (file === paths.migrationCutoverFile) removeControlFile(file)
}
writeControlFile(taskFile, { ...task, status: 'unknown_future_state' })
await assert.rejects(inspectDatabaseStartup(), /DATABASE_TASK_UNAVAILABLE/)
writeControlFile(taskFile, { ...task, status: 'succeeded' })
removeControlFile(paths.migrationLockFile)
const override = { version: 1, updatedAt: timestamp, sourceTaskId: taskId, config: {
  DB_TYPE: 'mysql', DB_HOST: target.host, DB_PORT: target.port, DB_USER: target.user,
  DB_PASSWORD: '', DB_NAME: 'another_database', DB_SYNC: false,
} }
writeControlFile(paths.runtimeOverrideFile, override)
await assert.rejects(inspectDatabaseStartup(), /DATABASE_CONTROL_MISMATCH/)
assert.equal(fs.existsSync(paths.migrationCutoverFile), false, '归属不匹配不能重建 marker')
writeControlFile(paths.runtimeOverrideFile, { ...override, config: { ...override.config, DB_NAME: target.database } })
assert.deepEqual(await inspectDatabaseStartup(), { mode: 'cutover', taskId })
assert.equal(fs.existsSync(source), false, '控制检查从不创建业务 SQLite')
console.log('[startup-control] 损坏字段、未知任务状态及终态目标归属检查通过')
