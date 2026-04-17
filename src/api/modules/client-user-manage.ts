/**
 * 模块说明：src/api/modules/client-user-manage.ts
 * 文件职责：封装管理端对客户端用户的治理接口。
 * 维护说明：
 * - 客户端用户与管理端用户分开维护，避免前端页面混淆字段语义；
 * - 当前聚焦列表、启停与重置密码三类治理动作。
 */

import { request, type RequestConfig } from '@/api/http'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

/**
 * 客户端用户启停状态：
 * - enabled: 账号正常
 * - disabled: 账号被停用，禁止登录
 */
export type ClientUserStatus = 'enabled' | 'disabled'

/**
 * 客户端用户管理资料：
 * - 面向管理端展示，包含基本信息与状态。
 */
export interface ClientUserManageProfile {
  id: string
  account: string
  username: string
  mobile: string
  email: string
  realName: string
  departmentName: string
  status: ClientUserStatus
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * 客户端用户列表查询参数：
 * - keyword: 支持账号/姓名模糊搜索
 * - status: 状态筛选
 */
export interface ClientUserListQuery extends PaginationQueryInput {
  keyword?: string
  status?: ClientUserStatus
}

interface ClientUserListRawResult {
  page: number
  pageSize: number
  total: number
  list: ClientUserManageProfile[]
}

/**
 * 客户端用户列表标准结果：
 * - records 字段与现有前端分页工具保持一致。
 */
export type ClientUserListResult = PaginationResult<ClientUserManageProfile>

/**
 * 管理员重置客户端用户密码参数：
 */
export interface ResetClientUserPasswordPayload {
  newPassword: string
}

/**
 * 更新客户端用户信息参数：
 */
export interface UpdateClientUserPayload {
  username: string
  mobile?: string
  email?: string
  departmentName?: string
  status: ClientUserStatus
}

/**
 * 获取客户端用户列表：
 * - 在模块内完成分页结果的归一化。
 */
export const getClientUserList = async (
  params: ClientUserListQuery,
  requestConfig: RequestConfig = {},
): Promise<ClientUserListResult> => {
  const result = await request<ClientUserListRawResult>({
    ...requestConfig,
    method: 'GET',
    url: '/client-users',
    params,
  })

  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    records: result.list,
  }
}

/**
 * 更新客户端用户启停状态：
 */
export const updateClientUserStatus = (id: string, status: ClientUserStatus) =>
  request<ClientUserManageProfile>({
    method: 'PATCH',
    url: `/client-users/${id}/status`,
    data: { status },
  })

/**
 * 编辑客户端用户信息：
 */
export const updateClientUser = (id: string, payload: UpdateClientUserPayload) =>
  request<ClientUserManageProfile>({
    method: 'PATCH',
    url: `/client-users/${id}`,
    data: payload,
  })

/**
 * 管理员重置客户端用户密码：
 * - 成功后对应的客户端会话会被清除。
 */
export const resetClientUserPassword = (id: string, payload: ResetClientUserPasswordPayload) =>
  request<ClientUserManageProfile>({
    method: 'POST',
    url: `/client-users/${id}/reset-password`,
    data: payload,
  })
