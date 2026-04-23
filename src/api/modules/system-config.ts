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
  updatedAt: string
}

export interface UpdateO2oRuleConfigsPayload {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
  clientPreorderUpdateLimit: number
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
