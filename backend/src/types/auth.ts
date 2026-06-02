/**
 * 模块说明：`backend/src/types/auth.ts`
 * 文件职责：集中声明管理端认证与授权体系使用的角色、状态、审计结果、请求上下文以及安全用户视图类型。
 * 实现逻辑：
 * 1. 通过常量联合类型固定角色与状态取值，避免路由和服务层散落硬编码字符串；
 * 2. 使用 `AuthUserContext` 与 `AuthenticatedRequest` 描述鉴权中间件挂载后的请求结构；
 * 3. 通过 `UserSafeProfile` 约束对前端可暴露的用户字段，隔离密码和会话等敏感信息。
 */

import type { Request } from 'express'
import type { PermissionCode } from '../constants/auth-permissions.js'

/**
 * 系统用户角色：
 * - admin：管理员，可访问用户管理、审计日志等系统治理能力；
 * - operator：普通操作员，聚焦日常业务操作；
 * - supplier：供货方，仅可访问送货单录入等专属页面。
 */
export const USER_ROLES = ['admin', 'operator', 'supplier'] as const
export type UserRole = (typeof USER_ROLES)[number]

/**
 * 系统用户状态：
 * - enabled：启用，可正常登录与执行业务；
 * - disabled：停用，禁止继续登录与访问受保护接口。
 */
export const USER_STATUSES = ['enabled', 'disabled'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

/**
 * 审计结果状态：
 * - success：关键操作成功执行；
 * - failed：关键操作执行失败或被拒绝。
 */
export const AUDIT_RESULT_STATUSES = ['success', 'failed'] as const
export type AuditResultStatus = (typeof AUDIT_RESULT_STATUSES)[number]

/**
 * 认证上下文：
 * - 由认证中间件解析管理端安全 Cookie 或兼容 Bearer Token 后注入到请求对象；
 * - `authSource` 用于区分当前请求是否需要额外执行 CSRF 校验；
 * - 后续服务层据此完成权限判定、数据归属与审计留痕。
 */
export interface AuthUserContext {
  userId: string
  username: string
  displayName: string
  role: UserRole
  permissions: PermissionCode[]
  status: UserStatus
  sessionToken: string
  authSource: 'cookie' | 'bearer'
}

/**
 * 已认证请求：
 * - 仅在 requireAuth 中间件之后使用；
 * - 避免在各路由中重复声明 auth 字段结构。
 */
export interface AuthenticatedRequest extends Request {
  auth: AuthUserContext
}

/**
 * 对外返回的用户安全视图：
 * - 不暴露密码哈希、会话令牌等敏感字段；
 * - 前端登录态、用户列表与详情页均可复用该结构。
 */
export interface UserSafeProfile {
  id: string
  username: string
  displayName: string
  email: string | null
  role: UserRole
  permissions: PermissionCode[]
  status: UserStatus
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
}
