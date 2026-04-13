/**
 * 模块说明：backend/src/constants/auth-permissions.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { UserRole } from '../types/auth.js'

/**
 * 系统权限点：
 * - 以“资源:动作”格式命名，便于前后端与审计文案保持一致；
 * - 角色只是权限集合的载体，真正的访问控制统一落在权限点上。
 */
export const PERMISSION_CODES = [
  'dashboard:view',
  'orders:create',
  'orders:view',
  'orders:delete',
  'products:view',
  'products:manage',
  'tags:view',
  'tags:manage',
  'system_configs:view',
  'system_configs:update',
  'users:view',
  'users:create',
  'users:update',
  'users:status',
  'users:reset_password',
  'audit_logs:view',
  'audit_logs:export',
  'inbound:create',
  'inbound:view',
  'inbound:verify',
] as const

export type PermissionCode = (typeof PERMISSION_CODES)[number]

/**
 * 默认角色权限集合：
 * - admin 继续兼容现有管理员能力，并补齐细粒度系统治理权限；
 * - operator 保留日常业务操作能力，但默认不进入系统治理域。
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, PermissionCode[]> = {
  admin: [
    'dashboard:view',
    'orders:create',
    'orders:view',
    'orders:delete',
    'products:view',
    'products:manage',
    'tags:view',
    'tags:manage',
    'system_configs:view',
    'system_configs:update',
    'users:view',
    'users:create',
    'users:update',
    'users:status',
    'users:reset_password',
    'audit_logs:view',
    'audit_logs:export',
    'inbound:view',
    'inbound:verify',
  ],
  operator: [
    'dashboard:view',
    'orders:create',
    'orders:view',
    'products:view',
    'products:manage',
    'tags:view',
    'tags:manage',
    'system_configs:view',
    'inbound:view',
    'inbound:verify',
  ],
  supplier: [
    'products:view',
    'inbound:create',
    'inbound:view',
  ],
}

/**
 * 基于角色解析权限点：
 * - 当前版本先使用默认角色权限集合，不引入额外表结构迁移；
 * - 返回新数组，避免调用方误改共享常量。
 */
export const resolvePermissionsByRole = (role: UserRole): PermissionCode[] => {
  return [...DEFAULT_ROLE_PERMISSIONS[role]]
}
