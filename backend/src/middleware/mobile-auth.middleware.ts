import type { NextFunction, Request, Response } from 'express'
import { mobileSessionService } from '../services/mobile-session.service.js'
import type { MobileAuthenticatedRequest } from '../types/mobile-auth.js'
import { BizError } from '../utils/errors.js'
import { extractRequestMeta } from '../utils/request-meta.js'

export const readRequiredMobileBearer = (req: Request) => {
  const authorization = req.headers.authorization
  if (!authorization) throw new BizError('Access Token 缺失或格式非法', 401, { code: 40100 })
  const match = /^Bearer ([^\s]+)$/.exec(authorization)
  if (!match?.[1]) throw new BizError('Access Token 缺失或格式非法', 401, { code: 40100 })
  return match[1]
}

/** Mobile 专属路由只接受 ylma_ Bearer，不读取 Cookie，也不接受 query token。 */
export const requireMobileAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = readRequiredMobileBearer(req)
    const auth = await mobileSessionService.resolveAccess(token, req.path, extractRequestMeta(req))
    ;(req as MobileAuthenticatedRequest).mobileAuth = auth
    next()
  } catch (error) {
    next(error)
  }
}
