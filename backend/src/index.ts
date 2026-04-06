import { createApp } from './app.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from './config/database-bootstrap.js'
import { AppDataSource } from './config/data-source.js'
import { env, envLoadContext } from './config/env.js'
import { authService } from './services/auth.service.js'

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

const logLine = (label: string, value: string, tone: 'info' | 'success' | 'warn' = 'info') => {
  const colorByTone = {
    info: 'cyan',
    success: 'green',
    warn: 'yellow',
  } as const

  const timestamp = new Date().toISOString()
  console.log(`${paint(timestamp, 'dim')} ${paint(`[${label}]`, colorByTone[tone])} ${value}`)
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
    if (adminBootstrap.initialized) {
      logLine(
        'INIT CREDENTIAL',
        `username=${adminBootstrap.username} password=${env.INIT_ADMIN_PASSWORD}`,
        'warn',
      )
      logLine('SECURITY', '首次登录后请立即修改默认管理员密码。', 'warn')
    } else if (adminBootstrap.usingDefaultBootstrapPassword) {
      logLine('SECURITY', '当前配置仍为内置默认初始化密码，建议改为私有强密码。', 'warn')
    }
    console.log(paint('='.repeat(72), 'dim'))
  })
}

try {
  await bootstrap()
} catch (error) {
  logBanner('服务启动失败')
  console.error(paint('[y-link-backend] bootstrap failed:', 'red'), error)
  process.exit(1)
}
