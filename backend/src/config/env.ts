/**
 * 模块说明：backend/src/config/env.ts
 * 文件职责：统一装载后端运行环境，支持基础 env、profile env、自定义 env 与数据库运行时覆盖配置四级合并。
 * 维护说明：数据库切换后的“应用生效”依赖本文件在启动阶段读取覆盖配置，因此修改优先级时必须同步检查切换/回退接口。
 */

import { z } from 'zod'
import {
  backendRootDir,
  envFileBootstrap,
  resolveEnvFilePath,
} from './env-file-bootstrap.js'
import {
  getDatabaseRuntimeOverrideFilePath,
  loadDatabaseRuntimeOverrideEnvValues,
  readDatabaseRuntimeOverride,
} from './database-runtime-override.js'

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length ? normalized : undefined
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (typeof value !== 'string' || !value.length) {
    return undefined
  }
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  return undefined
}

function sanitizeProfileName(profile: string): string {
  return profile.replaceAll(/[^a-zA-Z0-9_-]/g, '-')
}

function loadRuntimeDatabaseOverride(): boolean {
  /**
   * 最后加载数据库运行时覆盖配置：
   * - 用于“SQLite -> MySQL”切换后的下次重启生效；
   * - 只覆盖数据库相关字段，不污染其他业务配置；
   * - 优先级最高，保证切换/回退动作具备确定性。
   */
  const skipRuntimeDatabaseOverride = process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE === 'true'
  const runtimeDatabaseOverrideEnvValues = skipRuntimeDatabaseOverride
    ? null
    : loadDatabaseRuntimeOverrideEnvValues()
  const runtimeDatabaseOverrideLoaded = Boolean(runtimeDatabaseOverrideEnvValues)
  if (runtimeDatabaseOverrideEnvValues) {
    Object.entries(runtimeDatabaseOverrideEnvValues).forEach(([key, value]) => {
      process.env[key] = value
    })
    envFileBootstrap.loadedFiles.push(getDatabaseRuntimeOverrideFilePath())
  }
  return runtimeDatabaseOverrideLoaded
}

const runtimeDatabaseOverrideLoaded = loadRuntimeDatabaseOverride()

// 使用 zod 对环境变量做强约束，避免启动后才暴露配置错误。
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_PROFILE: z.string().trim().min(1).default('default'),
  ENV_FILE: z.string().optional().transform(normalizeOptionalString),
  PORT: z.coerce.number().default(3001),
  DB_TYPE: z.enum(['sqlite', 'mysql']).default('sqlite'),
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string().min(1).default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1).default('y_link'),
  SQLITE_DB_PATH: z.string().optional().transform(normalizeOptionalString),
  DB_SYNC: z.string().optional().transform(parseBoolean),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(128).default(20),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(5000),
  DB_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(3000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
  DB_QUEUE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(100),
  DB_MAX_QUERY_MS: z.coerce.number().int().min(25).max(60_000).default(200),
  SQLITE_SYNCHRONOUS: z.enum(['FULL', 'NORMAL']).default('FULL'),
  SQLITE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(5000),
  SQLITE_CACHE_SIZE_KIB: z.coerce.number().int().min(4096).max(1_048_576).default(65_536),
  SQLITE_WAL_AUTOCHECKPOINT_PAGES: z.coerce.number().int().min(1).max(100_000).default(1000),
  SQLITE_JOURNAL_SIZE_LIMIT_BYTES: z.coerce.number().int().min(1_048_576).max(1_073_741_824).default(67_108_864),
  SQLITE_WRITE_QUEUE_MAX_PENDING: z.coerce.number().int().min(1).max(10_000).default(256),
  SQLITE_WRITE_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(5000),
  // 是否在启动阶段自动执行 backend/sql/ 下已核实幂等的增量迁移脚本（仅覆盖白名单内文件，
  // 见 mysql-migration-runner.ts）；默认关闭，避免无人值守地对生产数据库执行结构变更。
  DB_AUTO_MIGRATE: z.string().optional().transform(parseBoolean),
  AUTH_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(168),
  MOBILE_ACCESS_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  MOBILE_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MOBILE_SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().int().min(1).max(730).default(90),
  MOBILE_REFRESH_GRACE_SECONDS: z.coerce.number().int().min(1).max(600).default(60),
  MOBILE_MAX_ACTIVE_SESSIONS: z.coerce.number().int().min(1).max(100).default(10),
  MOBILE_REFRESH_ROTATION_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
  MOBILE_REFRESH_ROTATION_RATE_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  INIT_ADMIN_USERNAME: z.string().trim().min(1).default('admin'),
  // 管理员初始化密码不再提供内置默认值，必须在需要时由私有配置显式提供。
  INIT_ADMIN_PASSWORD: z.string().min(6).optional().transform(normalizeOptionalString),
  INIT_ADMIN_DISPLAY_NAME: z.string().trim().min(1).default('系统管理员'),
  PERMANENT_DELETE_PASSWORD: z.string().optional().transform(normalizeOptionalString),
  VERIFICATION_CODE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  INVITE_CODE_PEPPER: z.string().optional().transform(normalizeOptionalString),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  // 启动期直接抛错，避免错误配置导致后续数据写入不一致。
  throw new Error(`环境变量校验失败: ${parsed.error.message}`)
}

const defaultSqliteDbPath =
  parsed.data.APP_PROFILE === 'default'
    ? './data/y-link.sqlite'
    : `./data/local-dev/y-link.${sanitizeProfileName(parsed.data.APP_PROFILE)}.sqlite`

/**
 * 输出统一的运行时配置：
 * - 默认 profile 仍保持现有 SQLite / MySQL 部署逻辑；
 * - 非 default profile 默认写入独立 SQLite 文件，实现本地数据隔离；
 * - ENV_FILE 与 APP_PROFILE 同时保留，便于启动日志回显来源。
 */
export const env = {
  ...parsed.data,
  SQLITE_DB_PATH: parsed.data.SQLITE_DB_PATH ?? defaultSqliteDbPath,
  DB_SYNC: parsed.data.DB_SYNC,
} as const

// 额外导出环境加载上下文，便于启动日志说明当前究竟加载了哪些配置来源。
const runtimeDatabaseOverride = readDatabaseRuntimeOverride()

export const envLoadContext = {
  backendRootDir,
  loadedFiles: envFileBootstrap.loadedFiles,
  requestedProfile: envFileBootstrap.requestedProfile,
  requestedEnvFile: envFileBootstrap.requestedEnvFile
    ? resolveEnvFilePath(envFileBootstrap.requestedEnvFile)
    : undefined,
  runtimeDatabaseOverrideLoaded,
  runtimeDatabaseOverride: runtimeDatabaseOverride
    ? {
        filePath: getDatabaseRuntimeOverrideFilePath(),
        updatedAt: runtimeDatabaseOverride.updatedAt,
        dbType: runtimeDatabaseOverride.config.DB_TYPE,
      }
    : undefined,
} as const
