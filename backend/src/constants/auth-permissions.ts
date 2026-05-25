/**
 * 模块说明：backend/src/constants/auth-permissions.ts
 * 文件职责：权限常量中心，定义系统权限码与角色默认权限映射。
 * 实现逻辑：
 * - 输出统一权限枚举供后端中间件与前端路由共用；
 * - 维护角色到权限集合的默认关系，作为用户初始化基础。
 * 维护说明：
 * - 新增权限码后必须同步路由守卫、菜单可见性和权限回归测试。
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
  'audit_logs:view',
  'audit_logs:export',
  'inbound:create',
  'inbound:view',
  'inbound:verify',
  'customer_service:view',
  'customer_service:reply',
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
    'audit_logs:view',
    'audit_logs:export',
    'inbound:view',
    'inbound:verify',
    'customer_service:view',
    'customer_service:reply',
  ],
  operator: [
    'dashboard:view',
    'orders:create',
    'orders:view',
    'orders:update',
    'products:view',
    'products:manage',
    'tags:view',
    'tags:manage',
    'system_configs:view',
    'inbound:view',
    'inbound:verify',
    'customer_service:view',
    'customer_service:reply',
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
