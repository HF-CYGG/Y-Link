/**
 * 模块说明：src/api/modules/client-user-manage.ts
 * 文件职责：封装管理端对客户端用户的治理接口。
 * 维护说明：
 * - 客户端用户与管理端用户分开维护，避免前端页面混淆字段语义；
 * - 当前聚焦列表、启停与重置密码三类治理动作。
 */

import { request, type RequestConfig } from '@/api/http'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

export type ClientUserStatus = 'enabled' | 'disabled'

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

export type ClientUserListResult = PaginationResult<ClientUserManageProfile>

export interface ResetClientUserPasswordPayload {
  newPassword: string
}

export interface UpdateClientUserPayload {
  username: string
  mobile?: string
  email?: string
  departmentName?: string
  status: ClientUserStatus
}

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

export const updateClientUserStatus = (id: string, status: ClientUserStatus) =>
  request<ClientUserManageProfile>({
    method: 'PATCH',
    url: `/client-users/${id}/status`,
    data: { status },
  })

export const updateClientUser = (id: string, payload: UpdateClientUserPayload) =>
  request<ClientUserManageProfile>({
    method: 'PATCH',
    url: `/client-users/${id}`,
    data: payload,
  })

export const resetClientUserPassword = (id: string, payload: ResetClientUserPasswordPayload) =>
  request<ClientUserManageProfile>({
    method: 'POST',
    url: `/client-users/${id}/reset-password`,
    data: payload,
  })
