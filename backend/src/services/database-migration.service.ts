/**
 * 模块说明：backend/src/services/database-migration.service.ts
 * 文件职责：提供 SQLite -> MySQL 迁移预检、任务持久化、全表迁移执行、应用切换与回退能力。
 * 维护说明：本文件是数据库迁移总控入口；若新增实体、调整启动配置或更改覆盖文件结构，必须同步校验这里的预检与执行流程。
 */

import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DataSource, type DataSourceOptions, type EntityMetadata } from 'typeorm'
import { appDataPaths } from '../config/app-data-paths.js'
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
import { databaseMaintenanceModeService } from './database-maintenance-mode.service.js'
import { o2oPreorderService } from './o2o-preorder.service.js'

type MigrationIssueLevel = 'info' | 'warning' | 'error'
type MigrationTaskStatus =
  | 'prechecked'
  | 'queued'
  | 'running'
  | 'restart_pending'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
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

export interface CreateAutomaticSQLiteToMySqlTaskInput {
  target: Omit<MySqlMigrationTargetInput, 'dbSync'>
  note?: string
}

export interface AutomaticMigrationStartupInput {
  taskId: string
  sourceSqlitePath: string
  attempts: number
  createdAt: string
  deferMaintenanceFinish?: boolean
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
  sourceSha256?: string
  targetSha256?: string
  structureMatched?: boolean
  autoIncrementMatched?: boolean
  constraintsMatched?: boolean
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
  mode?: 'manual' | 'automatic'
  resumeCount?: number
  cancelRequestedAt?: string
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
  immutableSnapshotFile?: DatabaseMigrationBackupFile
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
  rollbackResult?: {
    rolledBackAt: string
    sourceSqlitePath: string
    mysqlStartupAttempts: number
    message: string
  }
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
const migrationTaskDir = appDataPaths.migrationTaskDir
const sqliteBackupDir = appDataPaths.migrationBackupDir
const sqliteSnapshotDir = appDataPaths.migrationSnapshotDir
const jsonSnapshotDir = appDataPaths.migrationJsonDir
const migrationSecretDir = appDataPaths.migrationSecretDir
const migrationLockFile = appDataPaths.migrationLockFile
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

function quoteSqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function normalizeCanonicalNumber(value: string): string {
  const normalized = value.trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return normalized
  }
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  const [integerPart, fractionPart = ''] = unsigned.split('.')
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0'
  const fraction = fractionPart.replace(/0+$/, '')
  const numeric = fraction ? `${integer}.${fraction}` : integer
  return negative && numeric !== '0' ? `-${numeric}` : numeric
}

/**
 * 将当前静态实体 CHECK 与 MySQL information_schema 返回值收敛到可严格比较的形式。
 * MySQL 可能补充冗余分组括号、调整关键字大小写，或给字符串增加字符集 introducer；
 * 这些格式差异会被消除。遇到需要依赖分组语义的 OR/NOT/算术表达式时返回 null，
 * 由调用方按约束不一致阻断迁移，避免误判。
 */
function normalizeStaticCheckClause(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const clause = value.trim().replace(/\\'/gu, "'")

  const tokens: string[] = []
  const parentheses: boolean[] = []
  let cursor = 0

  const appendToken = (token: string): void => {
    tokens.push(token)
  }

  while (cursor < clause.length) {
    const character = clause[cursor]
    if (/\s/u.test(character)) {
      cursor += 1
      continue
    }

    if (character === '`') {
      let identifier = ''
      let closed = false
      cursor += 1
      while (cursor < clause.length) {
        if (clause[cursor] === '`' && clause[cursor + 1] === '`') {
          identifier += '`'
          cursor += 2
          continue
        }
        if (clause[cursor] === '`') {
          cursor += 1
          closed = true
          break
        }
        identifier += clause[cursor]
        cursor += 1
      }
      if (!closed) {
        return null
      }
      appendToken(`identifier:${identifier.toLowerCase()}`)
      continue
    }

    if (character === "'") {
      let literal = ''
      let closed = false
      cursor += 1
      while (cursor < clause.length) {
        if (clause[cursor] === "'" && clause[cursor + 1] === "'") {
          literal += "'"
          cursor += 2
          continue
        }
        if (clause[cursor] === "'") {
          cursor += 1
          closed = true
          break
        }
        literal += clause[cursor]
        cursor += 1
      }
      if (!closed) {
        return null
      }
      appendToken(`string:${JSON.stringify(literal)}`)
      continue
    }

    const remaining = clause.slice(cursor)
    const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(remaining)
    if (numberMatch) {
      appendToken(`number:${normalizeCanonicalNumber(numberMatch[0])}`)
      cursor += numberMatch[0].length
      continue
    }

    const wordMatch = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(remaining)
    if (wordMatch) {
      const word = wordMatch[0].toLowerCase()
      cursor += wordMatch[0].length
      let nextCursor = cursor
      while (nextCursor < clause.length && /\s/u.test(clause[nextCursor])) {
        nextCursor += 1
      }
      if (word.startsWith('_') && clause[nextCursor] === "'") {
        continue
      }
      if (['or', 'not', 'between', 'is', 'in', 'like', 'xor'].includes(word)) {
        return null
      }
      appendToken(word === 'and' ? 'keyword:and' : `word:${word}`)
      continue
    }

    const operator = ['>=', '<=', '<>', '!='].find((candidate) => remaining.startsWith(candidate))
    if (operator) {
      appendToken(`operator:${operator === '!=' ? '<>' : operator}`)
      cursor += operator.length
      continue
    }
    if (['=', '>', '<', ','].includes(character)) {
      appendToken(character === ',' ? 'comma' : `operator:${character}`)
      cursor += 1
      continue
    }
    if (['+', '-', '*', '/', '%', '|', '&', '^'].includes(character)) {
      return null
    }
    if (character === '(') {
      const previousToken = tokens[tokens.length - 1]
      const isFunctionCall = typeof previousToken === 'string' && previousToken.startsWith('word:')
      parentheses.push(isFunctionCall)
      if (isFunctionCall) {
        appendToken('left-parenthesis')
      }
      cursor += 1
      continue
    }
    if (character === ')') {
      const isFunctionCall = parentheses.pop()
      if (isFunctionCall === undefined) {
        return null
      }
      if (isFunctionCall) {
        appendToken('right-parenthesis')
      }
      cursor += 1
      continue
    }
    return null
  }

  return parentheses.length === 0 && tokens.length > 0 ? tokens.join('\u001f') : null
}

function normalizeCanonicalDate(value: string): string {
  const match = value.trim().match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z)?$/,
  )
  if (!match) {
    return value
  }
  const milliseconds = (match[3] ?? '').slice(0, 3).padEnd(3, '0')
  return `${match[1]}T${match[2]}.${milliseconds}`
}

function canonicalizeDatabaseValue(
  value: unknown,
  columnType: string,
): string | number | boolean | null {
  if (value === null || value === undefined) {
    return null
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      return String(value)
    }
    // 运行态 MySQL 连接固定按 UTC 解析无时区 DATETIME，与 SQLite/API
    // 的既有时间语义保持一致，哈希也统一使用 UTC 规范形式。
    return normalizeCanonicalDate(value.toISOString())
  }
  if (Buffer.isBuffer(value)) {
    return `base64:${value.toString('base64')}`
  }
  if (typeof value === 'bigint') {
    return normalizeCanonicalNumber(value.toString())
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return String(value)
    }
    return normalizeCanonicalNumber(String(value))
  }
  if (typeof value === 'string') {
    if (/date|time/.test(columnType)) {
      return normalizeCanonicalDate(value)
    }
    if (/int|decimal|numeric|float|double|real|number/.test(columnType)) {
      return normalizeCanonicalNumber(value)
    }
    return value
  }
  if (typeof value === 'boolean') {
    return value
  }
  return JSON.stringify(value)
}

function assertPathInsideDirectory(filePath: string, directoryPath: string, label: string): void {
  const resolvedFilePath = path.resolve(filePath)
  const resolvedDirectoryPath = path.resolve(directoryPath)
  if (
    resolvedFilePath !== resolvedDirectoryPath
    && !resolvedFilePath.startsWith(`${resolvedDirectoryPath}${path.sep}`)
  ) {
    throw new Error(`${label}不在迁移持久化目录内，已拒绝访问`)
  }
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

function parseVersionParts(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isVersionAtLeast(versionParts: [number, number, number], minimumParts: [number, number, number]): boolean {
  for (let index = 0; index < minimumParts.length; index += 1) {
    if (versionParts[index] > minimumParts[index]) {
      return true
    }
    if (versionParts[index] < minimumParts[index]) {
      return false
    }
  }
  return true
}

function buildCheckConstraintSupportIssue(version: string | null): DatabaseMigrationIssue | undefined {
  if (!version) {
    return {
      level: 'warning',
      code: 'target_mysql_version_unknown',
      message: '无法识别目标 MySQL 版本，请确认该版本会强制执行 CHECK 约束，否则业务字段兜底约束可能不会生效。',
    }
  }

  const versionParts = parseVersionParts(version)
  if (!versionParts) {
    return {
      level: 'warning',
      code: 'target_mysql_version_unknown',
      message: `无法解析目标 MySQL 版本 ${version}，请确认该版本会强制执行 CHECK 约束。`,
    }
  }

  const isMariaDb = version.toLowerCase().includes('mariadb')
  const minimumVersion: [number, number, number] = isMariaDb ? [10, 2, 1] : [8, 0, 16]
  if (isVersionAtLeast(versionParts, minimumVersion)) {
    return undefined
  }

  return {
    level: 'error',
    code: 'target_mysql_check_constraint_unsupported',
    message: `目标数据库版本 ${version} 不满足 CHECK 约束强制执行要求，请升级到 ${isMariaDb ? 'MariaDB 10.2.1+' : 'MySQL 8.0.16+'} 后再迁移。`,
  }
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

class AutomaticMigrationCancelledError extends Error {
  constructor() {
    super('自动迁移已由管理员紧急回退取消')
    this.name = 'AutomaticMigrationCancelledError'
  }
}

export class DatabaseMigrationService {
  private readonly cancelledAutomaticTaskIds = new Set<string>()
  private readonly automaticFinalizingTaskIds = new Set<string>()
  private readonly taskWriteQueues = new Map<string, Promise<void>>()

  private assertAutomaticTaskNotCancelled(taskId: string): void {
    if (this.cancelledAutomaticTaskIds.has(taskId)) {
      throw new AutomaticMigrationCancelledError()
    }
  }

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
   * 数据库迁移高危写操作管理员兜底：
   * - 除路由门禁外，服务层统一再校验一次 admin 身份；
   * - 若越权触发，统一写入失败审计，确保 P0 场景可追踪。
   */
  private async assertAdminActor(
    actor: AuthUserContext | undefined,
    requestMeta: RequestMeta | undefined,
    actionType: string,
    actionLabel: string,
  ): Promise<AuthUserContext> {
    if (actor?.role === 'admin') {
      return actor
    }

    await auditService.safeRecord({
      actionType,
      actionLabel: `${actionLabel}（越权拦截）`,
      targetType: 'database_migration',
      targetCode: actionType,
      actor,
      requestMeta,
      resultStatus: 'failed',
      detail: {
        reason: 'role_mismatch',
        requiredRole: 'admin',
        actualRole: actor?.role ?? null,
      },
    })
    throw new BizError('当前账号无权执行该操作', 403)
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
    await fs.mkdir(sqliteSnapshotDir, { recursive: true })
    await fs.mkdir(jsonSnapshotDir, { recursive: true })
    await fs.mkdir(migrationSecretDir, { recursive: true })

    const legacyTaskDir = path.resolve(backendRootDir, 'data', 'migration-tasks')
    if (legacyTaskDir !== migrationTaskDir) {
      const legacyTaskFiles = await fs.readdir(legacyTaskDir).catch(() => [])
      for (const fileName of legacyTaskFiles.filter((name) => name.endsWith('.json'))) {
        const targetPath = path.resolve(migrationTaskDir, fileName)
        try {
          await fs.access(targetPath)
        } catch {
          await fs.copyFile(path.resolve(legacyTaskDir, fileName), targetPath)
        }
      }
    }
  }

  private async writeJsonAtomically(filePath: string, payload: unknown, mode = 0o600): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tempFilePath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(tempFilePath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode,
    })
    try {
      await fs.rename(tempFilePath, filePath)
    } catch {
      await fs.rm(filePath, { force: true })
      await fs.rename(tempFilePath, filePath)
    }
    try {
      await fs.chmod(filePath, mode)
    } catch {
      // Windows 不保证支持 POSIX 权限位；onebox/Linux 会按 0600 收紧敏感文件。
    }
  }

  private getTaskSecretFilePath(taskId: string): string {
    return path.resolve(migrationSecretDir, `${taskId}.json`)
  }

  private async readTaskPassword(taskId: string): Promise<string> {
    try {
      const raw = JSON.parse(await fs.readFile(this.getTaskSecretFilePath(taskId), 'utf8')) as {
        version?: unknown
        taskId?: unknown
        password?: unknown
      }
      if (raw.version !== 1 || raw.taskId !== taskId || typeof raw.password !== 'string') {
        throw new Error('迁移凭据文件结构不合法')
      }
      return raw.password
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return ''
      }
      throw error
    }
  }

  private async writeTaskPassword(taskId: string, password: string): Promise<void> {
    await this.writeJsonAtomically(this.getTaskSecretFilePath(taskId), {
      version: 1,
      taskId,
      password,
      updatedAt: new Date().toISOString(),
    })
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
      extra: {
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
      },
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

  private async countRowsMatching(dataSource: DataSource, tableName: string, whereClause: string): Promise<number> {
    const result = await dataSource.query(
      `SELECT COUNT(1) AS total FROM ${quoteIdentifier(tableName)} WHERE ${whereClause}`,
    )
    return toNumber(this.readFirstField(result, 'total') ?? 0)
  }

  private async collectSourceBusinessConstraintIssues(existingSourceTableNames: string[]): Promise<DatabaseMigrationIssue[]> {
    const existingTableSet = new Set(existingSourceTableNames)
    const checks: Array<{
      tableName: string
      code: string
      message: (count: number) => string
      whereClause: string
    }> = [
      {
        tableName: 'base_product',
        code: 'source_base_product_constraint_dirty',
        message: (count) => `源 SQLite 中有 ${count} 条商品数据不满足库存、价格或折扣率（1.0 至 10.0）约束，请先清理后再迁移到 MySQL。`,
        whereClause:
          '`default_price` < 0 OR `discount_rate` < 1.0 OR `discount_rate` > 10.0 OR `limit_per_user` < 1 OR `current_stock` < 0 OR `pre_ordered_stock` < 0 OR `pre_ordered_stock` > `current_stock`',
      },
      {
        tableName: 'biz_outbound_order',
        code: 'source_outbound_order_constraint_dirty',
        message: (count) => `源 SQLite 中有 ${count} 条出库主单不满足总数、总金额或幂等键约束，请先清理后再迁移到 MySQL。`,
        whereClause:
          "`total_qty` < 0 OR `total_amount` < 0 OR LENGTH(TRIM(COALESCE(`idempotency_key`, ''))) = 0",
      },
      {
        tableName: 'biz_outbound_order_item',
        code: 'source_outbound_order_item_constraint_dirty',
        message: (count) => `源 SQLite 中有 ${count} 条出库明细不满足行号、数量、单价或金额约束，请先清理后再迁移到 MySQL。`,
        whereClause: '`line_no` < 1 OR `qty` <= 0 OR `unit_price` <= 0 OR `line_amount` < 0',
      },
    ]

    const issues: DatabaseMigrationIssue[] = []
    for (const check of checks) {
      if (!existingTableSet.has(check.tableName)) {
        continue
      }
      const dirtyCount = await this.countRowsMatching(AppDataSource, check.tableName, check.whereClause)
      if (dirtyCount > 0) {
        issues.push({
          level: 'error',
          code: check.code,
          message: check.message(dirtyCount),
        })
      }
    }
    return issues
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

    // 防御性日志：
    // 一旦进入损坏占位分支，说明任务文件已不可直接执行；记录关键信息便于运维快速定位与巡检告警。
    console.warn('[database-migration] 检测到损坏任务文件，已返回占位记录。', {
      taskId,
      filePath,
      errorMessage,
    })

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
      const secretPassword = await this.readTaskPassword(taskId)
      if (secretPassword) {
        parsed.target = {
          ...parsed.target,
          password: secretPassword,
        }
      }
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
      const filePath = result.responseTask.recordFilePath ?? path.resolve(migrationTaskDir, `${taskId}.json`)
      throw new BizError(
        `${result.errorMessage}。任务文件：${filePath}。请先尝试以下步骤：1）打开该 JSON 文件修复语法或结构；2）若无法修复可删除该文件并重新创建任务；完成后再${actionLabel}。`,
        409,
      )
    }
    return result.task
  }

  private async writeTaskRecord(task: InternalMigrationTaskRecord): Promise<InternalMigrationTaskRecord> {
    const previousWrite = this.taskWriteQueues.get(task.id) ?? Promise.resolve()
    const currentWrite = previousWrite
      .catch(() => undefined)
      .then(async () => {
        await this.writeTaskRecordWithoutLock(task)
      })
    this.taskWriteQueues.set(task.id, currentWrite)
    try {
      await currentWrite
    } finally {
      if (this.taskWriteQueues.get(task.id) === currentWrite) {
        this.taskWriteQueues.delete(task.id)
      }
    }
    return task
  }

  private async writeTaskRecordWithoutLock(task: InternalMigrationTaskRecord): Promise<void> {
    const filePath = await this.getTaskFilePath(task.id)
    if (task.mode === 'automatic') {
      try {
        const existingTask = JSON.parse(await fs.readFile(filePath, 'utf8')) as InternalMigrationTaskRecord
        if (existingTask.cancelRequestedAt) {
          task.cancelRequestedAt = existingTask.cancelRequestedAt
          if (existingTask.status === 'rolled_back' && task.status !== 'rolled_back') {
            Object.assign(task, existingTask)
            return
          }
        }
      } catch {
        // 新任务尚无文件，或旧文件已损坏；由后续原子写入/调用方校验处理。
      }
    }
    if (task.target.password && task.target.password !== '***') {
      await this.writeTaskPassword(task.id, task.target.password)
    }
    const persistedTask: InternalMigrationTaskRecord = {
      ...task,
      target: {
        ...task.target,
        password: '',
      },
    }
    await this.writeJsonAtomically(filePath, persistedTask)
  }

  private async createSqliteBackupSnapshot(): Promise<{ fileName: string; filePath: string }> {
    this.assertCurrentSourceIsSqlite()
    await this.ensureMigrationDirectories()
    const fileName = `y-link-backup-before-mysql-migration-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.sqlite`
    const filePath = path.resolve(sqliteBackupDir, fileName)
    await fs.rm(filePath, { force: true })
    await AppDataSource.query(`VACUUM INTO ${quoteSqliteStringLiteral(filePath)}`)
    try {
      await fs.chmod(filePath, 0o600)
    } catch {
      // Windows 不保证支持 POSIX 权限位。
    }
    return {
      fileName,
      filePath,
    }
  }

  private async createConsistentSqliteSnapshot(taskId: string): Promise<DatabaseMigrationBackupFile> {
    this.assertCurrentSourceIsSqlite()
    await this.ensureMigrationDirectories()
    const fileName = `${taskId}.sqlite`
    const filePath = path.resolve(sqliteSnapshotDir, fileName)
    await fs.rm(filePath, { force: true })
    await AppDataSource.query(`VACUUM INTO ${quoteSqliteStringLiteral(filePath)}`)
    const integrityRows = this.toQueryRows(await AppDataSource.query('PRAGMA integrity_check'))
    const integrityValue = String(Object.values(integrityRows[0] ?? {})[0] ?? '').toLowerCase()
    if (integrityValue !== 'ok') {
      await fs.rm(filePath, { force: true })
      throw new BizError(`SQLite 一致性检查未通过：${integrityValue || '未知错误'}`, 409)
    }
    try {
      await fs.chmod(filePath, 0o600)
    } catch {
      // Windows 不保证支持 POSIX 权限位。
    }
    return {
      fileName,
      filePath,
      fileSizeBytes: await this.statFileSize(filePath),
    }
  }

  private createSqliteSnapshotDataSource(snapshotFilePath: string, includeEntities = true): DataSource {
    return new DataSource({
      type: 'sqlite',
      database: snapshotFilePath,
      entities: includeEntities ? appEntities : [],
      synchronize: false,
      logging: false,
    })
  }

  private async listTableColumnNames(dataSource: DataSource, tableName: string): Promise<string[]> {
    if (dataSource.options.type === 'sqlite') {
      const rows = this.toQueryRows(await dataSource.query(`PRAGMA table_info(${quoteIdentifier(tableName)})`))
      return sortTextList(
        rows
          .map((row) => this.readStringField(row, 'name'))
          .filter((value): value is string => Boolean(value)),
      )
    }
    const rows = await dataSource.query(
      `
        SELECT column_name AS columnName
        FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position
      `,
      [dataSource.options.database, tableName],
    )
    return this.extractSortedStringFieldList(rows, 'columnName')
  }

  private async assertStrictSourceSchema(
    snapshotDataSource: DataSource,
    providedMetadatas?: EntityMetadata[],
  ): Promise<void> {
    const integrityRows = this.toQueryRows(await snapshotDataSource.query('PRAGMA integrity_check'))
    const integrityResults = integrityRows.flatMap((row) => Object.values(row))
      .map((value) => String(value).trim().toLowerCase())
    if (integrityResults.length !== 1 || integrityResults[0] !== 'ok') {
      throw new BizError(
        `SQLite 源库完整性检查失败：${integrityResults.filter(Boolean).join('；') || '未返回有效结果'}`,
        409,
      )
    }

    const expectedMetadatas = providedMetadatas ?? this.resolveOrderedEntityMetadatas(snapshotDataSource)
    const expectedTableNames = sortTextList(expectedMetadatas.map((metadata) => metadata.tableName))
    const actualTableNames = await this.listExistingTableNames(snapshotDataSource)
    const unknownTables = actualTableNames.filter((tableName) => !expectedTableNames.includes(tableName))
    const missingTables = expectedTableNames.filter((tableName) => !actualTableNames.includes(tableName))
    if (unknownTables.length || missingTables.length) {
      throw new BizError(
        `SQLite 源库结构不符合自动迁移白名单：未知表 ${unknownTables.join('、') || '无'}；缺失表 ${missingTables.join('、') || '无'}`,
        409,
      )
    }

    for (const metadata of expectedMetadatas) {
      const expectedColumns = sortTextList(metadata.columns.map((column) => column.databaseName))
      const actualColumns = await this.listTableColumnNames(snapshotDataSource, metadata.tableName)
      const unknownColumns = actualColumns.filter((columnName) => !expectedColumns.includes(columnName))
      const missingColumns = expectedColumns.filter((columnName) => !actualColumns.includes(columnName))
      if (unknownColumns.length || missingColumns.length) {
        throw new BizError(
          `SQLite 表 ${metadata.tableName} 字段不符合自动迁移白名单：未知字段 ${unknownColumns.join('、') || '无'}；缺失字段 ${missingColumns.join('、') || '无'}`,
          409,
        )
      }
    }

    const foreignKeyFailures = this.toQueryRows(await snapshotDataSource.query('PRAGMA foreign_key_check'))
    if (foreignKeyFailures.length > 0) {
      throw new BizError(`SQLite 源库存在 ${foreignKeyFailures.length} 条外键完整性异常`, 409)
    }
  }

  private async forEachTableBatch(
    dataSource: DataSource,
    metadata: EntityMetadata,
    callback: (rows: QueryRow[]) => Promise<void>,
  ): Promise<number> {
    if (metadata.primaryColumns.length !== 1) {
      throw new BizError(`表 ${metadata.tableName} 不满足单主键游标迁移要求`, 409)
    }
    const primaryKey = metadata.primaryColumns[0].databaseName
    let lastPrimaryKey: unknown
    let totalRows = 0

    while (true) {
      const whereClause = lastPrimaryKey === undefined ? '' : `WHERE ${quoteIdentifier(primaryKey)} > ?`
      const parameters = lastPrimaryKey === undefined
        ? [MIGRATION_BATCH_SIZE]
        : [lastPrimaryKey, MIGRATION_BATCH_SIZE]
      const rows = this.toQueryRows(
        await dataSource.query(
          `
            SELECT *
            FROM ${quoteIdentifier(metadata.tableName)}
            ${whereClause}
            ORDER BY ${quoteIdentifier(primaryKey)}
            LIMIT ?
          `,
          parameters,
        ),
      )
      if (rows.length === 0) {
        break
      }
      await callback(rows)
      totalRows += rows.length
      lastPrimaryKey = rows[rows.length - 1][primaryKey]
      if (lastPrimaryKey === undefined || lastPrimaryKey === null) {
        throw new BizError(`表 ${metadata.tableName} 的主键游标为空，无法继续自动迁移`, 409)
      }
    }
    return totalRows
  }

  private async createStreamingJsonSnapshotBackup(
    snapshotDataSource: DataSource,
    orderedMetadatas: EntityMetadata[],
    sourceTableStats: DatabaseMigrationTableStat[],
    taskId: string,
  ): Promise<DatabaseMigrationBackupFile> {
    await this.ensureMigrationDirectories()
    const fileName = `${taskId}.json`
    const filePath = path.resolve(jsonSnapshotDir, fileName)
    const fileHandle = await fs.open(filePath, 'w', 0o600)
    try {
      await fileHandle.write(
        `${JSON.stringify({
          exportedAt: new Date().toISOString(),
          version: 'sqlite-to-mysql-automatic-snapshot-v2',
          tableStats: sourceTableStats,
        }).replace(/}$/, '')},"tables":{`,
      )
      for (let tableIndex = 0; tableIndex < orderedMetadatas.length; tableIndex += 1) {
        const metadata = orderedMetadatas[tableIndex]
        await fileHandle.write(`${tableIndex > 0 ? ',' : ''}${JSON.stringify(metadata.tableName)}:[`)
        let firstRow = true
        await this.forEachTableBatch(snapshotDataSource, metadata, async (rows) => {
          this.assertAutomaticTaskNotCancelled(taskId)
          for (const row of rows) {
            await fileHandle.write(`${firstRow ? '' : ','}${JSON.stringify(row)}`)
            firstRow = false
          }
        })
        await fileHandle.write(']')
      }
      await fileHandle.write('}}')
    } catch (error) {
      await fileHandle.close()
      await fs.rm(filePath, { force: true })
      throw error
    }
    await fileHandle.close()
    try {
      await fs.chmod(filePath, 0o600)
    } catch {
      // Windows 不保证支持 POSIX 权限位。
    }
    return {
      fileName,
      filePath,
      fileSizeBytes: await this.statFileSize(filePath),
    }
  }

  private async calculateTableSha256(
    dataSource: DataSource,
    metadata: EntityMetadata,
    taskId?: string,
  ): Promise<string> {
    const hash = createHash('sha256')
    const orderedColumns = [...metadata.columns].sort((left, right) =>
      compareText(left.databaseName, right.databaseName))
    await this.forEachTableBatch(dataSource, metadata, async (rows) => {
      if (taskId) {
        this.assertAutomaticTaskNotCancelled(taskId)
      }
      for (const row of rows) {
        const canonicalRow = orderedColumns.map((column) => [
          column.databaseName,
          canonicalizeDatabaseValue(
            row[column.databaseName],
            typeof column.type === 'function' ? column.type.name.toLowerCase() : String(column.type).toLowerCase(),
          ),
        ])
        hash.update(JSON.stringify(canonicalRow))
        hash.update('\n')
      }
    })
    return hash.digest('hex')
  }

  private async migrateSingleTableByPrimaryKey(
    sourceDataSource: DataSource,
    targetDataSource: DataSource,
    metadata: EntityMetadata,
    taskId?: string,
  ): Promise<DatabaseMigrationTableStat> {
    const columnNames = metadata.columns.map((column) => column.databaseName)
    const targetColumnNames = await this.listTableColumnNames(targetDataSource, metadata.tableName)
    const expectedColumnNames = sortTextList(columnNames)
    if (
      expectedColumnNames.length !== targetColumnNames.length
      || expectedColumnNames.some((columnName, index) => columnName !== targetColumnNames[index])
    ) {
      throw new BizError(`目标 MySQL 表 ${metadata.tableName} 字段结构与源实体不一致`, 409)
    }

    const queryRunner = targetDataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()
    try {
      const importedRows = await this.forEachTableBatch(sourceDataSource, metadata, async (rows) => {
        if (taskId) {
          this.assertAutomaticTaskNotCancelled(taskId)
        }
        const rowPlaceholder = `(${columnNames.map(() => '?').join(',')})`
        const sql = `
          INSERT INTO ${quoteIdentifier(metadata.tableName)}
          (${columnNames.map(quoteIdentifier).join(',')})
          VALUES ${rows.map(() => rowPlaceholder).join(',')}
        `
        const parameters = rows.flatMap((row) => columnNames.map((columnName) => row[columnName]))
        await queryRunner.query(sql, parameters)
      })
      await queryRunner.commitTransaction()
      return {
        tableName: metadata.tableName,
        rowCount: importedRows,
      }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      throw error
    } finally {
      await queryRunner.release()
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

  private async validateAutomaticMigration(
    sourceDataSource: DataSource,
    targetDataSource: DataSource,
    orderedMetadatas: EntityMetadata[],
    taskId?: string,
  ): Promise<DatabaseMigrationValidationResult> {
    const items: DatabaseMigrationValidationItem[] = []
    for (const metadata of orderedMetadatas) {
      if (taskId) {
        this.assertAutomaticTaskNotCancelled(taskId)
      }
      const expectedColumns = sortTextList(metadata.columns.map((column) => column.databaseName))
      const targetColumns = await this.listTableColumnNames(targetDataSource, metadata.tableName)
      const structureMatched =
        expectedColumns.length === targetColumns.length
        && expectedColumns.every((columnName, index) => columnName === targetColumns[index])
      const sourceRowCount = await this.countTableRows(sourceDataSource, metadata.tableName)
      const targetRowCount = await this.countTableRows(targetDataSource, metadata.tableName)
      const sourceSha256 = await this.calculateTableSha256(sourceDataSource, metadata, taskId)
      const targetSha256 = await this.calculateTableSha256(targetDataSource, metadata, taskId)
      const constraintsMatched = await this.validateTargetConstraintNames(targetDataSource, metadata)

      const primaryColumn = metadata.primaryColumns.length === 1 ? metadata.primaryColumns[0] : null
      let autoIncrementMatched = true
      if (primaryColumn?.isGenerated) {
        const maxRows = await targetDataSource.query(
          `SELECT MAX(${quoteIdentifier(primaryColumn.databaseName)}) AS maxId FROM ${quoteIdentifier(metadata.tableName)}`,
        )
        const maximumId = toNumber(this.readFirstField(maxRows, 'maxId') ?? 0)
        const autoIncrementRows = await targetDataSource.query(
          `
            SELECT auto_increment AS autoIncrement
            FROM information_schema.tables
            WHERE table_schema = ? AND table_name = ?
          `,
          [targetDataSource.options.database, metadata.tableName],
        )
        const nextIdRaw = this.readFirstField(autoIncrementRows, 'autoIncrement')
        const nextId = nextIdRaw === null || nextIdRaw === undefined ? 1 : toNumber(nextIdRaw)
        autoIncrementMatched = nextId > maximumId
      }

      items.push({
        tableName: metadata.tableName,
        sourceRowCount,
        targetRowCount,
        sourceSha256,
        targetSha256,
        structureMatched,
        autoIncrementMatched,
        constraintsMatched,
        matched:
          sourceRowCount === targetRowCount
          && sourceSha256 === targetSha256
          && structureMatched
          && autoIncrementMatched
          && constraintsMatched,
        blocking: true,
      })
    }

    for (const metadata of orderedMetadatas) {
      if (taskId) {
        this.assertAutomaticTaskNotCancelled(taskId)
      }
      const checkRows = this.toQueryRows(
        await targetDataSource.query(`CHECK TABLE ${quoteIdentifier(metadata.tableName)} FOR UPGRADE`),
      )
      const hasCheckError = checkRows.some((row) => {
        const messageType = this.readStringField(row, 'Msg_type')?.toLowerCase()
        return messageType === 'error'
      })
      const hasSuccessfulCheckStatus = checkRows.some((row) => {
        const messageType = this.readStringField(row, 'Msg_type')?.toLowerCase()
        const messageText = this.readStringField(row, 'Msg_text')?.trim().toLowerCase()
        return (
          messageType === 'status' &&
          (messageText === 'ok' || messageText === 'table is already up to date')
        )
      })
      if (hasCheckError || !hasSuccessfulCheckStatus) {
        const checkSummary = checkRows
          .map((row) => {
            const messageType = this.readStringField(row, 'Msg_type') ?? 'unknown'
            const messageText = this.readStringField(row, 'Msg_text') ?? 'unknown'
            return `${messageType}:${messageText}`
          })
          .join('；')
        throw new BizError(
          `目标 MySQL 表 ${metadata.tableName} 完整性检查未通过：${checkSummary || '未返回检查结果'}`,
          409,
        )
      }
    }

    const sourceTotalRows = items.reduce((sum, item) => sum + item.sourceRowCount, 0)
    const targetTotalRows = items.reduce((sum, item) => sum + item.targetRowCount, 0)
    const passed = items.every((item) => item.matched)
    return {
      checkedAt: new Date().toISOString(),
      passed,
      blockingFailure: !passed,
      sourceTotalRows,
      targetTotalRows,
      items,
    }
  }

  private async validateTargetConstraintNames(
    targetDataSource: DataSource,
    metadata: EntityMetadata,
  ): Promise<boolean> {
    const normalizeNames = (names: Array<string | undefined>): string[] => sortTextList(
      names
        .filter((name): name is string => Boolean(name))
        .map((name) => name.toLowerCase()),
    )
    const expectedUniqueNames = normalizeNames(
      metadata.indices.filter((index) => index.isUnique).map((index) => index.name),
    )
    const expectedForeignKeyNames = normalizeNames(metadata.foreignKeys.map((foreignKey) => foreignKey.name))
    const expectedChecks = new Map<string, string>()
    for (const check of metadata.checks) {
      if (!check.name || typeof check.expression !== 'string') {
        return false
      }
      const normalizedClause = normalizeStaticCheckClause(check.expression)
      if (!normalizedClause) {
        return false
      }
      expectedChecks.set(check.name.toLowerCase(), normalizedClause)
    }

    const uniqueRows = await targetDataSource.query(
      `
        SELECT DISTINCT index_name AS constraintName
        FROM information_schema.statistics
        WHERE table_schema = ?
          AND table_name = ?
          AND non_unique = 0
          AND index_name <> 'PRIMARY'
      `,
      [targetDataSource.options.database, metadata.tableName],
    )
    const foreignKeyRows = await targetDataSource.query(
      `
        SELECT DISTINCT constraint_name AS constraintName
        FROM information_schema.key_column_usage
        WHERE table_schema = ?
          AND table_name = ?
          AND referenced_table_name IS NOT NULL
      `,
      [targetDataSource.options.database, metadata.tableName],
    )
    const checkRows = await targetDataSource.query(
      `
        SELECT
          tc.constraint_name AS constraintName,
          cc.check_clause AS checkClause
        FROM information_schema.table_constraints tc
        INNER JOIN information_schema.check_constraints cc
          ON cc.constraint_catalog = tc.constraint_catalog
         AND cc.constraint_schema = tc.constraint_schema
         AND cc.constraint_name = tc.constraint_name
        WHERE tc.table_schema = ?
          AND tc.table_name = ?
          AND tc.constraint_type = 'CHECK'
      `,
      [targetDataSource.options.database, metadata.tableName],
    )
    const extractNames = (rows: unknown): string[] => normalizeNames(
      this.toQueryRows(rows).map((row) => this.readStringField(row, 'constraintName')),
    )
    const actualCheckRows = this.toQueryRows(checkRows)
    const actualChecks = new Map<string, string>()
    for (const row of actualCheckRows) {
      const constraintName = this.readStringField(row, 'constraintName')?.toLowerCase()
      const normalizedClause = normalizeStaticCheckClause(this.readStringField(row, 'checkClause'))
      if (!constraintName || !normalizedClause || actualChecks.has(constraintName)) {
        return false
      }
      actualChecks.set(constraintName, normalizedClause)
    }
    const checkConstraintsMatched = (
      expectedChecks.size === actualChecks.size
      && [...expectedChecks].every(([constraintName, expectedClause]) => (
        actualChecks.get(constraintName) === expectedClause
      ))
    )
    return (
      JSON.stringify(expectedUniqueNames) === JSON.stringify(extractNames(uniqueRows))
      && JSON.stringify(expectedForeignKeyNames) === JSON.stringify(extractNames(foreignKeyRows))
      && checkConstraintsMatched
    )
  }

  private assertAutomaticMigrationEnabled(): void {
    if (process.env.Y_LINK_AUTOMATIC_DB_MIGRATION_ENABLED !== 'true') {
      throw new BizError('当前部署不是受 onebox 重启守护的环境，已禁用一键自动迁移', 409)
    }
  }

  private async acquireAutomaticMigrationLock(taskId: string): Promise<void> {
    await this.ensureMigrationDirectories()
    let handle: Awaited<ReturnType<typeof fs.open>>
    try {
      handle = await fs.open(migrationLockFile, 'wx', 0o600)
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'EEXIST'
      ) {
        throw new BizError('已有自动数据库迁移任务正在执行或等待重启验收', 409)
      }
      throw error
    }
    try {
      await handle.writeFile(JSON.stringify({
        version: 1,
        taskId,
        acquiredAt: new Date().toISOString(),
        pid: process.pid,
      }, null, 2))
      await handle.sync()
    } catch (error) {
      await fs.rm(migrationLockFile, { force: true }).catch(() => undefined)
      throw error
    } finally {
      await handle.close()
    }
  }

  private async releaseAutomaticMigrationLock(taskId: string): Promise<void> {
    try {
      const serializedLock = await fs.readFile(migrationLockFile, 'utf8')
      let lockTaskId: unknown
      try {
        lockTaskId = (JSON.parse(serializedLock) as { taskId?: unknown }).taskId
      } catch {
        const maintenanceTaskId = databaseMaintenanceModeService.getActiveTaskId()
        if (maintenanceTaskId && maintenanceTaskId !== taskId) {
          return
        }
        await fs.rm(migrationLockFile, { force: true })
        return
      }
      if (lockTaskId !== taskId) {
        return
      }
      await fs.rm(migrationLockFile, { force: true })
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.warn('[database-migration] 释放自动迁移锁失败', {
          taskId,
          errorMessage: formatUnknownErrorMessage(error),
        })
      }
    }
  }

  private async verifyMySqlAutomaticPermissions(targetDataSource: DataSource): Promise<void> {
    const privilegeRows = this.toQueryRows(await targetDataSource.query(
      `
        SELECT table_schema AS schemaName, privilege_type AS privilegeType
        FROM information_schema.schema_privileges
        WHERE grantee = CONCAT(
            QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', 1)),
            '@',
            QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', -1))
          )
        UNION
        SELECT NULL AS schemaName, privilege_type AS privilegeType
        FROM information_schema.user_privileges
        WHERE grantee = CONCAT(
          QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', 1)),
          '@',
          QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', -1))
        )
      `,
    ))
    const targetDatabase = String(targetDataSource.options.database ?? '')
    const grantedPrivileges = new Set(
      privilegeRows
        .filter((row) => {
          const schemaName = this.readStringField(row, 'schemaName')
          if (!schemaName) {
            return true
          }
          return schemaName.replace(/\\([\\_%])/g, '$1') === targetDatabase
        })
        .map((row) => this.readStringField(row, 'privilegeType')?.toUpperCase())
        .filter((value): value is string => Boolean(value)),
    )
    const requiredPrivileges = [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'CREATE',
      'DROP',
      'ALTER',
      'INDEX',
      'REFERENCES',
      'CREATE TEMPORARY TABLES',
    ]
    const missingPrivileges = requiredPrivileges.filter((privilege) => !grantedPrivileges.has(privilege))
    if (missingPrivileges.length > 0) {
      throw new BizError(`目标 MySQL 账号缺少自动迁移权限：${missingPrivileges.join('、')}`, 409)
    }

    const probeTableName = `_y_link_migration_permission_probe_${process.pid}_${Date.now()}`
    try {
      await targetDataSource.query(
        `CREATE TABLE ${quoteIdentifier(probeTableName)} (id BIGINT NOT NULL PRIMARY KEY, value_text VARCHAR(32) NULL)`,
      )
      await targetDataSource.query(
        `INSERT INTO ${quoteIdentifier(probeTableName)} (id, value_text) VALUES (1, 'probe')`,
      )
      await targetDataSource.query(
        `ALTER TABLE ${quoteIdentifier(probeTableName)} ADD INDEX ${quoteIdentifier(`${probeTableName}_idx`)} (value_text)`,
      )
      await targetDataSource.query(
        `UPDATE ${quoteIdentifier(probeTableName)} SET value_text = 'verified' WHERE id = 1`,
      )
      await targetDataSource.query(`DELETE FROM ${quoteIdentifier(probeTableName)} WHERE id = 1`)
    } finally {
      await targetDataSource.query(`DROP TABLE IF EXISTS ${quoteIdentifier(probeTableName)}`).catch(() => undefined)
    }
  }

  private async assertAutomaticTargetReady(target: MySqlMigrationTargetInput): Promise<void> {
    const targetDataSource = this.createMysqlDataSource(target)
    try {
      await targetDataSource.initialize()
      const versionRows = await targetDataSource.query('SELECT VERSION() AS version')
      const version = this.readStringField(this.toQueryRows(versionRows)[0] ?? {}, 'version')
      const versionParts = version ? parseVersionParts(version) : null
      if (!version || !versionParts || version.toLowerCase().includes('mariadb') || !isVersionAtLeast(versionParts, [8, 0, 16])) {
        throw new BizError(`一键自动迁移要求 MySQL 8.0.16+，当前版本为 ${version || '未知'}`, 409)
      }
      const schemaInfo = await this.inspectMySqlSchemaCharset(targetDataSource)
      if (!schemaInfo.databaseExists) {
        throw new BizError('目标 MySQL 数据库不存在，请由运维预先创建独立空库', 409)
      }
      if (schemaInfo.defaultCharset !== 'utf8mb4') {
        throw new BizError(`一键自动迁移要求目标数据库使用 utf8mb4，当前为 ${schemaInfo.defaultCharset || '未知'}`, 409)
      }
      const existingTables = await this.listExistingTableNames(targetDataSource)
      if (existingTables.length > 0) {
        throw new BizError(`一键自动迁移只允许独立空库，当前已存在表：${existingTables.join('、')}`, 409)
      }
      await this.verifyMySqlAutomaticPermissions(targetDataSource)
    } finally {
      if (targetDataSource.isInitialized) {
        await targetDataSource.destroy()
      }
    }
  }

  private async prepareOwnedAutomaticTarget(
    targetDataSource: DataSource,
    taskId: string,
    retrying: boolean,
    expectedTableNames: string[],
  ): Promise<void> {
    const ownerTableName = '_y_link_migration_owner'
    const existingTables = await this.listExistingTableNames(targetDataSource)
    if (retrying) {
      if (!existingTables.includes(ownerTableName)) {
        throw new BizError('目标库缺少本任务所有权标记，禁止自动清理或续跑', 409)
      }
      const ownerRows = this.toQueryRows(
        await targetDataSource.query(
          `SELECT task_id AS taskId FROM ${quoteIdentifier(ownerTableName)} LIMIT 1`,
        ),
      )
      if (this.readStringField(ownerRows[0] ?? {}, 'taskId') !== taskId) {
        throw new BizError('目标库由其他迁移任务占用，禁止自动清理或续跑', 409)
      }
      const unexpectedTables = existingTables.filter(
        (tableName) => tableName !== ownerTableName && !expectedTableNames.includes(tableName),
      )
      if (unexpectedTables.length > 0) {
        throw new BizError(`目标库出现非本任务结构，禁止自动清理：${unexpectedTables.join('、')}`, 409)
      }
      const queryRunner = targetDataSource.createQueryRunner()
      await queryRunner.connect()
      try {
        await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0')
        for (const tableName of existingTables) {
          if (tableName !== ownerTableName) {
            await queryRunner.query(`DROP TABLE ${quoteIdentifier(tableName)}`)
          }
        }
      } finally {
        try {
          await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1')
        } finally {
          await queryRunner.release()
        }
      }
      return
    }

    if (existingTables.length > 0) {
      throw new BizError(`目标库不再为空，已禁止开始自动迁移：${existingTables.join('、')}`, 409)
    }
    await targetDataSource.query(`
      CREATE TABLE ${quoteIdentifier(ownerTableName)} (
        task_id VARCHAR(100) NOT NULL PRIMARY KEY,
        created_at DATETIME(3) NOT NULL
      )
    `)
    await targetDataSource.query(
      `INSERT INTO ${quoteIdentifier(ownerTableName)} (task_id, created_at) VALUES (?, ?)`,
      [taskId, new Date()],
    )
  }

  private async clearAutomaticTargetOwnerMarker(
    targetDataSource: DataSource,
    taskId: string,
    allowMissing = false,
  ): Promise<void> {
    const ownerTableName = '_y_link_migration_owner'
    const existingTables = await this.listExistingTableNames(targetDataSource)
    if (!existingTables.includes(ownerTableName)) {
      if (allowMissing) {
        return
      }
      throw new BizError('目标库所有权标记不存在，禁止完成自动切换', 409)
    }
    await this.assertAutomaticTargetOwnerMarker(targetDataSource, taskId)
    await targetDataSource.query(`DROP TABLE ${quoteIdentifier(ownerTableName)}`)
  }

  private async assertAutomaticTargetOwnerMarker(
    targetDataSource: DataSource,
    taskId: string,
  ): Promise<void> {
    const ownerTableName = '_y_link_migration_owner'
    const existingTables = await this.listExistingTableNames(targetDataSource)
    if (!existingTables.includes(ownerTableName)) {
      throw new BizError('目标库所有权标记不存在，禁止完成自动切换', 409)
    }
    const ownerRows = this.toQueryRows(
      await targetDataSource.query(
        `SELECT task_id AS taskId FROM ${quoteIdentifier(ownerTableName)} LIMIT 1`,
      ),
    )
    if (this.readStringField(ownerRows[0] ?? {}, 'taskId') !== taskId) {
      throw new BizError('目标库所有权标记异常，禁止完成自动切换', 409)
    }
  }

  private async runMysqlSchemaWorker(
    target: MySqlMigrationTargetInput,
    mode: 'initialize' | 'verify' = 'initialize',
  ): Promise<void> {
    const workerFilePath = path.resolve(backendRootDir, 'dist', 'commands', 'prepare-mysql-migration-schema.js')
    try {
      await fs.access(workerFilePath)
    } catch {
      throw new BizError('自动迁移建表子进程不存在，请先构建 onebox 后端产物', 500)
    }

    const workerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
      Y_LINK_MYSQL_SCHEMA_WORKER: 'true',
      Y_LINK_MYSQL_SCHEMA_WORKER_MODE: mode,
      DB_TYPE: 'mysql',
      DB_HOST: target.host,
      DB_PORT: String(target.port),
      DB_USER: target.user,
      DB_PASSWORD: target.password,
      DB_NAME: target.database,
      DB_SYNC: 'false',
    }
    delete workerEnv.APP_PROFILE
    delete workerEnv.ENV_FILE

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [workerFilePath], {
        cwd: backendRootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: workerEnv,
        windowsHide: true,
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${String(chunk)}`.slice(-8_000)
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) {
          resolve()
          return
        }
        const sanitizedError = target.password
          ? stderr.replaceAll(target.password, '***')
          : stderr
        reject(new Error(sanitizedError.trim() || `MySQL 建表子进程退出码 ${String(code)}`))
      })
    })
  }

  private isAutomaticMigrationE2EEnabled(): boolean {
    return env.APP_PROFILE === 'verify-db-migration'
      && process.env.Y_LINK_DB_MIGRATION_E2E === 'true'
  }

  private async maybeInterruptAutomaticMigrationE2E(attempt: number): Promise<void> {
    if (
      !this.isAutomaticMigrationE2EEnabled()
      || process.env.Y_LINK_DB_MIGRATION_E2E_INTERRUPT_ONCE !== 'true'
      || attempt !== 0
    ) {
      return
    }
    const markerFilePath = path.resolve(appDataPaths.runtimeDir, 'e2e-migration-interrupted-once')
    await fs.mkdir(appDataPaths.runtimeDir, { recursive: true })
    try {
      const markerHandle = await fs.open(markerFilePath, 'wx', 0o600)
      await markerHandle.close()
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        return
      }
      throw error
    }
    process.exit(75)
  }

  private async maybeTamperAutomaticMigrationE2E(
    targetDataSource: DataSource,
    orderedMetadatas: EntityMetadata[],
  ): Promise<void> {
    if (
      !this.isAutomaticMigrationE2EEnabled()
      || process.env.Y_LINK_DB_MIGRATION_E2E_TAMPER_TARGET !== 'true'
    ) {
      return
    }
    const systemConfigMetadata = orderedMetadatas.find((metadata) => metadata.tableName === 'system_configs')
    const primaryColumn = systemConfigMetadata?.primaryColumns[0]
    const valueColumn = systemConfigMetadata?.columns.find((column) => column.databaseName === 'config_value')
    if (!systemConfigMetadata || !primaryColumn || !valueColumn) {
      throw new Error('隔离验收无法定位 system_configs 内容篡改字段')
    }
    await targetDataSource.query(
      `
        UPDATE ${quoteIdentifier(systemConfigMetadata.tableName)}
        SET ${quoteIdentifier(valueColumn.databaseName)} = CONCAT(
          ${quoteIdentifier(valueColumn.databaseName)},
          '-e2e-tampered'
        )
        ORDER BY ${quoteIdentifier(primaryColumn.databaseName)}
        LIMIT 1
      `,
    )
  }

  private async maybeDelayAutomaticMigrationFinalizerE2E(taskId: string): Promise<void> {
    if (!this.isAutomaticMigrationE2EEnabled()) {
      return
    }
    const delayMs = Number(process.env.Y_LINK_DB_MIGRATION_E2E_VERIFY_DELAY_MS ?? '0')
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
      throw new Error('自动迁移 E2E 重启后验收延迟必须是 0 到 30000 毫秒的整数')
    }
    const deadline = Date.now() + delayMs
    while (Date.now() < deadline) {
      this.assertAutomaticTaskNotCancelled(taskId)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())))
      })
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
    const queryRunner = targetDataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      if (targetDataSource.options.type === 'mysql') {
        await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0')
      }
      for (const metadata of reversedMetadatas) {
        await queryRunner.query(`DELETE FROM ${quoteIdentifier(metadata.tableName)}`)
      }
    } finally {
      try {
        if (targetDataSource.options.type === 'mysql') {
          await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1')
        }
      } finally {
        await queryRunner.release()
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
    issues.push(...(await this.collectSourceBusinessConstraintIssues(existingSourceTableNames)))
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
      const targetVersion = this.readStringField(this.toQueryRows(versionRows)[0] ?? {}, 'version') ?? null
      const targetSchemaInfo = await this.inspectMySqlSchemaCharset(targetDataSource)
      const targetExistingAppTables = await this.collectMySqlExistingAppTableStats(targetDataSource)
      const targetState = this.collectTargetPrecheckIssues(
        input,
        expectedTableNames,
        targetSchemaInfo,
        targetExistingAppTables,
      )
      const checkConstraintSupportIssue = buildCheckConstraintSupportIssue(targetVersion)
      if (checkConstraintSupportIssue) {
        targetState.issues.push(checkConstraintSupportIssue)
      }

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
        targetVersion,
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
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'database_migration.create_task', '创建 SQLite 转 MySQL 迁移任务')
    const precheck = await this.buildPrecheck({
      target: input.target,
      allowTargetWithData: input.allowTargetWithData ?? false,
    })

    const now = new Date().toISOString()
    const task: InternalMigrationTaskRecord = {
      id: createTaskId(),
      status: precheck.canProceed ? 'prechecked' : 'failed',
      mode: 'manual',
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
      actor: adminActor,
      requestMeta,
      detail: {
        target: sanitizeMysqlTarget(task.target),
        canProceed: precheck.canProceed,
        issues: precheck.issues,
      },
    })

    return this.sanitizeTaskRecord(task)
  }

  async createAutomaticSQLiteToMySqlTask(
    input: CreateAutomaticSQLiteToMySqlTaskInput,
    actor?: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<SQLiteToMySqlTaskRecord> {
    const adminActor = await this.assertAdminActor(
      actor,
      requestMeta,
      'database_migration.create_automatic_task',
      '创建一键自动数据库迁移任务',
    )
    this.assertAutomaticMigrationEnabled()
    this.assertCurrentSourceIsSqlite()
    if (readDatabaseRuntimeOverride()) {
      throw new BizError('检测到已有数据库运行时覆盖配置，请先完成回退或清理后再执行一键迁移', 409)
    }

    const taskId = createTaskId()
    await this.acquireAutomaticMigrationLock(taskId)
    try {
      const target: MySqlMigrationTargetInput = {
        ...input.target,
        dbSync: false,
      }
      const sourceSummary = await this.buildSourcePrecheckSummary()
      const precheck: SQLiteToMySqlPrecheckResult = {
        canProceed: false,
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
          host: target.host,
          port: target.port,
          user: target.user,
          database: target.database,
          version: null,
          reachable: false,
          databaseExists: false,
          existingAppTables: [],
          missingAppTables: sourceSummary.expectedTableNames,
          schemaReady: false,
          needsSchemaInitialization: true,
          totalRows: 0,
        },
        issues: [{
          level: 'info',
          code: 'automatic_precheck_queued',
          message: '自动迁移任务已受理，后台状态机将执行完整预检。',
        }],
        activeRuntimeOverride: null,
      }

      const now = new Date().toISOString()
      const task: InternalMigrationTaskRecord = {
        id: taskId,
        mode: 'automatic',
        status: 'queued',
        resumeCount: 0,
        createdAt: now,
        updatedAt: now,
        note: input.note?.trim() || undefined,
        source: {
          sqlitePath: precheck.source.sqlitePath,
        },
        target,
        options: {
          allowTargetWithData: false,
          initializeSchema: true,
          clearTargetBeforeImport: false,
          switchAfterSuccess: true,
          createSqliteBackup: true,
        },
        precheck,
        progress: {
          currentStage: '自动迁移任务已排队，正在等待进入只读维护',
          tableResults: [],
        },
      }
      await this.writeTaskRecord(task)
      await auditService.safeRecord({
        actionType: 'database_migration.create_automatic_task',
        actionLabel: '创建一键自动数据库迁移任务',
        targetType: 'database_migration',
        targetId: task.id,
        targetCode: task.id,
        actor: adminActor,
        requestMeta,
        detail: {
          target: sanitizeMysqlTarget(target),
          dbSync: false,
        },
      })
      return this.sanitizeTaskRecord(task)
    } catch (error) {
      await this.releaseAutomaticMigrationLock(taskId)
      throw error
    }
  }

  private async updateAutomaticTaskStage(
    task: InternalMigrationTaskRecord,
    phase: string,
    currentStage: string,
  ): Promise<void> {
    this.assertAutomaticTaskNotCancelled(task.id)
    await databaseMaintenanceModeService.updatePhase(phase)
    await this.updateTaskStage(task, currentStage)
  }

  async runAutomaticSQLiteToMySqlTask(
    taskId: string,
    actor?: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<void> {
    const adminActor = await this.assertAdminActor(
      actor,
      requestMeta,
      'database_migration.run_automatic_task',
      '执行一键自动数据库迁移任务',
    )
    const task = await this.readTaskRecord(taskId, '执行一键自动迁移任务')
    if (task.mode !== 'automatic' || !['queued', 'running'].includes(task.status)) {
      throw new BizError('自动迁移任务状态不允许执行', 409)
    }
    const resumingAfterRestart = task.status === 'running'
    if (resumingAfterRestart && (task.resumeCount ?? 0) > 2) {
      throw new BizError('自动迁移任务已达到最多两次续跑限制', 409)
    }

    let snapshotDataSource: DataSource | null = null
    let targetDataSource: DataSource | null = null
    let cutoverPrepared = false
    let maintenanceStarted = false
    let cancelledByAdmin = false
    try {
      this.assertAutomaticTaskNotCancelled(task.id)
      if (!resumingAfterRestart) {
        task.progress.currentStage = '正在执行自动迁移预检'
        await this.writeTaskRecord(task)

        await this.assertStrictSourceSchema(AppDataSource)
        await this.assertAutomaticTargetReady(task.target)
        const latestPrecheck = await this.buildPrecheck({
          target: task.target,
          allowTargetWithData: false,
          initializeSchema: true,
          clearTargetBeforeImport: false,
          switchAfterSuccess: true,
        })
        if (!latestPrecheck.canProceed) {
          throw new BizError(
            latestPrecheck.issues
              .filter((issue) => issue.level === 'error')
              .map((issue) => issue.message)
              .join('；') || '自动迁移预检未通过',
            409,
          )
        }
        task.precheck = latestPrecheck
      }
      task.status = 'running'
      task.startedAt ??= new Date().toISOString()
      await this.writeTaskRecord(task)

      await o2oPreorderService.stopTimeoutRecycleLoop()
      await databaseMaintenanceModeService.beginReadOnly({
        taskId,
        phase: 'draining_writes',
      })
      maintenanceStarted = true
      this.assertAutomaticTaskNotCancelled(task.id)
      await this.updateTaskStage(task, '已冻结新写入并排空在途请求')

      await this.updateAutomaticTaskStage(task, 'prechecking', '正在执行冻结后的源库与目标库复检')
      await this.assertStrictSourceSchema(AppDataSource)

      await this.updateAutomaticTaskStage(task, 'snapshotting', '正在生成不可变 SQLite 一致性快照')
      let immutableSnapshotFile = task.immutableSnapshotFile
      if (immutableSnapshotFile) {
        assertPathInsideDirectory(immutableSnapshotFile.filePath, sqliteSnapshotDir, 'SQLite 不可变快照')
        const snapshotExists = await fs.access(immutableSnapshotFile.filePath).then(() => true).catch(() => false)
        if (!snapshotExists) {
          immutableSnapshotFile = undefined
        }
      }
      immutableSnapshotFile ??= await this.createConsistentSqliteSnapshot(task.id)
      task.immutableSnapshotFile = immutableSnapshotFile
      task.backupFile = immutableSnapshotFile
      await this.writeTaskRecord(task)

      snapshotDataSource = this.createSqliteSnapshotDataSource(immutableSnapshotFile.filePath)
      await snapshotDataSource.initialize()
      await this.assertStrictSourceSchema(snapshotDataSource)
      const orderedMetadatas = this.resolveOrderedEntityMetadatas(snapshotDataSource)
      const sourceTableStats = await this.collectTableStatsByMetadatas(snapshotDataSource, orderedMetadatas)

      await this.updateAutomaticTaskStage(task, 'exporting_json', '正在从不可变快照流式生成 JSON 备份')
      const jsonSnapshotExists = task.jsonSnapshotFile
        ? await fs.access(task.jsonSnapshotFile.filePath).then(() => true).catch(() => false)
        : false
      if (!jsonSnapshotExists) {
        task.jsonSnapshotFile = await this.createStreamingJsonSnapshotBackup(
          snapshotDataSource,
          orderedMetadatas,
          sourceTableStats,
          task.id,
        )
      }
      await this.writeTaskRecord(task)

      targetDataSource = this.createMysqlDataSource(task.target)
      await targetDataSource.initialize()
      let validationResult: DatabaseMigrationValidationResult | null = null
      let importedTables: DatabaseMigrationTableStat[] = []

      const initialAttempt = resumingAfterRestart ? Math.max(1, task.resumeCount ?? 1) : 0
      for (let attempt = initialAttempt; attempt <= 2; attempt += 1) {
        task.resumeCount = attempt
        importedTables = []
        task.progress.tableResults = []
        try {
          await this.updateAutomaticTaskStage(
            task,
            'initializing_mysql',
            attempt === 0 ? '正在以独立 MySQL 子进程初始化目标表结构' : `正在执行第 ${attempt} 次安全续跑`,
          )
          const existingTargetTables = await this.listExistingTableNames(targetDataSource)
          await this.prepareOwnedAutomaticTarget(
            targetDataSource,
            task.id,
            attempt > 0 && existingTargetTables.length > 0,
            orderedMetadatas.map((metadata) => metadata.tableName),
          )
          await this.runMysqlSchemaWorker(task.target)
          await this.maybeInterruptAutomaticMigrationE2E(attempt)

          for (const metadata of orderedMetadatas) {
            await this.updateAutomaticTaskStage(task, 'importing', `正在迁移表 ${metadata.tableName}`)
            const tableResult = await this.migrateSingleTableByPrimaryKey(
              snapshotDataSource,
              targetDataSource,
              metadata,
              task.id,
            )
            importedTables.push(tableResult)
            task.progress.tableResults = [...importedTables]
            await this.writeTaskRecord(task)
          }

          await this.maybeTamperAutomaticMigrationE2E(targetDataSource, orderedMetadatas)
          await this.runMysqlSchemaWorker(task.target, 'verify')
          await this.updateAutomaticTaskStage(task, 'validating', '正在执行全表结构、内容哈希与自增序列强校验')
          validationResult = await this.validateAutomaticMigration(
            snapshotDataSource,
            targetDataSource,
            orderedMetadatas,
            task.id,
          )
          if (!validationResult.passed || validationResult.blockingFailure) {
            throw new BizError(this.buildValidationFailureMessage(validationResult), 409)
          }
          break
        } catch (error) {
          if (error instanceof AutomaticMigrationCancelledError) {
            throw error
          }
          if (attempt >= 2) {
            throw error
          }
          task.resumeCount = attempt + 1
          const retryErrorMessage = formatUnknownErrorMessage(error)
          task.errorMessage = `第 ${attempt + 1} 次执行中断：${
            task.target.password ? retryErrorMessage.replaceAll(task.target.password, '***') : retryErrorMessage
          }`
          await this.updateAutomaticTaskStage(
            task,
            'resuming',
            `执行中断，正在准备第 ${attempt + 1} 次安全续跑`,
          )
        }
      }

      if (!validationResult) {
        throw new BizError('自动迁移未生成强校验结果，禁止切换', 409)
      }
      task.result = {
        importedTables,
        importedRows: importedTables.reduce((sum, item) => sum + item.rowCount, 0),
        runtimeOverrideApplied: true,
        validation: validationResult,
      }

      await this.updateAutomaticTaskStage(task, 'switching', '强校验通过，正在写入 MySQL 切换标记')
      const cutoverModule = await import('./database-migration-cutover.service.js')
      this.assertAutomaticTaskNotCancelled(task.id)
      await cutoverModule.createDatabaseMigrationCutoverMarker({
        taskId: task.id,
        sourceSqlitePath: task.source.sqlitePath,
      })
      try {
        this.assertAutomaticTaskNotCancelled(task.id)
        await this.writeMysqlRuntimeOverride(
          task.target,
          adminActor,
          task.id,
          '一键自动迁移强校验通过，准备 onebox 重启切换',
        )
        this.assertAutomaticTaskNotCancelled(task.id)
      } catch (error) {
        await cutoverModule.clearDatabaseMigrationCutoverMarker()
        throw error
      }

      task.status = 'restart_pending'
      task.updatedAt = new Date().toISOString()
      task.progress.currentStage = '切换配置已持久化，等待 onebox 计划重启'
      task.errorMessage = undefined
      await this.writeTaskRecord(task)
      this.assertAutomaticTaskNotCancelled(task.id)
      cutoverPrepared = true

      await auditService.safeRecord({
        actionType: 'database_migration.automatic_restart_pending',
        actionLabel: '一键自动迁移等待 onebox 重启验收',
        targetType: 'database_migration',
        targetId: task.id,
        targetCode: task.id,
        actor: adminActor,
        requestMeta,
        detail: {
          importedRows: task.result.importedRows,
          validationPassed: task.result.validation.passed,
          resumeCount: task.resumeCount ?? 0,
        },
      })

      setTimeout(() => {
        process.exit(cutoverModule.PLANNED_DATABASE_MIGRATION_EXIT_CODE)
      }, 250)
    } catch (error) {
      cancelledByAdmin = error instanceof AutomaticMigrationCancelledError
      task.status = 'failed'
      task.updatedAt = new Date().toISOString()
      task.finishedAt = new Date().toISOString()
      task.progress.currentStage = error instanceof AutomaticMigrationCancelledError
        ? '自动迁移已由管理员取消，正在执行紧急回退'
        : '自动迁移失败，已恢复正常写入'
      const rawErrorMessage = formatUnknownErrorMessage(error)
      task.errorMessage = task.target.password
        ? rawErrorMessage.replaceAll(task.target.password, '***')
        : rawErrorMessage
      await this.writeTaskRecord(task)
      if (!cancelledByAdmin) {
        if (maintenanceStarted) {
          await databaseMaintenanceModeService.finishReadOnly(task.id)
        }
        o2oPreorderService.startTimeoutRecycleLoop()
        await this.releaseAutomaticMigrationLock(task.id)
        await fs.rm(this.getTaskSecretFilePath(task.id), { force: true })
        await auditService.safeRecord({
          actionType: 'database_migration.run_automatic_task_failed',
          actionLabel: '一键自动数据库迁移失败',
          targetType: 'database_migration',
          targetId: task.id,
          targetCode: task.id,
          actor: adminActor,
          requestMeta,
          resultStatus: 'failed',
          detail: {
            errorMessage: task.errorMessage,
            resumeCount: task.resumeCount ?? 0,
          },
        })
      }
      throw error
    } finally {
      if (snapshotDataSource?.isInitialized) {
        await snapshotDataSource.destroy()
      }
      if (targetDataSource?.isInitialized) {
        await targetDataSource.destroy()
      }
      if (
        !cutoverPrepared
        && !cancelledByAdmin
        && maintenanceStarted
        && databaseMaintenanceModeService.isReadOnly()
      ) {
        await databaseMaintenanceModeService.finishReadOnly(task.id)
      }
    }
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
      .map((item) => {
        const mismatchReasons = [
          item.sourceRowCount !== item.targetRowCount ? `行数 ${item.sourceRowCount}/${item.targetRowCount}` : null,
          item.sourceSha256 && item.targetSha256 && item.sourceSha256 !== item.targetSha256 ? '内容哈希不一致' : null,
          item.structureMatched === false ? '结构不一致' : null,
          item.constraintsMatched === false ? '外键/唯一/CHECK 约束不一致' : null,
          item.autoIncrementMatched === false ? '自增序列不一致' : null,
        ].filter(Boolean)
        return `${item.tableName}(${mismatchReasons.join('、') || '校验不一致'})`
      })
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
        await this.runMysqlSchemaWorker(runningTask.target)
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
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'database_migration.run_task', '执行 SQLite 转 MySQL 迁移任务')
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
      const executionResult = await this.executeSQLiteToMySqlMigration(runningTask, latestPrecheck, adminActor)
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
        actor: adminActor,
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
        actor: adminActor,
        requestMeta,
        resultStatus: 'failed',
        detail: {
          errorMessage: failedTask.errorMessage,
        },
      })

      throw error
    }
  }

  async finalizeAutomaticMigrationAfterStartup(
    input: AutomaticMigrationStartupInput,
  ): Promise<SQLiteToMySqlTaskRecord> {
    if (env.DB_TYPE !== 'mysql' || AppDataSource.options.type !== 'mysql') {
      throw new Error('自动迁移启动后验收要求当前应用已连接 MySQL')
    }
    const task = await this.readTaskRecord(input.taskId, '执行 MySQL 启动后验收')
    this.automaticFinalizingTaskIds.add(task.id)
    try {
    if (task.mode !== 'automatic' || !task.result?.validation?.passed) {
      throw new Error(`自动迁移任务状态 ${task.status} 不允许启动后验收`)
    }
    if (path.resolve(task.source.sqlitePath) !== path.resolve(input.sourceSqlitePath)) {
      throw new Error('自动迁移切换标记中的 SQLite 回退路径与任务记录不一致')
    }
    if (!task.immutableSnapshotFile?.filePath) {
      throw new Error('自动迁移任务缺少不可变 SQLite 快照，禁止确认切换成功')
    }
    assertPathInsideDirectory(task.immutableSnapshotFile.filePath, sqliteSnapshotDir, 'SQLite 不可变快照')

    if (task.cancelRequestedAt) {
      return this.prepareCancelledAutomaticMigrationRollback(task, input)
    }

    if (task.status === 'succeeded') {
      await this.clearAutomaticTargetOwnerMarker(AppDataSource, task.id, true)
      if (!input.deferMaintenanceFinish) {
        await databaseMaintenanceModeService.finishReadOnly(task.id)
      }
      await this.releaseAutomaticMigrationLock(task.id)
      await fs.rm(this.getTaskSecretFilePath(task.id), { force: true })
      await this.recordAutomaticMigrationSucceededAudit(task)
      return this.sanitizeTaskRecord(task)
    }
    if (!['running', 'restart_pending', 'verifying'].includes(task.status)) {
      throw new Error(`自动迁移任务状态 ${task.status} 不允许启动后验收`)
    }

    task.status = 'verifying'
    task.updatedAt = new Date().toISOString()
    task.progress.currentStage = 'MySQL 已启动，正在执行重启后全表验收'
    await databaseMaintenanceModeService.updatePhase('verifying')
    await this.writeTaskRecord(task)

    const snapshotDataSource = this.createSqliteSnapshotDataSource(task.immutableSnapshotFile.filePath, false)
    try {
      await snapshotDataSource.initialize()
      await this.maybeDelayAutomaticMigrationFinalizerE2E(task.id)
      const orderedMetadatas = this.resolveOrderedEntityMetadatas(AppDataSource)
      await this.assertStrictSourceSchema(snapshotDataSource, orderedMetadatas)
      // TypeORM/MySQL 8.4 会对等价 tinyint(1) 与部分索引返回伪结构差异；
      // 统一复用独立 MySQL 方言子进程做严格且可解释的结构验收。
      await this.runMysqlSchemaWorker(task.target, 'verify')
      const validation = await this.validateAutomaticMigration(
        snapshotDataSource,
        AppDataSource,
        orderedMetadatas,
        task.id,
      )
      if (!validation.passed || validation.blockingFailure) {
        throw new Error(this.buildValidationFailureMessage(validation))
      }
      this.assertAutomaticTaskNotCancelled(task.id)
      // 首次由 verifying 进入 succeeded 前必须确认目标库仍由当前任务持有。
      // 只有 succeeded 已持久化后的幂等重入，才允许清理阶段发现标记已不存在。
      await this.assertAutomaticTargetOwnerMarker(AppDataSource, task.id)

      // 先持久化成功意图，再幂等删除所有权标记。任一写入点崩溃后，
      // 下次启动都可依据 durable succeeded 状态安全完成余下清理。
      task.status = 'succeeded'
      task.updatedAt = new Date().toISOString()
      task.finishedAt = new Date().toISOString()
      task.progress.currentStage = '一键自动迁移完成，MySQL 重启后验收通过'
      task.errorMessage = undefined
      task.result = {
        importedTables: validation.items.map((item) => ({
          tableName: item.tableName,
          rowCount: item.targetRowCount,
        })),
        importedRows: validation.targetTotalRows,
        runtimeOverrideApplied: true,
        validation,
      }
      await this.writeTaskRecord(task)
      this.assertAutomaticTaskNotCancelled(task.id)
      await this.clearAutomaticTargetOwnerMarker(AppDataSource, task.id)
      this.assertAutomaticTaskNotCancelled(task.id)
      if (!input.deferMaintenanceFinish) {
        await databaseMaintenanceModeService.finishReadOnly(task.id)
      }
      await this.releaseAutomaticMigrationLock(task.id)
      await fs.rm(this.getTaskSecretFilePath(task.id), { force: true })
      await this.recordAutomaticMigrationSucceededAudit(task)
      return this.sanitizeTaskRecord(task)
    } catch (error) {
      if (error instanceof AutomaticMigrationCancelledError) {
        return this.prepareCancelledAutomaticMigrationRollback(task, input)
      }
      throw error
    } finally {
      if (snapshotDataSource.isInitialized) {
        await snapshotDataSource.destroy()
      }
    }
    } finally {
      this.automaticFinalizingTaskIds.delete(task.id)
    }
  }

  async finalizeAutomaticMigrationRollbackAfterStartup(
    input: AutomaticMigrationStartupInput,
  ): Promise<SQLiteToMySqlTaskRecord> {
    if (env.DB_TYPE !== 'sqlite' || AppDataSource.options.type !== 'sqlite') {
      throw new Error('自动迁移回退验收要求当前应用已恢复 SQLite')
    }
    const task = await this.readTaskRecord(input.taskId, '确认 SQLite 自动回退')
    if (task.mode !== 'automatic' || path.resolve(task.source.sqlitePath) !== path.resolve(input.sourceSqlitePath)) {
      throw new Error('自动迁移回退标记与任务记录不一致')
    }
    const cancelledByAdmin = Boolean(task.cancelRequestedAt)
    task.status = 'rolled_back'
    task.updatedAt = new Date().toISOString()
    task.finishedAt = new Date().toISOString()
    task.progress.currentStage = cancelledByAdmin
      ? '管理员紧急回退已完成，SQLite 已通过启动自检'
      : 'MySQL 连续启动失败，已自动回退 SQLite 并通过启动自检'
    task.errorMessage = undefined
    task.rollbackResult = {
      rolledBackAt: new Date().toISOString(),
      sourceSqlitePath: input.sourceSqlitePath,
      mysqlStartupAttempts: input.attempts,
      message: cancelledByAdmin
        ? '管理员已取消自动迁移，原 SQLite 已恢复并完成启动自检'
        : '已自动恢复原 SQLite 运行时覆盖并完成启动自检',
    }
    await this.writeTaskRecord(task)
    if (!input.deferMaintenanceFinish) {
      await databaseMaintenanceModeService.finishReadOnly(task.id)
    }
    await this.releaseAutomaticMigrationLock(task.id)
    await fs.rm(this.getTaskSecretFilePath(task.id), { force: true })
    await auditService.safeRecordOnce({
      actionType: 'database_migration.automatic_rolled_back',
      actionLabel: cancelledByAdmin
        ? 'SQLite 一键自动迁移已紧急回退'
        : 'SQLite 一键自动迁移已自动回退',
      targetType: 'database_migration',
      targetId: task.id,
      targetCode: task.id,
      actor: this.buildAutomaticMigrationSystemActor(),
      resultStatus: 'failed',
      detail: {
        mysqlStartupAttempts: input.attempts,
        message: task.rollbackResult.message,
      },
    }, {
      allowDuringDatabaseMaintenance: true,
    })
    return this.sanitizeTaskRecord(task)
  }

  private async recordAutomaticMigrationSucceededAudit(task: InternalMigrationTaskRecord): Promise<void> {
    if (!task.result) {
      return
    }
    await auditService.safeRecordOnce({
      actionType: 'database_migration.automatic_succeeded',
      actionLabel: 'SQLite 一键自动迁移成功',
      targetType: 'database_migration',
      targetId: task.id,
      targetCode: task.id,
      actor: this.buildAutomaticMigrationSystemActor(),
      detail: {
        importedRows: task.result.importedRows,
        tableCount: task.result.validation.items.length,
        validationPassed: task.result.validation.passed,
        resumeCount: task.resumeCount ?? 0,
      },
    }, {
      allowDuringDatabaseMaintenance: true,
    })
  }

  private buildAutomaticMigrationSystemActor(): {
    userId: null
    username: string
    displayName: string
  } {
    return {
      // MySQL 中 actor_user_id 是 bigint；系统动作没有真实用户主键，应使用 NULL，
      // 由账号与显示名字段保留可读的系统身份快照。
      userId: null,
      username: 'system',
      displayName: '数据库自动迁移程序',
    }
  }

  private async ensureAutomaticRollbackMarker(
    task: InternalMigrationTaskRecord,
    attempts: number,
  ): Promise<void> {
    const cutoverModule = await import('./database-migration-cutover.service.js')
    const currentMarker = cutoverModule.readDatabaseMigrationCutoverMarker()
    if (currentMarker && currentMarker.taskId !== task.id) {
      throw new BizError('数据库切换标记属于其他任务，已禁止覆盖', 409)
    }
    if (!currentMarker) {
      await cutoverModule.createDatabaseMigrationCutoverMarker({
        taskId: task.id,
        sourceSqlitePath: task.source.sqlitePath,
      })
    }
    cutoverModule.markDatabaseMigrationCutover({
      status: 'rollback_pending',
      attempts,
      lastError: '管理员请求紧急回退自动迁移',
    })
  }

  private async writeAutomaticSqliteRollbackOverride(task: InternalMigrationTaskRecord): Promise<void> {
    await writeDatabaseRuntimeOverride({
      version: 1,
      updatedAt: new Date().toISOString(),
      reason: '自动迁移取消或启动失败，准备恢复 SQLite',
      sourceTaskId: task.id,
      updatedBy: null,
      config: {
        DB_TYPE: 'sqlite',
        SQLITE_DB_PATH: task.source.sqlitePath,
        DB_SYNC: false,
      },
      rollbackConfig: {
        DB_TYPE: 'sqlite',
        SQLITE_DB_PATH: task.source.sqlitePath,
        DB_SYNC: false,
      },
    })
  }

  private async prepareCancelledAutomaticMigrationRollback(
    task: InternalMigrationTaskRecord,
    input: AutomaticMigrationStartupInput,
  ): Promise<SQLiteToMySqlTaskRecord> {
    task.cancelRequestedAt ??= new Date().toISOString()
    task.status = 'rolled_back'
    task.updatedAt = new Date().toISOString()
    task.finishedAt = new Date().toISOString()
    task.progress.currentStage = '管理员已取消自动迁移，等待 onebox 重启恢复 SQLite'
    task.errorMessage = undefined
    task.rollbackResult = {
      rolledBackAt: new Date().toISOString(),
      sourceSqlitePath: task.source.sqlitePath,
      mysqlStartupAttempts: input.attempts,
      message: '管理员已取消自动迁移，SQLite 回退配置已持久化并等待重启验收',
    }
    await this.writeTaskRecord(task)
    await this.writeAutomaticSqliteRollbackOverride(task)
    await this.ensureAutomaticRollbackMarker(task, input.attempts)
    return this.sanitizeTaskRecord(task)
  }

  async resumeInterruptedAutomaticMigrationAfterStartup(): Promise<string | null> {
    if (env.DB_TYPE !== 'sqlite' || AppDataSource.options.type !== 'sqlite') {
      return null
    }
    let taskId: string
    try {
      const rawLock = await fs.readFile(migrationLockFile, 'utf8')
      let lock: { taskId?: unknown } | null = null
      try {
        lock = JSON.parse(rawLock) as { taskId?: unknown }
      } catch {
        // 交由下方的 owner 恢复分支处理零字节或截断 JSON。
      }
      if (typeof lock?.taskId === 'string' && lock.taskId.trim()) {
        taskId = lock.taskId.trim()
      } else {
        const cutoverModule = await import('./database-migration-cutover.service.js')
        const marker = cutoverModule.readDatabaseMigrationCutoverMarker()
        const maintenanceTaskId = databaseMaintenanceModeService.getActiveTaskId()
        if (marker && maintenanceTaskId && marker.taskId !== maintenanceTaskId) {
          console.error('[database-migration] 损坏锁无法恢复：marker 与维护任务不一致')
          return null
        }
        const recoveredTaskId = maintenanceTaskId ?? marker?.taskId
        if (!recoveredTaskId) {
          await fs.rm(migrationLockFile, { force: true })
          console.warn('[database-migration] 已删除无 owner 的损坏自动迁移锁')
          return null
        }
        taskId = recoveredTaskId
        await this.writeJsonAtomically(migrationLockFile, {
          version: 1,
          taskId,
          acquiredAt: new Date().toISOString(),
          recoveredAt: new Date().toISOString(),
          pid: process.pid,
        })
      }
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.error('[database-migration] 读取自动迁移锁失败', {
          errorMessage: formatUnknownErrorMessage(error),
        })
      }
      return null
    }

    const cutoverModule = await import('./database-migration-cutover.service.js')
    let task: InternalMigrationTaskRecord
    try {
      task = await this.readTaskRecord(taskId, '恢复意外中断的自动迁移任务')
    } catch (error) {
      const marker = cutoverModule.readDatabaseMigrationCutoverMarker()
      if (marker?.taskId === taskId) {
        cutoverModule.clearDatabaseMigrationCutoverMarker()
      }
      await databaseMaintenanceModeService.finishReadOnly(taskId)
      await this.releaseAutomaticMigrationLock(taskId)
      await fs.rm(this.getTaskSecretFilePath(taskId), { force: true })
      console.error('[database-migration] 自动迁移锁对应的任务不存在或已损坏，已清理陈旧恢复状态', {
        taskId,
        errorMessage: formatUnknownErrorMessage(error),
      })
      return null
    }
    if (task.cancelRequestedAt) {
      await this.writeAutomaticSqliteRollbackOverride(task)
      const marker = cutoverModule.readDatabaseMigrationCutoverMarker()
      await this.ensureAutomaticRollbackMarker(task, marker?.attempts ?? 0)
      await this.finalizeAutomaticMigrationRollbackAfterStartup({
        taskId: task.id,
        sourceSqlitePath: task.source.sqlitePath,
        attempts: marker?.attempts ?? 0,
        createdAt: marker?.createdAt ?? new Date().toISOString(),
      })
      cutoverModule.clearDatabaseMigrationCutoverMarker()
      return null
    }
    if (task.mode !== 'automatic' || !['queued', 'running'].includes(task.status)) {
      const marker = cutoverModule.readDatabaseMigrationCutoverMarker()
      const isPendingCutover = (
        task.mode === 'automatic'
        && ['restart_pending', 'verifying'].includes(task.status)
        && marker?.taskId === task.id
      )
      if (!isPendingCutover) {
        if (marker?.taskId === task.id) {
          cutoverModule.clearDatabaseMigrationCutoverMarker()
        }
        await databaseMaintenanceModeService.finishReadOnly(task.id)
        await this.releaseAutomaticMigrationLock(task.id)
        await fs.rm(this.getTaskSecretFilePath(task.id), { force: true })
      }
      return null
    }
    if (task.status === 'running') {
      task.resumeCount = (task.resumeCount ?? 0) + 1
      if (task.resumeCount > 2) {
        task.status = 'failed'
        task.finishedAt = new Date().toISOString()
        task.updatedAt = new Date().toISOString()
        task.errorMessage = '自动迁移进程连续中断，已达到最多两次续跑限制'
        task.progress.currentStage = '自动续跑次数已耗尽，已恢复 SQLite 正常写入'
        await this.writeTaskRecord(task)
        await databaseMaintenanceModeService.finishReadOnly(task.id)
        await this.releaseAutomaticMigrationLock(task.id)
        await fs.rm(this.getTaskSecretFilePath(task.id), { force: true })
        return null
      }
      task.progress.currentStage = `检测到进程意外中断，准备第 ${task.resumeCount} 次自动续跑`
      task.updatedAt = new Date().toISOString()
      await this.writeTaskRecord(task)
    }

    const systemActor: AuthUserContext = {
      userId: 'system',
      username: 'system',
      displayName: '数据库迁移恢复程序',
      role: 'admin',
      permissions: [],
      status: 'enabled',
      sessionToken: '',
      authSource: 'bearer',
    }
    setImmediate(() => {
      void this.runAutomaticSQLiteToMySqlTask(task.id, systemActor).catch((error) => {
        console.error('[database-migration] 自动续跑失败', {
          taskId: task.id,
          errorMessage: formatUnknownErrorMessage(error),
        })
      })
    })
    return task.id
  }

  private async stopAutomaticMigrationForEmergencyAction(
    requestedTaskId?: string,
  ): Promise<{ taskId: string; sourceSqlitePath: string } | null> {
    const cutoverModule = await import('./database-migration-cutover.service.js')
    const marker = cutoverModule.readDatabaseMigrationCutoverMarker()
    const maintenanceTaskId = databaseMaintenanceModeService.getActiveTaskId()
    if (marker && maintenanceTaskId && marker.taskId !== maintenanceTaskId) {
      throw new BizError('只读维护任务与数据库切换标记不一致，已禁止自动扩大回退范围', 409)
    }

    const activeTaskId = maintenanceTaskId ?? marker?.taskId ?? requestedTaskId?.trim()
    if (!activeTaskId) {
      return null
    }
    if (requestedTaskId?.trim() && requestedTaskId.trim() !== activeTaskId) {
      throw new BizError(`当前活动自动迁移任务为 ${activeTaskId}，禁止回退其他任务`, 409)
    }

    let task: InternalMigrationTaskRecord
    try {
      task = await this.readTaskRecord(activeTaskId, '执行自动迁移紧急回退')
    } catch (error) {
      if (marker?.taskId === activeTaskId) {
        cutoverModule.clearDatabaseMigrationCutoverMarker()
      }
      await clearDatabaseRuntimeOverride()
      await databaseMaintenanceModeService.finishReadOnly(activeTaskId)
      await this.releaseAutomaticMigrationLock(activeTaskId)
      await fs.rm(this.getTaskSecretFilePath(activeTaskId), { force: true })
      if (error instanceof BizError && [404, 409].includes(error.statusCode)) {
        return null
      }
      throw error
    }
    if (task.mode !== 'automatic') {
      return null
    }

    this.cancelledAutomaticTaskIds.add(activeTaskId)
    task.cancelRequestedAt ??= new Date().toISOString()
    task.updatedAt = new Date().toISOString()
    task.progress.currentStage = '已持久化管理员紧急回退意图，正在停止自动迁移'
    await this.writeTaskRecord(task)
    await this.writeAutomaticSqliteRollbackOverride(task)
    await this.ensureAutomaticRollbackMarker(task, marker?.attempts ?? 0)

    if (
      ['running', 'verifying'].includes(task.status)
      || this.automaticFinalizingTaskIds.has(activeTaskId)
    ) {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100)
        })
        task = await this.readTaskRecord(activeTaskId, '等待自动迁移停止')
        if (
          !['running', 'verifying'].includes(task.status)
          && !this.automaticFinalizingTaskIds.has(activeTaskId)
        ) {
          break
        }
      }
      if (
        ['running', 'verifying'].includes(task.status)
        || this.automaticFinalizingTaskIds.has(activeTaskId)
      ) {
        throw new BizError('自动迁移尚未响应紧急取消，请稍后重试回退操作', 409)
      }
    }

    task.status = 'rolled_back'
    task.updatedAt = new Date().toISOString()
    task.finishedAt = new Date().toISOString()
    task.progress.currentStage = '管理员已执行紧急回退，自动迁移已停止并恢复 SQLite'
    task.errorMessage = undefined
    task.rollbackResult = {
      rolledBackAt: new Date().toISOString(),
      sourceSqlitePath: task.source.sqlitePath,
      mysqlStartupAttempts: marker?.attempts ?? 0,
      message: '管理员已取消活动自动迁移并恢复原 SQLite 运行配置',
    }
    await this.writeTaskRecord(task)
    this.cancelledAutomaticTaskIds.delete(activeTaskId)
    return {
      taskId: activeTaskId,
      sourceSqlitePath: task.source.sqlitePath,
    }
  }

  private async schedulePlannedAutomaticMigrationRestart(): Promise<void> {
    const cutoverModule = await import('./database-migration-cutover.service.js')
    setTimeout(() => {
      process.exit(cutoverModule.PLANNED_DATABASE_MIGRATION_EXIT_CODE)
    }, 250)
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
      filePath: appDataPaths.runtimeOverrideFile,
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
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'database_migration.apply_switch', '应用数据库切换覆盖配置')
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
      adminActor,
      input.taskId,
      input.reason?.trim() || DATABASE_MIGRATION_SWITCH_REASON_DEFAULT,
    )

    await auditService.safeRecord({
      actionType: 'database_migration.apply_switch',
      actionLabel: '应用数据库切换覆盖配置',
      targetType: 'database_runtime_override',
      targetCode: input.taskId ?? persisted.config.DB_NAME ?? 'mysql',
      actor: adminActor,
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
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'database_migration.rollback_switch', '回退数据库切换覆盖配置')
    const currentOverride = readDatabaseRuntimeOverride()
    const stoppedAutomaticTask = await this.stopAutomaticMigrationForEmergencyAction(input.taskId)

    if (input.clearOnly) {
      if (stoppedAutomaticTask) {
        await auditService.safeRecord({
          actionType: 'database_migration.rollback_switch',
          actionLabel: '紧急回退自动数据库迁移',
          targetType: 'database_migration',
          targetId: stoppedAutomaticTask.taskId,
          targetCode: stoppedAutomaticTask.taskId,
          actor: adminActor,
          requestMeta,
          detail: {
            clearOnly: true,
            emergencyAutomaticRollback: true,
          },
        }, {
          allowDuringDatabaseMaintenance: true,
        })
        await this.schedulePlannedAutomaticMigrationRestart()
        return {
          restartRequired: true,
          rollbackMode: 'sqlite_override',
          activeOverride: maskDatabaseRuntimeOverride(readDatabaseRuntimeOverride()),
        }
      }
      const cleared = await clearDatabaseRuntimeOverride()

      await auditService.safeRecord({
        actionType: 'database_migration.rollback_switch',
        actionLabel: '回退数据库切换覆盖配置（仅清理覆盖文件）',
        targetType: 'database_runtime_override',
        targetCode: input.taskId ?? 'clear',
        actor: adminActor,
        requestMeta,
        detail: {
          clearOnly: true,
          cleared,
          sourceTaskId: input.taskId,
        },
      }, {
        allowDuringDatabaseMaintenance: true,
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
      actor: adminActor,
      requestMeta,
      detail: {
        sqlitePath,
        sourceTaskId: input.taskId,
        emergencyAutomaticRollback: Boolean(stoppedAutomaticTask),
      },
    }, {
      allowDuringDatabaseMaintenance: true,
    })
    if (stoppedAutomaticTask) {
      await this.schedulePlannedAutomaticMigrationRestart()
    }

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
    const adminActor = await this.assertAdminActor(actor, requestMeta, 'database_migration.clear_override', '清理数据库运行时覆盖配置')
    const stoppedAutomaticTask = await this.stopAutomaticMigrationForEmergencyAction()
    if (stoppedAutomaticTask) {
      await auditService.safeRecord({
        actionType: 'database_migration.clear_override',
        actionLabel: '紧急清理自动迁移数据库运行时覆盖配置',
        targetType: 'database_migration',
        targetId: stoppedAutomaticTask.taskId,
        targetCode: stoppedAutomaticTask.taskId,
        actor: adminActor,
        requestMeta,
        detail: {
          emergencyAutomaticRollback: true,
        },
      }, {
        allowDuringDatabaseMaintenance: true,
      })
      await this.schedulePlannedAutomaticMigrationRestart()
      return {
        cleared: false,
        restartRequired: true,
      }
    }
    const cleared = await clearDatabaseRuntimeOverride()

    await auditService.safeRecord({
      actionType: 'database_migration.clear_override',
      actionLabel: '清理数据库运行时覆盖配置',
      targetType: 'database_runtime_override',
      targetCode: 'clear',
      actor: adminActor,
      requestMeta,
      detail: {
        cleared,
      },
    }, {
      allowDuringDatabaseMaintenance: true,
    })

    return {
      cleared,
      restartRequired: true,
    }
  }
}

export const databaseMigrationService = new DatabaseMigrationService()
