/**
 * 文件说明：后台权限常量定义，集中维护系统权限点清单、角色默认权限映射和权限辅助类型。
 * 实现逻辑：使用固定的“资源:动作”权限码作为权限判断基础，再把不同角色可访问的权限集合收敛到同一处维护。
 * 维护重点：新增业务模块权限时，需要同步检查路由权限拦截、前端菜单控制和角色默认授权配置。
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
  'orders:update',
  'orders:edit',
  'orders:merge',
  'orders:delete',
  'products:view',
  'products:manage',
  'tags:view',
  'tags:manage',
  'system_configs:view',
  'system_configs:update',
  'verification_providers:test',
  'data_maintenance:backup',
  'data_maintenance:import',
  'db_migration:view',
  'db_migration:operate',
  'users:view',
  'users:create',
  'users:update',
  'users:status',
  'users:reset_password',
  'users:deactivate',
  'users:permanent_delete',
  'audit_logs:view',
  'audit_logs:export',
  'reports:view',
  'reports:export',
  'inbound:create',
  'inbound:view',
  'inbound:verify',
  'customer_service:view',
  'customer_service:reply',
  'products:import',
  'inventory:view',
  'inventory:operate',
  'inventory:void',
  'stocktake:view',
  'stocktake:count',
  'stocktake:approve',
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
    'orders:update',
    'orders:edit',
    'orders:merge',
    'orders:delete',
    'products:view',
    'products:manage',
    'tags:view',
    'tags:manage',
    'system_configs:view',
    'system_configs:update',
    'verification_providers:test',
    'data_maintenance:backup',
    'data_maintenance:import',
    'db_migration:view',
    'db_migration:operate',
    'users:view',
    'users:create',
    'users:update',
    'users:status',
    'users:reset_password',
    'users:deactivate',
    'users:permanent_delete',
    'audit_logs:view',
    'audit_logs:export',
    'reports:view',
    'reports:export',
    'inbound:view',
    'inbound:verify',
    'customer_service:view',
    'customer_service:reply',
    'products:import',
    'inventory:view',
    'inventory:operate',
    'inventory:void',
    'stocktake:view',
    'stocktake:count',
    'stocktake:approve',
  ],
  operator: [
    'dashboard:view',
    'orders:create',
    'orders:view',
    'orders:update',
    'orders:edit',
    'products:view',
    'products:manage',
    'tags:view',
    'tags:manage',
    'system_configs:view',
    'reports:view',
    'reports:export',
    'inbound:view',
    'inbound:verify',
    'customer_service:view',
    'customer_service:reply',
    'inventory:view',
    'inventory:operate',
    'stocktake:view',
    'stocktake:count',
  ],
  supplier: [
    'products:view',
    'inbound:create',
    'inbound:view',
  ],
}

/**
 * 基于角色解析权限点：
 * - 本函数仅提供角色默认与授权上界，账号实际授权须使用 resolveUserPermissions；
 * - 返回新数组，避免调用方误改共享常量。
 */
export const resolvePermissionsByRole = (role: UserRole): PermissionCode[] => {
  return [...DEFAULT_ROLE_PERMISSIONS[role]]
}

/** 本次用户覆盖仅作用于页面已展示的治理子集，其他业务权限继续来自角色。 */
export const GOVERNANCE_PERMISSION_CODES: PermissionCode[] = [
  'system_configs:view',
  'system_configs:update',
  'verification_providers:test',
  'data_maintenance:backup',
  'data_maintenance:import',
  'db_migration:view',
  'db_migration:operate',
  'users:view',
  'users:create',
  'users:update',
  'users:status',
  'users:reset_password',
  'users:deactivate',
  'users:permanent_delete',
  'audit_logs:view',
  'audit_logs:export',
  'reports:view',
  'reports:export',
]

/** NULL/未配置沿用默认；损坏配置收窄为无治理权限，不能恢复完整角色权限。 */
export function resolveUserPermissions(user: { role: UserRole; governancePermissionsJson?: string | null }): PermissionCode[] {
  const defaults = resolvePermissionsByRole(user.role)
  if (user.governancePermissionsJson == null) return defaults
  let selected: unknown
  try { selected = JSON.parse(user.governancePermissionsJson) } catch { selected = [] }
  const valid = Array.isArray(selected) && selected.every((item: unknown) =>
    typeof item === 'string' && GOVERNANCE_PERMISSION_CODES.includes(item as PermissionCode))
  const allowed = new Set<unknown>(valid ? selected as unknown[] : [])
  return defaults.filter((permission) => !GOVERNANCE_PERMISSION_CODES.includes(permission) || allowed.has(permission))
}

/** 可治理管理员必须同时保有用户页与编辑入口；仅有 admin 角色不能承担恢复职责。 */
export function isUserGovernanceAdmin(user: {
  role: UserRole; status: string; deactivatedAt?: Date | null; restoredAt?: Date | null; governancePermissionsJson?: string | null
}): boolean {
  const permissions = resolveUserPermissions(user)
  return user.role === 'admin' && user.status === 'enabled'
    && (user.deactivatedAt?.getTime() ?? 0) <= (user.restoredAt?.getTime() ?? 0)
    && permissions.includes('users:view') && permissions.includes('users:update')
}
