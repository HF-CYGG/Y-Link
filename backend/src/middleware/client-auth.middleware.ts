/**
 * 模块说明：`backend/src/middleware/client-auth.middleware.ts`
 * 文件职责：负责客户端接口的登录态识别与请求上下文注入，统一兼容 Cookie 与 Bearer Token 两种取值来源。
 * 实现逻辑：
 * 1. Authorization 存在时独占认证决策且失败不回退 Cookie；无 Authorization 时保持 Web Cookie 行为；
 * 2. 调用客户端认证服务解析用户会话，并把结果写入 `req.clientAuth` 供后续路由复用；
 * 3. 当令牌缺失或失效时，统一抛出未登录错误，保持客户端接口鉴权口径一致。
 */

import type { NextFunction, Request, Response } from 'express'
import { clientAuthService } from '../services/client-auth.service.js'
import { BizError } from '../utils/errors.js'
import { readClientSessionTokenFromCookie } from '../utils/client-auth-cookie.js'
import type { ClientAuthenticatedRequest } from '../types/client-auth.js'
import type { MobileAuthenticatedRequest } from '../types/mobile-auth.js'
import { mobileSessionService } from '../services/mobile-session.service.js'
import { isMobileAccessToken } from '../utils/mobile-token.js'
import { extractRequestMeta } from '../utils/request-meta.js'

const parseAuthorizationBearer = (req: Request) => {
  const authorization = req.headers.authorization
  if (authorization !== undefined) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization)
    if (!match?.[1]) throw new BizError('未登录或登录状态已失效', 401)
    return match[1]
  }
  return null
}

export const requireClientAuth = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    // Authorization 一旦存在就独占认证决策；任何格式/令牌错误都禁止回退 Cookie。
    const authorizationToken = parseAuthorizationBearer(req)
    if (authorizationToken && isMobileAccessToken(authorizationToken)) {
      const mobileAuth = await mobileSessionService.resolveAccess(
        authorizationToken,
        req.path,
        extractRequestMeta(req),
      )
      ;(req as MobileAuthenticatedRequest).mobileAuth = mobileAuth
      ;(req as ClientAuthenticatedRequest).clientAuth = {
        userId: mobileAuth.userId,
        mobile: mobileAuth.user.mobile ?? '',
        email: mobileAuth.user.email ?? '',
        account: mobileAuth.user.realName || mobileAuth.user.email || mobileAuth.user.mobile || '',
        realName: mobileAuth.user.realName,
        accountType: mobileAuth.user.accountType,
        staffNo: mobileAuth.user.staffNo,
        sessionToken: authorizationToken,
      }
      next()
      return
    }
    const token = authorizationToken ?? readClientSessionTokenFromCookie(req)
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
