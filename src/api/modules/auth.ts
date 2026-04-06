import { request } from '@/api/http'

/**
 * 前端用户角色类型：
 * - admin：系统管理员，默认拥有完整治理权限；
 * - operator：普通操作员，聚焦日常业务处理。
 */
export type UserRole = 'admin' | 'operator'

/**
 * 前端权限点：
 * - 与后端保持一一对应，统一使用“资源:动作”命名；
 * - 路由、菜单、按钮与页面能力边界全部基于此类型做约束。
 */
export const PERMISSION_CODES = [
  'dashboard:view',
  'orders:create',
  'orders:view',
  'products:view',
  'products:manage',
  'tags:view',
  'tags:manage',
  'users:view',
  'users:create',
  'users:update',
  'users:status',
  'users:reset_password',
  'audit_logs:view',
  'audit_logs:export',
] as const

export type PermissionCode = (typeof PERMISSION_CODES)[number]

/**
 * 默认角色权限集合：
 * - 兼容现有 admin/operator 登录与页面可见性；
 * - 当本地旧快照中缺失 permissions 字段时，可按角色自动兜底恢复。
 */
export const ROLE_DEFAULT_PERMISSION_MAP: Record<UserRole, PermissionCode[]> = {
  admin: [
    'dashboard:view',
    'orders:create',
    'orders:view',
    'products:view',
    'products:manage',
    'tags:view',
    'tags:manage',
    'users:view',
    'users:create',
    'users:update',
    'users:status',
    'users:reset_password',
    'audit_logs:view',
    'audit_logs:export',
  ],
  operator: ['dashboard:view', 'orders:create', 'orders:view', 'products:view', 'products:manage', 'tags:view', 'tags:manage'],
}

/**
 * 权限点中文文案：
 * - 用户管理页用于展示“关键权限能力边界”；
 * - 也可为后续按钮提示、空态说明提供统一文案来源。
 */
export const PERMISSION_LABEL_MAP: Record<PermissionCode, string> = {
  'dashboard:view': '查看工作台',
  'orders:create': '新增出库单',
  'orders:view': '查看出库单',
  'products:view': '查看产品资料',
  'products:manage': '维护产品资料',
  'tags:view': '查看标签资料',
  'tags:manage': '维护标签资料',
  'users:view': '查看用户',
  'users:create': '新增用户',
  'users:update': '编辑用户',
  'users:status': '启停用户',
  'users:reset_password': '重置密码',
  'audit_logs:view': '查看审计日志',
  'audit_logs:export': '导出审计日志',
}

/**
 * 系统治理关键权限点：
 * - 用于用户管理页突出展示与系统治理直接相关的能力边界；
 * - 保持顺序稳定，方便表格与卡片模式复用。
 */
export const GOVERNANCE_PERMISSION_CODES: PermissionCode[] = [
  'users:view',
  'users:create',
  'users:update',
  'users:status',
  'users:reset_password',
  'audit_logs:view',
  'audit_logs:export',
]

/**
 * 前端用户状态类型：
 * - enabled：账号启用，可正常登录；
 * - disabled：账号停用，禁止继续使用系统。
 */
export type UserStatus = 'enabled' | 'disabled'

/**
 * 对齐后端安全用户视图：
 * - 仅包含前端需要展示与鉴权的信息；
 * - permissions 为本期新增字段，用于细粒度权限点校验。
 */
export interface UserSafeProfile {
  id: string
  username: string
  displayName: string
  role: UserRole
  permissions: PermissionCode[]
  status: UserStatus
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * 登录入参：
 * - username/password 与后端登录接口字段保持一致；
 * - 由页面层负责基础必填校验。
 */
export interface LoginPayload {
  username: string
  password: string
}

/**
 * 登录返回结果：
 * - token 供后续请求走 Bearer 鉴权；
 * - expiresAt 用于前端展示和持久化；
 * - user 同时承载角色与权限点，供页面鉴权直接复用。
 */
export interface LoginResult {
  token: string
  expiresAt: string
  user: UserSafeProfile
}

/**
 * 本人修改密码参数：
 * - currentPassword 用于向后端证明当前操作者知晓旧密码；
 * - newPassword 为目标密码，确认密码校验由页面层先行完成。
 */
export interface ChangePasswordPayload {
  currentPassword: string
  newPassword: string
}

/**
 * 归一化用户权限：
 * - 优先使用后端返回的 permissions；
 * - 若读取到旧版本本地快照，则按 role 自动补齐默认权限。
 */
export const normalizeUserPermissions = (user: Pick<UserSafeProfile, 'role' | 'permissions'>): PermissionCode[] => {
  if (Array.isArray(user.permissions) && user.permissions.length > 0) {
    return [...new Set(user.permissions)]
  }

  return [...ROLE_DEFAULT_PERMISSION_MAP[user.role]]
}

/**
 * 归一化安全用户资料：
 * - 登录、/auth/me、本地持久化恢复都通过同一入口补齐 permissions；
 * - 避免页面层四处分散处理兼容逻辑。
 */
export const normalizeUserSafeProfile = (user: UserSafeProfile): UserSafeProfile => {
  return {
    ...user,
    permissions: normalizeUserPermissions(user),
  }
}

/**
 * 调用登录接口：
 * - 登录页提交成功后会由 Auth Store 统一接管状态持久化；
 * - API 层先归一化 permissions，保证调用端拿到稳定结构。
 */
export const login = async (payload: LoginPayload) => {
  const result = await request<LoginResult>({
    method: 'POST',
    url: '/auth/login',
    data: payload,
  })

  return {
    ...result,
    user: normalizeUserSafeProfile(result.user),
  }
}

/**
 * 调用退出接口：
 * - 需要携带当前 token；
 * - 即使接口失败，前端也可以按本地清理策略完成退出。
 */
export const logout = () =>
  request<boolean>({
    method: 'POST',
    url: '/auth/logout',
  })

/**
 * 获取当前登录用户：
 * - 用于页面刷新后的登录态恢复；
 * - 同步兜底修正 permissions，保证旧持久化数据也能平滑升级。
 */
export const getCurrentUser = async () => {
  const result = await request<UserSafeProfile>({
    method: 'GET',
    url: '/auth/me',
  })

  return normalizeUserSafeProfile(result)
}

/**
 * 本人修改密码接口：
 * - 成功后服务端会作废当前账号已有会话；
 * - 前端收到成功结果后应主动清理本地登录态并引导重新登录。
 */
export const changePassword = (payload: ChangePasswordPayload) =>
  request<boolean>({
    method: 'POST',
    url: '/auth/change-password',
    data: payload,
  })

/**
 * 角色中文文案：
 * - 供列表、头部、登录页欢迎区统一复用；
 * - 避免不同页面出现不一致表述。
 */
export const ROLE_LABEL_MAP: Record<UserRole, string> = {
  admin: '管理员',
  operator: '操作员',
}

/**
 * 状态中文文案：
 * - 用于用户管理页与头部状态展示；
 * - 与后端 enabled/disabled 值保持一一映射。
 */
export const STATUS_LABEL_MAP: Record<UserStatus, string> = {
  enabled: '启用',
  disabled: '停用',
}
