import { createApp } from './app.js'
import { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } from './config/database-bootstrap.js'
import { AppDataSource } from './config/data-source.js'
import { env, envLoadContext } from './config/env.js'
import { authService } from './services/auth.service.js'

async function bootstrap(): Promise<void> {
  const databaseRuntime = prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  const adminBootstrap = await authService.ensureDefaultAdmin()

  const app = createApp()
  app.listen(env.PORT, () => {
    // 启动日志保留最关键信息，便于快速排查端口与环境问题。
    console.log(`[y-link-backend] listening on http://127.0.0.1:${env.PORT}`)
    console.log(
      `[y-link-backend] profile=${env.APP_PROFILE} envFiles=${
        envLoadContext.loadedFiles.length ? envLoadContext.loadedFiles.join(', ') : '(none)'
      }`,
    )
    console.log(`[y-link-backend] database mode=${databaseRuntime.mode} target=${databaseRuntime.summary}`)
    console.log(
      `[y-link-backend] default admin username=${adminBootstrap.username} initialized=${adminBootstrap.initialized}`,
    )
  })
}

try {
  await bootstrap()
} catch (error) {
  console.error('[y-link-backend] bootstrap failed:', error)
  process.exit(1)
}
