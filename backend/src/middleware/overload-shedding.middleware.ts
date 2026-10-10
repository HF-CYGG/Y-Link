/**
 * 文件说明：过载分级削峰中间件与进程级过载监测器单例。
 * 实现逻辑：
 * - elevated：拒绝匿名认证入口（管理端 + Web 客户端的登录、验证码、注册、发码、找回）、新建实时推送（SSE）连接与各类导出；
 * - critical：在此基础上再拒绝读请求（GET/HEAD），但保留 `/auth/me`、`/client-auth/me` 以免已登录页面被误判为会话失效；
 * - 已登录用户的写请求在任何等级都不削峰（避免业务提交半途失败）；`/health`、救援控制面与移动端 `/api/v1/*` 不纳入；
 * - 被削峰的请求直接返回 503 + `Retry-After: 5`，不写审计（过载时不再增加写入）。
 * 维护说明：新增匿名入口、导出或 SSE 接口时同步登记下方清单；削峰只是保护手段，容量型 DDoS 仍需上游 CDN/高防。
 */

import type { NextFunction, Request, Response } from 'express'
import { OVERLOAD_SHEDDING_POLICY } from '../config/load-protection-policy.js'
import { OverloadMonitor, type OverloadLevel, type OverloadShedCategory } from '../utils/overload-monitor.js'

export const overloadMonitor = new OverloadMonitor(OVERLOAD_SHEDDING_POLICY)

const ANONYMOUS_AUTH_PATHS = new Set([
  '/api/auth/captcha',
  '/api/auth/login',
  '/api/auth/login/mfa',
  '/api/auth/login/mfa/webauthn/options',
  '/api/auth/login/mfa/webauthn/verify',
  '/api/auth/webauthn/login/options',
  '/api/auth/webauthn/login/verify',
  '/api/client-auth/captcha',
  '/api/client-auth/capabilities',
  '/api/client-auth/verification-code/send',
  '/api/client-auth/register',
  '/api/client-auth/login',
  '/api/client-auth/forgot-password/verify',
  '/api/client-auth/forgot-password/reset',
])

const REALTIME_PATHS = new Set([
  '/api/client-feedback/stream',
  '/api/customer-service/stream',
])

const EXPORT_PATH_PATTERN = /^\/api\/(?:audit-logs\/export|data-maintenance\/export\/json|inventory\/logs\/export|products\/export|reports\/[^/]+\/export)$/

const CRITICAL_READ_ALLOWLIST = new Set(['/api/auth/me', '/api/client-auth/me'])

/** 按等级判定请求是否应被削峰，返回削峰类别；不削峰返回 null。 */
export function classifyOverloadShed(method: string, path: string, level: OverloadLevel): OverloadShedCategory | null {
  if (level === 'normal') return null
  if (!path.startsWith('/api/') || path.startsWith('/api/v1/') || path.startsWith('/api/database-rescue')) return null
  if (ANONYMOUS_AUTH_PATHS.has(path)) return 'anonymousAuth'
  if (REALTIME_PATHS.has(path)) return 'realtime'
  if (EXPORT_PATH_PATTERN.test(path)) return 'export'
  const upperMethod = method.toUpperCase()
  if (level === 'critical' && (upperMethod === 'GET' || upperMethod === 'HEAD') && !CRITICAL_READ_ALLOWLIST.has(path)) {
    return 'read'
  }
  return null
}

export function overloadSheddingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const category = classifyOverloadShed(req.method, req.path, overloadMonitor.getLevel())
  if (!category) {
    next()
    return
  }
  overloadMonitor.recordShed(category)
  res.setHeader('Retry-After', '5')
  res.setHeader('Cache-Control', 'no-store')
  res.status(503).json({
    code: 503,
    message: '系统当前繁忙，请稍后重试',
    data: { reason: 'SERVER_OVERLOADED' },
  })
}
