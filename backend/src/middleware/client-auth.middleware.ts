/**
 * 模块说明：backend/src/middleware/client-auth.middleware.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { NextFunction, Request, Response } from 'express'
import { clientAuthService } from '../services/client-auth.service.js'
import { BizError } from '../utils/errors.js'
import type { ClientAuthenticatedRequest } from '../types/client-auth.js'

const parseBearerToken = (req: Request) => {
  const authorization = req.headers.authorization
  if (!authorization) {
    return null
  }
  const [scheme, token] = authorization.split(' ')
  if (scheme !== 'Bearer' || !token?.trim()) {
    return null
  }
  return token.trim()
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
