/** 数据库外控制路由：只接受当前任务 Bearer，所有输入受界限约束，错误只返回稳定原因码。 */
import { Router, json, type Request, type Response, type NextFunction } from 'express'
import {
  authenticateDatabaseRescueCredential, beginDatabaseRescueRollback, databaseRescueStatus,
  prepareDatabaseRescueRollback, RescueControlError,
  resumeDatabaseRecoveryOperation,
} from '../runtime/database-rescue-control.js'
import { isSecureOrDirectLoopback } from '../utils/http-security.js'
import { requestRuntimeShutdown } from '../runtime/runtime-shutdown.js'

const attempts = new Map<string, { count: number; resetsAt: number }>()
export function requireDatabaseRescueCredential(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store')
  if (!isSecureOrDirectLoopback(req)) {
    res.status(403).json({ code: 403, message: '救援需要可信 HTTPS 或容器本地连接', data: { reason: 'RESCUE_SECURE_TRANSPORT_REQUIRED' } })
    return
  }
  const key = req.ip || req.socket.remoteAddress || 'unknown'
  const time = Date.now()
  for (const [entry, state] of attempts) if (state.resetsAt <= time) attempts.delete(entry)
  if (!attempts.has(key) && attempts.size >= 1024) {
    res.status(429).json({ code: 429, message: '请求过于频繁', data: null }); return
  }
  const state = attempts.get(key) ?? { count: 0, resetsAt: time + 60_000 }
  state.count += 1
  attempts.set(key, state)
  if (state.count > 120) {
    res.setHeader('Retry-After', '60')
    res.status(429).json({ code: 429, message: '请求过于频繁', data: null }); return
  }
  try {
    const authorization = req.headers.authorization ?? ''
    if (!authorization.startsWith('Bearer ')) throw new RescueControlError('RESCUE_UNAUTHORIZED', 401)
    res.locals.rescueTaskId = authenticateDatabaseRescueCredential(authorization.slice(7))
    next()
  } catch {
    res.status(401).json({ code: 401, message: '救援凭证无效或已过期', data: { reason: 'RESCUE_UNAUTHORIZED' } })
  }
}
const handle = (work: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response) => {
  void Promise.resolve().then(() => work(req, res)).catch((error: unknown) => {
    if (res.headersSent) { res.end(); return }
    const status = error instanceof RescueControlError ? error.status : 503
    const reason = error instanceof RescueControlError ? error.code : 'RESCUE_CONTROL_UNAVAILABLE'
    res.status(status).json({ code: status, message: '救援操作未完成，请查看诊断状态', data: { reason } })
  })
}
export const databaseRescueRouter = Router()
databaseRescueRouter.use(requireDatabaseRescueCredential)
databaseRescueRouter.use(json({ limit: '4kb' }))
databaseRescueRouter.get('/status', handle((_req, res) => {
  res.json({ code: 0, message: 'ok', data: databaseRescueStatus(res.locals.rescueTaskId as string) })
}))
databaseRescueRouter.post('/prepare-rollback', handle((_req, res) => {
  res.json({ code: 0, message: 'ok', data: prepareDatabaseRescueRollback(res.locals.rescueTaskId as string) })
}))
databaseRescueRouter.post('/rollback-to-source-sqlite', handle(async (req, res) => {
  const nonce = typeof req.body?.nonce === 'string' && req.body.nonce.length <= 100 ? req.body.nonce : ''
  const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : ''
  const intent = await beginDatabaseRescueRollback(res.locals.rescueTaskId as string, nonce, key)
  res.status(202).json({ code: 0, message: 'accepted', data: { taskId: intent.taskId, operationId: intent.operationId, phase: intent.phase } })
  if (intent.phase === 'PREPARED' || intent.phase === 'RESTART_READY') setTimeout(() => {
    void resumeDatabaseRecoveryOperation(intent.taskId, intent.operationId)
      .then(() => requestRuntimeShutdown('database_rescue_rollback', 75))
      .catch(() => console.error('[database-rescue] 恢复未完成，保持控制面供诊断', { code: 'RESCUE_RESUME_FAILED' }))
  }, 250)
}))
