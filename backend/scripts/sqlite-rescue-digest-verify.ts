/** 独立只读摘要回归：完整文本、结构、自增与唯一预期终态审计均需精确核对。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sqlite3 from 'sqlite3'
import { inspectSqliteForRescue } from '../src/runtime/sqlite-rescue-inspection.js'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-rescue-digest-'))
const file = path.join(directory, 'source.sqlite')
const db = await new Promise<sqlite3.Database>((resolve, reject) => {
  const connection = new sqlite3.Database(file, (error) => error ? reject(error) : resolve(connection))
})
const exec = (sql: string) => new Promise<void>((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()))
const run = (sql: string, values: unknown[]) => new Promise<void>((resolve, reject) => db.run(sql, values, (error) => error ? reject(error) : resolve()))
try {
  await exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)')
  await run('INSERT INTO fixture(value) VALUES (?)', ['文本\0甲'])
  const first = await inspectSqliteForRescue(file)
  await run('UPDATE fixture SET value = ?', ['文本\0乙'])
  assert.notEqual((await inspectSqliteForRescue(file)).sha256, first.sha256, 'NUL 后的文本变化必须影响摘要')
  const beforeIndex = await inspectSqliteForRescue(file)
  await exec('CREATE UNIQUE INDEX idx_fixture_value ON fixture(value)')
  assert.notEqual((await inspectSqliteForRescue(file)).sha256, beforeIndex.sha256, '约束与索引变化必须影响摘要')
  await exec(`CREATE TABLE sys_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action_type TEXT, action_label TEXT, actor_user_id INTEGER,
    actor_username TEXT, actor_display_name TEXT, target_type TEXT, target_id TEXT, target_code TEXT,
    result_status TEXT, detail_json TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT)`)
  const baseline = await inspectSqliteForRescue(file)
  const taskId = 'fixture_task'
  const detail = JSON.stringify({ mysqlStartupAttempts: 2, taskStatePersisted: true,
    message: '管理员已取消自动迁移，原 SQLite 已恢复并完成启动自检' })
  await run(`INSERT INTO sys_audit_log(action_type,action_label,actor_username,actor_display_name,target_type,
    target_id,target_code,result_status,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, [
    'database_migration.automatic_rolled_back', 'SQLite 一键自动迁移已紧急回退', 'system', '数据库自动迁移程序',
    'database_migration', taskId, taskId, 'failed', detail, new Date().toISOString(),
  ])
  assert.equal((await inspectSqliteForRescue(file, { taskId, baseline })).sha256, baseline.sha256,
    '仅有一条精确终态审计时可重入，无历史审计行也需正确处理自增序列')
  await run('UPDATE sys_audit_log SET action_label = ?', ['异常动作'])
  await assert.rejects(inspectSqliteForRescue(file, { taskId, baseline }), /RESCUE_UNEXPECTED_AUDIT_INCREMENT/)
  await run('UPDATE sys_audit_log SET action_label = ?', ['SQLite 一键自动迁移已紧急回退'])
  await run('INSERT INTO fixture(value) VALUES (?)', ['新增业务写'])
  assert.notEqual((await inspectSqliteForRescue(file, { taskId, baseline })).sha256, baseline.sha256)
  console.log('[sqlite-rescue-digest] NUL 文本、结构、自增、空审计基线及精确审计增量通过')
} finally {
  await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()))
}
