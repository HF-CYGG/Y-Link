import { request, type RequestConfig } from '@/api/http'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'
import type { UserRole, UserSafeProfile, UserStatus } from '@/api/modules/auth'
import { normalizeUserSafeProfile } from '@/api/modules/auth'

/**
 * 用户列表查询参数：
 * - keyword 支持账号/姓名模糊搜索；
 * - role/status 用于后台常见的维度筛选。
 */
export interface UserListQuery extends PaginationQueryInput {
  keyword?: string
  role?: UserRole
  status?: UserStatus
}

/**
 * 用户列表原始响应：
 * - 后端分页字段为 list；
 * - 前端页面统一消费 records，因此在 API 层做一次归一化。
 */
interface UserListRawResult {
  page: number
  pageSize: number
  total: number
  list: UserSafeProfile[]
}

/**
 * 用户列表标准结果：
 * - records 字段与现有前端分页工具保持一致；
 * - 同时确保每条用户数据都补齐 permissions 字段。
 */
export type UserListResult = PaginationResult<UserSafeProfile>

/**
 * 新增用户参数：
 * - password 仅在新增时必填；
 * - status 可选，默认由后端兜底为 enabled。
 */
export interface CreateUserPayload {
  username: string
  password: string
  displayName: string
  role: UserRole
  status?: UserStatus
}

/**
 * 编辑用户参数：
 * - 与后端接口约定保持一致；
 * - 若不改密码，则不传 password 字段。
 */
export interface UpdateUserPayload {
  displayName?: string
  password?: string
  role?: UserRole
}

/**
 * 管理员重置密码参数：
 * - newPassword 为新密码；
 * - 页面层负责确认密码一致性，接口层只传最终值。
 */
export interface ResetUserPasswordPayload {
  newPassword: string
}

/**
 * 获取用户列表：
 * - 统一在模块内完成分页结果归一化；
 * - 确保页面层拿到的用户条目已经带有稳定权限点集合。
 */
export const getUserList = async (params: UserListQuery, requestConfig: RequestConfig = {}): Promise<UserListResult> => {
  const result = await request<UserListRawResult>({
    ...requestConfig,
    method: 'GET',
    url: '/users',
    params,
  })

  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    records: result.list.map(normalizeUserSafeProfile),
  }
}

/**
 * 新增用户接口：
 * - 返回新建后的安全用户资料；
 * - 页面层可直接读取角色与权限点。
 */
export const createUser = async (payload: CreateUserPayload) => {
  const result = await request<UserSafeProfile>({
    method: 'POST',
    url: '/users',
    data: payload,
  })

  return normalizeUserSafeProfile(result)
}

/**
 * 更新用户接口：
 * - 角色变更后会同步带回新的权限点集合；
 * - 页面无需再自行推导该用户的权限变化。
 */
export const updateUser = async (id: string, payload: UpdateUserPayload) => {
  const result = await request<UserSafeProfile>({
    method: 'PUT',
    url: `/users/${id}`,
    data: payload,
  })

  return normalizeUserSafeProfile(result)
}

/**
 * 更新用户状态接口：
 * - 启用/停用都走同一接口；
 * - 返回值仍使用统一的安全用户资料结构。
 */
export const updateUserStatus = async (id: string, status: UserStatus) => {
  const result = await request<UserSafeProfile>({
    method: 'PATCH',
    url: `/users/${id}/status`,
    data: { status },
  })

  return normalizeUserSafeProfile(result)
}

/**
 * 管理员重置用户密码接口：
 * - 成功后目标用户已有会话会被服务端失效；
 * - 返回目标用户最新安全资料，便于页面必要时刷新行数据。
 */
export const resetUserPassword = async (id: string, payload: ResetUserPasswordPayload) => {
  const result = await request<UserSafeProfile>({
    method: 'POST',
    url: `/users/${id}/reset-password`,
    data: payload,
  })

  return normalizeUserSafeProfile(result)
}
