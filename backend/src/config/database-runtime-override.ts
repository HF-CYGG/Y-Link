/**
 * 模块说明：backend/src/config/database-runtime-override.ts
 * 文件职责：统一管理数据库运行时覆盖配置文件，供启动期装载、迁移切换与回退流程复用。
 * 维护说明：本文件只处理“文件持久化与脱敏展示”，不直接承担迁移逻辑，避免职责混杂。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type DatabaseOverrideMode = 'sqlite' | 'mysql'

export interface DatabaseRuntimeOverrideConfig {
  DB_TYPE: DatabaseOverrideMode
  DB_HOST?: string
  DB_PORT?: number
  DB_USER?: string
  DB_PASSWORD?: string
  DB_NAME?: string
  SQLITE_DB_PATH?: string
  DB_SYNC?: boolean
}

export interface DatabaseRuntimeOverrideRollbackConfig {
  DB_TYPE: 'sqlite'
  SQLITE_DB_PATH: string
  DB_SYNC?: boolean
}

export interface DatabaseRuntimeOverrideFile {
  version: 1
  updatedAt: string
  reason?: string
  sourceTaskId?: string
  updatedBy?: {
    userId: string
    username: string
    displayName: string
  } | null
  config: DatabaseRuntimeOverrideConfig
  rollbackConfig?: DatabaseRuntimeOverrideRollbackConfig
}

/**
 * 运行时覆盖文件固定落在 backend/data/runtime 下：
 * - 与业务数据库文件、备份文件同属后端可写目录；
 * - 不依赖当前 shell 工作目录，避免从 monorepo 根目录启动时路径错位。
 */
const backendRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtimeDir = path.resolve(backendRootDir, 'data', 'runtime')
const runtimeOverrideFilePath = path.resolve(runtimeDir, 'database-runtime-override.json')
const runtimeOverrideTempFilePath = `${runtimeOverrideFilePath}.tmp`

/**
 * 运行时覆盖文件字段边界：
 * - 与路由层 zod 口径保持一致，避免“接口看似拦住了，磁盘落盘仍可写入脏数据”；
 * - 统一在底层工具里兜底，确保任何调用方都要经过同一套合法性收敛。
 */
const RUNTIME_OVERRIDE_LIMITS = {
  host: 200,
  user: 100,
  database: 100,
  password: 500,
  sqlitePath: 500,
  reason: 500,
  sourceTaskId: 100,
  actorUserId: 64,
  actorUsername: 64,
  actorDisplayName: 128,
} as const

function normalizeLimitedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    return undefined
  }
  return normalized
}

function normalizeRawLimitedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length > maxLength) {
    return undefined
  }
  return value
}

function normalizeIsoDateTime(value: unknown): string | undefined {
  const normalized = normalizeLimitedText(value, 64)
  if (!normalized) {
    return undefined
  }
  const parsedTime = Date.parse(normalized)
  if (Number.isNaN(parsedTime)) {
    return undefined
  }
  return new Date(parsedTime).toISOString()
}

function containsUnsafeLineBreak(value: string): boolean {
  return /[\r\n]/.test(value)
}

function normalizeStringValue(value: unknown): string | undefined {
  return normalizeLimitedText(value, 2000)
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'on') {
      return true
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'off') {
      return false
    }
  }
  return undefined
}

function normalizeOptionalPort(value: unknown): number | undefined {
  const normalizedPort = normalizeOptionalNumber(value)
  if (
    normalizedPort === undefined
    || !Number.isInteger(normalizedPort)
    || normalizedPort < 1
    || normalizedPort > 65535
  ) {
    return undefined
  }
  return normalizedPort
}

function normalizeSqlitePathValue(value: unknown): string | undefined {
  const normalizedPath = normalizeLimitedText(value, RUNTIME_OVERRIDE_LIMITS.sqlitePath)
  if (!normalizedPath || containsUnsafeLineBreak(normalizedPath)) {
    return undefined
  }
  return normalizedPath
}

function normalizeRuntimeOverrideActor(
  input: unknown,
): DatabaseRuntimeOverrideFile['updatedBy'] {
  if (!input || typeof input !== 'object') {
    return null
  }

  const rawActor = input as Record<string, unknown>
  const userId = normalizeLimitedText(rawActor.userId, RUNTIME_OVERRIDE_LIMITS.actorUserId)
  const username = normalizeLimitedText(rawActor.username, RUNTIME_OVERRIDE_LIMITS.actorUsername)
  const displayName = normalizeLimitedText(rawActor.displayName, RUNTIME_OVERRIDE_LIMITS.actorDisplayName)
  if (!userId || !username || !displayName) {
    return null
  }

  return {
    userId,
    username,
    displayName,
  }
}

function normalizeRuntimeOverrideConfig(input: unknown): DatabaseRuntimeOverrideConfig | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const rawConfig = input as Record<string, unknown>
  const rawDbType = normalizeStringValue(rawConfig.DB_TYPE)
  if (rawDbType !== 'sqlite' && rawDbType !== 'mysql') {
    return null
  }

  const normalizedConfig: DatabaseRuntimeOverrideConfig = {
    DB_TYPE: rawDbType,
  }

  const host = normalizeLimitedText(rawConfig.DB_HOST, RUNTIME_OVERRIDE_LIMITS.host)
  const port = normalizeOptionalPort(rawConfig.DB_PORT)
  const user = normalizeLimitedText(rawConfig.DB_USER, RUNTIME_OVERRIDE_LIMITS.user)
  const password = normalizeRawLimitedText(rawConfig.DB_PASSWORD, RUNTIME_OVERRIDE_LIMITS.password)
  const database = normalizeLimitedText(rawConfig.DB_NAME, RUNTIME_OVERRIDE_LIMITS.database)
  const sqlitePath = normalizeSqlitePathValue(rawConfig.SQLITE_DB_PATH)
  const dbSync = normalizeOptionalBoolean(rawConfig.DB_SYNC)

  if (rawDbType === 'mysql') {
    if (!host || !port || !user || !database) {
      return null
    }
    normalizedConfig.DB_HOST = host
    normalizedConfig.DB_PORT = port
    normalizedConfig.DB_USER = user
    normalizedConfig.DB_PASSWORD = password ?? ''
    normalizedConfig.DB_NAME = database
  }

  if (rawDbType === 'sqlite') {
    if (!sqlitePath) {
      return null
    }
    normalizedConfig.SQLITE_DB_PATH = sqlitePath
  }

  if (dbSync !== undefined) {
    normalizedConfig.DB_SYNC = dbSync
  }

  return normalizedConfig
}

function normalizeRollbackConfig(input: unknown): DatabaseRuntimeOverrideRollbackConfig | undefined {
  if (!input || typeof input !== 'object') {
    return undefined
  }

  const rawRollback = input as Record<string, unknown>
  const dbType = normalizeStringValue(rawRollback.DB_TYPE)
  const sqlitePath = normalizeSqlitePathValue(rawRollback.SQLITE_DB_PATH)
  if (dbType !== 'sqlite' || !sqlitePath) {
    return undefined
  }

  return {
    DB_TYPE: 'sqlite',
    SQLITE_DB_PATH: sqlitePath,
    DB_SYNC: normalizeOptionalBoolean(rawRollback.DB_SYNC),
  }
}

export function getDatabaseRuntimeOverrideFilePath(): string {
  return runtimeOverrideFilePath
}

function normalizeRuntimeOverrideFilePayload(input: unknown): DatabaseRuntimeOverrideFile | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const rawPayload = input as Record<string, unknown>
  const config = normalizeRuntimeOverrideConfig(rawPayload.config)
  if (!config) {
    return null
  }

  const updatedAt = normalizeIsoDateTime(rawPayload.updatedAt)
  if (!updatedAt) {
    return null
  }

  const rawVersion = rawPayload.version
  if (rawVersion !== 1 && rawVersion !== '1') {
    return null
  }

  return {
    version: 1,
    updatedAt,
    reason: normalizeLimitedText(rawPayload.reason, RUNTIME_OVERRIDE_LIMITS.reason),
    sourceTaskId: normalizeLimitedText(rawPayload.sourceTaskId, RUNTIME_OVERRIDE_LIMITS.sourceTaskId),
    updatedBy: normalizeRuntimeOverrideActor(rawPayload.updatedBy),
    config,
    rollbackConfig: normalizeRollbackConfig(rawPayload.rollbackConfig),
  }
}

export function readDatabaseRuntimeOverride(): DatabaseRuntimeOverrideFile | null {
  if (!fs.existsSync(runtimeOverrideFilePath)) {
    return null
  }

  try {
    const raw = JSON.parse(fs.readFileSync(runtimeOverrideFilePath, 'utf8')) as Record<string, unknown>
    return normalizeRuntimeOverrideFilePayload(raw)
  } catch {
    return null
  }
}

/**
 * 启动期只接受字符串环境变量，因此这里把 JSON 覆盖配置映射为字符串字典。
 */
export function loadDatabaseRuntimeOverrideEnvValues(): Record<string, string> | null {
  const runtimeOverride = readDatabaseRuntimeOverride()
  if (!runtimeOverride) {
    return null
  }

  const envMap: Record<string, string> = {
    DB_TYPE: runtimeOverride.config.DB_TYPE,
  }

  if (runtimeOverride.config.DB_HOST) {
    envMap.DB_HOST = runtimeOverride.config.DB_HOST
  }
  if (runtimeOverride.config.DB_PORT !== undefined) {
    envMap.DB_PORT = String(runtimeOverride.config.DB_PORT)
  }
  if (runtimeOverride.config.DB_USER) {
    envMap.DB_USER = runtimeOverride.config.DB_USER
  }
  if (runtimeOverride.config.DB_PASSWORD !== undefined) {
    envMap.DB_PASSWORD = runtimeOverride.config.DB_PASSWORD
  }
  if (runtimeOverride.config.DB_NAME) {
    envMap.DB_NAME = runtimeOverride.config.DB_NAME
  }
  if (runtimeOverride.config.SQLITE_DB_PATH) {
    envMap.SQLITE_DB_PATH = runtimeOverride.config.SQLITE_DB_PATH
  }
  if (runtimeOverride.config.DB_SYNC !== undefined) {
    envMap.DB_SYNC = runtimeOverride.config.DB_SYNC ? 'true' : 'false'
  }

  return envMap
}

export async function writeDatabaseRuntimeOverride(payload: DatabaseRuntimeOverrideFile): Promise<DatabaseRuntimeOverrideFile> {
  fs.mkdirSync(runtimeDir, { recursive: true })
  const normalizedPayload = normalizeRuntimeOverrideFilePayload(payload)
  if (!normalizedPayload) {
    throw new Error('数据库运行时覆盖配置不合法，已拒绝写入磁盘')
  }

  // 先写临时文件再替换正式文件，尽量避免进程中断时留下半截 JSON。
  fs.writeFileSync(runtimeOverrideTempFilePath, JSON.stringify(normalizedPayload, null, 2), 'utf8')
  try {
    fs.renameSync(runtimeOverrideTempFilePath, runtimeOverrideFilePath)
  } catch {
    if (fs.existsSync(runtimeOverrideFilePath)) {
      fs.unlinkSync(runtimeOverrideFilePath)
    }
    fs.renameSync(runtimeOverrideTempFilePath, runtimeOverrideFilePath)
  }
  return normalizedPayload
}

export async function clearDatabaseRuntimeOverride(): Promise<boolean> {
  if (!fs.existsSync(runtimeOverrideFilePath)) {
    return false
  }
  fs.unlinkSync(runtimeOverrideFilePath)
  return true
}

export function maskDatabaseRuntimeOverride(
  payload: DatabaseRuntimeOverrideFile | null,
): (Omit<DatabaseRuntimeOverrideFile, 'config'> & { config: DatabaseRuntimeOverrideConfig | null }) | null {
  if (!payload) {
    return null
  }

  return {
    version: payload.version,
    updatedAt: payload.updatedAt,
    reason: payload.reason,
    sourceTaskId: payload.sourceTaskId,
    updatedBy: payload.updatedBy,
    rollbackConfig: payload.rollbackConfig,
    config: payload.config.DB_TYPE === 'mysql'
      ? {
          ...payload.config,
          DB_PASSWORD: payload.config.DB_PASSWORD ? '***' : '',
        }
      : payload.config,
  }
}
