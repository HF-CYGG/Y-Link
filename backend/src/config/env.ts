/**
 * 模块说明：backend/src/config/env.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * 后端根目录：
 * - 所有 profile/env 文件都相对 backend 根目录解析；
 * - 避免因为从不同工作目录启动进程而导致读取错位。
 */
const backendRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * 启动前先记录系统/命令行已经注入的环境变量键名。
 * 这样可以实现以下优先级：
 * 1. `.env` 作为基础默认值；
 * 2. 外部进程注入的环境变量可覆盖 `.env`；
 * 3. `.env.<profile>` 用于显式切换 profile，优先级高于外部继承变量；
 * 4. `ENV_FILE` 指向的自定义 env 文件优先级最高，便于强制切换到独立本地环境。
 */
const initialProcessEnvKeys = new Set(Object.keys(process.env))

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

function resolveEnvFilePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(backendRootDir, filePath)
}

function loadEnvFile(
  filePath: string,
  loadedFiles: string[],
  options?: {
    overrideExternal?: boolean
  },
): void {
  if (!fs.existsSync(filePath)) {
    return
  }

  const parsed = dotenv.parse(fs.readFileSync(filePath))

  for (const [key, value] of Object.entries(parsed)) {
    // profile/env file 是显式环境切换入口，因此允许覆盖外部继承变量；
    // 基础 `.env` 仍仅补默认值，避免意外覆盖系统级配置。
    if (options?.overrideExternal || !initialProcessEnvKeys.has(key)) {
      process.env[key] = value
    }
  }

  loadedFiles.push(filePath)
}

function bootstrapEnvFiles(): {
  requestedProfile: string | undefined
  requestedEnvFile: string | undefined
  loadedFiles: string[]
} {
  const loadedFiles: string[] = []

  // 先加载 backend/.env，作为所有环境的基础默认值。
  loadEnvFile(path.resolve(backendRootDir, '.env'), loadedFiles)

  // 再根据 profile 加载覆盖文件，例如 `.env.local-dev`。
  const requestedProfile = normalizeOptionalString(process.env.APP_PROFILE)
  if (requestedProfile) {
    loadEnvFile(path.resolve(backendRootDir, `.env.${requestedProfile}`), loadedFiles, {
      overrideExternal: true,
    })
  }

  // 最后加载显式指定的 env 文件，便于本地调试或 CI 进行定制覆盖。
  const requestedEnvFile = normalizeOptionalString(process.env.ENV_FILE)
  if (requestedEnvFile) {
    loadEnvFile(resolveEnvFilePath(requestedEnvFile), loadedFiles, {
      overrideExternal: true,
    })
  }

  return {
    requestedProfile,
    requestedEnvFile,
    loadedFiles,
  }
}

const envBootstrap = bootstrapEnvFiles()

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
  AUTH_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(168),
  INIT_ADMIN_USERNAME: z.string().trim().min(1).default('admin'),
  INIT_ADMIN_PASSWORD: z.string().min(6).default('Admin@123456'),
  INIT_ADMIN_DISPLAY_NAME: z.string().trim().min(1).default('系统管理员'),
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
export const envLoadContext = {
  backendRootDir,
  loadedFiles: envBootstrap.loadedFiles,
  requestedProfile: envBootstrap.requestedProfile,
  requestedEnvFile: envBootstrap.requestedEnvFile
    ? resolveEnvFilePath(envBootstrap.requestedEnvFile)
    : undefined,
} as const
