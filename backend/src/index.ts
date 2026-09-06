/**
 * 最薄启动入口：先检查磁盘控制状态，再动态加载业务模块。
 * 数据库、配置或切换验收失败后保留独立救援进程；救援不创建账号、会话或业务表。
 */
let businessRuntime: typeof import('./runtime/business-runtime.js') | undefined
let reason = 'DATABASE_STARTUP_FAILED'
try {
  const { inspectDatabaseStartup } = await import('./runtime/database-startup-preflight.js')
  const startup = await inspectDatabaseStartup()
  businessRuntime = await import('./runtime/business-runtime.js')
  await businessRuntime.startBusinessRuntime(startup)
} catch (error) {
  // 只输出稳定码，数据库驱动异常可能包含内部路径、账号或连接参数。
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)) reason = error.message
  if (businessRuntime) await businessRuntime.stopFailedBusinessRuntime().catch(() => undefined)
  try {
    const { inspectRecoveryIntent } = await import('./runtime/database-rescue-control.js')
    const recovery = inspectRecoveryIntent()
    if (recovery.state === 'healthy' && recovery.value.phase === 'VERIFYING' && recovery.value.sqliteRestartAttempts < 2) process.exit(75)
    const { inspectDatabaseRuntimeOverride } = await import('./config/database-runtime-override.js')
    const override = inspectDatabaseRuntimeOverride()
    if (override.state === 'healthy' && override.value.config.DB_TYPE === 'mysql'
      && (recovery.state === 'absent' || (recovery.state === 'healthy' && recovery.value.phase === 'COMPLETED'))) {
      const cutover = await import('./services/database-migration-cutover.service.js')
      const result = await cutover.handleDatabaseMigrationCutoverStartupFailure({ activeDatabaseType: 'mysql', error })
      if (result.handled) process.exit(result.exitCode)
    }
  } catch { /* 无法证明恢复状态时保持救援，不猜测目标。 */ }
  const { startDatabaseRescueServer } = await import('./runtime/rescue-app.js')
  await startDatabaseRescueServer(reason)
}
