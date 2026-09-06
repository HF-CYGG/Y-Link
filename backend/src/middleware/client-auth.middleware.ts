/**
 * 模块说明：`backend/src/middleware/client-auth.middleware.ts`
 * 文件职责：负责客户端接口的登录态识别与请求上下文注入，统一兼容 Cookie 与 Bearer Token 两种取值来源。
 * 实现逻辑：
 * 1. 优先从客户端安全 Cookie 中读取会话令牌，兼容历史 Bearer 头，停止支持 URL query access_token；
 * 2. 调用客户端认证服务解析用户会话，并把结果写入 `req.clientAuth` 供后续路由复用；
 * 3. 当令牌缺失或失效时，统一抛出未登录错误，保持客户端接口鉴权口径一致。
 */

import type { NextFunction, Request, Response } from 'express'
import { clientAuthService } from '../services/client-auth.service.js'
import { BizError } from '../utils/errors.js'
import {
  isClientCsrfTokenValid,
  readClientCsrfHeaderToken,
  readClientCsrfTokenFromCookie,
  readClientSessionTokenFromCookie,
} from '../utils/client-auth-cookie.js'
import type { ClientAuthenticatedRequest } from '../types/client-auth.js'

const parseBearerToken = (req: Request) => {
  const sessionToken = readClientSessionTokenFromCookie(req)
  if (sessionToken) {
    return sessionToken
  }

  const authorization = req.headers.authorization
  if (authorization) {
    const [scheme, token] = authorization.split(' ')
    if (scheme === 'Bearer' && token?.trim()) {
      return token.trim()
    }
  }

  // 出于防泄露要求，客户端不再接受 URL query access_token。
  return null
}

function parseClientCredential(req: Request): { token: string; source: 'cookie' | 'bearer' } | null {
  const cookieToken = readClientSessionTokenFromCookie(req)
  if (cookieToken) {
    return { token: cookieToken, source: 'cookie' }
  }
  const token = parseBearerToken(req)
  return token ? { token, source: 'bearer' } : null
}

const isSafeRequestMethod = (method: string) => ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())

export const requireClientAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const credential = parseClientCredential(req)
    if (!credential) {
      throw new BizError('未登录或登录状态已失效', 401)
    }
    const auth = await clientAuthService.resolveClientByToken(credential.token)
    auth.authSource = credential.source
    ;(req as ClientAuthenticatedRequest).clientAuth = auth
    if (!isSafeRequestMethod(req.method) && credential.source === 'cookie') {
      const cookieToken = readClientCsrfTokenFromCookie(req)
      const headerToken = readClientCsrfHeaderToken(req)
      if (!cookieToken || !headerToken) {
        throw new BizError('请求安全校验失败，请刷新页面后重试', 403, { reason: 'CLIENT_CSRF_MISSING' })
      }
      if (!isClientCsrfTokenValid(credential.token, cookieToken, headerToken)) {
        throw new BizError('请求安全校验失败，请刷新页面后重试', 403, { reason: 'CLIENT_CSRF_MISMATCH' })
      }
    }
    next()
  } catch (error) {
    next(error)
  }
}
