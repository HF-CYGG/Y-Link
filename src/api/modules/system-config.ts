/**
 * 模块说明：src/api/modules/system-config.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
  updatedAt: string
}

export interface UpdateO2oRuleConfigsPayload {
  autoCancelEnabled: boolean
  autoCancelHours: number
  limitEnabled: boolean
  limitQty: number
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

export const getOrderSerialConfigs = () =>
  request<OrderSerialConfigsResult>({
    method: 'GET',
    url: '/system-configs/order-serial',
  })

export const updateOrderSerialConfigs = (payload: UpdateOrderSerialConfigsPayload) =>
  request<UpdateOrderSerialConfigsResult>({
    method: 'PUT',
    url: '/system-configs/order-serial',
    data: payload,
  })

export const getO2oRuleConfigs = () =>
  request<O2oRuleConfigRecord>({
    method: 'GET',
    url: '/system-configs/o2o-rules',
  })

export const updateO2oRuleConfigs = (payload: UpdateO2oRuleConfigsPayload) =>
  request<UpdateO2oRuleConfigsResult>({
    method: 'PUT',
    url: '/system-configs/o2o-rules',
    data: payload,
  })

export const getVerificationProviderConfigs = () =>
  request<VerificationProviderConfigsResult>({
    method: 'GET',
    url: '/system-configs/verification-providers',
  })

export const updateVerificationProviderConfigs = (payload: UpdateVerificationProviderConfigsPayload) =>
  request<UpdateVerificationProviderConfigsResult>({
    method: 'PUT',
    url: '/system-configs/verification-providers',
    data: payload,
  })

export const testVerificationProviderSend = (payload: TestVerificationProviderPayload) =>
  request<TestVerificationProviderResult>({
    method: 'POST',
    url: '/system-configs/verification-providers/test-send',
    data: payload,
  })
