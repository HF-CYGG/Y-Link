/**
 * 模块说明：backend/src/config/env-file-bootstrap.ts
 * 文件职责：在任何持久化路径或运行时覆盖文件求值前，统一装载基础、profile 与自定义 env 文件。
 * 实现逻辑：保持“.env 默认值 < 初始进程环境 < profile < ENV_FILE”的既有优先级。
 * 维护说明：本模块不能依赖 app-data-paths 或 database-runtime-override，否则会重新形成启动期循环依赖。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

export interface EnvFileBootstrapContext {
  requestedProfile: string | undefined
  requestedEnvFile: string | undefined
  loadedFiles: string[]
}

export const backendRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const initialProcessEnvKeys = new Set(Object.keys(process.env))

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  return normalized.length ? normalized : undefined
}

export function resolveEnvFilePath(filePath: string): string {
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
    if (options?.overrideExternal || !initialProcessEnvKeys.has(key)) {
      process.env[key] = value
    }
  }
  loadedFiles.push(filePath)
}

function bootstrapEnvFiles(): EnvFileBootstrapContext {
  const loadedFiles: string[] = []
  loadEnvFile(path.resolve(backendRootDir, '.env'), loadedFiles)

  const requestedProfile = normalizeOptionalString(process.env.APP_PROFILE)
  if (requestedProfile) {
    loadEnvFile(path.resolve(backendRootDir, `.env.${requestedProfile}`), loadedFiles, {
      overrideExternal: true,
    })
  }

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

export const envFileBootstrap = bootstrapEnvFiles()
