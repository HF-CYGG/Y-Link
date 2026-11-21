/** 商城补货入口的轻量查询，保留客户端鉴权和请求取消语义。 */
import { request, type RequestConfig } from '@/api/http'
import type { ActiveRestockRequestResult } from '../../../packages/shared-types/src/index'

export const getActiveClientRestockRequest = (skuId: string, config: RequestConfig = {}) => request<ActiveRestockRequestResult>({
  ...config, method: 'GET', url: '/client-feedback/restock-requests/active', params: { skuId },
})
