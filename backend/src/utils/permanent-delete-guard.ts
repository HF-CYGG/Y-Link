/**
 * 文件说明：永久删除口令的入口防护工具，统一提供“按账号计桶”的频控中间件与带失败审计的口令校验。
 * 实现逻辑：
 * - 全局永久删除口令被多个高风险入口共用（含供货方），任何校验入口都必须限速，避免被在线逐个试错；
 * - 频控按操作账号计桶而不是“账号 + 目标”，防止攻击者换目标 ID 绕过；
 * - 口令错误、缺失与频控拦截均写脱敏失败审计，审计与日志中不出现任何口令内容。
 * 维护说明：
 * - 新增使用 `assertPermanentDeletePassword` 的入口时，应同时挂 `createPermanentDeleteLimiter` 并改用 `assertPermanentDeletePasswordAudited`；
 * - 已存在的系统账号/客户端账号/供货方已入库删除限流器保持原样，本工具只覆盖此前缺少限流的入口。
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

interface PermanentDeleteAuditTarget {
  actionType: string
  actionLabel: string
  targetType: string
}

const normalizeAuditTargetId = (value: unknown): string | null => {
  const normalized = String(value ?? '').trim()
  return normalized && normalized.length <= 64 ? normalized : null
}

/**
 * 永久删除频控中间件：必须挂在 requireAuth 之后，按当前登录账号计桶。
 */
export function createPermanentDeleteLimiter(options: PermanentDeleteAuditTarget & { storePrefix: string }): RequestHandler {
  return rateLimit({
    windowMs: PERMANENT_DELETE_RATE_LIMIT_WINDOW_MS,
    limit: PERMANENT_DELETE_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `${options.storePrefix}:${(req as AuthenticatedRequest).auth?.userId ?? 'unknown'}`,
    ...(AppDataSource.options.type === 'mysql'
      ? { store: new DatabaseRateLimitStore(options.storePrefix) }
      : {}),
    handler: async (req, res) => {
      const authReq = req as AuthenticatedRequest
      await auditService.safeRecord({
        actionType: options.actionType,
        actionLabel: `${options.actionLabel}（频控拦截）`,
        targetType: options.targetType,
        targetId: normalizeAuditTargetId(req.params.id),
        actor: authReq.auth,
        requestMeta: extractRequestMeta(req),
        resultStatus: 'failed',
        detail: { reason: 'rate_limited' },
      })
      res.status(429).json({ code: 429, message: '永久删除请求过于频繁，请稍后再试', data: null })
    },
  })
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
