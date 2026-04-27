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

function normalizeStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
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

  const host = normalizeStringValue(rawConfig.DB_HOST)
  const port = normalizeOptionalNumber(rawConfig.DB_PORT)
  const user = normalizeStringValue(rawConfig.DB_USER)
  const password = typeof rawConfig.DB_PASSWORD === 'string' ? rawConfig.DB_PASSWORD : undefined
  const database = normalizeStringValue(rawConfig.DB_NAME)
  const sqlitePath = normalizeStringValue(rawConfig.SQLITE_DB_PATH)
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
  const sqlitePath = normalizeStringValue(rawRollback.SQLITE_DB_PATH)
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

export function readDatabaseRuntimeOverride(): DatabaseRuntimeOverrideFile | null {
  if (!fs.existsSync(runtimeOverrideFilePath)) {
    return null
  }

  try {
    const raw = JSON.parse(fs.readFileSync(runtimeOverrideFilePath, 'utf8')) as Record<string, unknown>
    const config = normalizeRuntimeOverrideConfig(raw.config)
    if (!config) {
      return null
    }

    const updatedBy =
      raw.updatedBy && typeof raw.updatedBy === 'object'
        ? {
            userId: normalizeStringValue((raw.updatedBy as Record<string, unknown>).userId) ?? '',
            username: normalizeStringValue((raw.updatedBy as Record<string, unknown>).username) ?? '',
            displayName: normalizeStringValue((raw.updatedBy as Record<string, unknown>).displayName) ?? '',
          }
        : null

    return {
      version: 1,
      updatedAt: normalizeStringValue(raw.updatedAt) ?? new Date(0).toISOString(),
      reason: normalizeStringValue(raw.reason),
      sourceTaskId: normalizeStringValue(raw.sourceTaskId),
      updatedBy: updatedBy?.userId && updatedBy.username ? updatedBy : null,
      config,
      rollbackConfig: normalizeRollbackConfig(raw.rollbackConfig),
    }
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
  const normalizedPayload: DatabaseRuntimeOverrideFile = {
    version: 1,
    updatedAt: payload.updatedAt,
    reason: payload.reason,
    sourceTaskId: payload.sourceTaskId,
    updatedBy: payload.updatedBy ?? null,
    config: payload.config,
    rollbackConfig: payload.rollbackConfig,
  }
  fs.writeFileSync(runtimeOverrideFilePath, JSON.stringify(normalizedPayload, null, 2), 'utf8')
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
