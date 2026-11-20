/** 冻结后复检允许有确切归属的中断目标，绝不允许清理其他任务或未知结构。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createVerificationIsolation } from './verification-isolation.js'

const isolation = createVerificationIsolation('migration-resume')
isolation.seal({ type: 'sqlite', database: path.join(isolation.rootDir, 'fixture.sqlite') })
process.env.Y_LINK_AUTOMATIC_DB_MIGRATION_ENABLED = 'true'
const { DatabaseMigrationService, databaseMigrationService } = await import('../src/services/database-migration.service.js')
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

// 认领失败任务遗留表时，清理途中断连不得留下无主表：标记须先转交给本任务，清理期间始终保留。
const reclaimService = service as unknown as {
  listExistingTableNames: () => Promise<string[]>
  resolveReclaimableFailedAutomaticTarget: () => Promise<string | null>
  prepareOwnedAutomaticTarget: (
    dataSource: unknown,
    target: unknown,
    taskId: string,
    retrying: boolean,
    expectedTableNames: string[],
  ) => Promise<string | null>
}
const ownerTable = '_y_link_migration_owner'
let reclaimTables = [ownerTable, 'biz_a', 'biz_b']
let reclaimOwners = [{ taskId: 'task-old' }]
let failDropOf: string | null = 'biz_b'
const reclaimQuery = async (sql: string, params: unknown[] = []) => {
  if (sql.startsWith('UPDATE')) {
    reclaimOwners = reclaimOwners.map((row) => (row.taskId === params[2] ? { taskId: String(params[0]) } : row))
    return { affectedRows: 1 }
  }
  if (sql.includes('task_id')) return reclaimOwners
  const dropMatch = /^DROP TABLE `([^`]+)`$/.exec(sql)
  if (dropMatch) {
    if (dropMatch[1] === failDropOf) throw new Error('模拟清理途中断连')
    reclaimTables = reclaimTables.filter((name) => name !== dropMatch[1])
    return []
  }
  if (sql.startsWith('SET FOREIGN_KEY_CHECKS')) return []
  throw new Error(`非预期查询：${sql}`)
}
const reclaimDataSource = {
  query: reclaimQuery,
  createQueryRunner: () => ({ connect: async () => undefined, query: reclaimQuery, release: async () => undefined }),
}
reclaimService.listExistingTableNames = async () => [...reclaimTables]
reclaimService.resolveReclaimableFailedAutomaticTarget = async () => (
  reclaimOwners.length === 1 && reclaimOwners[0]?.taskId === 'task-old' ? 'task-old' : null
)
await assert.rejects(
  reclaimService.prepareOwnedAutomaticTarget(reclaimDataSource, {}, 'task-new', false, ['biz_a', 'biz_b']),
  /模拟清理途中断连/,
)
assert.ok(reclaimTables.includes(ownerTable), '认领清理中断后必须保留所有权标记')
assert.deepEqual(reclaimOwners, [{ taskId: 'task-new' }], '清理业务表前所有权标记必须已转交给当前任务')
failDropOf = null
assert.equal(
  await reclaimService.prepareOwnedAutomaticTarget(reclaimDataSource, {}, 'task-new', true, ['biz_a', 'biz_b']),
  null,
)
assert.deepEqual(reclaimTables, [ownerTable], '当前任务续跑应清完剩余遗留表并保留自身标记')
console.log('[migration-resume] 冻结后复检、归属隔离、未知表拒绝、失败释放及遗留表认领中断续跑通过')

// 用真实 HTTP 准入、SQLite 与任务文件复现 202 后自动执行和手动控制交错。
const [{ AppDataSource: source }, { appDataPaths }, { databaseOperationGate: gate }, { databaseMaintenanceModeService: maintenance },
  { SysUser }, { SysUserSession }, { hashSessionToken }, { createApp }, { o2oPreorderService }] = await Promise.all([
  import('../src/config/data-source.js'), import('../src/config/app-data-paths.js'), import('../src/database/operation-gate.js'),
  import('../src/services/database-maintenance-mode.service.js'), import('../src/entities/sys-user.entity.js'),
  import('../src/entities/sys-user-session.entity.js'), import('../src/utils/session-token.js'), import('../src/app.js'),
  import('../src/services/o2o-preorder.service.js'),
])
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(ok => { resolve = ok }); return { promise, resolve } }
const waitForBarrier = async (promise: Promise<void>, label: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`等待${label}超时`)), 15_000) })])
  } finally { if (timer) clearTimeout(timer) }
}
const manualEntered = deferred(), releaseManual = deferred(), scheduled = deferred(), startAutomatic = deferred(), automaticStarted = deferred()
const migration = databaseMigrationService
const internal = migration as unknown as {
  acquireAutomaticMigrationLock(taskId: string): Promise<void>
  assertAutomaticTargetReady(input: unknown): Promise<void>
  buildPrecheck(input: unknown): Promise<{ canProceed: boolean }>
}
const acquire = internal.acquireAutomaticMigrationLock
const assertTargetReady = internal.assertAutomaticTargetReady
const buildPrecheck = internal.buildPrecheck
const runAutomatic = migration.runAutomaticSQLiteToMySqlTask
const beginReadOnly = maintenance.beginReadOnly
const blockedManualTaskId = 'manual-execution-overlaps-auto-dispatch'
const fixtureFailure = '隔离验收：自动任务已通过排空，并在冻结后复检遇到模拟目标故障'
let scheduledRun: Promise<void> | undefined
let manualResponse: ReturnType<typeof fetch> | undefined
let automaticTaskId: string | undefined
let drainedTaskId: string | undefined
let starts = 0
let requestsAtFirstDispatch: number | undefined
let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
try {
  await isolation.assertTarget(source)
  await source.initialize()
  await (await import('../src/database/database-strategy.js')).initializeDatabaseInfrastructure(source)
  await source.synchronize()
  const admin = await source.getRepository(SysUser).save({ username: 'resume_admin', displayName: '隔离迁移管理员', role: 'admin', status: 'enabled', passwordHash: 'fixture-only' })
  const token = randomBytes(32).toString('hex')
  await source.getRepository(SysUserSession).save({ userId: admin.id, sessionToken: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastAccessAt: new Date() })
  const actor = { userId: admin.id, username: admin.username, displayName: admin.displayName, role: 'admin' as const,
    status: 'enabled' as const, authSource: 'bearer' as const, sessionToken: token, permissions: [] }

  internal.acquireAutomaticMigrationLock = async function (taskId) {
    if (taskId === blockedManualTaskId) { manualEntered.resolve(); await releaseManual.promise }
    await acquire.call(this, taskId)
  }
  migration.runAutomaticSQLiteToMySqlTask = function (...args) {
    requestsAtFirstDispatch = gate.snapshot().activeOperations
    scheduledRun = (async () => {
      await startAutomatic.promise
      automaticStarted.resolve()
      return runAutomatic.apply(this, args)
    })()
    scheduled.resolve()
    return scheduledRun
  }
  maintenance.beginReadOnly = async function (input) {
    await beginReadOnly.call(this, input)
    const { mode, activeOperations } = gate.snapshot()
    assert.equal(mode, 'frozen')
    assert.equal(activeOperations, 0, '取得治理租约前必须排空所有在途操作')
    drainedTaskId = input.taskId
  }
  internal.assertAutomaticTargetReady = async () => {
    // 没有网络连接：只在真实维护屏障排空后注入目标失败，保留终态与资源收口路径。
    if (!maintenance.isReadOnly()) { starts++; return }
    assert.equal(drainedTaskId, automaticTaskId)
    assert.equal(maintenance.getActiveTaskId(), automaticTaskId)
    assert.equal(gate.snapshot().activeOperations, 1, '冻结复检期间只允许当前任务的一项治理租约')
    throw new Error(fixtureFailure)
  }
  internal.buildPrecheck = async () => ({ ...(await migration.getSQLiteToMySqlTask(automaticTaskId!)).precheck, canProceed: true })

  server = createApp().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const post = (suffix: string, body: unknown = {}) => fetch(`http://127.0.0.1:${address.port}/api/data-maintenance/db-migration/${suffix}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  const target = { host: '127.0.0.1', port: 1, user: 'fixture', password: randomBytes(24).toString('hex'), database: 'queued_fixture' }
  const accepted = await post('automatic-tasks', { target })
  assert.equal(accepted.status, 202)
  const result = await accepted.json() as { data: { id: string; status: string } }
  automaticTaskId = result.data.id
  assert.equal(result.data.status, 'queued')
  await waitForBarrier(scheduled.promise, '202 后台调度')
  assert.equal(requestsAtFirstDispatch, 0, '自动调度前必须释放整个 202 HTTP operation 租约')

  manualResponse = post(`tasks/${blockedManualTaskId}/run`)
  await waitForBarrier(manualEntered.promise, '手动请求占有门禁')
  startAutomatic.resolve()
  await waitForBarrier(automaticStarted.promise, '自动任务接续门禁')
  const competing = await post(`tasks/${blockedManualTaskId}/run`)
  assert.equal(competing.status, 409, '新的 HTTP 迁移入口不得排队插入')
  assert.match((await competing.json() as { message: string }).message, /已有迁移控制操作/)
  assert.equal((await migration.getSQLiteToMySqlTask(automaticTaskId)).status, 'queued')
  assert.equal(starts, 0, '前一个手动控制操作退出前不能执行自动任务')
  releaseManual.resolve()
  assert.equal((await manualResponse).status, 409, '已有持久自动任务时手动请求不能进入迁移')
  await assert.rejects(scheduledRun!, new RegExp(fixtureFailure))
  assert.equal(starts, 1)
  const failed = await migration.getSQLiteToMySqlTask(automaticTaskId)
  assert.equal(failed.status, 'failed')
  assert.ok(failed.finishedAt)
  assert.equal(fs.existsSync(appDataPaths.migrationLockFile), false)
  assert.equal(maintenance.isReadOnly(), false)
  assert.equal(gate.snapshot().activeOperations, 0)

  const previousTaskId = automaticTaskId
  const queuedAfterRestart = await migration.createAutomaticSQLiteToMySqlTask({ target }, actor)
  automaticTaskId = queuedAfterRestart.id
  await assert.rejects(runAutomatic.call(migration, previousTaskId, actor), /同任务持久所有权/)
  assert.equal((await migration.getSQLiteToMySqlTask(automaticTaskId)).status, 'queued')
  assert.equal(JSON.parse(fs.readFileSync(appDataPaths.migrationLockFile, 'utf8')).taskId, automaticTaskId)
  scheduledRun = undefined
  assert.equal(await migration.resumeInterruptedAutomaticMigrationAfterStartup(), automaticTaskId)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(scheduledRun, '启动恢复必须调度持久 queued 任务')
  await assert.rejects(scheduledRun, new RegExp(fixtureFailure))
  assert.equal(starts, 2)
  assert.equal((await migration.getSQLiteToMySqlTask(automaticTaskId)).status, 'failed')
  assert.equal(fs.existsSync(appDataPaths.migrationLockFile), false)
  assert.equal(maintenance.isReadOnly(), false)
  assert.equal(gate.snapshot().activeOperations, 0)
  console.log('[migration-resume] 202 后任务接续、手动争用、旧任务隔离、启动调度及故障清理通过')
} finally {
  startAutomatic.resolve(); releaseManual.resolve()
  if (manualResponse) await Promise.allSettled([manualResponse])
  if (scheduledRun) await Promise.allSettled([scheduledRun])
  maintenance.beginReadOnly = beginReadOnly
  migration.runAutomaticSQLiteToMySqlTask = runAutomatic
  internal.acquireAutomaticMigrationLock = acquire
  internal.assertAutomaticTargetReady = assertTargetReady
  internal.buildPrecheck = buildPrecheck
  try {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
  } finally {
    try {
      // 自动迁移失败收尾会恢复回收循环，先停止定时器并等正在回收的工作退出。
      await o2oPreorderService.stopTimeoutRecycleLoop()
    } finally {
      if (source.isInitialized) await source.destroy()
      isolation.cleanup()
    }
  }
}
