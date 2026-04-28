/**
 * 模块说明：数据维护与迁移 API 模块。
 * 文件职责：封装 SQLite 备份、全量 JSON 导入导出，以及 SQLite -> MySQL 数据库迁移助手所需的预检、任务、切换和回退接口。
 * 实现逻辑：
 * - 在 API 层统一声明迁移表单、任务记录、运行时覆盖状态等类型，避免页面层直接猜测后端返回结构；
 * - 列表、详情、运行时状态等可刷新接口支持透传 signal，便于系统治理页用 useStableRequest 消除旧请求回写；
 * - 迁移动作类接口保持轻薄封装，页面层只需关注交互编排与风险提示。
 * 维护说明：
 * - 若后端新增迁移阶段字段、任务状态或运行时覆盖结构，需优先同步本文件类型；
 * - 迁移相关接口均属于高风险治理动作，页面侧调用时应配合权限、确认弹窗与结果提示。
 */

import { request, type RequestConfig } from '@/api/http'

/**
 * MySQL 目标库连接参数：
 * - 供预检、创建迁移任务与数据库切换共用；
 * - dbSync 用于与后端运行时覆盖配置保持一致。
 */
export interface MySqlMigrationTarget {
  host: string
  port: number
  user: string
  password: string
  database: string
  dbSync?: boolean
}

/**
 * 迁移预检请求参数：
 * - allowTargetWithData 为 true 时，允许目标库已有业务表数据，但页面仍应给出高风险提示。
 */
export interface SQLiteToMySqlPrecheckPayload {
  target: MySqlMigrationTarget
  allowTargetWithData?: boolean
}

/**
 * 创建迁移任务参数：
 * - initializeSchema：是否初始化目标表结构；
 * - clearTargetBeforeImport：是否在导入前清空目标库业务表；
 * - switchAfterSuccess：迁移成功后是否自动写入 MySQL 运行时覆盖配置；
 * - createSqliteBackup：执行前是否创建 SQLite 物理备份；
 * - note：管理员备注，便于后续追溯任务意图。
 */
export interface CreateSQLiteToMySqlTaskPayload extends SQLiteToMySqlPrecheckPayload {
  initializeSchema?: boolean
  clearTargetBeforeImport?: boolean
  switchAfterSuccess?: boolean
  createSqliteBackup?: boolean
  note?: string
}

/**
 * 数据库切换参数：
 * - taskId 与 target 至少传一个；
 * - 系统治理页优先使用 taskId，确保切换目标来源可审计。
 */
export interface ApplyDatabaseSwitchPayload {
  taskId?: string
  target?: MySqlMigrationTarget
  reason?: string
}

/**
 * 数据库回退参数：
 * - clearOnly 为 true 时，仅清除运行时覆盖文件；
 * - taskId / sqlitePath 用于显式指定要回退到哪个 SQLite 数据源。
 */
export interface RollbackDatabaseSwitchPayload {
  taskId?: string
  sqlitePath?: string
  reason?: string
  clearOnly?: boolean
}

/**
 * 迁移预检问题：
 * - error 会阻断后续迁移；
 * - warning 允许继续，但页面应醒目提示；
 * - info 用于补充当前环境说明。
 */
export interface DatabaseMigrationIssue {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
}

/**
 * 业务表行数统计：
 * - 用于预检结果、任务进度和最终导入结果展示；
 * - rowCount 由后端已完成聚合，前端直接展示即可。
 */
export interface DatabaseMigrationTableStat {
  tableName: string
  rowCount: number
}

/**
 * 数据库迁移预检结果：
 * - 同时返回 SQLite 源信息、MySQL 目标信息、问题列表与当前运行时覆盖状态；
 * - 页面可据此决定是否允许创建迁移任务。
 */
export interface SQLiteToMySqlPrecheckResult {
  canProceed: boolean
  checkedAt: string
  source: {
    dbType: 'sqlite'
    sqlitePath: string
    sqliteFileExists: boolean
    sqliteFileSizeBytes: number
    expectedTables: string[]
    existingTables: string[]
    missingTables: string[]
    tables: DatabaseMigrationTableStat[]
    totalRows: number
  }
  target: {
    dbType: 'mysql'
    host: string
    port: number
    user: string
    database: string
    version: string | null
    reachable: boolean
    databaseExists: boolean
    existingAppTables: DatabaseMigrationTableStat[]
    missingAppTables: string[]
    schemaReady: boolean
    needsSchemaInitialization: boolean
    totalRows: number
  }
  issues: DatabaseMigrationIssue[]
  activeRuntimeOverride: DatabaseRuntimeOverrideFile | null
}

/**
 * 迁移任务状态：
 * - prechecked：已创建，待执行；
 * - running：正在迁移；
 * - succeeded：迁移成功；
 * - failed：迁移失败。
 */
export type DatabaseMigrationTaskStatus = 'prechecked' | 'running' | 'succeeded' | 'failed'

/**
 * 迁移任务记录：
 * - 列表接口与详情接口都返回该结构；
 * - progress.currentStage 用于给管理员展示当前所处阶段。
 */
export interface SQLiteToMySqlTaskRecord {
  id: string
  status: DatabaseMigrationTaskStatus
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  note?: string
  source: {
    sqlitePath: string
  }
  target: MySqlMigrationTarget
  options: {
    allowTargetWithData: boolean
    initializeSchema: boolean
    clearTargetBeforeImport: boolean
    switchAfterSuccess: boolean
    createSqliteBackup: boolean
  }
  precheck: SQLiteToMySqlPrecheckResult
  backupFile?: {
    fileName: string
    filePath: string
    fileSizeBytes?: number
  }
  jsonSnapshotFile?: {
    fileName: string
    filePath: string
    fileSizeBytes: number
  }
  progress: {
    currentStage: string
    tableResults: DatabaseMigrationTableStat[]
  }
  result?: {
    importedTables: DatabaseMigrationTableStat[]
    importedRows: number
    runtimeOverrideApplied: boolean
    validation: {
      checkedAt: string
      passed: boolean
      blockingFailure: boolean
      sourceTotalRows: number
      targetTotalRows: number
      items: Array<{
        tableName: string
        sourceRowCount: number
        targetRowCount: number
        matched: boolean
        blocking: boolean
      }>
    }
  }
  errorMessage?: string
}

/**
 * 运行时覆盖文件中的执行人信息：
 * - 仅用于页面做审计辅助展示；
 * - 不包含敏感认证信息。
 */
export interface DatabaseRuntimeOverrideOperator {
  userId: string
  username: string
  displayName: string
}

/**
 * 运行时覆盖中的数据库连接配置：
 * - MySQL 密码会由后端脱敏为 ***；
 * - SQLite 模式下展示 sqlite 路径，便于确认当前回退目标。
 */
export interface DatabaseRuntimeOverrideConfig {
  DB_TYPE: 'sqlite' | 'mysql'
  DB_HOST?: string
  DB_PORT?: number
  DB_USER?: string
  DB_PASSWORD?: string
  DB_NAME?: string
  SQLITE_DB_PATH?: string
  DB_SYNC?: boolean
}

/**
 * 回退配置快照：
 * - 当系统已切到 MySQL 时，后端会保留一份 SQLite 回退目标；
 * - 页面用该信息提醒管理员“当前可回退到哪里”。
 */
export interface DatabaseRuntimeOverrideRollbackConfig {
  DB_TYPE: 'sqlite'
  SQLITE_DB_PATH: string
  DB_SYNC?: boolean
}

/**
 * 脱敏后的运行时覆盖文件：
 * - 直接映射后端 mask 之后的展示结构；
 * - 页面不接触真实密码。
 */
export interface DatabaseRuntimeOverrideFile {
  version: 1
  updatedAt: string
  reason?: string
  sourceTaskId?: string
  updatedBy?: DatabaseRuntimeOverrideOperator | null
  config: DatabaseRuntimeOverrideConfig | null
  rollbackConfig?: DatabaseRuntimeOverrideRollbackConfig
}

/**
 * 运行时覆盖状态：
 * - filePath 为固定覆盖文件路径；
 * - activeOverride 为当前生效配置，为 null 表示未启用运行时覆盖。
 */
export interface DatabaseRuntimeOverrideStateResult {
  filePath: string
  activeOverride: DatabaseRuntimeOverrideFile | null
  effectiveDatabase: {
    dbType: 'sqlite' | 'mysql'
    displayName: string
    summary: string
    source: 'environment' | 'runtime_override'
    sourceLabel: string
    description: string
  }
  beginnerGuide: {
    headline: string
    recommendedAction: string
    nextStep: string
    riskTip: string
  }
}

/**
 * 创建 SQLite 数据库备份：
 * - 仅适用于本地 SQLite 运行环境，供系统管理员做数据快照兜底。
 */
export const createSqliteBackup = () =>
  request<{ fileName: string; filePath: string }>({
    method: 'POST',
    url: '/data-maintenance/backup/sqlite',
  })

/**
 * 导出系统全量数据为 JSON 格式：
 * - 返回包含全部基础表数据及导出时间戳与版本号的对象，可用于跨库或环境迁移。
 */
export const exportDataAsJson = () =>
  request<{
    exportedAt: string
    version: string
    tables: Record<string, Array<Record<string, unknown>>>
  }>({
    method: 'GET',
    url: '/data-maintenance/export/json',
  })

/**
 * 通过 JSON 格式导入恢复系统全量数据：
 * - 覆盖现有数据，具有破坏性操作，通常在运维环境交接或系统重建时调用。
 */
export const importDataFromJson = (payload: {
  exportedAt: string
  version: string
  tables: Record<string, Array<Record<string, unknown>>>
}) =>
  request<{
    imported: Record<string, number>
  }>({
    method: 'POST',
    url: '/data-maintenance/import/json',
    data: payload,
  })

/**
 * 执行 SQLite -> MySQL 迁移预检：
 * - 用于校验 SQLite 源文件、MySQL 连通性、目标库业务表数据与运行时覆盖现状；
 * - 建议在创建迁移任务前先调用一次，减少误操作。
 */
export const precheckSQLiteToMySqlMigration = (
  payload: SQLiteToMySqlPrecheckPayload,
  requestConfig: RequestConfig = {},
) =>
  request<SQLiteToMySqlPrecheckResult>({
    ...requestConfig,
    method: 'POST',
    url: '/data-maintenance/db-migration/precheck',
    data: payload,
  })

/**
 * 获取全部数据库迁移任务：
 * - 后端已按更新时间倒序返回；
 * - 页面可直接用于任务表格与选中详情展示。
 */
export const getSQLiteToMySqlMigrationTasks = (requestConfig: RequestConfig = {}) =>
  request<SQLiteToMySqlTaskRecord[]>({
    ...requestConfig,
    method: 'GET',
    url: '/data-maintenance/db-migration/tasks',
  })

/**
 * 获取单个数据库迁移任务详情：
 * - 供需要单独刷新某个任务状态时调用；
 * - 当前页面可在用户手动刷新或查看指定任务时复用。
 */
export const getSQLiteToMySqlMigrationTaskDetail = (taskId: string, requestConfig: RequestConfig = {}) =>
  request<SQLiteToMySqlTaskRecord>({
    ...requestConfig,
    method: 'GET',
    url: `/data-maintenance/db-migration/tasks/${taskId}`,
  })

/**
 * 创建数据库迁移任务：
 * - 后端会同步执行一次预检并把结果落入任务文件；
 * - 成功后返回完整任务记录，便于页面立即选中并展示。
 */
export const createSQLiteToMySqlMigrationTask = (payload: CreateSQLiteToMySqlTaskPayload) =>
  request<SQLiteToMySqlTaskRecord>({
    method: 'POST',
    url: '/data-maintenance/db-migration/tasks',
    data: payload,
  })

/**
 * 执行数据库迁移任务：
 * - 仅允许对待执行或失败后的任务再次运行；
 * - 返回最新任务记录，页面应及时刷新列表与运行时状态。
 */
export const runSQLiteToMySqlMigrationTask = (taskId: string) =>
  request<SQLiteToMySqlTaskRecord>({
    method: 'POST',
    url: `/data-maintenance/db-migration/tasks/${taskId}/run`,
  })

/**
 * 获取数据库运行时覆盖状态：
 * - 用于展示当前应用究竟使用 SQLite 还是 MySQL；
 * - 也是切换与回退后的状态确认依据。
 */
export const getDatabaseMigrationRuntimeOverrideState = (requestConfig: RequestConfig = {}) =>
  request<DatabaseRuntimeOverrideStateResult>({
    ...requestConfig,
    method: 'GET',
    url: '/data-maintenance/db-migration/runtime-override',
  })

/**
 * 应用数据库切换：
 * - 常规场景优先使用 taskId，让切换动作与某次迁移任务建立审计关联；
 * - 返回 restartRequired 供页面明确提示“需要重启后端服务”。
 */
export const applyDatabaseMigrationSwitch = (payload: ApplyDatabaseSwitchPayload) =>
  request<{
    restartRequired: true
    activeOverride: DatabaseRuntimeOverrideFile | null
    sourceTaskId?: string
  }>({
    method: 'POST',
    url: '/data-maintenance/db-migration/switch',
    data: payload,
  })

/**
 * 回退数据库切换：
 * - 可根据任务来源回退，也可显式指定 SQLite 路径；
 * - clearOnly 为 true 时仅清除覆盖文件，不强制写入 SQLite 配置。
 */
export const rollbackDatabaseMigrationSwitch = (payload: RollbackDatabaseSwitchPayload) =>
  request<{
    restartRequired: true
    rollbackMode: 'clear' | 'sqlite_override'
    activeOverride: DatabaseRuntimeOverrideFile | null
  }>({
    method: 'POST',
    url: '/data-maintenance/db-migration/rollback',
    data: payload,
  })

/**
 * 清空数据库运行时覆盖：
 * - 用于撤销此前的切换决定，回到默认环境变量配置；
 * - 仍需重启后端服务后才会完全生效。
 */
export const clearDatabaseMigrationRuntimeOverride = () =>
  request<boolean>({
    method: 'DELETE',
    url: '/data-maintenance/db-migration/runtime-override',
  })
