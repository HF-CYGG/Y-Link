/** 文件职责：以任务终态、校验结果和实际运行数据库共同判定自动迁移完成，避免重启窗口误报。 */
import type { DatabaseRuntimeOverrideStateResult, SQLiteToMySqlTaskRecord } from '@/api/modules/data-maintenance'

export const isAutomaticMigrationCompleted = (
  task: SQLiteToMySqlTaskRecord | null,
  runtime: DatabaseRuntimeOverrideStateResult | null,
): boolean => task?.mode === 'automatic'
  && task.status === 'succeeded'
  && task.readState === 'healthy'
  && task.result?.validation.passed === true
  && task.result.validation.blockingFailure === false
  && runtime?.effectiveDatabase.dbType === 'mysql'
  && runtime.runtimeOverrideStatus.pendingRestart === false
