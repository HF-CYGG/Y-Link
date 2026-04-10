/**
 * 模块说明：backend/src/middleware/auth.middleware.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { NextFunction, Request, Response } from 'express'
import type { PermissionCode } from '../constants/auth-permissions.js'
import type { AuthenticatedRequest, UserRole } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import { authService } from '../services/auth.service.js'

function parseBearerToken(req: Request): string | null {
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

/**
 * 认证中间件：
 * - 统一校验 Bearer Token；
 * - 将当前登录用户注入 req.auth，供后续业务与审计链路直接复用。
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = parseBearerToken(req)
    if (!token) {
      throw new BizError('未登录或登录状态已失效', 401)
    }

    const auth = await authService.resolveAuthUserByToken(token)
    ;(req as AuthenticatedRequest).auth = auth
    next()
  } catch (error) {
    next(error)
  }
}

/**
 * 角色校验中间件：
 * - 在 requireAuth 之后使用；
 * - 用于限制管理员专属接口，如用户管理与审计查询。
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = (req as AuthenticatedRequest).auth
    if (!auth) {
      next(new BizError('未登录或登录状态已失效', 401))
      return
    }

    if (!roles.includes(auth.role)) {
      next(new BizError('当前账号无权访问该接口', 403))
      return
    }

    next()
  }
}

/**
 * 权限点校验中间件：
 * - 在保留 role 的同时，以 permission 作为更细粒度的接口访问控制依据；
 * - 适用于用户管理、审计导出等系统治理接口，避免再以“管理员大权限”粗放控制。
 */
export function requirePermission(...permissions: PermissionCode[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = (req as AuthenticatedRequest).auth
    if (!auth) {
      next(new BizError('未登录或登录状态已失效', 401))
      return
    }

    const missingPermissions = permissions.filter((permission) => !auth.permissions.includes(permission))
    if (missingPermissions.length > 0) {
      next(new BizError('当前账号无权访问该接口', 403))
      return
    }

    next()
  }
}
