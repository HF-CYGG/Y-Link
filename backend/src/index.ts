/**
 * 模块说明：backend/src/index.ts
 * 文件职责：作为后端启动入口，负责初始化数据库、默认数据、自检日志以及运行时配置回显。
 * 维护说明：数据库切换/回退依赖启动阶段读取覆盖配置，因此启动日志必须明确打印当前是否命中了运行时覆盖。
 */

import { createApp } from './app.js'
import type { Server } from 'node:http'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from './config/database-bootstrap.js'
import { AppDataSource } from './config/data-source.js'
import { maskDatabaseRuntimeOverride, readDatabaseRuntimeOverride } from './config/database-runtime-override.js'
import { env, envLoadContext } from './config/env.js'
import { initializeDatabaseInfrastructure } from './database/database-strategy.js'
import { authService } from './services/auth.service.js'
import {
  assertDatabaseMigrationE2EStartupAllowed,
  completeDatabaseMigrationCutoverStartup,
  handleDatabaseMigrationCutoverStartupFailure,
  handleDatabaseMigrationCutoverStartupSuccess,
  inspectDatabaseMigrationCutoverMarker,
  type DatabaseMigrationCutoverStartupSuccessResult,
} from './services/database-migration-cutover.service.js'
import { databaseMaintenanceModeService } from './services/database-maintenance-mode.service.js'
import { databaseMigrationService } from './services/database-migration.service.js'
import { notificationService } from './services/notification.service.js'
import { o2oPreorderService } from './services/o2o-preorder.service.js'
import { persistentRiskStateService } from './services/persistent-risk-state.service.js'
import { systemConfigService } from './services/system-config.service.js'
import { migrateLegacyUploadReferences } from './utils/upload-migration.js'
import { registerRuntimeShutdownHandler } from './runtime/runtime-shutdown.js'
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

let activeHttpServer: Server | null = null
let shutdownPromise: Promise<void> | null = null

const shutdownRuntime = (reason: string, exitCode: number): Promise<void> => {
  if (shutdownPromise) {
    return shutdownPromise
  }
  shutdownPromise = (async () => {
    logLine('SHUTDOWN', `reason=${reason}，停止接收新请求并等待后台事务完成`, 'warn')
    const server = activeHttpServer
    const serverClosed = server
      ? new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeIdleConnections?.()
        })
      : Promise.resolve()

    let backgroundStopped = false
    const backgroundStop = Promise.allSettled([
      notificationService.stopOutboxWorker(),
      o2oPreorderService.stopTimeoutRecycleLoop(),
    ]).then(() => {
      backgroundStopped = true
    })
    await Promise.race([backgroundStop, sleep(18_000)])
    if (!backgroundStopped) {
      logLine('SHUTDOWN', '后台事务在 18 秒内未结束，将进入强制收口', 'warn')
    }

    let serverStopped = false
    await Promise.race([
      serverClosed.then(() => {
        serverStopped = true
      }),
      sleep(4_000),
    ])
    if (!serverStopped) {
      server?.closeAllConnections?.()
      await Promise.race([serverClosed, sleep(1_000)])
    }

    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy().catch((error) => {
        console.error(paint('[y-link-backend] datasource shutdown failed:', 'red'), error)
      })
    }
    activeHttpServer = null
    process.exit(exitCode)
  })()
  return shutdownPromise
}

registerRuntimeShutdownHandler(shutdownRuntime)

process.once('SIGTERM', () => {
  void shutdownRuntime('SIGTERM', 0)
})
process.once('SIGINT', () => {
  void shutdownRuntime('SIGINT', 0)
})

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

const runStartupDiagnostics = async (port: number): Promise<boolean> => {
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
  return healthOk
}

const logCutoverStartupResult = (
  cutoverStartupResult: DatabaseMigrationCutoverStartupSuccessResult,
): void => {
  if (cutoverStartupResult.action === 'mysql_finalized') {
    logLine('DB CUTOVER', `task=${cutoverStartupResult.taskId} MySQL 启动校验已完成`, 'success')
  } else if (cutoverStartupResult.action === 'rollback_finalized') {
    logLine('DB CUTOVER', `task=${cutoverStartupResult.taskId} SQLite 自动回退已确认`, 'warn')
  } else if (
    cutoverStartupResult.action === 'awaiting_mysql_finalizer'
    || cutoverStartupResult.action === 'awaiting_rollback_finalizer'
  ) {
    logLine(
      'DB CUTOVER',
      `task=${cutoverStartupResult.marker.taskId} finalizer=${cutoverStartupResult.action}，保留维护状态等待主迁移服务接管`,
      'warn',
    )
  } else if (cutoverStartupResult.action === 'rollback_restart_pending') {
    logLine(
      'DB CUTOVER',
      `task=${cutoverStartupResult.marker.taskId} 紧急取消已持久化，准备重启恢复 SQLite`,
      'warn',
    )
  } else if (cutoverStartupResult.action === 'database_type_mismatch') {
    logLine(
      'DB CUTOVER',
      `task=${cutoverStartupResult.marker?.taskId ?? 'unknown'} marker 与当前数据库类型不一致，已保留维护状态`,
      'error',
    )
  }
}

const runMutableStartupBootstrap = async () => {
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
  logLine('STEP', 'ensure default notification rules')
  await notificationService.ensureDefaultRules()

  return {
    adminBootstrap,
    configBootstrap,
  }
}

type MutableStartupBootstrapResult = Awaited<ReturnType<typeof runMutableStartupBootstrap>>

const logMutableStartupBootstrapResult = (
  result: MutableStartupBootstrapResult,
): void => {
  const { adminBootstrap, configBootstrap } = result
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
    logLine('INIT CREDENTIAL', `username=${adminBootstrap.username} password=***`, 'warn')
    logLine('SECURITY', '管理员初始化已要求使用私有密码，首次登录后仍建议立即改密。', 'warn')
  }
  if (adminBootstrap.rotatedLegacyDefaultPassword) {
    logLine('SECURITY', '已检测并迁移历史默认管理员口令，请改用私有初始化密码重新登录。', 'warn')
  }
}

async function bootstrap(): Promise<void> {
  logBanner('启动阶段')
  logLine('STEP', 'prepare runtime context')
  prepareDatabaseRuntime()
  logLine('STEP', 'initialize datasource')
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  const cutoverMarkerInspection = inspectDatabaseMigrationCutoverMarker()
  if (cutoverMarkerInspection.state === 'corrupted') {
    const recoveryTaskId = (
      databaseMaintenanceModeService.getActiveTaskId()
      ?? readDatabaseRuntimeOverride()?.sourceTaskId
    )
    if (recoveryTaskId) {
      await databaseMaintenanceModeService.beginReadOnly({
        taskId: recoveryTaskId,
        phase: 'control_state_corrupted',
      })
    }
    throw new Error('数据库迁移切换标记存在但已损坏，已禁止启动期 schema 与业务写入')
  }
  const cutoverMarkerAtStartup = cutoverMarkerInspection.marker
  let mutableStartupBootstrapResult: MutableStartupBootstrapResult | null = null
  if (!cutoverMarkerAtStartup) {
    logLine('STEP', 'initialize database schema')
    const schemaInitResult = await initializeDatabaseSchemaIfNeeded(AppDataSource)
    logLine('SCHEMA', `action=${schemaInitResult.action} reason=${schemaInitResult.reason}`)
    mutableStartupBootstrapResult = await runMutableStartupBootstrap()
  } else {
    await databaseMaintenanceModeService.beginReadOnly({
      taskId: cutoverMarkerAtStartup.taskId,
      phase: cutoverMarkerAtStartup.status === 'rollback_pending' ? 'rollback_verifying' : 'verifying',
    })
    logLine(
      'DB CUTOVER',
      `task=${cutoverMarkerAtStartup.taskId} 已进入无 schema/业务写入启动模式，先完成不可变快照验收`,
      'warn',
    )
  }

  const app = createApp()
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(env.PORT)
    activeHttpServer = server
    const onError = (error: Error) => {
      activeHttpServer = null
      reject(error)
    }
    server.once('error', onError)
    server.once('listening', () => {
      server.off('error', onError)
      resolve()
    })
  })

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
  if (mutableStartupBootstrapResult) {
    logMutableStartupBootstrapResult(mutableStartupBootstrapResult)
  }
  console.log(paint('='.repeat(72), 'dim'))

  const healthOk = await runStartupDiagnostics(env.PORT)
  if (!healthOk && cutoverMarkerAtStartup) {
    throw new Error('数据库切换后的 HTTP 健康自检未通过，禁止确认切换成功')
  }

  // 切换启动时，故障注入必须发生在数据源与 HTTP 健康检查之后、任何业务写入之前，
  // 以覆盖 onebox 启动失败自动回退路径，同时不污染待验收的 MySQL 数据。
  assertDatabaseMigrationE2EStartupAllowed(env.DB_TYPE)
  const cutoverStartupResult = await handleDatabaseMigrationCutoverStartupSuccess({
    activeDatabaseType: env.DB_TYPE,
  })
  logCutoverStartupResult(cutoverStartupResult)
  if (cutoverStartupResult.action === 'rollback_restart_pending') {
    setTimeout(() => {
      void shutdownRuntime('database_cutover_rollback', 75)
    }, 250)
    return
  }

  if (
    cutoverMarkerAtStartup
    && (
      cutoverStartupResult.action === 'mysql_finalized'
      || cutoverStartupResult.action === 'rollback_finalized'
    )
  ) {
    logLine('STEP', 'initialize database schema after cutover verification')
    const schemaInitResult = await initializeDatabaseSchemaIfNeeded(AppDataSource)
    logLine('SCHEMA', `action=${schemaInitResult.action} reason=${schemaInitResult.reason}`)
    mutableStartupBootstrapResult = await runMutableStartupBootstrap()
    logMutableStartupBootstrapResult(mutableStartupBootstrapResult)
    await completeDatabaseMigrationCutoverStartup(cutoverStartupResult.taskId)
  }

  void databaseMigrationService.resumeInterruptedAutomaticMigrationAfterStartup().then((taskId) => {
    if (taskId) {
      logLine('DB MIGRATION', `task=${taskId} 已调度自动续跑`, 'warn')
    }
  }).catch((error) => {
    console.error(paint('[y-link-backend] resume automatic database migration failed:', 'red'), error)
  }).finally(() => {
    // 通知 outbox 定时器在维护期只空转检查，不领取新任务；维护 drain 会等待已领取批次释放。
    notificationService.startOutboxWorker()
    if (!databaseMaintenanceModeService.isReadOnly()) {
      o2oPreorderService.startTimeoutRecycleLoop()
      persistentRiskStateService.startCleanupLoop()
    } else {
      logLine('DB MIGRATION', '数据库仍处于只读维护，后台写任务保持暂停', 'warn')
    }
  })
}

try {
  await bootstrap()
} catch (error) {
  logBanner('服务启动失败')
  console.error(paint('[y-link-backend] bootstrap failed:', 'red'), error)
  let exitCode = 1
  try {
    const cutoverFailureResult = await handleDatabaseMigrationCutoverStartupFailure({
      activeDatabaseType: env.DB_TYPE,
      error,
    })
    if (cutoverFailureResult.handled) {
      exitCode = cutoverFailureResult.exitCode
      logLine(
        'DB CUTOVER',
        `task=${cutoverFailureResult.marker.taskId} action=${cutoverFailureResult.action} attempts=${cutoverFailureResult.marker.attempts}，请求 onebox 计划重启`,
        'warn',
      )
    }
  } catch (cutoverError) {
    console.error(paint('[y-link-backend] database cutover recovery failed:', 'red'), cutoverError)
  }
  await shutdownRuntime('bootstrap_failure', exitCode)
}
