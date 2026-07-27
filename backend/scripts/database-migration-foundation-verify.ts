/**
 * 模块说明：backend/scripts/database-migration-foundation-verify.ts
 * 文件职责：验证自动数据库迁移依赖的持久化目录、只读维护状态与写请求门禁契约。
 * 实现逻辑：
 * - 使用临时目录隔离真实运行数据，避免验证脚本接触生产任务或数据库凭据；
 * - 覆盖维护状态的原子落盘、进程重建恢复、公开状态脱敏和维护结束清理；
 * - 覆盖查询放行、普通写请求阻断、紧急回退放行等全局门禁规则。
 * 维护说明：
 * - 本脚本是轻量基础契约验证，不替代真实 MySQL + onebox 的完整迁移验收；
 * - 新增维护状态字段或例外接口时，必须同步补充断言，禁止扩大匿名写入面。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveAppDataPaths } from '../src/config/app-data-paths.js'
import {
  DatabaseMaintenanceModeService,
  MAINTENANCE_READ_ONLY_CODE,
  MAINTENANCE_READ_ONLY_MESSAGE,
  shouldAllowWriteDuringDatabaseMaintenance,
} from '../src/services/database-maintenance-mode.service.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'y-link-db-migration-foundation-'))

try {
  const backendIndexSource = fs.readFileSync(path.resolve(import.meta.dirname, '../src/index.ts'), 'utf8')
  const resumeCallIndex = backendIndexSource.indexOf(
    'databaseMigrationService.resumeInterruptedAutomaticMigrationAfterStartup()',
  )
  const resumeChainSource = backendIndexSource.slice(resumeCallIndex, resumeCallIndex + 1_500)
  const catchIndex = resumeChainSource.indexOf('.catch(')
  const finallyIndex = resumeChainSource.indexOf('.finally(')
  const readOnlyGuardIndex = resumeChainSource.indexOf(
    'if (!databaseMaintenanceModeService.isReadOnly())',
  )
  const timeoutRecycleStartIndex = resumeChainSource.indexOf(
    'o2oPreorderService.startTimeoutRecycleLoop()',
  )
  assert.ok(resumeCallIndex >= 0, '启动入口必须恢复意外中断的自动迁移任务')
  assert.ok(catchIndex >= 0, '自动迁移恢复异常必须记录并收敛')
  assert.ok(finallyIndex > catchIndex, '自动迁移恢复成功或失败后都必须进入统一后台任务恢复分支')
  assert.ok(
    readOnlyGuardIndex > finallyIndex,
    '后台任务恢复必须在 finally 中复核数据库只读维护状态',
  )
  assert.ok(
    timeoutRecycleStartIndex > readOnlyGuardIndex,
    '非只读状态下必须在统一恢复分支启动 O2O 超时回收',
  )

  const paths = resolveAppDataPaths(tempRoot)
  assert.equal(paths.rootDir, path.resolve(tempRoot))
  assert.equal(paths.databaseMigrationDir, path.join(path.resolve(tempRoot), 'database-migration'))
  assert.equal(paths.runtimeDir, path.join(path.resolve(tempRoot), 'runtime'))
  assert.equal(paths.maintenanceStateFile, path.join(path.resolve(tempRoot), 'runtime', 'maintenance-state.json'))

  const service = new DatabaseMaintenanceModeService({
    stateFilePath: paths.maintenanceStateFile,
  })
  assert.deepEqual(service.getPublicState(), {
    readOnly: false,
    phase: null,
    message: null,
  })

  const releaseInFlightActivity = service.registerInFlightWrite()
  assert.ok(releaseInFlightActivity, '维护开始前必须能够获取数据库活动租约')
  let drainCompleted = false
  const beginReadOnlyPromise = service.beginReadOnly({
    taskId: 'automatic-task-secret-id',
    phase: 'draining_writes',
  }).then(() => {
    drainCompleted = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(service.isReadOnly(), true)
  assert.equal(drainCompleted, false, '只读冻结不得越过已获取的数据库活动租约')
  assert.equal(service.registerInFlightWrite(), null, '冻结后不得再获取数据库写活动租约')
  releaseInFlightActivity()
  await beginReadOnlyPromise
  assert.equal(drainCompleted, true)
  assert.equal(service.isReadOnly(), true)
  assert.deepEqual(service.getPublicState(), {
    readOnly: true,
    phase: 'draining_writes',
    message: MAINTENANCE_READ_ONLY_MESSAGE,
  })

  const persistedState = fs.readFileSync(paths.maintenanceStateFile, 'utf8')
  assert.match(persistedState, /automatic-task-secret-id/)
  assert.doesNotMatch(persistedState, /password|DB_PASSWORD|mysql:\/\/|sqlitePath/i)

  const restoredService = new DatabaseMaintenanceModeService({
    stateFilePath: paths.maintenanceStateFile,
  })
  assert.equal(restoredService.isReadOnly(), true)
  assert.equal(restoredService.getPublicState().phase, 'draining_writes')

  await restoredService.updatePhase('snapshotting')
  assert.equal(restoredService.getPublicState().phase, 'snapshotting')

  assert.equal(shouldAllowWriteDuringDatabaseMaintenance('GET', '/api/products'), true)
  assert.equal(shouldAllowWriteDuringDatabaseMaintenance('POST', '/api/products'), false)
  assert.equal(
    shouldAllowWriteDuringDatabaseMaintenance('POST', '/api/data-maintenance/db-migration/rollback'),
    true,
  )
  assert.equal(
    shouldAllowWriteDuringDatabaseMaintenance('DELETE', '/api/data-maintenance/db-migration/runtime-override'),
    true,
  )
  assert.equal(
    shouldAllowWriteDuringDatabaseMaintenance('POST', '/api/data-maintenance/db-migration/automatic-tasks'),
    false,
  )

  assert.equal(MAINTENANCE_READ_ONLY_CODE, 50301)
  assert.equal(MAINTENANCE_READ_ONLY_MESSAGE, '服务器维护中，当前为只读状态，暂时无法提交操作')

  await restoredService.finishReadOnly()
  assert.equal(restoredService.isReadOnly(), false)
  assert.equal(fs.existsSync(paths.maintenanceStateFile), false)

  const blockedStatePath = path.join(tempRoot, 'blocked-maintenance-state')
  fs.mkdirSync(blockedStatePath)
  const failedPersistService = new DatabaseMaintenanceModeService({
    stateFilePath: blockedStatePath,
  })
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    await assert.rejects(
      failedPersistService.beginReadOnly({
        taskId: 'persist-failure-task',
        phase: 'draining_writes',
      }),
    )
  } finally {
    console.error = originalConsoleError
  }
  assert.equal(
    failedPersistService.isReadOnly(),
    false,
    '维护状态持久化失败后必须同步回滚进程内只读状态',
  )

  console.log('database migration foundation verify: passed')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
