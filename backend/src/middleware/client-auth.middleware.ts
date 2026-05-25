/**
 * 模块说明：backend/src/middleware/client-auth.middleware.ts
 * 文件职责：提供客户端登录态校验与写操作 CSRF 校验中间件，并在拒绝时写入安全审计。
 * 实现逻辑：
 * - 登录态校验按 `Cookie -> Bearer -> query token` 顺序提取凭证，兼容旧端过渡；
 * - 校验成功后把 `clientAuth` 挂到请求上下文，供路由层和服务层复用；
 * - 对 Cookie 会话的写请求强制做双提交 CSRF 校验，失败统一返回 403 并记录审计。
 * 维护说明：若后续下线 Bearer/query 兼容，只需要收敛 `parseClientCredential`，其余调用链可保持不变。
 */

import type { NextFunction, Request, Response } from 'express'
import { auditService } from '../services/audit.service.js'
import { clientAuthService } from '../services/client-auth.service.js'
import type { ClientAuthenticatedRequest } from '../types/client-auth.js'
import {
  readClientCsrfTokenFromCookie,
  readClientSessionTokenFromCookie,
  resolveClientCsrfHeaderValue,
} from '../utils/client-auth-cookie.js'
import { BizError } from '../utils/errors.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const UNAUTHORIZED_MESSAGE = '未登录或登录状态已失效'
const CSRF_FORBIDDEN_MESSAGE = '客户端写操作校验失败，请刷新页面后重试'

/**
 * 解析客户端凭证来源：
 * - 优先使用 HttpOnly Cookie（当前正式链路）；
 * - 其次兼容 Bearer 与 access_token（用于历史客户端平滑升级）；
 * - 返回 authSource 供后续 CSRF 分支判断是否需要双提交校验。
 */
const parseClientCredential = (req: Request) => {
  const cookieToken = readClientSessionTokenFromCookie(req)
  if (cookieToken) {
    return {
      token: cookieToken,
      authSource: 'cookie' as const,
    }
  }

  const authorization = req.headers.authorization
  if (authorization) {
    const [scheme, token] = authorization.split(' ')
    if (scheme === 'Bearer' && token?.trim()) {
      return {
        token: token.trim(),
        authSource: 'bearer' as const,
      }
    }
  }

  const queryToken = typeof req.query.access_token === 'string'
    ? req.query.access_token.trim()
    : ''
  if (!queryToken) {
    return null
  }

  return {
    token: queryToken,
    authSource: 'bearer' as const,
  }
}

export const requireClientAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const credential = parseClientCredential(req)
    if (!credential) {
      throw new BizError(UNAUTHORIZED_MESSAGE, 401)
    }

    const auth = await clientAuthService.resolveClientByToken(credential.token)
    auth.authSource = credential.authSource
    ;(req as ClientAuthenticatedRequest).clientAuth = auth
    next()
  } catch (error) {
    next(error)
  }
}

const isSafeRequestMethod = (method?: string) => {
  const normalizedMethod = (method ?? 'GET').toUpperCase()
  return ['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)
}

/**
 * 将拒绝原因写入审计：
 * - targetCode 记录被拦截的请求方法与路径；
 * - 若已识别登录用户，则写入客户端账号主体，便于事后追踪同账号异常行为。
 */
const recordForbiddenAudit = (req: Request, reason: string, detail?: Record<string, unknown>) => {
  const clientReq = req as ClientAuthenticatedRequest
  void auditService.safeRecord({
    actionType: 'security.access_denied',
    actionLabel: '客户端请求被拒绝',
    targetType: 'client_request',
    targetCode: `${req.method} ${req.originalUrl || req.url}`,
    actor: clientReq.clientAuth
      ? {
          userId: clientReq.clientAuth.userId,
          username: clientReq.clientAuth.account,
          displayName: clientReq.clientAuth.realName || clientReq.clientAuth.account,
        }
      : null,
    resultStatus: 'failed',
    requestMeta: extractRequestMeta(req),
    detail: {
      reason,
      ...(detail ?? {}),
    },
  })
}

/**
 * 客户端 CSRF 校验中间件：
 * - 只拦截非安全方法（POST/PATCH/DELETE...）；
 * - 只对 Cookie 登录态启用（Bearer 兼容链路不强制）；
 * - 校验失败即审计并返回 403，避免静默放行写请求。
 */
export const requireClientCsrf = (req: Request, _res: Response, next: NextFunction) => {
  if (isSafeRequestMethod(req.method)) {
    next()
    return
  }

  const clientReq = req as ClientAuthenticatedRequest
  if (clientReq.clientAuth?.authSource !== 'cookie') {
    next()
    return
  }

  const csrfCookieToken = readClientCsrfTokenFromCookie(req)
  const csrfHeaderToken = resolveClientCsrfHeaderValue(req)
  if (!csrfCookieToken || !csrfHeaderToken || csrfCookieToken !== csrfHeaderToken) {
    recordForbiddenAudit(req, 'client_csrf_validation_failed', {
      csrfCookiePresent: Boolean(csrfCookieToken),
      csrfHeaderPresent: Boolean(csrfHeaderToken),
    })
    next(new BizError(CSRF_FORBIDDEN_MESSAGE, 403))
    return
  }

  next()
}
