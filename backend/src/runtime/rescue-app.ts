/** 最小无数据库 HTTP 应用；不装配普通登录、业务路由、上传、审计或后台 worker。 */
import express from 'express'
import { databaseRescueRouter } from '../routes/database-rescue.routes.js'
import { configureHttpSecurity } from '../utils/http-security.js'
import { registerRuntimeShutdownHandler } from './runtime-shutdown.js'

export function createDatabaseRescueApp(reason: string) {
  const app = express()
  configureHttpSecurity(app)
  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.status(503).json({ status: 'RESCUE', code: reason, maintenance: { readOnly: true, phase: 'rescue', message: '数据库恢复模式' } })
  })
  app.use('/api/database-rescue', databaseRescueRouter)
  app.use((_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.status(503).json({ code: 50301, message: '数据库恢复中，请使用独立救援页面', data: { reason: 'DATABASE_RESCUE_MODE' } })
  })
  return app
}

export async function startDatabaseRescueServer(reason: string): Promise<void> {
  const port = Number(process.env.PORT ?? 3001)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RESCUE_PORT_INVALID')
  const app = createDatabaseRescueApp(reason)
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const instance = app.listen(port, () => resolve(instance))
    instance.once('error', reject)
  })
  const shutdown = async (_reason: string, code: number) => {
    server.closeIdleConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    process.exit(code)
  }
  registerRuntimeShutdownHandler(shutdown)
  process.once('SIGTERM', () => { void shutdown('SIGTERM', 0) })
  process.once('SIGINT', () => { void shutdown('SIGINT', 0) })
  console.error('[database-rescue] 已启动受限救援控制面', { code: reason })
}
