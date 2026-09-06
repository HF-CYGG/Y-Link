/** 冻结后复检允许有确切归属的中断目标，绝不允许清理其他任务或未知结构。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-migration-resume-'))
process.env.Y_LINK_DATA_DIR = root
process.env.DB_TYPE = 'sqlite'
process.env.SQLITE_DB_PATH = path.join(root, 'fixture.sqlite')
const { DatabaseMigrationService } = await import('../src/services/database-migration.service.js')
const service = new DatabaseMigrationService() as unknown as {
  createMysqlDataSource: () => unknown
  inspectMySqlSchemaCharset: () => Promise<unknown>
  listExistingTableNames: () => Promise<string[]>
  verifyMySqlAutomaticPermissions: () => Promise<void>
  assertAutomaticTargetReady: (target: unknown, resume?: { taskId: string; expectedTableNames: string[] }) => Promise<void>
}
let tables = ['_y_link_migration_owner', 'fixture']
let owners = [{ taskId: 'task-current' }]
let version = '8.4.10'
let charset = 'utf8mb4'
let permissionChecks = 0
let destroyed = 0
const queries: string[] = []
service.createMysqlDataSource = () => ({
  isInitialized: true,
  initialize: async () => undefined,
  destroy: async () => { destroyed += 1 },
  query: async (sql: string) => {
    queries.push(sql)
    if (sql.includes('VERSION()')) return [{ version }]
    if (sql.includes('task_id')) return owners
    throw new Error(`非预期查询：${sql}`)
  },
})
service.inspectMySqlSchemaCharset = async () => ({ databaseExists: true, defaultCharset: charset })
service.listExistingTableNames = async () => tables
service.verifyMySqlAutomaticPermissions = async () => { permissionChecks += 1 }
const resume = { taskId: 'task-current', expectedTableNames: ['fixture'] }
await service.assertAutomaticTargetReady({}, resume)
assert.equal(permissionChecks, 1, '续跑仍须复检权限')
await assert.rejects(service.assertAutomaticTargetReady({}), /独立空库/)
owners = [{ taskId: 'task-other' }]
await assert.rejects(service.assertAutomaticTargetReady({}, resume), /所有权|其他|占用/)
owners = [{ taskId: 'task-current' }, { taskId: 'task-other' }]
await assert.rejects(service.assertAutomaticTargetReady({}, resume), /所有权|其他|占用/)
owners = [{ taskId: 'task-current' }]
tables.push('unrelated_data')
await assert.rejects(service.assertAutomaticTargetReady({}, resume), /非本任务/)
tables = ['fixture']
await assert.rejects(service.assertAutomaticTargetReady({}, resume), /所有权/)
tables = ['_y_link_migration_owner', 'fixture']
version = '8.0.15'
await assert.rejects(service.assertAutomaticTargetReady({}, resume), /8.0.16/)
version = '8.4.10'
charset = 'latin1'
await assert.rejects(service.assertAutomaticTargetReady({}, resume), /utf8mb4/)
charset = 'utf8mb4'
tables = []
await service.assertAutomaticTargetReady({}, resume)
assert.equal(permissionChecks, 2)
assert.equal(destroyed, 9, '每个失败路径均须释放连接')
assert.ok(queries.every(sql => /^SELECT /i.test(sql)), '所有权复检不能执行数据清理')
console.log('[migration-resume] 冻结后复检、归属隔离、未知表拒绝及失败释放通过')
