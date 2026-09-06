/** 数据库模块加载前只检查控制文件；任何无法判定的中间态都留在救援，不执行 schema/bootstrap。 */
import path from 'node:path'
import { appDataPaths } from '../config/app-data-paths.js'
import { inspectDatabaseRuntimeOverride, type DatabaseRuntimeOverrideConfig } from '../config/database-runtime-override.js'
import { inspectControlFile, writeControlFile } from './durable-control-file.js'
import { inspectRecoveryIntent, prepareRecoveryStartup } from './database-rescue-control.js'
import { validateCutoverControl, validateMigrationLock, validateMaintenanceControl } from './database-control-validation.js'

const object = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : null
function mysqlTargetMatches(task: Record<string, unknown>, config: DatabaseRuntimeOverrideConfig): boolean {
  const target = object(task.target)
  return !!target && target.host === config.DB_HOST && target.user === config.DB_USER
    && target.database === config.DB_NAME && Number(target.port) === config.DB_PORT
}
export async function inspectDatabaseStartup(): Promise<{ mode: 'normal' | 'cutover' | 'resume'; taskId?: string }> {
  const intent = inspectRecoveryIntent()
  if (intent.state === 'corrupted') throw new Error('RESCUE_INTENT_CORRUPTED')
  if (intent.state === 'healthy' && intent.value.phase !== 'COMPLETED') {
    const recovery = await prepareRecoveryStartup()
    return { mode: 'cutover', taskId: recovery!.taskId }
  }
  const override = inspectDatabaseRuntimeOverride()
  if (override.state === 'corrupted') throw new Error('DATABASE_OVERRIDE_CORRUPTED')
  const marker = inspectControlFile(appDataPaths.migrationCutoverFile, validateCutoverControl)
  const lock = inspectControlFile(appDataPaths.migrationLockFile, validateMigrationLock)
  const maintenance = inspectControlFile(appDataPaths.maintenanceStateFile, validateMaintenanceControl)
  if ([marker, lock, maintenance].some((item) => item.state === 'corrupted')) throw new Error('DATABASE_CONTROL_CORRUPTED')
  const activeTaskIds = [marker, lock, maintenance].flatMap((item) => item.state === 'healthy' ? [String(item.value.taskId)] : [])
  if (new Set(activeTaskIds).size > 1) throw new Error('DATABASE_CONTROL_MISMATCH')
  const taskId = activeTaskIds[0]
  if (taskId) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error('DATABASE_TASK_INVALID')
    const task = inspectControlFile(path.join(appDataPaths.migrationTaskDir, `${taskId}.json`), (value) => {
      const item = object(value)
      return item?.id === taskId && item.mode === 'automatic'
        && ['queued', 'running', 'restart_pending', 'verifying', 'succeeded', 'failed', 'rolled_back'].includes(String(item.status)) ? item : null
    })
    if (task.state !== 'healthy') throw new Error('DATABASE_TASK_UNAVAILABLE')
    if (marker.state === 'healthy') {
      if (override.state !== 'healthy' || override.value.sourceTaskId !== taskId) throw new Error('DATABASE_CONTROL_MISMATCH')
      const source = object(task.value.source)
      if (typeof source?.sqlitePath !== 'string' || path.resolve(source.sqlitePath) !== path.resolve(String(marker.value.sourceSqlitePath))) {
        throw new Error('DATABASE_CONTROL_MISMATCH')
      }
      if (override.value.config.DB_TYPE === 'sqlite') {
        if (path.resolve(override.value.config.SQLITE_DB_PATH ?? '') !== path.resolve(source.sqlitePath)
          || (marker.value.status !== 'rollback_pending' && Number(marker.value.attempts) < 2)) throw new Error('DATABASE_CONTROL_MISMATCH')
      } else {
        if (marker.value.status === 'rollback_pending' || !mysqlTargetMatches(task.value, override.value.config)) {
          throw new Error('DATABASE_CONTROL_MISMATCH')
        }
      }
      return { mode: 'cutover', taskId }
    }
    // marker 已删除而维护尚未解除：只能用持久化终态和同任务显式 override 续接收尾。
    // 维护存在证明业务写入仍未开放；任何归属/目标不一致都保持救援。
    if (maintenance.state === 'healthy' && override.state === 'healthy' && override.value.sourceTaskId === taskId
      && ((task.value.status === 'succeeded' && override.value.config.DB_TYPE === 'mysql')
        || (task.value.status === 'rolled_back' && override.value.config.DB_TYPE === 'sqlite'))) {
      const source = object(task.value.source)
      if (typeof source?.sqlitePath !== 'string') throw new Error('DATABASE_TASK_INVALID')
      if (override.value.config.DB_TYPE === 'sqlite'
        && path.resolve(override.value.config.SQLITE_DB_PATH ?? '') !== path.resolve(source.sqlitePath)) throw new Error('DATABASE_CONTROL_MISMATCH')
      if (override.value.config.DB_TYPE === 'mysql' && !mysqlTargetMatches(task.value, override.value.config)) throw new Error('DATABASE_CONTROL_MISMATCH')
      writeControlFile(appDataPaths.migrationCutoverFile, {
        version: 1, taskId, sourceSqlitePath: source.sqlitePath, attempts: 2,
        status: task.value.status === 'succeeded' ? 'verifying' : 'rollback_pending',
        createdAt: new Date().toISOString(), lastError: null,
      })
      return { mode: 'cutover', taskId }
    }
    if (['queued', 'running'].includes(String(task.value.status)) && lock.state === 'healthy'
      && override.state === 'absent') return { mode: 'resume', taskId }
    throw new Error('DATABASE_RECOVERY_REQUIRED')
  }
  // 完成日志保留为后续启动证据；正常 MySQL override 不要求旧 marker 永久存在。
  return { mode: 'normal' }
}
