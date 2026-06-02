/**
 * 模块说明：系统配置治理 API 模块。
 * 文件职责：封装订单流水号、O2O 规则与验证码供应商通道配置的查询与更新接口及相关类型。
 * 维护说明：维护时重点关注配置项默认值、通道模板字段约束与前后端配置结构对齐。
 */

import { request } from '@/api/http'

export type OrderSerialType = 'department' | 'walkin'

export interface OrderSerialConfigRecord {
  orderType: OrderSerialType
  orderTypeLabel: string
  prefix: string
  start: number
  current: number
  width: number
  updatedAt: string
}

export interface OrderSerialConfigsResult {
  list: OrderSerialConfigRecord[]
}

export interface OrderSerialConfigValueInput {
  start: number
  current: number
  width: number
}

export interface UpdateOrderSerialConfigsPayload {
  department: OrderSerialConfigValueInput
  walkin: OrderSerialConfigValueInput
}

export interface UpdateOrderSerialConfigsResult {
  list: OrderSerialConfigRecord[]
  changed: boolean
}

export interface O2oRuleConfigRecord {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
  clientPreorderUpdateLimit: number
  storeBusinessHoursText: string
  updatedAt: string
}

export interface UpdateO2oRuleConfigsPayload {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
  clientPreorderUpdateLimit: number
  storeBusinessHoursText: string
}

export interface UpdateO2oRuleConfigsResult {
  config: O2oRuleConfigRecord
  changed: boolean
}

export interface VerificationProviderChannelConfig {
  enabled: boolean
  httpMethod: 'POST' | 'GET'
  apiUrl: string
  headersTemplate: string
  bodyTemplate: string
  successMatch: string
  updatedAt: string
}

export interface VerificationProviderConfigsResult {
  mobile: VerificationProviderChannelConfig
  email: VerificationProviderChannelConfig
}

export interface VerificationProviderChannelInput {
  enabled: boolean
  httpMethod: 'POST' | 'GET'
  apiUrl: string
  headersTemplate: string
  bodyTemplate: string
  successMatch: string
}

export interface UpdateVerificationProviderConfigsPayload {
  mobile: VerificationProviderChannelInput
  email: VerificationProviderChannelInput
}

export interface UpdateVerificationProviderConfigsResult {
  config: VerificationProviderConfigsResult
  changed: boolean
}

export interface CustomerServiceFaqRecord {
  question: string
  answer: string
}

export interface CustomerServiceAvailabilityRecord {
  status: 'online' | 'offline'
  reason: 'within_work_hours' | 'outside_work_hours' | 'no_online_staff'
  isOnline: boolean
  withinWorkHours: boolean
  hasOnlineStaff: boolean
  serviceConnectedCount: number
  serverTime: string
  workHoursText: string
  offlineNotice: string
  offlineFaqs: CustomerServiceFaqRecord[]
}

export interface CustomerServiceConfigRecord {
  enabled: boolean
  realtimeEnabled: boolean
  entryNotice: string
  workdayStart: string
  workdayEnd: string
  workdayWeekdays: number[]
  offlineNotice: string
  offlineFaqs: CustomerServiceFaqRecord[]
  sseKeepaliveSeconds: number
  availability: CustomerServiceAvailabilityRecord
  updatedAt: string
}

export interface UpdateCustomerServiceConfigsPayload {
  enabled: boolean
  realtimeEnabled: boolean
  entryNotice: string
  workdayStart: string
  workdayEnd: string
  workdayWeekdays: number[]
  offlineNotice: string
  offlineFaqs: CustomerServiceFaqRecord[]
  sseKeepaliveSeconds: number
}

export interface UpdateCustomerServiceConfigsResult {
  config: CustomerServiceConfigRecord
  changed: boolean
}

export interface TestVerificationProviderPayload {
  channel: 'mobile' | 'email'
  target: string
  config: VerificationProviderChannelInput
}

export interface TestVerificationProviderResult {
  channel: 'mobile' | 'email'
  target: string
  code: string
}

export interface ClientDepartmentConfigRecord {
  tree: ClientDepartmentTreeNode[]
  options: string[]
  updatedAt: string
}

export interface ClientDepartmentTreeNode {
  id: string
  label: string
  children: ClientDepartmentTreeNode[]
}

export interface UpdateClientDepartmentConfigsPayload {
  tree?: ClientDepartmentTreeNode[]
  options?: string[]
}

export interface UpdateClientDepartmentConfigsResult {
  config: ClientDepartmentConfigRecord
  changed: boolean
}

export type ClientStaffDirectoryStatus = 'active' | 'inactive'

export interface ClientStaffDirectoryRecord {
  id: string
  staffNo: string
  realName: string
  departmentName: string
  status: ClientStaffDirectoryStatus
  linkedClientUserCount: number
  createdAt: string
  updatedAt: string
}

export interface ClientStaffDirectoryListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: ClientStaffDirectoryStatus
}

export interface ClientStaffDirectoryListResult {
  page: number
  pageSize: number
  total: number
  list: ClientStaffDirectoryRecord[]
}

export interface SaveClientStaffDirectoryPayload {
  staffNo: string
  realName: string
  departmentName: string
  status?: ClientStaffDirectoryStatus
}

export interface SaveClientStaffDirectoryResult {
  record: ClientStaffDirectoryRecord
}

export interface DeleteClientStaffDirectoryBatchPayload {
  ids: string[]
}

export interface DeleteClientStaffDirectoryBatchResult {
  summary: {
    deleted: number
    linkedDepartmentAccounts: number
  }
}

export interface ImportClientStaffDirectoryPayload {
  rows?: SaveClientStaffDirectoryPayload[]
  rawText?: string
}

export interface ImportClientStaffDirectoryResult {
  summary: {
    created: number
    updated: number
    skipped: number
    autoCreatedDepartments: string[]
  }
  list: ClientStaffDirectoryRecord[]
}

export interface ImportClientStaffDirectoryPreviewRow {
  staffNo: string
  realName: string
  departmentName: string
  status: ClientStaffDirectoryStatus
  action: 'create' | 'update' | 'skip'
}

export interface ImportClientStaffDirectoryPreviewResult {
  summary: {
    total: number
    creatable: number
    updatable: number
    skippable: number
    autoCreatedDepartments: string[]
  }
  rows: ImportClientStaffDirectoryPreviewRow[]
}

/**
 * 获取流水号生成配置：
 * - 区分“部门”和“散客”开单类型。
 */
export const getOrderSerialConfigs = () =>
  request<OrderSerialConfigsResult>({
    method: 'GET',
    url: '/system-configs/order-serial',
  })

/**
 * 更新流水号生成配置：
 * - 提交后影响全局订单的自动编号规则。
 */
export const updateOrderSerialConfigs = (payload: UpdateOrderSerialConfigsPayload) =>
  request<UpdateOrderSerialConfigsResult>({
    method: 'PUT',
    url: '/system-configs/order-serial',
    data: payload,
  })

/**
 * 获取线上预订全局规则：
 * - 包括超时自动取消时长与单用户库存限购数配置。
 */
export const getO2oRuleConfigs = () =>
  request<O2oRuleConfigRecord>({
    method: 'GET',
    url: '/system-configs/o2o-rules',
  })

/**
 * 更新线上预订规则：
 */
export const updateO2oRuleConfigs = (payload: UpdateO2oRuleConfigsPayload) =>
  request<UpdateO2oRuleConfigsResult>({
    method: 'PUT',
    url: '/system-configs/o2o-rules',
    data: payload,
  })

/**
 * 获取客服中心配置：
 * - 当前管理端系统配置页只修改其中一部分字段，但保存时仍沿用完整配置结构。
 */
export const getCustomerServiceConfigs = () =>
  request<CustomerServiceConfigRecord>({
    method: 'GET',
    url: '/system-configs/customer-service',
  })

/**
 * 保存客服中心配置：
 * - 包括客服在线时间、入口提示语、离线提示与 FAQ 等共享口径。
 */
export const updateCustomerServiceConfigs = (payload: UpdateCustomerServiceConfigsPayload) =>
  request<UpdateCustomerServiceConfigsResult>({
    method: 'PUT',
    url: '/system-configs/customer-service',
    data: payload,
  })

/**
 * 获取验证码网关服务配置：
 * - 包括短信(mobile)与邮件(email)通道的 HTTP 发送接口模板。
 */
export const getVerificationProviderConfigs = () =>
  request<VerificationProviderConfigsResult>({
    method: 'GET',
    url: '/system-configs/verification-providers',
  })

/**
 * 保存验证码网关服务配置：
 */
export const updateVerificationProviderConfigs = (payload: UpdateVerificationProviderConfigsPayload) =>
  request<UpdateVerificationProviderConfigsResult>({
    method: 'PUT',
    url: '/system-configs/verification-providers',
    data: payload,
  })

/**
 * 测试验证码发送通道：
 * - 后端会使用传入的未保存配置实时发起请求，协助调试配置的准确性。
 */
export const testVerificationProviderSend = (payload: TestVerificationProviderPayload) =>
  request<TestVerificationProviderResult>({
    method: 'POST',
    url: '/system-configs/verification-providers/test-send',
    data: payload,
  })

/**
 * 获取客户端部门配置：
 * - 返回可供客户端账号选择的部门列表。
 */
export const getClientDepartmentConfigs = () =>
  request<ClientDepartmentConfigRecord>({
    method: 'GET',
    url: '/system-configs/client-departments',
  })

/**
 * 保存客户端部门配置：
 * - 提交后客户端注册、资料编辑和后台编辑会统一按该列表约束。
 */
export const updateClientDepartmentConfigs = (payload: UpdateClientDepartmentConfigsPayload) =>
  request<UpdateClientDepartmentConfigsResult>({
    method: 'PUT',
    url: '/system-configs/client-departments',
    data: payload,
  })

export const getClientStaffDirectoryList = (params: ClientStaffDirectoryListQuery) =>
  request<ClientStaffDirectoryListResult>({
    method: 'GET',
    url: '/system-configs/client-staff-directory',
    params,
  })

export const createClientStaffDirectoryRecord = (payload: SaveClientStaffDirectoryPayload) =>
  request<SaveClientStaffDirectoryResult>({
    method: 'POST',
    url: '/system-configs/client-staff-directory',
    data: payload,
  })

export const updateClientStaffDirectoryRecord = (id: string, payload: Omit<SaveClientStaffDirectoryPayload, 'status'>) =>
  request<SaveClientStaffDirectoryResult>({
    method: 'PUT',
    url: `/system-configs/client-staff-directory/${id}`,
    data: payload,
  })

export const updateClientStaffDirectoryStatus = (id: string, status: ClientStaffDirectoryStatus) =>
  request<SaveClientStaffDirectoryResult>({
    method: 'PATCH',
    url: `/system-configs/client-staff-directory/${id}/status`,
    data: { status },
  })

export const deleteClientStaffDirectoryBatch = (payload: DeleteClientStaffDirectoryBatchPayload) =>
  request<DeleteClientStaffDirectoryBatchResult>({
    method: 'DELETE',
    url: '/system-configs/client-staff-directory',
    data: payload,
  })

export const importClientStaffDirectory = (payload: ImportClientStaffDirectoryPayload) =>
  request<ImportClientStaffDirectoryResult>({
    method: 'POST',
    url: '/system-configs/client-staff-directory/import',
    data: payload,
  })

export const previewClientStaffDirectoryImport = (payload: ImportClientStaffDirectoryPayload) =>
  request<ImportClientStaffDirectoryPreviewResult>({
    method: 'POST',
    url: '/system-configs/client-staff-directory/import/preview',
    data: payload,
  })

export const importClientStaffDirectoryFile = (file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  return request<ImportClientStaffDirectoryResult>({
    method: 'POST',
    url: '/system-configs/client-staff-directory/import',
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  })
}

export const previewClientStaffDirectoryImportFile = (file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  return request<ImportClientStaffDirectoryPreviewResult>({
    method: 'POST',
    url: '/system-configs/client-staff-directory/import/preview',
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  })
}
