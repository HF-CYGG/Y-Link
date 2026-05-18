/**
 * 模块说明：backend/src/index.ts
 * 文件职责：作为后端启动入口，负责初始化数据库、默认数据、自检日志以及运行时配置回显。
 * 维护说明：数据库切换/回退依赖启动阶段读取覆盖配置，因此启动日志必须明确打印当前是否命中了运行时覆盖。
 */

import { createApp } from './app.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from './config/database-bootstrap.js'
import { AppDataSource } from './config/data-source.js'
import { maskDatabaseRuntimeOverride, readDatabaseRuntimeOverride } from './config/database-runtime-override.js'
import { env, envLoadContext } from './config/env.js'
import { authService } from './services/auth.service.js'
import { o2oPreorderService } from './services/o2o-preorder.service.js'
import { systemConfigService } from './services/system-config.service.js'
import { migrateLegacyUploadReferences } from './utils/upload-migration.js'
import { installSqliteTransactionQueue } from './utils/sqlite-transaction-queue.js'
import {
  buildEffectiveDatabaseSummary,
  buildRuntimeOverrideStatusSummary,
} from './utils/effective-database.js'

const colorPalette = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
  brightCyan: '\u001B[96m',
} as const

const shouldColorizeLogs = (): boolean => {
  const noColor = process.env.NO_COLOR
  if (typeof noColor === 'string' && noColor.length > 0) {
    return false
  }

  const rawFlag = (process.env.LOG_COLOR ?? 'true').trim().toLowerCase()
  return rawFlag !== 'false' && rawFlag !== '0' && rawFlag !== 'off'
}

const paint = (text: string, color: keyof typeof colorPalette): string => {
  if (!shouldColorizeLogs()) {
    return text
  }
  return `${colorPalette[color]}${text}${colorPalette.reset}`
}

const resolveLogTimeZone = (): string => {
  return process.env.TZ?.trim() || 'Asia/Shanghai'
}

const getDateTimePartsInTimeZone = (date: Date, timeZone: string): Record<string, string> => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  })
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
}

const formatTimeZoneOffset = (date: Date, timeZone: string): string => {
  const parts = getDateTimePartsInTimeZone(date, timeZone)
  const zonedTimeAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  const offsetMinutes = Math.round((zonedTimeAsUtc - date.getTime()) / 60_000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteMinutes = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')
  const minutes = String(absoluteMinutes % 60).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

const formatLogTimestamp = (date = new Date()): string => {
  const timeZone = resolveLogTimeZone()
  try {
    const parts = getDateTimePartsInTimeZone(date, timeZone)
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${formatTimeZoneOffset(date, timeZone)}`
  } catch {
    return date.toISOString()
  }
}

const logBanner = (title: string) => {
  console.log(paint('='.repeat(72), 'dim'))
  console.log(paint(`[y-link-backend] ${title}`, 'brightCyan'))
  console.log(paint('='.repeat(72), 'dim'))
}

const logLine = (label: string, value: string, tone: 'info' | 'success' | 'warn' | 'error' = 'info') => {
  const colorByTone = {
    info: 'cyan',
    success: 'green',
    warn: 'yellow',
    error: 'red',
  } as const

  const timestamp = formatLogTimestamp()
  const logLabel = `[${label}]`
  console.log(`${paint(timestamp, 'dim')} ${paint(logLabel, colorByTone[tone])} ${value}`)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const probeHealthEndpoint = async (port: number): Promise<boolean> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

const runStartupDiagnostics = async (port: number) => {
  logBanner('启动自检')
  logLine('RUNTIME', `pid=${process.pid} node=${process.version} platform=${process.platform}/${process.arch} timezone=${resolveLogTimeZone()}`)

  try {
    await AppDataSource.query('SELECT 1')
    logLine('CHECK DB', 'database ping success', 'success')
  } catch (error) {
    logLine('CHECK DB', `database ping failed: ${String(error)}`, 'error')
  }

  let healthOk = false
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    healthOk = await probeHealthEndpoint(port)
    if (healthOk) {
      logLine('CHECK HTTP', `/health probe success (attempt=${attempt})`, 'success')
      break
    }

    logLine('CHECK HTTP', `/health probe failed (attempt=${attempt})`, 'warn')
    if (attempt < 3) {
      await sleep(500)
    }
  }

  if (healthOk) {
    logLine('CHECK SUMMARY', 'all startup checks passed', 'success')
  } else {
    logLine('CHECK SUMMARY', 'startup checks completed with warnings', 'warn')
  }
  console.log(paint('='.repeat(72), 'dim'))
}

async function bootstrap(): Promise<void> {
  logBanner('启动阶段')
  logLine('STEP', 'prepare runtime context')
  prepareDatabaseRuntime()
  logLine('STEP', 'initialize datasource')
  await AppDataSource.initialize()
  logLine('STEP', 'install sqlite transaction queue')
  installSqliteTransactionQueue(AppDataSource)
  logLine('STEP', 'initialize database schema')
  const schemaInitResult = await initializeDatabaseSchemaIfNeeded(AppDataSource)
  logLine('SCHEMA', `action=${schemaInitResult.action} reason=${schemaInitResult.reason}`)
  logLine('STEP', 'migrate legacy upload references')
  const uploadMigrationResult = await migrateLegacyUploadReferences(AppDataSource)
  logLine(
    'UPLOAD MIGRATION',
    `products=${uploadMigrationResult.productThumbnailUpdatedCount} feedbackMessages=${uploadMigrationResult.feedbackAttachmentUpdatedCount} movedFiles=${uploadMigrationResult.movedFileCount}`,
    uploadMigrationResult.movedFileCount > 0 ? 'success' : 'info',
  )
  logLine('STEP', 'ensure default admin')
  const adminBootstrap = await authService.ensureDefaultAdmin()
  logLine('STEP', 'ensure default system configs')
  const configBootstrap = await systemConfigService.ensureDefaultConfigs()

  const app = createApp()
  app.listen(env.PORT, () => {
    o2oPreorderService.startTimeoutRecycleLoop()
    const activeOverride = maskDatabaseRuntimeOverride(readDatabaseRuntimeOverride())
    const effectiveDatabase = buildEffectiveDatabaseSummary(activeOverride)
    const runtimeOverrideStatus = buildRuntimeOverrideStatusSummary(activeOverride)
    logBanner('服务启动完成')
    logLine('LISTEN', `http://127.0.0.1:${env.PORT}`, 'success')
    logLine(
      'PROFILE',
      `${env.APP_PROFILE} (envFiles=${
        envLoadContext.loadedFiles.length ? envLoadContext.loadedFiles.join(', ') : '(none)'
      })`,
    )
    if (envLoadContext.runtimeDatabaseOverride) {
      logLine(
        'DB OVERRIDE',
        `loaded=${envLoadContext.runtimeDatabaseOverride.filePath} dbType=${envLoadContext.runtimeDatabaseOverride.dbType} updatedAt=${envLoadContext.runtimeDatabaseOverride.updatedAt}`,
        'warn',
      )
    }
    logLine(
      'DATABASE',
      `actual=${effectiveDatabase.displayName} target=${effectiveDatabase.summary} source=${effectiveDatabase.sourceLabel}`,
    )
    logLine(
      'DB OVERRIDE STATUS',
      `${runtimeOverrideStatus.statusLabel}（pendingRestart=${runtimeOverrideStatus.pendingRestart}）`,
      runtimeOverrideStatus.pendingRestart ? 'warn' : 'info',
    )
    logLine(
      'ADMIN',
      `username=${adminBootstrap.username} displayName=${adminBootstrap.displayName} initialized=${adminBootstrap.initialized}`,
      adminBootstrap.initialized ? 'success' : 'info',
    )
    logLine(
      'ADMIN BOOTSTRAP',
      `privatePasswordApplied=${adminBootstrap.usedPrivateBootstrapPassword} rotatedLegacyDefault=${adminBootstrap.rotatedLegacyDefaultPassword}`,
      adminBootstrap.usedPrivateBootstrapPassword ? 'success' : 'info',
    )
    logLine(
      'SYSTEM CONFIG',
      `inserted=${configBootstrap.insertedCount}/${configBootstrap.totalCount}`,
      configBootstrap.insertedCount > 0 ? 'success' : 'info',
    )
    if (adminBootstrap.initialized) {
      // 安全加固：禁止在启动日志输出明文密码，避免被日志采集系统或终端历史泄露。
      logLine('INIT CREDENTIAL', `username=${adminBootstrap.username} password=***`, 'warn')
      logLine('SECURITY', '管理员初始化已要求使用私有密码，首次登录后仍建议立即改密。', 'warn')
    }
    if (adminBootstrap.rotatedLegacyDefaultPassword) {
      logLine('SECURITY', '已检测并迁移历史默认管理员口令，请改用私有初始化密码重新登录。', 'warn')
    }
    console.log(paint('='.repeat(72), 'dim'))
    void runStartupDiagnostics(env.PORT)
  })
}

try {
  await bootstrap()
} catch (error) {
  logBanner('服务启动失败')
  console.error(paint('[y-link-backend] bootstrap failed:', 'red'), error)
  process.exit(1)
}
