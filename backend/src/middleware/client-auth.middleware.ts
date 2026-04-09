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
