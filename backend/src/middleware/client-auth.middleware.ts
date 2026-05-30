/**
 * 模块说明：backend/src/middleware/client-auth.middleware.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { NextFunction, Request, Response } from 'express'
import { clientAuthService } from '../services/client-auth.service.js'
import { BizError } from '../utils/errors.js'
import { readClientSessionTokenFromCookie } from '../utils/client-auth-cookie.js'
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

  /**
   * 客户端反馈页的在线状态使用浏览器原生 SSE，
   * 这里兼容 `access_token` 查询参数，保证无需额外协议库也能续接。
   */
  const queryToken = typeof req.query.access_token === 'string'
    ? req.query.access_token.trim()
    : ''
  if (!queryToken) {
    return null
  }
  return queryToken
}

export const requireClientAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = parseBearerToken(req)
    if (!token) {
      throw new BizError('未登录或登录状态已失效', 401)
    }
    const auth = await clientAuthService.resolveClientByToken(token)
    ;(req as ClientAuthenticatedRequest).clientAuth = auth
    next()
  } catch (error) {
    next(error)
  }
}
