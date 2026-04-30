/**
 * 模块说明：backend/src/services/database-migration.service.ts
 * 文件职责：提供 SQLite -> MySQL 迁移预检、任务持久化、全表迁移执行、应用切换与回退能力。
 * 维护说明：本文件是数据库迁移总控入口；若新增实体、调整启动配置或更改覆盖文件结构，必须同步校验这里的预检与执行流程。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DataSource, type DataSourceOptions, type EntityMetadata } from 'typeorm'
import { resolveSqliteDatabasePath } from '../config/database-bootstrap.js'
import {
  clearDatabaseRuntimeOverride,
  maskDatabaseRuntimeOverride,
  readDatabaseRuntimeOverride,
  writeDatabaseRuntimeOverride,
  type DatabaseRuntimeOverrideConfig,
  type DatabaseRuntimeOverrideFile,
} from '../config/database-runtime-override.js'
import { AppDataSource, appEntities, createDataSourceOptions } from '../config/data-source.js'
import { env } from '../config/env.js'
import {
  DATABASE_MIGRATION_ROLLBACK_REASON_DEFAULT,
  DATABASE_MIGRATION_SUCCESS_STAGE_PENDING_SWITCH,
  DATABASE_MIGRATION_SUCCESS_STAGE_WITH_SWITCH,
  DATABASE_MIGRATION_SWITCH_REASON_DEFAULT,
} from '../constants/database-migration-copy.js'
import type { AuthUserContext } from '../types/auth.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { BizError } from '../utils/errors.js'
import {
  buildBeginnerGuide,
  buildEffectiveDatabaseSummary,
  buildRuntimeOverrideStatusSummary,
  type RuntimeOverrideStatusSummary,
} from '../utils/effective-database.js'
import { auditService } from './audit.service.js'

type MigrationIssueLevel = 'info' | 'warning' | 'error'
type MigrationTaskStatus = 'prechecked' | 'running' | 'succeeded' | 'failed'
type QueryRow = Record<string, unknown>

export interface MySqlMigrationTargetInput {
  host: string
  port: number
  user: string
  password: string
  database: string
  dbSync?: boolean
}

export interface SQLiteToMySqlPrecheckInput {
  target: MySqlMigrationTargetInput
  allowTargetWithData?: boolean
  initializeSchema?: boolean
  clearTargetBeforeImport?: boolean
  switchAfterSuccess?: boolean
}

export interface CreateSQLiteToMySqlTaskInput extends SQLiteToMySqlPrecheckInput {
  initializeSchema?: boolean
  clearTargetBeforeImport?: boolean
  switchAfterSuccess?: boolean
  createSqliteBackup?: boolean
  note?: string
}

export interface ApplyDatabaseSwitchInput {
  taskId?: string
  target?: MySqlMigrationTargetInput
  reason?: string
}

export interface RollbackDatabaseSwitchInput {
  taskId?: string
  sqlitePath?: string
  reason?: string
  clearOnly?: boolean
}

export interface DatabaseMigrationIssue {
  level: MigrationIssueLevel
  code: string
  message: string
}

export interface DatabaseMigrationTableStat {
  tableName: string
  rowCount: number
}

export interface DatabaseMigrationBackupFile {
  fileName: string
  filePath: string
  fileSizeBytes: number
}

export interface DatabaseMigrationValidationItem {
  tableName: string
  sourceRowCount: number
  targetRowCount: number
  matched: boolean
  blocking: boolean
}

export interface DatabaseMigrationValidationResult {
  checkedAt: string
  passed: boolean
  blockingFailure: boolean
  sourceTotalRows: number
  targetTotalRows: number
  items: DatabaseMigrationValidationItem[]
}

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
  activeRuntimeOverride: ReturnType<typeof maskDatabaseRuntimeOverride>
}

export interface SQLiteToMySqlTaskRecord {
  id: string
  status: MigrationTaskStatus
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  note?: string
  source: {
    sqlitePath: string
  }
  target: MySqlMigrationTargetInput
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
  jsonSnapshotFile?: DatabaseMigrationBackupFile
  progress: {
    currentStage: string
    tableResults: DatabaseMigrationTableStat[]
  }
  result?: {
    importedTables: DatabaseMigrationTableStat[]
    importedRows: number
    runtimeOverrideApplied: boolean
    validation: DatabaseMigrationValidationResult
  }
  errorMessage?: string
  /**
   * 任务文件读取状态：
   * - healthy 表示任务文件可正常解析；
   * - corrupted 表示任务文件存在 JSON 语法或结构损坏，当前返回的是占位记录。
   */
  readState: 'healthy' | 'corrupted'
  /**
   * 任务源文件名：
   * - 便于管理员快速定位 backend/data/migration-tasks 下的具体文件；
   * - 损坏占位记录会优先回传该字段，方便人工修复。
   */
  recordFileName?: string
  /**
   * 任务源文件绝对路径：
   * - 主要用于系统治理场景排查损坏任务文件；
   * - 正常任务也会透传，保持列表与详情展示口径一致。
   */
  recordFilePath?: string
  /**
   * 读取任务文件时的错误说明：
   * - 正常任务为空；
   * - 损坏任务会回传明确原因，供前端区分“不存在”和“已损坏”。
   */
  recordErrorMessage?: string
}

export interface DatabaseRuntimeOverrideStateResult {
  filePath: string
  activeOverride: ReturnType<typeof maskDatabaseRuntimeOverride>
  effectiveDatabase: {
    dbType: 'sqlite' | 'mysql'
    displayName: string
    summary: string
    source: 'environment' | 'runtime_override'
    sourceLabel: string
    description: string
  }
  runtimeOverrideStatus: RuntimeOverrideStatusSummary
  beginnerGuide: {
    headline: string
    recommendedAction: string
    nextStep: string
    riskTip: string
  }
}

type InternalMigrationTaskRecord = Omit<
  SQLiteToMySqlTaskRecord,
  'readState' | 'recordFileName' | 'recordFilePath' | 'recordErrorMessage'
>

type TaskRecordReadResult =
  | {
      readState: 'healthy'
      task: InternalMigrationTaskRecord
      responseTask: SQLiteToMySqlTaskRecord
    }
  | {
      readState: 'corrupted'
      errorMessage: string
      responseTask: SQLiteToMySqlTaskRecord
    }

interface SourcePrecheckSummary {
  sqlitePath: string
  sqliteFileExists: boolean
  sqliteFileSizeBytes: number
  expectedTableNames: string[]
  existingSourceTableNames: string[]
  missingSourceTables: string[]
  sourceTableStats: DatabaseMigrationTableStat[]
  sourceTotalRows: number
  issues: DatabaseMigrationIssue[]
}

interface TargetPrecheckSummary {
  targetReachable: boolean
  targetVersion: string | null
  targetDatabaseExists: boolean
  targetExistingAppTables: DatabaseMigrationTableStat[]
  targetMissingAppTables: string[]
  targetSchemaReady: boolean
  targetNeedsSchemaInitialization: boolean
  issues: DatabaseMigrationIssue[]
}

interface MigrationExecutionResult {
  importedTables: DatabaseMigrationTableStat[]
  runtimeOverrideApplied: boolean
  validationResult: DatabaseMigrationValidationResult
}

/**
 * 迁移任务目录固定落盘，确保应用重启后仍能查看历史任务与上次切换决策。
 */
const backendRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const migrationTaskDir = path.resolve(backendRootDir, 'data', 'migration-tasks')
const sqliteBackupDir = path.resolve(backendRootDir, 'data', 'backup')
const MIGRATION_BATCH_SIZE = 300
const CRITICAL_VALIDATION_TABLES = new Set([
  'sys_user',
  'system_configs',
  'base_product',
  'client_user',
  'biz_outbound_order',
  'biz_outbound_order_item',
  'biz_inbound_order',
  'biz_inbound_order_item',
  'o2o_preorder',
  'o2o_preorder_item',
  'inventory_log',
])

function createTaskId(): string {
  return `sqlite_mysql_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeText(value: string): string {
  return value.trim()
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right)
}

function sortTextList(values: string[]): string[] {
  return [...values].sort(compareText)
}

function isQueryRow(value: unknown): value is QueryRow {
  return typeof value === 'object' && value !== null
}

function formatUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    return JSON.stringify(error)
  } catch {
    return '未知错误'
  }
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``
}

function buildMysqlTargetConfig(input: MySqlMigrationTargetInput): DatabaseRuntimeOverrideConfig {
  return {
    DB_TYPE: 'mysql',
    DB_HOST: normalizeText(input.host),
    DB_PORT: input.port,
    DB_USER: normalizeText(input.user),
    DB_PASSWORD: input.password,
    DB_NAME: normalizeText(input.database),
    DB_SYNC: input.dbSync ?? false,
  }
}

function sanitizeMysqlTarget(target: MySqlMigrationTargetInput): MySqlMigrationTargetInput {
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password ? '***' : '',
    database: target.database,
    dbSync: target.dbSync,
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'bigint') {
    return Number(value)
  }
  return Number(value ?? 0)
}

function createTableStatMap(tableStats: DatabaseMigrationTableStat[]): Map<string, number> {
  return new Map(tableStats.map((item) => [item.tableName, item.rowCount]))
}

/**
 * 区分“任务文件不存在”和“文件内容损坏”：
 * - 列表接口遇到损坏文件要继续返回其他任务；
 * - 详情与执行接口仍需对不存在给出 404，避免误导管理员。
 */
function isFileNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as {
        code?: unknown
      }).code === 'ENOENT',
  )
}

export class DatabaseMigrationService {
  /**
   * 将原始查询结果统一收敛为对象数组：
   * - 避免直接依赖 `query()` 返回的 `any`；
   * - 同时去掉 Sonar 对无效类型断言的告警。
   */
  private toQueryRows(value: unknown): QueryRow[] {
    if (!Array.isArray(value)) {
      return []
    }
    return value.filter(isQueryRow)
  }

  /**
   * 读取查询结果中的字符串字段：
   * - 对缺失字段返回 `undefined`，由调用方决定是否过滤；
   * - 对非字符串值统一转为字符串，减少数据库驱动差异影响。
   */
  private readStringField(row: QueryRow, fieldName: string): string | undefined {
    const rawValue = row[fieldName]
    if (rawValue === null || rawValue === undefined) {
      return undefined
    }
    if (typeof rawValue === 'string') {
      return rawValue
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean' || typeof rawValue === 'bigint') {
      return `${rawValue}`
    }
    if (rawValue instanceof Date) {
      return rawValue.toISOString()
    }
    return undefined
  }

  /**
   * 批量提取单列字符串并做稳定排序，供表名、schema 名等场景复用。
   */
  private extractSortedStringFieldList(rows: unknown, fieldName: string): string[] {
    return sortTextList(
      this.toQueryRows(rows)
        .map((row) => this.readStringField(row, fieldName))
        .filter((value): value is string => Boolean(value)),
    )
  }

  /**
   * 从单行查询中提取字段值：
   * - 优先读取第一行指定列；
   * - 若查询为空则返回 `undefined`，避免额外断言。
   */
  private readFirstField(rows: unknown, fieldName: string): unknown {
    return this.toQueryRows(rows)[0]?.[fieldName]
  }

  private async ensureMigrationDirectories(): Promise<void> {
    await fs.mkdir(migrationTaskDir, { recursive: true })
    await fs.mkdir(sqliteBackupDir, { recursive: true })
  }

  /**
   * 迁移源库限定为当前正在运行的 SQLite：
   * - 避免服务已切到 MySQL 后仍误把 MySQL 当源库再次迁移；
   * - 也避免“离线文件路径 + 在线应用库”口径不一致。
   */
  private assertCurrentSourceIsSqlite(): void {
    if (env.DB_TYPE !== 'sqlite' || AppDataSource.options.type !== 'sqlite') {
      throw new BizError('当前应用不是以 SQLite 模式运行，无法执行 SQLite -> MySQL 迁移', 400)
    }
  }

  private createMysqlDataSource(target: MySqlMigrationTargetInput): DataSource {
    const options: DataSourceOptions = createDataSourceOptions(buildMysqlTargetConfig(target))
    return new DataSource({
      ...options,
      synchronize: false,
    })
  }

  /**
   * 统一查询当前数据源下的真实业务表名：
   * - SQLite 读取 sqlite_master；
   * - MySQL 读取 information_schema；
   * - 结果统一转为排序后的表名数组，供预检、校验与差异提示复用。
   */
  private async listExistingTableNames(dataSource: DataSource): Promise<string[]> {
    if (dataSource.options.type === 'sqlite') {
      const rows = await dataSource.query(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
        `,
      )
      return this.extractSortedStringFieldList(rows, 'name')
    }

    const rows = await dataSource.query(
      `
        SELECT table_name AS tableName
        FROM information_schema.tables
        WHERE table_schema = ?
      `,
      [dataSource.options.database],
    )
    return this.extractSortedStringFieldList(rows, 'tableName')
  }

  private async statFileSize(filePath: string): Promise<number> {
    try {
      const statResult = await fs.stat(filePath)
      return statResult.size
    } catch {
      return 0
    }
  }

  private async countTableRows(dataSource: DataSource, tableName: string): Promise<number> {
    const result = await dataSource.query(`SELECT COUNT(1) AS total FROM ${quoteIdentifier(tableName)}`)
    return toNumber(this.readFirstField(result, 'total') ?? 0)
  }

  private resolveOrderedEntityMetadatas(dataSource: DataSource): EntityMetadata[] {
    const metadataList = dataSource.entityMetadatas
      .filter((metadata) => metadata.tableType !== 'view')
      .slice()

    const metadataMap = new Map(metadataList.map((metadata) => [metadata.tableName, metadata]))
    const dependencyMap = new Map<string, Set<string>>()
    const reverseDependencyMap = new Map<string, Set<string>>()

    metadataList.forEach((metadata) => {
      dependencyMap.set(metadata.tableName, new Set())
      reverseDependencyMap.set(metadata.tableName, new Set())
    })

    metadataList.forEach((metadata) => {
      metadata.foreignKeys.forEach((foreignKey) => {
        const targetTableName = foreignKey.referencedEntityMetadata.tableName
        if (!metadataMap.has(targetTableName) || targetTableName === metadata.tableName) {
          return
        }
        const currentDependencySet = dependencyMap.get(metadata.tableName)
        const targetReverseDependencySet = reverseDependencyMap.get(targetTableName)
        if (!currentDependencySet || !targetReverseDependencySet) {
          return
        }
        currentDependencySet.add(targetTableName)
        targetReverseDependencySet.add(metadata.tableName)
      })
    })

    const readyQueue = metadataList
      .filter((metadata) => dependencyMap.get(metadata.tableName)?.size === 0)
      .map((metadata) => metadata.tableName)
    readyQueue.sort(compareText)

    const sortedTableNames: string[] = []
    while (readyQueue.length > 0) {
      const currentTableName = readyQueue.shift()
      if (!currentTableName) {
        break
      }
      sortedTableNames.push(currentTableName)

      const dependentTables = sortTextList([...(reverseDependencyMap.get(currentTableName) ?? new Set())])
      dependentTables.forEach((dependentTableName) => {
        const dependencySet = dependencyMap.get(dependentTableName)
        if (!dependencySet) {
          return
        }
        dependencySet.delete(currentTableName)
        if (dependencySet.size === 0) {
          readyQueue.push(dependentTableName)
          readyQueue.sort(compareText)
        }
      })
    }

    if (sortedTableNames.length !== metadataList.length) {
      return metadataList.sort((prev, next) => prev.tableName.localeCompare(next.tableName))
    }

    return sortedTableNames
      .map((tableName) => metadataMap.get(tableName))
      .filter((metadata): metadata is EntityMetadata => Boolean(metadata))
  }

  private async collectSourceTableStats(dataSource: DataSource): Promise<DatabaseMigrationTableStat[]> {
    const orderedMetadatas = this.resolveOrderedEntityMetadatas(dataSource)
    const stats: DatabaseMigrationTableStat[] = []
    for (const metadata of orderedMetadatas) {
      const rowCount = await this.countTableRows(dataSource, metadata.tableName)
      stats.push({
        tableName: metadata.tableName,
        rowCount,
      })
    }
    return stats
  }

  private async collectTableStatsByMetadatas(
    dataSource: DataSource,
    orderedMetadatas: EntityMetadata[],
  ): Promise<DatabaseMigrationTableStat[]> {
    const stats: DatabaseMigrationTableStat[] = []
    for (const metadata of orderedMetadatas) {
      stats.push({
        tableName: metadata.tableName,
        rowCount: await this.countTableRows(dataSource, metadata.tableName),
      })
    }
    return stats
  }

  private async collectMySqlExistingAppTableStats(targetDataSource: DataSource): Promise<DatabaseMigrationTableStat[]> {
    const tableNames = appEntities.length
        ? targetDataSource.entityMetadatas
          .filter((metadata) => metadata.tableType !== 'view')
          .map((metadata) => metadata.tableName)
      : []

    if (tableNames.length === 0) {
      return []
    }

    const placeholders = tableNames.map(() => '?').join(', ')
    const rows = await targetDataSource.query(
      `
        SELECT table_name AS tableName
        FROM information_schema.tables
        WHERE table_schema = ?
          AND table_name IN (${placeholders})
      `,
      [targetDataSource.options.database, ...tableNames],
    )

    const existingTableNames = this.extractSortedStringFieldList(rows, 'tableName')
    const stats: DatabaseMigrationTableStat[] = []
    for (const tableName of existingTableNames) {
      stats.push({
        tableName,
        rowCount: await this.countTableRows(targetDataSource, tableName),
      })
    }
    return stats
  }

  /**
   * 检查目标库默认字符集：
   * - 企业环境默认推荐 `utf8mb4`，保证中文、特殊字符与后续扩展兼容；
   * - `utf8mb3` 允许继续，但会给出升级建议；
   * - 其余字符集视为高风险，直接阻断迁移。
   */
  private async inspectMySqlSchemaCharset(
    targetDataSource: DataSource,
  ): Promise<{ databaseExists: boolean; defaultCharset: string | null }> {
    const rows = await targetDataSource.query(
      `
        SELECT schema_name AS schemaName, default_character_set_name AS defaultCharset
        FROM information_schema.schemata
        WHERE schema_name = ?
      `,
      [targetDataSource.options.database],
    )
    const normalizedRows = this.toQueryRows(rows)

    return {
      databaseExists: normalizedRows.length > 0,
      defaultCharset: this.readStringField(normalizedRows[0] ?? {}, 'defaultCharset') ?? null,
    }
  }

  /**
   * 通过临时表演练写权限：
   * - 不污染正式业务表；
   * - 同时验证创建临时表与插入能力，避免迁移到一半才发现账号权限不足。
   */
  private async verifyMySqlWritePermission(targetDataSource: DataSource): Promise<void> {
    const probeTableName = `y_link_migration_probe_${Date.now()}`
    await targetDataSource.query(
      `CREATE TEMPORARY TABLE ${quoteIdentifier(probeTableName)} (id INT NOT NULL PRIMARY KEY)`,
    )
    await targetDataSource.query(`INSERT INTO ${quoteIdentifier(probeTableName)} (id) VALUES (1)`)
    await targetDataSource.query(`DROP TEMPORARY TABLE ${quoteIdentifier(probeTableName)}`)
  }

  private buildTargetConnectionIssue(error: unknown): DatabaseMigrationIssue {
    const rawMessage = formatUnknownErrorMessage(error)
    const normalizedMessage = rawMessage.toLowerCase()

    if (normalizedMessage.includes('unknown database')) {
      return {
        level: 'error',
        code: 'target_database_missing',
        message: '目标 MySQL 数据库不存在，请先创建数据库后再执行迁移预检。',
      }
    }

    if (normalizedMessage.includes('access denied')) {
      return {
        level: 'error',
        code: 'target_access_denied',
        message: '目标 MySQL 账号或密码无效，请检查用户名、密码与主机授权范围。',
      }
    }

    return {
      level: 'error',
      code: 'target_unreachable',
      message: `目标 MySQL 连接失败：${rawMessage}`,
    }
  }

  private sanitizeTaskRecord(task: InternalMigrationTaskRecord): SQLiteToMySqlTaskRecord {
    return {
      ...task,
      target: sanitizeMysqlTarget(task.target),
      readState: 'healthy',
      recordFileName: `${task.id}.json`,
      recordFilePath: path.resolve(migrationTaskDir, `${task.id}.json`),
      recordErrorMessage: undefined,
    }
  }

  private async getTaskFilePath(taskId: string): Promise<string> {
    await this.ensureMigrationDirectories()
    return path.resolve(migrationTaskDir, `${taskId}.json`)
  }

  /**
   * 为损坏任务文件构造“可展示但不可执行”的占位记录：
   * - 保证列表页还能继续打开，不会因为单个 JSON 坏掉整页报错；
   * - 同时把损坏原因和源文件路径带回前端，方便管理员人工处理。
   */
  private async buildCorruptedTaskRecord(
    taskId: string,
    filePath: string,
    errorMessage: string,
  ): Promise<SQLiteToMySqlTaskRecord> {
    let fallbackTimestamp = new Date().toISOString()
    try {
      const fileStat = await fs.stat(filePath)
      fallbackTimestamp = fileStat.mtime.toISOString()
    } catch {
      // 文件状态读取失败时退回当前时间，不再额外阻断损坏占位返回。
    }

    return {
      id: taskId,
      status: 'failed',
      createdAt: fallbackTimestamp,
      updatedAt: fallbackTimestamp,
      finishedAt: fallbackTimestamp,
      note: '迁移任务文件已损坏，系统当前返回的是占位记录，请先修复或删除该任务文件。',
      source: {
        sqlitePath: '任务文件损坏，原始 SQLite 路径不可读',
      },
      target: {
        host: '',
        port: 0,
        user: '',
        password: '',
        database: '',
        dbSync: false,
      },
      options: {
        allowTargetWithData: false,
        initializeSchema: false,
        clearTargetBeforeImport: false,
        switchAfterSuccess: false,
        createSqliteBackup: false,
      },
      precheck: {
        canProceed: false,
        checkedAt: fallbackTimestamp,
        source: {
          dbType: 'sqlite',
          sqlitePath: '任务文件损坏，无法读取源库信息',
          sqliteFileExists: false,
          sqliteFileSizeBytes: 0,
          expectedTables: [],
          existingTables: [],
          missingTables: [],
          tables: [],
          totalRows: 0,
        },
        target: {
          dbType: 'mysql',
          host: '',
          port: 0,
          user: '',
          database: '',
          version: null,
          reachable: false,
          databaseExists: false,
          existingAppTables: [],
          missingAppTables: [],
          schemaReady: false,
          needsSchemaInitialization: false,
          totalRows: 0,
        },
        issues: [
          {
            level: 'error',
            code: 'task_record_corrupted',
            message: errorMessage,
          },
        ],
        activeRuntimeOverride: null,
      },
      progress: {
        currentStage: '迁移任务文件已损坏，当前仅展示占位信息',
        tableResults: [],
      },
      errorMessage,
      readState: 'corrupted',
      recordFileName: path.basename(filePath),
      recordFilePath: filePath,
      recordErrorMessage: errorMessage,
    }
  }

  /**
   * 统一读取任务文件：
   * - 不存在时抛 404，明确告诉调用方“任务不存在”；
   * - 内容损坏时返回占位记录，由列表/详情接口继续容错展示。
   */
  private async readTaskRecordResult(taskId: string): Promise<TaskRecordReadResult> {
    const filePath = await this.getTaskFilePath(taskId)
    let raw = ''
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if (isFileNotFoundError(error)) {
        throw new BizError('迁移任务不存在', 404)
      }
      throw new BizError(`读取迁移任务失败：${formatUnknownErrorMessage(error)}`, 500)
    }

    try {
      const parsed = JSON.parse(raw) as InternalMigrationTaskRecord
      return {
        readState: 'healthy',
        task: parsed,
        responseTask: this.sanitizeTaskRecord(parsed),
      }
    } catch (error) {
      const errorMessage = `迁移任务文件已损坏，无法读取完整内容：${formatUnknownErrorMessage(error)}`
      return {
        readState: 'corrupted',
        errorMessage,
        responseTask: await this.buildCorruptedTaskRecord(taskId, filePath, errorMessage),
      }
    }
  }

  /**
   * 将“可容错读取”与“必须可执行”两个场景分开：
   * - 列表/详情可以消费损坏占位记录；
   * - 执行、切换、回退等写操作必须阻断损坏任务，避免风险扩大。
   */
  private async readTaskRecord(taskId: string, actionLabel: string): Promise<InternalMigrationTaskRecord> {
    const result = await this.readTaskRecordResult(taskId)
    if (result.readState === 'corrupted') {
      throw new BizError(`${result.errorMessage}，请先修复或删除该任务文件后再${actionLabel}`, 409)
    }
    return result.task
  }

  private async writeTaskRecord(task: InternalMigrationTaskRecord): Promise<InternalMigrationTaskRecord> {
    const filePath = await this.getTaskFilePath(task.id)
    await fs.writeFile(filePath, JSON.stringify(task, null, 2), 'utf8')
    return task
  }

  private async createSqliteBackupSnapshot(): Promise<{ fileName: string; filePath: string }> {
    this.assertCurrentSourceIsSqlite()
    await this.ensureMigrationDirectories()
    const sourcePath = resolveSqliteDatabasePath()
    const fileName = `y-link-backup-before-mysql-migration-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.sqlite`
    const filePath = path.resolve(sqliteBackupDir, fileName)
    await fs.copyFile(sourcePath, filePath)
    return {
      fileName,
      filePath,
    }
  }

  /**
   * JSON 快照备份覆盖全部应用实体表：
   * - 迁移前生成独立快照，便于跨数据库回放或人工抽检；
   * - 保留每张表完整行数据与导出统计，作为物理 SQLite 备份之外的第二道兜底。
   */
  private async createJsonSnapshotBackup(
    orderedMetadatas: EntityMetadata[],
    sourceTableStats: DatabaseMigrationTableStat[],
  ): Promise<DatabaseMigrationBackupFile> {
    await this.ensureMigrationDirectories()
    const tables: Record<string, Array<Record<string, unknown>>> = {}

    for (const metadata of orderedMetadatas) {
      const orderExpression = this.buildOrderExpression(metadata)
      const rows = await AppDataSource.query(
        `
          SELECT *
          FROM ${quoteIdentifier(metadata.tableName)}
          ORDER BY ${orderExpression}
        `,
      )
      tables[metadata.tableName] = this.toQueryRows(rows)
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      version: 'sqlite-to-mysql-migration-snapshot-v1',
      source: {
        dbType: 'sqlite',
        sqlitePath: resolveSqliteDatabasePath(),
      },
      tableStats: sourceTableStats,
      tables,
    }

    const fileName = `y-link-json-snapshot-before-mysql-migration-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`
    const filePath = path.resolve(sqliteBackupDir, fileName)
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')

    return {
      fileName,
      filePath,
      fileSizeBytes: await this.statFileSize(filePath),
    }
  }

  /**
   * 迁后关键数据校验：
   * - 默认校验全部应用表行数一致性；
   * - 对关键表使用 blocking 标记，任一关键表不一致都禁止自动/手动切换。
   */
  private buildMigrationValidationResult(
    sourceTableStats: DatabaseMigrationTableStat[],
    targetTableStats: DatabaseMigrationTableStat[],
  ): DatabaseMigrationValidationResult {
    const sourceMap = createTableStatMap(sourceTableStats)
    const targetMap = createTableStatMap(targetTableStats)
    const tableNames = sortTextList([...new Set([...sourceMap.keys(), ...targetMap.keys()])])

    const items = tableNames.map((tableName) => {
      const sourceRowCount = sourceMap.get(tableName) ?? 0
      const targetRowCount = targetMap.get(tableName) ?? 0
      const blocking = CRITICAL_VALIDATION_TABLES.has(tableName)
      return {
        tableName,
        sourceRowCount,
        targetRowCount,
        matched: sourceRowCount === targetRowCount,
        blocking,
      }
    })

    const blockingFailure = items.some((item) => item.blocking && !item.matched)
    const passed = items.every((item) => item.matched)

    return {
      checkedAt: new Date().toISOString(),
      passed,
      blockingFailure,
      sourceTotalRows: sourceTableStats.reduce((sum, item) => sum + item.rowCount, 0),
      targetTotalRows: targetTableStats.reduce((sum, item) => sum + item.rowCount, 0),
      items,
    }
  }

  private ensureTaskValidationPassed(task: InternalMigrationTaskRecord): void {
    if (task.status !== 'succeeded') {
      throw new BizError('迁移任务尚未成功完成，禁止切换到目标 MySQL', 409)
    }

    if (!task.result?.validation?.passed || task.result.validation.blockingFailure) {
      throw new BizError('迁后关键数据校验未通过，已禁止切换到目标 MySQL', 409)
    }
  }

  private async clearTargetTables(targetDataSource: DataSource, orderedMetadatas: EntityMetadata[]): Promise<void> {
    const reversedMetadatas = orderedMetadatas.slice().reverse()
    if (targetDataSource.options.type === 'mysql') {
      await targetDataSource.query('SET FOREIGN_KEY_CHECKS = 0')
    }

    try {
      for (const metadata of reversedMetadatas) {
        await targetDataSource.query(`DELETE FROM ${quoteIdentifier(metadata.tableName)}`)
      }
    } finally {
      if (targetDataSource.options.type === 'mysql') {
        await targetDataSource.query('SET FOREIGN_KEY_CHECKS = 1')
      }
    }
  }

  private buildOrderExpression(metadata: EntityMetadata): string {
    const orderColumns = metadata.primaryColumns.length > 0 ? metadata.primaryColumns : metadata.columns.slice(0, 1)
    return orderColumns.map((column) => quoteIdentifier(column.databaseName)).join(', ')
  }

  private async migrateSingleTable(
    sourceDataSource: DataSource,
    targetDataSource: DataSource,
    metadata: EntityMetadata,
  ): Promise<DatabaseMigrationTableStat> {
    const orderExpression = this.buildOrderExpression(metadata)
    let importedRowCount = 0
    let offset = 0

    while (true) {
      const rows = this.toQueryRows(
        await sourceDataSource.query(
        `
          SELECT *
          FROM ${quoteIdentifier(metadata.tableName)}
          ORDER BY ${orderExpression}
          LIMIT ? OFFSET ?
        `,
        [MIGRATION_BATCH_SIZE, offset],
        ),
      )

      if (rows.length === 0) {
        break
      }

      await targetDataSource.createQueryBuilder().insert().into(metadata.tableName).values(rows).execute()
      importedRowCount += rows.length
      offset += rows.length
    }

    return {
      tableName: metadata.tableName,
      rowCount: importedRowCount,
    }
  }

  /**
   * 汇总源 SQLite 侧预检信息：
   * - 聚合文件存在性、表结构完整性与行数统计；
   * - 让总预检函数只负责装配结果，降低认知复杂度。
   */
  private async buildSourcePrecheckSummary(): Promise<SourcePrecheckSummary> {
    const issues: DatabaseMigrationIssue[] = []
    const sqlitePath = resolveSqliteDatabasePath()
    const sqliteFileSizeBytes = await this.statFileSize(sqlitePath)
    const expectedTableNames = this.resolveOrderedEntityMetadatas(AppDataSource).map((metadata) => metadata.tableName)
    const existingSourceTableNames = await this.listExistingTableNames(AppDataSource)
    const missingSourceTables = expectedTableNames.filter((tableName) => !existingSourceTableNames.includes(tableName))
    const sqliteFileExists = await fs
      .access(sqlitePath)
      .then(() => true)
      .catch(() => false)

    if (!sqliteFileExists) {
      issues.push({
        level: 'error',
        code: 'source_sqlite_missing',
        message: '当前 SQLite 数据文件不存在，无法继续执行迁移。',
      })
    }

    if (missingSourceTables.length > 0) {
      issues.push({
        level: 'error',
        code: 'source_schema_incomplete',
        message: `当前 SQLite 缺少业务表：${missingSourceTables.join('、')}。请先确认源库是否完整可用。`,
      })
    }

    const sourceTableStats = await this.collectSourceTableStats(AppDataSource)
    const sourceTotalRows = sourceTableStats.reduce((sum, item) => sum + item.rowCount, 0)
    if (sourceTotalRows === 0) {
      issues.push({
        level: 'warning',
        code: 'source_empty',
        message: '源 SQLite 库当前没有业务数据，迁移完成后目标 MySQL 也将为空库。',
      })
    }

    return {
      sqlitePath,
      sqliteFileExists,
      sqliteFileSizeBytes,
      expectedTableNames,
      existingSourceTableNames,
      missingSourceTables,
      sourceTableStats,
      sourceTotalRows,
      issues,
    }
  }

  /**
   * 复用目标库缺陷提示：
   * - 将字符集、表结构、权限与数据覆盖风险统一映射为问题列表；
   * - 保持预检文案集中，避免主流程里充满条件分支。
   */
  private collectTargetPrecheckIssues(
    input: SQLiteToMySqlPrecheckInput,
    expectedTableNames: string[],
    targetSchemaInfo: { databaseExists: boolean; defaultCharset: string | null },
    targetExistingAppTables: DatabaseMigrationTableStat[],
  ): {
    issues: DatabaseMigrationIssue[]
    targetDatabaseExists: boolean
    targetMissingAppTables: string[]
    targetSchemaReady: boolean
    targetNeedsSchemaInitialization: boolean
  } {
    const issues: DatabaseMigrationIssue[] = []
    const targetDatabaseExists = targetSchemaInfo.databaseExists
    const targetMissingAppTables = expectedTableNames.filter(
      (tableName) => !targetExistingAppTables.some((item) => item.tableName === tableName),
    )
    const targetSchemaReady = targetMissingAppTables.length === 0
    const targetNeedsSchemaInitialization = targetMissingAppTables.length > 0

    if (!targetDatabaseExists) {
      issues.push({
        level: 'error',
        code: 'target_database_missing',
        message: '目标 MySQL 数据库不存在，请先创建数据库后再执行迁移预检。',
      })
    }

    if (targetSchemaInfo.defaultCharset === 'utf8mb3') {
      issues.push({
        level: 'warning',
        code: 'target_charset_utf8mb3',
        message: '目标 MySQL 默认字符集为 utf8mb3，建议升级为 utf8mb4，避免后续特殊字符兼容风险。',
      })
    } else if (targetSchemaInfo.defaultCharset && targetSchemaInfo.defaultCharset !== 'utf8mb4') {
      issues.push({
        level: 'error',
        code: 'target_charset_incompatible',
        message: `目标 MySQL 默认字符集为 ${targetSchemaInfo.defaultCharset}，当前迁移要求使用 utf8mb4 或 utf8mb3。`,
      })
    }

    if (targetMissingAppTables.length > 0 && input.initializeSchema === false) {
      issues.push({
        level: 'error',
        code: 'target_schema_missing',
        message: `目标 MySQL 缺少业务表：${targetMissingAppTables.join('、')}。若要继续，请开启“初始化目标表结构”。`,
      })
    } else if (targetMissingAppTables.length > 0) {
      issues.push({
        level: 'info',
        code: 'target_schema_will_initialize',
        message: `目标 MySQL 仍缺少 ${targetMissingAppTables.length} 张业务表，执行迁移时将按当前实体结构初始化表结构。`,
      })
    }

    if (targetExistingAppTables.length > 0 && !input.allowTargetWithData) {
      issues.push({
        level: 'error',
        code: 'target_not_empty',
        message: '目标 MySQL 中已存在业务表数据。若确认可清空后导入，请在创建迁移任务时显式允许目标库带数据。',
      })
    }

    if (targetExistingAppTables.length > 0 && input.allowTargetWithData) {
      issues.push({
        level: 'warning',
        code: 'target_data_will_be_replaced',
        message: '目标 MySQL 已存在业务数据；若执行迁移任务并开启清空目标库，将覆盖这些历史数据。',
      })
    }

    if (targetExistingAppTables.length > 0 && input.allowTargetWithData && input.clearTargetBeforeImport === false) {
      issues.push({
        level: 'warning',
        code: 'target_data_merge_risk',
        message: '目标 MySQL 已存在业务数据，且当前未开启“导入前清空目标业务表”，执行迁移时可能产生主键冲突或重复数据。',
      })
    }

    return {
      issues,
      targetDatabaseExists,
      targetMissingAppTables,
      targetSchemaReady,
      targetNeedsSchemaInitialization,
    }
  }

  /**
   * 汇总目标 MySQL 侧预检信息：
   * - 单独封装连接、字符集、权限与目标数据状态；
   * - 连接失败时统一退化为不可达结果，避免主流程继续展开。
   */
  private async buildTargetPrecheckSummary(
    input: SQLiteToMySqlPrecheckInput,
    expectedTableNames: string[],
  ): Promise<TargetPrecheckSummary> {
    let targetDataSource: DataSource | null = null
    try {
      targetDataSource = this.createMysqlDataSource(input.target)
      await targetDataSource.initialize()

      const versionRows = await targetDataSource.query('SELECT VERSION() AS version')
      const targetSchemaInfo = await this.inspectMySqlSchemaCharset(targetDataSource)
      const targetExistingAppTables = await this.collectMySqlExistingAppTableStats(targetDataSource)
      const targetState = this.collectTargetPrecheckIssues(
        input,
        expectedTableNames,
        targetSchemaInfo,
        targetExistingAppTables,
      )

      try {
        await this.verifyMySqlWritePermission(targetDataSource)
      } catch (error) {
        targetState.issues.push({
          level: 'error',
          code: 'target_write_permission_denied',
          message: `目标 MySQL 缺少基础写权限，无法创建临时表或写入测试数据：${String(error)}`,
        })
      }

      return {
        targetReachable: true,
        targetVersion: this.readStringField(this.toQueryRows(versionRows)[0] ?? {}, 'version') ?? null,
        targetDatabaseExists: targetState.targetDatabaseExists,
        targetExistingAppTables,
        targetMissingAppTables: targetState.targetMissingAppTables,
        targetSchemaReady: targetState.targetSchemaReady,
        targetNeedsSchemaInitialization: targetState.targetNeedsSchemaInitialization,
        issues: targetState.issues,
      }
    } catch (error) {
      return {
        targetReachable: false,
        targetVersion: null,
        targetDatabaseExists: false,
        targetExistingAppTables: [],
        targetMissingAppTables: [],
        targetSchemaReady: false,
        targetNeedsSchemaInitialization: false,
        issues: [this.buildTargetConnectionIssue(error)],
      }
    } finally {
      if (targetDataSource?.isInitialized) {
        await targetDataSource.destroy()
      }
    }
  }

  private async buildPrecheck(input: SQLiteToMySqlPrecheckInput): Promise<SQLiteToMySqlPrecheckResult> {
    this.assertCurrentSourceIsSqlite()

    const sourceSummary = await this.buildSourcePrecheckSummary()

    const activeRuntimeOverride = maskDatabaseRuntimeOverride(readDatabaseRuntimeOverride())
    const issues = [...sourceSummary.issues]
    if (activeRuntimeOverride) {
      issues.push({
        level: 'warning',
        code: 'runtime_override_exists',
        message: '检测到已有数据库运行时覆盖配置，下次重启将优先采用覆盖目标，请确认是否需要先清理或回退。',
      })
    }

    const targetSummary = await this.buildTargetPrecheckSummary(input, sourceSummary.expectedTableNames)
    issues.push(...targetSummary.issues)

    const targetTotalRows = targetSummary.targetExistingAppTables.reduce((sum, item) => sum + item.rowCount, 0)
    const canProceed = issues.every((issue) => issue.level !== 'error')

    return {
      canProceed,
      checkedAt: new Date().toISOString(),
      source: {
        dbType: 'sqlite',
        sqlitePath: sourceSummary.sqlitePath,
        sqliteFileExists: sourceSummary.sqliteFileExists,
        sqliteFileSizeBytes: sourceSummary.sqliteFileSizeBytes,
        expectedTables: sourceSummary.expectedTableNames,
        existingTables: sourceSummary.existingSourceTableNames,
        missingTables: sourceSummary.missingSourceTables,
        tables: sourceSummary.sourceTableStats,
        totalRows: sourceSummary.sourceTotalRows,
      },
      target: {
        dbType: 'mysql',
        host: input.target.host,
        port: input.target.port,
        user: input.target.user,
        database: input.target.database,
        version: targetSummary.targetVersion,
        reachable: targetSummary.targetReachable,
        databaseExists: targetSummary.targetDatabaseExists,
        existingAppTables: targetSummary.targetExistingAppTables,
        missingAppTables: targetSummary.targetMissingAppTables,
        schemaReady: targetSummary.targetSchemaReady,
        needsSchemaInitialization: targetSummary.targetNeedsSchemaInitialization,
        totalRows: targetTotalRows,
      },
      issues,
      activeRuntimeOverride,
    }
  }

  async precheckSQLiteToMySql(input: SQLiteToMySqlPrecheckInput): Promise<SQLiteToMySqlPrecheckResult> {
    return this.buildPrecheck(input)
  }

  async createSQLiteToMySqlTask(
    input: CreateSQLiteToMySqlTaskInput,
    actor?: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<SQLiteToMySqlTaskRecord> {
    const precheck = await this.buildPrecheck({
      target: input.target,
      allowTargetWithData: input.allowTargetWithData ?? false,
    })

    const now = new Date().toISOString()
    const task: InternalMigrationTaskRecord = {
      id: createTaskId(),
      status: precheck.canProceed ? 'prechecked' : 'failed',
      createdAt: now,
      updatedAt: now,
      note: input.note?.trim() || undefined,
      source: {
        sqlitePath: precheck.source.sqlitePath,
      },
      target: {
        ...input.target,
      },
      options: {
        allowTargetWithData: input.allowTargetWithData ?? false,
        initializeSchema: input.initializeSchema ?? true,
        clearTargetBeforeImport: input.clearTargetBeforeImport ?? true,
        switchAfterSuccess: input.switchAfterSuccess ?? false,
        // 迁移执行阶段固定启用 SQLite 物理备份，确保与 JSON 快照组成双重兜底。
        createSqliteBackup: true,
      },
      precheck,
      progress: {
        currentStage: precheck.canProceed ? '任务已创建，等待执行' : '任务创建失败，请先修复预检错误',
        tableResults: [],
      },
      errorMessage: precheck.canProceed ? undefined : precheck.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message).join('；'),
    }

    await this.writeTaskRecord(task)

    await auditService.safeRecord({
      actionType: 'database_migration.create_task',
      actionLabel: '创建 SQLite 转 MySQL 迁移任务',
      targetType: 'database_migration',
      targetId: task.id,
      targetCode: task.id,
      actor,
      requestMeta,
      detail: {
        target: sanitizeMysqlTarget(task.target),
        canProceed: precheck.canProceed,
        issues: precheck.issues,
      },
    })

    return this.sanitizeTaskRecord(task)
  }

  async listSQLiteToMySqlTasks(): Promise<SQLiteToMySqlTaskRecord[]> {
    await this.ensureMigrationDirectories()
    const fileNames = await fs.readdir(migrationTaskDir)
    const tasks: SQLiteToMySqlTaskRecord[] = []
    for (const fileName of fileNames.filter((name) => name.endsWith('.json'))) {
      const taskId = fileName.replace(/\.json$/i, '')
      try {
        const taskResult = await this.readTaskRecordResult(taskId)
        tasks.push(taskResult.responseTask)
      } catch (error) {
        if (error instanceof BizError && error.statusCode === 404) {
          continue
        }
        throw error
      }
    }
    const sortedTasks = [...tasks]
    sortedTasks.sort((prev, next) => next.updatedAt.localeCompare(prev.updatedAt))
    return sortedTasks
  }

  async getSQLiteToMySqlTask(taskId: string): Promise<SQLiteToMySqlTaskRecord> {
    const taskResult = await this.readTaskRecordResult(taskId)
    return taskResult.responseTask
  }

  /**
   * 执行前先阻断无效状态，避免迁移任务被重复运行。
   */
  private assertTaskCanRun(task: InternalMigrationTaskRecord): void {
    if (task.status === 'running') {
      throw new BizError('该迁移任务正在执行中，请稍后刷新状态', 409)
    }
    if (task.status === 'succeeded') {
      throw new BizError('该迁移任务已经执行成功，无需重复运行', 409)
    }
  }

  /**
   * 将“执行前复检失败”的写盘逻辑单独抽离，避免主执行函数被失败分支淹没。
   */
  private async markTaskRunBlockedByPrecheck(
    existingTask: InternalMigrationTaskRecord,
    latestPrecheck: SQLiteToMySqlPrecheckResult,
  ): Promise<SQLiteToMySqlTaskRecord> {
    const failedTask: InternalMigrationTaskRecord = {
      ...existingTask,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      precheck: latestPrecheck,
      progress: {
        ...existingTask.progress,
        currentStage: '执行前复检失败，已阻止迁移',
      },
      errorMessage: latestPrecheck.issues
        .filter((issue) => issue.level === 'error')
        .map((issue) => issue.message)
        .join('；'),
    }
    await this.writeTaskRecord(failedTask)
    return this.sanitizeTaskRecord(failedTask)
  }

  /**
   * 统一推进任务阶段并立即持久化，保证前端查看进度时总能拿到最新状态。
   */
  private async updateTaskStage(task: InternalMigrationTaskRecord, currentStage: string): Promise<void> {
    task.progress.currentStage = currentStage
    task.updatedAt = new Date().toISOString()
    await this.writeTaskRecord(task)
  }

  /**
   * 构造迁后校验失败提示：
   * - 只截取前 5 个不一致表，避免错误消息过长；
   * - 同时保留源/目标行数，便于快速人工核对。
   */
  private buildValidationFailureMessage(validationResult: DatabaseMigrationValidationResult): string {
    const failedItems = validationResult.items.filter((item) => !item.matched)
    return `迁后关键数据校验未通过：${failedItems
      .slice(0, 5)
      .map((item) => `${item.tableName}(${item.sourceRowCount}/${item.targetRowCount})`)
      .join('、')}`
  }

  /**
   * 负责真正的数据迁移执行：
   * - 该方法串联备份、建表、清表、逐表导入与迁后校验；
   * - 主入口只负责状态控制、审计与异常落盘。
   */
  private async executeSQLiteToMySqlMigration(
    runningTask: InternalMigrationTaskRecord,
    latestPrecheck: SQLiteToMySqlPrecheckResult,
    actor?: AuthUserContext,
  ): Promise<MigrationExecutionResult> {
    const sourceOrderedMetadatas = this.resolveOrderedEntityMetadatas(AppDataSource)
    const backupFile = await this.createSqliteBackupSnapshot()
    runningTask.backupFile = backupFile
    await this.updateTaskStage(runningTask, '已完成 SQLite 物理备份，正在生成 JSON 快照')

    const jsonSnapshotFile = await this.createJsonSnapshotBackup(sourceOrderedMetadatas, latestPrecheck.source.tables)
    runningTask.jsonSnapshotFile = jsonSnapshotFile
    await this.updateTaskStage(runningTask, '已完成双重备份，准备连接目标 MySQL')

    let targetDataSource: DataSource | null = null
    let runtimeOverrideApplied = false
    try {
      targetDataSource = this.createMysqlDataSource(runningTask.target)
      await targetDataSource.initialize()

      if (runningTask.options.initializeSchema) {
        await this.updateTaskStage(runningTask, '正在初始化目标 MySQL 表结构')
        await targetDataSource.synchronize()
      }

      const orderedMetadatas = this.resolveOrderedEntityMetadatas(targetDataSource)
      if (runningTask.options.clearTargetBeforeImport) {
        await this.updateTaskStage(runningTask, '正在清空目标 MySQL 业务表')
        await this.clearTargetTables(targetDataSource, orderedMetadatas)
      }

      const importedTables: DatabaseMigrationTableStat[] = []
      for (const metadata of orderedMetadatas) {
        await this.updateTaskStage(runningTask, `正在迁移表 ${metadata.tableName}`)
        const tableResult = await this.migrateSingleTable(AppDataSource, targetDataSource, metadata)
        importedTables.push(tableResult)
        runningTask.progress.tableResults = importedTables
        runningTask.updatedAt = new Date().toISOString()
        await this.writeTaskRecord(runningTask)
      }

      await this.updateTaskStage(runningTask, '正在执行迁后关键数据校验')
      const targetTableStats = await this.collectTableStatsByMetadatas(targetDataSource, orderedMetadatas)
      const validationResult = this.buildMigrationValidationResult(latestPrecheck.source.tables, targetTableStats)
      if (!validationResult.passed || validationResult.blockingFailure) {
        throw new BizError(this.buildValidationFailureMessage(validationResult), 409)
      }

      if (runningTask.options.switchAfterSuccess) {
        await this.writeMysqlRuntimeOverride(runningTask.target, actor, runningTask.id, '迁移任务执行成功后自动切换')
        runtimeOverrideApplied = true
      }

      return {
        importedTables,
        runtimeOverrideApplied,
        validationResult,
      }
    } finally {
      if (targetDataSource?.isInitialized) {
        await targetDataSource.destroy()
      }
    }
  }

  async runSQLiteToMySqlTask(
    taskId: string,
    actor?: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<SQLiteToMySqlTaskRecord> {
    const existingTask = await this.readTaskRecord(taskId, '执行迁移任务')
    this.assertTaskCanRun(existingTask)

    const latestPrecheck = await this.buildPrecheck({
      target: existingTask.target,
      allowTargetWithData: existingTask.options.allowTargetWithData,
    })
    if (!latestPrecheck.canProceed) {
      return this.markTaskRunBlockedByPrecheck(existingTask, latestPrecheck)
    }

    const runningTask: InternalMigrationTaskRecord = {
      ...existingTask,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      precheck: latestPrecheck,
      progress: {
        currentStage: '正在初始化目标 MySQL 连接',
        tableResults: [],
      },
      errorMessage: undefined,
    }
    await this.writeTaskRecord(runningTask)

    let importedTables: DatabaseMigrationTableStat[] = []
    let validationResult: DatabaseMigrationValidationResult | undefined
    let runtimeOverrideApplied = false
    try {
      const executionResult = await this.executeSQLiteToMySqlMigration(runningTask, latestPrecheck, actor)
      importedTables = executionResult.importedTables
      validationResult = executionResult.validationResult
      runtimeOverrideApplied = executionResult.runtimeOverrideApplied

      const succeededTask: InternalMigrationTaskRecord = {
        ...runningTask,
        status: 'succeeded',
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        progress: {
          currentStage: runtimeOverrideApplied
            ? DATABASE_MIGRATION_SUCCESS_STAGE_WITH_SWITCH
            : DATABASE_MIGRATION_SUCCESS_STAGE_PENDING_SWITCH,
          tableResults: importedTables,
        },
        result: {
          importedTables,
          importedRows: importedTables.reduce((sum, item) => sum + item.rowCount, 0),
          runtimeOverrideApplied,
          validation: validationResult,
        },
      }
      await this.writeTaskRecord(succeededTask)

      await auditService.safeRecord({
        actionType: 'database_migration.run_task',
        actionLabel: '执行 SQLite 转 MySQL 迁移任务',
        targetType: 'database_migration',
        targetId: succeededTask.id,
        targetCode: succeededTask.id,
        actor,
        requestMeta,
        detail: {
          importedRows: succeededTask.result?.importedRows ?? 0,
          importedTables: succeededTask.result?.importedTables ?? [],
          runtimeOverrideApplied,
          validation: succeededTask.result?.validation ?? null,
        },
      })

      return this.sanitizeTaskRecord(succeededTask)
    } catch (error) {
      const failedTask: InternalMigrationTaskRecord = {
        ...runningTask,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        progress: {
          ...runningTask.progress,
          currentStage: '迁移执行失败',
        },
        errorMessage: error instanceof Error ? error.message : String(error),
        result:
          importedTables.length > 0 && validationResult
            ? {
                importedTables,
                importedRows: importedTables.reduce((sum, item) => sum + item.rowCount, 0),
                runtimeOverrideApplied,
                validation: validationResult,
              }
            : undefined,
      }
      await this.writeTaskRecord(failedTask)

      await auditService.safeRecord({
        actionType: 'database_migration.run_task_failed',
        actionLabel: 'SQLite 转 MySQL 迁移任务执行失败',
        targetType: 'database_migration',
        targetId: failedTask.id,
        targetCode: failedTask.id,
        actor,
        requestMeta,
        resultStatus: 'failed',
        detail: {
          errorMessage: failedTask.errorMessage,
        },
      })

      throw error
    }
  }

  private async writeMysqlRuntimeOverride(
    target: MySqlMigrationTargetInput,
    actor?: AuthUserContext,
    sourceTaskId?: string,
    reason?: string,
  ): Promise<DatabaseRuntimeOverrideFile> {
    const payload: DatabaseRuntimeOverrideFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      reason,
      sourceTaskId,
      updatedBy: actor
        ? {
            userId: actor.userId,
            username: actor.username,
            displayName: actor.displayName,
          }
        : null,
      config: buildMysqlTargetConfig(target),
      rollbackConfig: {
        DB_TYPE: 'sqlite',
        SQLITE_DB_PATH: resolveSqliteDatabasePath(),
        DB_SYNC: env.DB_SYNC,
      },
    }

    return writeDatabaseRuntimeOverride(payload)
  }

  async getRuntimeOverrideState(): Promise<DatabaseRuntimeOverrideStateResult> {
    const activeOverride = maskDatabaseRuntimeOverride(readDatabaseRuntimeOverride())
    const effectiveDatabase = buildEffectiveDatabaseSummary(activeOverride)
    const runtimeOverrideStatus = buildRuntimeOverrideStatusSummary(activeOverride)
    return {
      filePath: path.resolve(backendRootDir, 'data', 'runtime', 'database-runtime-override.json'),
      activeOverride,
      effectiveDatabase,
      runtimeOverrideStatus,
      beginnerGuide: buildBeginnerGuide(effectiveDatabase, runtimeOverrideStatus),
    }
  }

  async applyDatabaseSwitch(
    input: ApplyDatabaseSwitchInput,
    actor?: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{
    restartRequired: true
    activeOverride: ReturnType<typeof maskDatabaseRuntimeOverride>
    sourceTaskId?: string
  }> {
    const task = input.taskId ? await this.readTaskRecord(input.taskId, '切换到目标 MySQL') : null
    if (task) {
      this.ensureTaskValidationPassed(task)
    }
    const target = task?.target ?? input.target
    if (!target) {
      throw new BizError('缺少目标 MySQL 配置，无法写入应用切换覆盖配置', 400)
    }

    const persisted = await this.writeMysqlRuntimeOverride(
      target,
      actor,
      input.taskId,
      input.reason?.trim() || DATABASE_MIGRATION_SWITCH_REASON_DEFAULT,
    )

    await auditService.safeRecord({
      actionType: 'database_migration.apply_switch',
      actionLabel: '应用数据库切换覆盖配置',
      targetType: 'database_runtime_override',
      targetCode: input.taskId ?? persisted.config.DB_NAME ?? 'mysql',
      actor,
      requestMeta,
      detail: {
        sourceTaskId: input.taskId,
        target: sanitizeMysqlTarget(target),
      },
    })

    return {
      restartRequired: true,
      activeOverride: maskDatabaseRuntimeOverride(persisted),
      sourceTaskId: input.taskId,
    }
  }

  async rollbackDatabaseSwitch(
    input: RollbackDatabaseSwitchInput,
    actor?: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{
    restartRequired: true
    rollbackMode: 'clear' | 'sqlite_override'
    activeOverride: ReturnType<typeof maskDatabaseRuntimeOverride>
  }> {
    const currentOverride = readDatabaseRuntimeOverride()

    if (input.clearOnly) {
      const cleared = await clearDatabaseRuntimeOverride()

      await auditService.safeRecord({
        actionType: 'database_migration.rollback_switch',
        actionLabel: '回退数据库切换覆盖配置（仅清理覆盖文件）',
        targetType: 'database_runtime_override',
        targetCode: input.taskId ?? 'clear',
        actor,
        requestMeta,
        detail: {
          clearOnly: true,
          cleared,
          sourceTaskId: input.taskId,
        },
      })

      return {
        restartRequired: true,
        rollbackMode: 'clear',
        activeOverride: null,
      }
    }

    let sqlitePath = input.sqlitePath?.trim()
    if (!sqlitePath && input.taskId) {
      const task = await this.readTaskRecord(input.taskId, '回退到指定 SQLite')
      sqlitePath = task.source.sqlitePath
    }
    if (!sqlitePath) {
      sqlitePath = currentOverride?.rollbackConfig?.SQLITE_DB_PATH ?? resolveSqliteDatabasePath()
    }

    const payload: DatabaseRuntimeOverrideFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      reason: input.reason?.trim() || DATABASE_MIGRATION_ROLLBACK_REASON_DEFAULT,
      sourceTaskId: input.taskId,
      updatedBy: actor
        ? {
            userId: actor.userId,
            username: actor.username,
            displayName: actor.displayName,
          }
        : null,
      config: {
        DB_TYPE: 'sqlite',
        SQLITE_DB_PATH: sqlitePath,
        DB_SYNC: env.DB_SYNC,
      },
      rollbackConfig: {
        DB_TYPE: 'sqlite',
        SQLITE_DB_PATH: sqlitePath,
        DB_SYNC: env.DB_SYNC,
      },
    }

    const persisted = await writeDatabaseRuntimeOverride(payload)

    await auditService.safeRecord({
      actionType: 'database_migration.rollback_switch',
      actionLabel: '回退数据库切换覆盖配置',
      targetType: 'database_runtime_override',
      targetCode: input.taskId ?? 'sqlite',
      actor,
      requestMeta,
      detail: {
        sqlitePath,
        sourceTaskId: input.taskId,
      },
    })

    return {
      restartRequired: true,
      rollbackMode: 'sqlite_override',
      activeOverride: maskDatabaseRuntimeOverride(persisted),
    }
  }

  async clearRuntimeOverride(
    actor?: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ cleared: boolean; restartRequired: true }> {
    const cleared = await clearDatabaseRuntimeOverride()

    await auditService.safeRecord({
      actionType: 'database_migration.clear_override',
      actionLabel: '清理数据库运行时覆盖配置',
      targetType: 'database_runtime_override',
      targetCode: 'clear',
      actor,
      requestMeta,
      detail: {
        cleared,
      },
    })

    return {
      cleared,
      restartRequired: true,
    }
  }
}

export const databaseMigrationService = new DatabaseMigrationService()
