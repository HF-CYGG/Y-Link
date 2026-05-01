/**
 * 模块说明：backend/src/middleware/auth.middleware.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { NextFunction, Request, Response } from 'express'
import type { PermissionCode } from '../constants/auth-permissions.js'
import { auditService } from '../services/audit.service.js'
import type { AuthenticatedRequest, UserRole } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import { extractRequestMeta } from '../utils/request-meta.js'
import { authService } from '../services/auth.service.js'

const FORBIDDEN_MESSAGE = '当前账号无权执行该操作'

/**
 * 统一记录越权访问审计：
 * - 由权限中间件在拦截时写入失败审计，覆盖“角色不匹配”和“权限点缺失”两类场景；
 * - 采用 safeRecord 保证即使审计写入失败也不会影响主流程响应。
 */
function recordForbiddenAudit(req: Request, reason: string, requiredRules: Record<string, unknown>) {
  const auth = (req as AuthenticatedRequest).auth
  void auditService.safeRecord({
    actionType: 'security.access_denied',
    actionLabel: '接口越权访问拦截',
    targetType: 'api_route',
    targetCode: `${req.method.toUpperCase()} ${req.originalUrl || req.url}`,
    actor: auth
      ? {
          userId: auth.userId,
          username: auth.username,
          displayName: auth.displayName,
        }
      : null,
    requestMeta: extractRequestMeta(req),
    resultStatus: 'failed',
    detail: {
      reason,
      requiredRules,
      actorRole: auth?.role ?? null,
      actorPermissions: auth?.permissions ?? [],
    },
  })
}

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
      recordForbiddenAudit(req, 'role_mismatch', { requiredRoles: roles })
      next(new BizError(FORBIDDEN_MESSAGE, 403))
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
      recordForbiddenAudit(req, 'permission_missing', {
        requiredPermissions: permissions,
        missingPermissions,
      })
      next(new BizError(FORBIDDEN_MESSAGE, 403))
      return
    }

    next()
  }
}
