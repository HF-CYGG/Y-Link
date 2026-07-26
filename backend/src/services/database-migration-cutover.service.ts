/**
 * 模块说明：backend/src/services/database-migration-cutover.service.ts
 * 文件职责：持久化 SQLite -> MySQL 计划切换标记，并在 onebox 启动失败时编排有限重试与 SQLite 自动回退。
 * 实现逻辑：
 * - 切换标记只保存任务 ID、SQLite 源路径和启动尝试状态，MySQL 连接凭据仅保留在运行时覆盖文件；
 * - 标记使用同目录临时文件原子替换并收紧为 0600，避免中断留下半截 JSON；
 * - MySQL 首次启动失败请求 onebox 计划重启，第二次失败写回 SQLite 运行时覆盖并进入回退确认；
 * - 启动成功后通过动态可选契约回调主迁移服务，任务最终状态仍由迁移服务统一维护。
 * 维护说明：
 * - 退出码 75 是 onebox 计划重启契约，普通启动失败不得复用该退出码；
 * - 新增标记字段前必须确认不包含目标库主机、用户、密码、库名或连接串等敏感配置。
 */

import fs from 'node:fs'
import path from 'node:path'
import { appDataPaths } from '../config/app-data-paths.js'
import {
  readDatabaseRuntimeOverride,
  writeDatabaseRuntimeOverride,
  type DatabaseRuntimeOverrideFile,
} from '../config/database-runtime-override.js'
import { databaseMaintenanceModeService } from './database-maintenance-mode.service.js'

export const PLANNED_DATABASE_MIGRATION_EXIT_CODE = 75
export const DATABASE_MIGRATION_PLANNED_RESTART_EXIT_CODE = PLANNED_DATABASE_MIGRATION_EXIT_CODE

const CUTOVER_MARKER_VERSION = 1
const MYSQL_STARTUP_FAILURES_BEFORE_ROLLBACK = 2
const MAX_TASK_ID_LENGTH = 100
const MAX_SQLITE_PATH_LENGTH = 1_000
const MAX_LAST_ERROR_LENGTH = 200

export type DatabaseMigrationCutoverStatus = 'mysql_pending' | 'verifying' | 'rollback_pending'

export interface DatabaseMigrationCutoverMarker {
  version: 1
  taskId: string
  sourceSqlitePath: string
  attempts: number
  status: DatabaseMigrationCutoverStatus
  createdAt: string
  lastError: string | null
}

export interface CreateDatabaseMigrationCutoverMarkerInput {
  taskId: string
  sourceSqlitePath: string
}

export interface MarkDatabaseMigrationCutoverInput {
  status?: DatabaseMigrationCutoverStatus
  attempts?: number
  lastError?: string | null
}

export interface DatabaseMigrationCutoverFinalizationInput {
  taskId: string
  sourceSqlitePath: string
  attempts: number
  createdAt: string
  deferMaintenanceFinish?: boolean
}

export type DatabaseMigrationCutoverStartupFailureResult =
  | {
      handled: false
      action: 'none'
      exitCode: 1
      marker: DatabaseMigrationCutoverMarker | null
    }
  | {
      handled: true
      action: 'restart_mysql' | 'restart_sqlite_rollback'
      exitCode: typeof DATABASE_MIGRATION_PLANNED_RESTART_EXIT_CODE
      marker: DatabaseMigrationCutoverMarker
    }

export type DatabaseMigrationCutoverStartupSuccessResult =
  | {
      action: 'none' | 'database_type_mismatch'
      marker: DatabaseMigrationCutoverMarker | null
    }
  | {
      action: 'awaiting_mysql_finalizer' | 'awaiting_rollback_finalizer'
      marker: DatabaseMigrationCutoverMarker
    }
  | {
      action: 'rollback_restart_pending'
      marker: DatabaseMigrationCutoverMarker
    }
  | {
      action: 'mysql_finalized' | 'rollback_finalized'
      marker: DatabaseMigrationCutoverMarker
      taskId: string
    }

type DatabaseType = 'sqlite' | 'mysql'
type CutoverFinalizer = (input: DatabaseMigrationCutoverFinalizationInput) => Promise<unknown>

interface DatabaseMigrationModuleWithOptionalCutoverFinalizers {
  databaseMigrationService?: {
    finalizeAutomaticMigrationAfterStartup?: CutoverFinalizer
    finalizeAutomaticMigrationRollbackAfterStartup?: CutoverFinalizer
  }
  finalizeAutomaticMigrationAfterStartup?: CutoverFinalizer
  finalizeAutomaticMigrationRollbackAfterStartup?: CutoverFinalizer
}

const markerFilePath = appDataPaths.migrationCutoverFile

function normalizeRequiredText(value: unknown, maxLength: number, fieldLabel: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldLabel}必须是字符串`)
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) {
    throw new Error(`${fieldLabel}不合法`)
  }
  return normalized
}

function normalizeIsoDateTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) {
    return null
  }
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) {
    return null
  }
  return new Date(timestamp).toISOString()
}

function normalizeAttempts(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null
  }
  return value
}

function normalizeStatus(value: unknown): DatabaseMigrationCutoverStatus | null {
  if (value === 'mysql_pending' || value === 'verifying' || value === 'rollback_pending') {
    return value
  }
  return null
}

function normalizeLastError(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_LAST_ERROR_LENGTH || normalized.includes('\0')) {
    return undefined
  }
  return normalized
}

function normalizeMarker(value: unknown): DatabaseMigrationCutoverMarker | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== CUTOVER_MARKER_VERSION) {
    return null
  }

  const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : ''
  const sourceSqlitePath = typeof raw.sourceSqlitePath === 'string' ? raw.sourceSqlitePath.trim() : ''
  const attempts = normalizeAttempts(raw.attempts)
  const status = normalizeStatus(raw.status)
  const createdAt = normalizeIsoDateTime(raw.createdAt)
  const lastError = normalizeLastError(raw.lastError)
  if (
    !taskId
    || taskId.length > MAX_TASK_ID_LENGTH
    || taskId.includes('\0')
    || !sourceSqlitePath
    || sourceSqlitePath.length > MAX_SQLITE_PATH_LENGTH
    || sourceSqlitePath.includes('\0')
    || attempts === null
    || !status
    || !createdAt
    || lastError === undefined
  ) {
    return null
  }

  return {
    version: CUTOVER_MARKER_VERSION,
    taskId,
    sourceSqlitePath,
    attempts,
    status,
    createdAt,
    lastError,
  }
}

function readFinalizerTaskStatus(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('status' in value)) {
    return null
  }
  return typeof value.status === 'string' ? value.status : null
}

function writeMarkerAtomically(marker: DatabaseMigrationCutoverMarker): DatabaseMigrationCutoverMarker {
  const normalizedMarker = normalizeMarker(marker)
  if (!normalizedMarker) {
    throw new Error('数据库迁移切换标记不合法，已拒绝写入磁盘')
  }

  const directory = path.dirname(markerFilePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const tempFilePath = `${markerFilePath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempFilePath, JSON.stringify(normalizedMarker, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    try {
      fs.chmodSync(tempFilePath, 0o600)
    } catch {
      // Windows 不保证支持 POSIX 权限位；onebox/Linux 会正常收紧为进程用户可读写。
    }
    try {
      fs.renameSync(tempFilePath, markerFilePath)
    } catch {
      if (fs.existsSync(markerFilePath)) {
        fs.rmSync(markerFilePath, { force: true })
      }
      fs.renameSync(tempFilePath, markerFilePath)
    }
    try {
      fs.chmodSync(markerFilePath, 0o600)
    } catch {
      // Windows 不保证支持 POSIX 权限位；onebox/Linux 会正常收紧为进程用户可读写。
    }
  } finally {
    if (fs.existsSync(tempFilePath)) {
      fs.rmSync(tempFilePath, { force: true })
    }
  }
  return normalizedMarker
}

/**
 * 只从 Error 的类型与标准错误码生成落盘摘要，不写入 message，避免连接串或密码随错误文本进入标记。
 */
function buildSafeStartupErrorSummary(error: unknown): string {
  const parts: string[] = []
  if (error instanceof Error) {
    const errorName = error.name.trim()
    if (/^[A-Z][A-Z0-9_.-]{0,79}$/i.test(errorName)) {
      parts.push(errorName)
    }
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const rawCode = (error as { code?: unknown }).code
    if (typeof rawCode === 'string' && /^[A-Z0-9_-]{1,80}$/i.test(rawCode)) {
      parts.push(rawCode)
    }
  }
  return (parts.length ? parts.join(':') : 'unknown_startup_failure').slice(0, MAX_LAST_ERROR_LENGTH)
}

function toFinalizationInput(marker: DatabaseMigrationCutoverMarker): DatabaseMigrationCutoverFinalizationInput {
  return {
    taskId: marker.taskId,
    sourceSqlitePath: marker.sourceSqlitePath,
    attempts: marker.attempts,
    createdAt: marker.createdAt,
  }
}

async function loadCutoverFinalizer(
  finalizerName: 'finalizeAutomaticMigrationAfterStartup' | 'finalizeAutomaticMigrationRollbackAfterStartup',
): Promise<CutoverFinalizer | null> {
  const migrationModule = await import('./database-migration.service.js') as unknown as DatabaseMigrationModuleWithOptionalCutoverFinalizers
  const serviceFinalizer = migrationModule.databaseMigrationService?.[finalizerName]
  if (typeof serviceFinalizer === 'function') {
    return serviceFinalizer.bind(migrationModule.databaseMigrationService)
  }
  const namedFinalizer = migrationModule[finalizerName]
  return typeof namedFinalizer === 'function' ? namedFinalizer : null
}

async function writeSqliteRollbackOverride(marker: DatabaseMigrationCutoverMarker): Promise<DatabaseRuntimeOverrideFile> {
  const currentOverride = readDatabaseRuntimeOverride()
  const sqliteDbSync = currentOverride?.rollbackConfig?.DB_SYNC ?? false
  return writeDatabaseRuntimeOverride({
    version: 1,
    updatedAt: new Date().toISOString(),
    reason: 'MySQL 自动切换启动连续失败，系统已计划回退到 SQLite',
    sourceTaskId: marker.taskId,
    updatedBy: null,
    config: {
      DB_TYPE: 'sqlite',
      SQLITE_DB_PATH: marker.sourceSqlitePath,
      DB_SYNC: sqliteDbSync,
    },
    rollbackConfig: {
      DB_TYPE: 'sqlite',
      SQLITE_DB_PATH: marker.sourceSqlitePath,
      DB_SYNC: sqliteDbSync,
    },
  })
}

export function createDatabaseMigrationCutoverMarker(
  input: CreateDatabaseMigrationCutoverMarkerInput,
): DatabaseMigrationCutoverMarker {
  const marker: DatabaseMigrationCutoverMarker = {
    version: CUTOVER_MARKER_VERSION,
    taskId: normalizeRequiredText(input.taskId, MAX_TASK_ID_LENGTH, '迁移任务 ID'),
    sourceSqlitePath: normalizeRequiredText(input.sourceSqlitePath, MAX_SQLITE_PATH_LENGTH, 'SQLite 源路径'),
    attempts: 0,
    status: 'mysql_pending',
    createdAt: new Date().toISOString(),
    lastError: null,
  }
  return writeMarkerAtomically(marker)
}

export function readDatabaseMigrationCutoverMarker(): DatabaseMigrationCutoverMarker | null {
  if (!fs.existsSync(markerFilePath)) {
    return null
  }
  try {
    return normalizeMarker(JSON.parse(fs.readFileSync(markerFilePath, 'utf8')))
  } catch {
    return null
  }
}

export function markDatabaseMigrationCutover(
  input: MarkDatabaseMigrationCutoverInput,
): DatabaseMigrationCutoverMarker {
  const current = readDatabaseMigrationCutoverMarker()
  if (!current) {
    throw new Error('数据库迁移切换标记不存在或已损坏')
  }

  const attempts = input.attempts === undefined ? current.attempts : normalizeAttempts(input.attempts)
  const status = input.status === undefined ? current.status : normalizeStatus(input.status)
  const lastError = input.lastError === undefined ? current.lastError : normalizeLastError(input.lastError)
  if (attempts === null || !status || lastError === undefined) {
    throw new Error('数据库迁移切换标记更新内容不合法')
  }
  return writeMarkerAtomically({
    ...current,
    attempts,
    status,
    lastError,
  })
}

export function clearDatabaseMigrationCutoverMarker(): boolean {
  if (!fs.existsSync(markerFilePath)) {
    return false
  }
  fs.rmSync(markerFilePath, { force: true })
  return true
}

export function assertDatabaseMigrationE2EStartupAllowed(activeDatabaseType: DatabaseType): void {
  if (
    process.env.APP_PROFILE !== 'verify-db-migration'
    || process.env.Y_LINK_DB_MIGRATION_E2E !== 'true'
    || activeDatabaseType !== 'mysql'
  ) {
    return
  }
  const requestedFailures = Number(
    process.env.Y_LINK_DB_MIGRATION_TEST_FAIL_MYSQL_STARTUP_ATTEMPTS ?? '0',
  )
  if (!Number.isSafeInteger(requestedFailures) || requestedFailures < 0 || requestedFailures > 2) {
    throw new Error('自动迁移 E2E 故障注入次数必须是 0 到 2 的整数')
  }
  const marker = readDatabaseMigrationCutoverMarker()
  if (
    marker
    && requestedFailures > marker.attempts
    && (marker.status === 'mysql_pending' || marker.status === 'verifying')
  ) {
    const error = new Error('隔离验收环境按计划注入 MySQL 启动失败')
    error.name = 'DatabaseMigrationE2EFaultInjectionError'
    Object.assign(error, { code: 'E2E_MYSQL_STARTUP_FAILURE' })
    throw error
  }
}

export async function handleDatabaseMigrationCutoverStartupFailure(input: {
  activeDatabaseType: DatabaseType
  error: unknown
}): Promise<DatabaseMigrationCutoverStartupFailureResult> {
  const marker = readDatabaseMigrationCutoverMarker()
  if (
    !marker
    || input.activeDatabaseType !== 'mysql'
    || (marker.status !== 'mysql_pending' && marker.status !== 'verifying')
  ) {
    return {
      handled: false,
      action: 'none',
      exitCode: 1,
      marker,
    }
  }

  const attemptedMarker = markDatabaseMigrationCutover({
    attempts: marker.attempts + 1,
    status: 'mysql_pending',
    lastError: buildSafeStartupErrorSummary(input.error),
  })
  if (attemptedMarker.attempts < MYSQL_STARTUP_FAILURES_BEFORE_ROLLBACK) {
    return {
      handled: true,
      action: 'restart_mysql',
      exitCode: DATABASE_MIGRATION_PLANNED_RESTART_EXIT_CODE,
      marker: attemptedMarker,
    }
  }

  await writeSqliteRollbackOverride(attemptedMarker)
  const rollbackMarker = markDatabaseMigrationCutover({
    status: 'rollback_pending',
  })
  return {
    handled: true,
    action: 'restart_sqlite_rollback',
    exitCode: DATABASE_MIGRATION_PLANNED_RESTART_EXIT_CODE,
    marker: rollbackMarker,
  }
}

export async function handleDatabaseMigrationCutoverStartupSuccess(input: {
  activeDatabaseType: DatabaseType
}): Promise<DatabaseMigrationCutoverStartupSuccessResult> {
  let marker = readDatabaseMigrationCutoverMarker()
  if (!marker) {
    return {
      action: 'none',
      marker: null,
    }
  }

  if (input.activeDatabaseType === 'mysql' && (marker.status === 'mysql_pending' || marker.status === 'verifying')) {
    marker = markDatabaseMigrationCutover({
      status: 'verifying',
      lastError: null,
    })
    const finalizer = await loadCutoverFinalizer('finalizeAutomaticMigrationAfterStartup')
    if (!finalizer) {
      return {
        action: 'awaiting_mysql_finalizer',
        marker,
      }
    }
    const finalizerResult = await finalizer({
      ...toFinalizationInput(marker),
      deferMaintenanceFinish: true,
    })
    if (readFinalizerTaskStatus(finalizerResult) === 'rolled_back') {
      marker = markDatabaseMigrationCutover({
        status: 'rollback_pending',
      })
      return {
        action: 'rollback_restart_pending',
        marker,
      }
    }
    return {
      action: 'mysql_finalized',
      marker,
      taskId: marker.taskId,
    }
  }

  // 若进程在“SQLite 覆盖已写入、marker 尚未改成 rollback_pending”的窗口退出，
  // attempts>=2 可证明回退已进入执行阶段，SQLite 成功启动后可安全续接最终确认。
  if (input.activeDatabaseType === 'sqlite' && marker.status === 'mysql_pending' && marker.attempts >= MYSQL_STARTUP_FAILURES_BEFORE_ROLLBACK) {
    marker = markDatabaseMigrationCutover({
      status: 'rollback_pending',
    })
  }

  if (input.activeDatabaseType === 'sqlite' && marker.status === 'rollback_pending') {
    const finalizer = await loadCutoverFinalizer('finalizeAutomaticMigrationRollbackAfterStartup')
    if (!finalizer) {
      return {
        action: 'awaiting_rollback_finalizer',
        marker,
      }
    }
    await finalizer({
      ...toFinalizationInput(marker),
      deferMaintenanceFinish: true,
    })
    return {
      action: 'rollback_finalized',
      marker,
      taskId: marker.taskId,
    }
  }

  return {
    action: 'database_type_mismatch',
    marker,
  }
}

export async function completeDatabaseMigrationCutoverStartup(taskId: string): Promise<void> {
  const normalizedTaskId = normalizeRequiredText(taskId, MAX_TASK_ID_LENGTH, '迁移任务 ID')
  const marker = readDatabaseMigrationCutoverMarker()
  if (!marker || marker.taskId !== normalizedTaskId) {
    throw new Error('数据库切换启动收尾标记不存在或不属于当前任务')
  }
  if (marker.status !== 'verifying' && marker.status !== 'rollback_pending') {
    throw new Error(`数据库切换启动收尾状态 ${marker.status} 不允许解除维护`)
  }
  const activeMaintenanceTaskId = databaseMaintenanceModeService.getActiveTaskId()
  if (activeMaintenanceTaskId && activeMaintenanceTaskId !== normalizedTaskId) {
    throw new Error('数据库切换标记与只读维护任务不一致，禁止解除维护')
  }
  await databaseMaintenanceModeService.finishReadOnly(normalizedTaskId)
  if (databaseMaintenanceModeService.isReadOnly()) {
    throw new Error('数据库切换启动补数完成后未能解除只读维护')
  }
  clearDatabaseMigrationCutoverMarker()
}
