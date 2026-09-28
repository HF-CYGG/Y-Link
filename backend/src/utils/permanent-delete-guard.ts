/**
 * 文件说明：永久删除口令的入口防护工具，统一提供“按账号计桶”的频控中间件与带失败审计的口令校验。
 * 实现逻辑：
 * - 全局永久删除口令被多个高风险入口共用（含供货方），任何校验入口都必须限速，避免被在线逐个试错；
 * - 两层频控：各入口保留自己的请求频控（按操作账号计桶，不含目标 ID）；另有一个所有入口共享的“口令失败”计数桶，
 *   同一账号在任何入口的失败尝试都计入同一额度，攻击者轮换订单、O2O、供货方、账号删除或 JSON 导入入口也无法叠加试错次数；
 *   成功请求不占用共享额度，正常的连续删除不受影响；
 * - 口令错误、缺失与频控拦截均写脱敏失败审计，审计与日志中不出现任何口令内容；操作类型只用于审计，不参与计数键。
 * 维护说明：
 * - 新增使用 `assertPermanentDeletePassword` 的入口时，应挂 `createPermanentDeleteLimiter`（已含共享口令桶）并改用 `assertPermanentDeletePasswordAudited`；
 * - 系统账号/客户端账号/供货方已入库删除沿用各自的请求限流器，但必须再挂 `createPermanentDeletePasswordGuard` 接入共享口令桶；
 * - 不校验永久删除口令的账号级频控（如 JSON 导出）使用 `createAccountScopedLimiter`，不得接入共享口令桶。
 */

import type { Request, RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { AppDataSource } from '../config/data-source.js'
import { auditService } from '../services/audit.service.js'
import { DatabaseRateLimitStore } from '../services/persistent-risk-state.service.js'
import type { AuthUserContext, AuthenticatedRequest } from '../types/auth.js'
import { BizError } from './errors.js'
import { assertPermanentDeletePassword } from './permanent-delete-password.js'
import { extractRequestMeta, type RequestMeta } from './request-meta.js'

export const PERMANENT_DELETE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
export const PERMANENT_DELETE_RATE_LIMIT_MAX = 5
/** 共享口令桶：同一账号在所有永久删除口令入口的失败尝试合计上限。 */
export const PERMANENT_DELETE_PASSWORD_FAILURE_WINDOW_MS = 5 * 60 * 1000
export const PERMANENT_DELETE_PASSWORD_FAILURE_MAX = 5

interface PermanentDeleteAuditTarget {
  actionType: string
  actionLabel: string
  targetType: string
}

const normalizeAuditTargetId = (value: unknown): string | null => {
  const normalized = String(value ?? '').trim()
  return normalized && normalized.length <= 64 ? normalized : null
}

const recordRateLimited = (req: Request, target: PermanentDeleteAuditTarget, detail: Record<string, unknown>) => auditService.safeRecord({
  actionType: target.actionType,
  actionLabel: `${target.actionLabel}（频控拦截）`,
  targetType: target.targetType,
  targetId: normalizeAuditTargetId(req.params.id),
  actor: (req as AuthenticatedRequest).auth,
  requestMeta: extractRequestMeta(req),
  resultStatus: 'failed',
  detail,
})

const PASSWORD_GUARD_TARGET = Symbol('permanentDeletePasswordGuardTarget')
type RequestWithGuardTarget = Request & { [PASSWORD_GUARD_TARGET]?: PermanentDeleteAuditTarget }

/**
 * 口令缺失（400）或错误（403）视为失败尝试，计入共享额度；其余结果（成功、目标不存在、业务冲突等）请求结束后归还额度。
 * 400 也包含请求体校验失败，同样按失败尝试计数，避免借畸形请求探测。
 */
const isPasswordAttemptAccepted = (statusCode: number) => statusCode !== 400 && statusCode !== 403

let sharedPasswordFailureLimiter: RequestHandler | null = null

/** 所有永久删除口令入口共享的单例限流器：同一个存储与计数键，确保跨入口合并计数。 */
function getSharedPasswordFailureLimiter(): RequestHandler {
  sharedPasswordFailureLimiter ??= rateLimit({
    windowMs: PERMANENT_DELETE_PASSWORD_FAILURE_WINDOW_MS,
    limit: PERMANENT_DELETE_PASSWORD_FAILURE_MAX,
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => isPasswordAttemptAccepted(res.statusCode),
    keyGenerator: (req) => `account:${(req as AuthenticatedRequest).auth?.userId ?? 'unknown'}`,
    ...(AppDataSource.options.type === 'mysql'
      ? { store: new DatabaseRateLimitStore('express-permanent-delete-password') }
      : {}),
    handler: async (req, res) => {
      const target = (req as RequestWithGuardTarget)[PASSWORD_GUARD_TARGET]
      if (target) await recordRateLimited(req, target, { reason: 'rate_limited', scope: 'shared_password_failures' })
      res.status(429).json({ code: 429, message: '永久删除口令错误次数过多，请稍后再试', data: null })
    },
  })
  return sharedPasswordFailureLimiter
}

/**
 * 接入共享口令失败桶：必须挂在 requireAuth 之后、口令校验之前；target 只用于频控拦截审计。
 */
export function createPermanentDeletePasswordGuard(target: PermanentDeleteAuditTarget): RequestHandler {
  const limiter = getSharedPasswordFailureLimiter()
  return (req, res, next) => {
    (req as RequestWithGuardTarget)[PASSWORD_GUARD_TARGET] = target
    return limiter(req, res, next)
  }
}

/**
 * 账号级请求频控中间件：必须挂在 requireAuth 之后，按当前登录账号计桶；
 * 同样需要“按账号计桶 + 频控拦截留痕”、但不校验永久删除口令的高风险入口（如 JSON 全量导出）可覆盖窗口、次数与提示语。
 */
export function createAccountScopedLimiter(options: PermanentDeleteAuditTarget & {
  storePrefix: string
  windowMs?: number
  limit?: number
  blockedMessage?: string
}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? PERMANENT_DELETE_RATE_LIMIT_WINDOW_MS,
    limit: options.limit ?? PERMANENT_DELETE_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `${options.storePrefix}:${(req as AuthenticatedRequest).auth?.userId ?? 'unknown'}`,
    ...(AppDataSource.options.type === 'mysql'
      ? { store: new DatabaseRateLimitStore(options.storePrefix) }
      : {}),
    handler: async (req, res) => {
      await recordRateLimited(req, options, { reason: 'rate_limited' })
      res.status(429).json({ code: 429, message: options.blockedMessage ?? '永久删除请求过于频繁，请稍后再试', data: null })
    },
  })
}

/**
 * 永久删除入口频控：先按入口的账号级请求频控，再接入所有入口共享的口令失败桶。
 */
export function createPermanentDeleteLimiter(options: PermanentDeleteAuditTarget & {
  storePrefix: string
  windowMs?: number
  limit?: number
  blockedMessage?: string
}): RequestHandler {
  const entryLimiter = createAccountScopedLimiter(options)
  const passwordGuard = createPermanentDeletePasswordGuard(options)
  return (req, res, next) => {
    void entryLimiter(req, res, (error?: unknown) => {
      if (error) {
        next(error)
        return
      }
      void passwordGuard(req, res, next)
    })
  }
}

/**
 * 带失败审计的永久删除口令校验：口令缺失或错误时写脱敏审计后原样抛出业务错误。
 */
export async function assertPermanentDeletePasswordAudited(input: PermanentDeleteAuditTarget & {
  password: string | null | undefined
  actor: AuthUserContext
  requestMeta?: RequestMeta
  targetId?: unknown
  targetCode?: string | null
}): Promise<void> {
  try {
    assertPermanentDeletePassword(input.password)
  } catch (error) {
    if (error instanceof BizError) {
      await auditService.safeRecord({
        actionType: input.actionType,
        actionLabel: input.actionLabel,
        targetType: input.targetType,
        targetId: normalizeAuditTargetId(input.targetId),
        targetCode: input.targetCode ?? null,
        actor: input.actor,
        requestMeta: input.requestMeta,
        resultStatus: 'failed',
        detail: { reason: error.statusCode === 400 ? 'password_missing' : 'password_rejected' },
      })
    }
    throw error
  }
}

/** 便于路由层直接使用请求对象的简写。 */
export function assertPermanentDeletePasswordForRequest(
  req: Request,
  password: string | null | undefined,
  target: PermanentDeleteAuditTarget,
): Promise<void> {
  const authReq = req as AuthenticatedRequest
  return assertPermanentDeletePasswordAudited({
    ...target,
    password,
    actor: authReq.auth,
    requestMeta: extractRequestMeta(req),
    targetId: req.params.id,
  })
}
