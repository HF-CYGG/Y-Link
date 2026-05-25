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
