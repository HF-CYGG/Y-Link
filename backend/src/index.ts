/**
 * 模块说明：backend/src/index.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { createApp } from './app.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from './config/database-bootstrap.js'
import { AppDataSource } from './config/data-source.js'
import { env, envLoadContext } from './config/env.js'
import { authService } from './services/auth.service.js'
import { systemConfigService } from './services/system-config.service.js'

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

  const timestamp = new Date().toISOString()
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
  logLine('RUNTIME', `pid=${process.pid} node=${process.version} platform=${process.platform}/${process.arch}`)

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
  const databaseRuntime = prepareDatabaseRuntime()
  logLine('STEP', 'initialize datasource')
  await AppDataSource.initialize()
  logLine('STEP', 'initialize database schema')
  const schemaInitResult = await initializeDatabaseSchemaIfNeeded(AppDataSource)
  logLine('SCHEMA', `action=${schemaInitResult.action} reason=${schemaInitResult.reason}`)
  logLine('STEP', 'ensure default admin')
  const adminBootstrap = await authService.ensureDefaultAdmin()
  logLine('STEP', 'ensure default system configs')
  const configBootstrap = await systemConfigService.ensureDefaultConfigs()

  const app = createApp()
  app.listen(env.PORT, () => {
    logBanner('服务启动完成')
    logLine('LISTEN', `http://127.0.0.1:${env.PORT}`, 'success')
    logLine(
      'PROFILE',
      `${env.APP_PROFILE} (envFiles=${
        envLoadContext.loadedFiles.length ? envLoadContext.loadedFiles.join(', ') : '(none)'
      })`,
    )
    logLine('DATABASE', `mode=${databaseRuntime.mode} target=${databaseRuntime.summary}`)
    logLine(
      'ADMIN',
      `username=${adminBootstrap.username} displayName=${adminBootstrap.displayName} initialized=${adminBootstrap.initialized}`,
      adminBootstrap.initialized ? 'success' : 'info',
    )
    logLine(
      'ADMIN BOOTSTRAP',
      `passwordSource=${adminBootstrap.usingDefaultBootstrapPassword ? 'built-in-default' : 'custom-env'}`,
      adminBootstrap.usingDefaultBootstrapPassword ? 'warn' : 'success',
    )
    logLine(
      'SYSTEM CONFIG',
      `inserted=${configBootstrap.insertedCount}/${configBootstrap.totalCount}`,
      configBootstrap.insertedCount > 0 ? 'success' : 'info',
    )
    if (adminBootstrap.initialized) {
      // 安全加固：禁止在启动日志输出明文密码，避免被日志采集系统或终端历史泄露。
      logLine('INIT CREDENTIAL', `username=${adminBootstrap.username} password=***`, 'warn')
      logLine('SECURITY', '首次登录后请立即修改默认管理员密码。', 'warn')
    } else if (adminBootstrap.usingDefaultBootstrapPassword) {
      logLine('SECURITY', '当前配置仍为内置默认初始化密码，建议改为私有强密码。', 'warn')
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
