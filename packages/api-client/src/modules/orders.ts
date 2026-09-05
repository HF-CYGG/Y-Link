import type {
  O2oMyOrderListQuery,
  O2oMyOrderListResult,
  O2oPreorderDetail,
  O2oPreorderSummary,
  O2oReturnRequestDetail,
  SubmitO2oPreorderPayload,
  SubmitO2oReturnRequestPayload,
  UpdateMyO2oPreorderPayload,
} from '@ylink/shared-types'

import type { ApiRequestOptions, HttpAdapter } from '../types.ts'

const encodePathSegment = (value: string) => encodeURIComponent(value)

/** 当前客户端 O2O 订单 Contract；最终金额、库存与退货数量均以后端响应为准。 */
export const createOrdersApi = (http: HttpAdapter) => ({
  listMyOrders(
    query: O2oMyOrderListQuery = {},
    options: ApiRequestOptions = {},
  ): Promise<O2oMyOrderListResult> {
    return http.request({
      ...options,
      method: 'GET',
      url: '/o2o/mall/preorders',
      params: {
        page: query.page,
        pageSize: query.pageSize,
        status: query.status,
        keyword: query.keyword,
      },
    })
  },

  submitPreorder(
    data: SubmitO2oPreorderPayload,
    options: ApiRequestOptions = {},
  ): Promise<O2oPreorderDetail> {
    // 不从 clientRequestId 自动推导请求头；Idempotency-Key 只接受调用方显式传入。
    return http.request({ ...options, method: 'POST', url: '/o2o/mall/preorders', data })
  },

  getPreorderDetail(id: string, options: ApiRequestOptions = {}): Promise<O2oPreorderDetail> {
    return http.request({
      ...options,
      method: 'GET',
      url: `/o2o/mall/preorders/${encodePathSegment(id)}`,
    })
  },

  getPreorderSummary(id: string, options: ApiRequestOptions = {}): Promise<O2oPreorderSummary> {
    return http.request({
      ...options,
      method: 'GET',
      url: `/o2o/mall/preorders/${encodePathSegment(id)}/summary`,
    })
  },

  markCustomerOrderPrinted(id: string, options: ApiRequestOptions = {}): Promise<O2oPreorderDetail> {
    return http.request({
      ...options,
      method: 'POST',
      url: `/o2o/mall/preorders/${encodePathSegment(id)}/customer-order-print`,
    })
  },

  cancelPreorder(id: string, options: ApiRequestOptions = {}): Promise<O2oPreorderDetail> {
    return http.request({
      ...options,
      method: 'POST',
      url: `/o2o/mall/preorders/${encodePathSegment(id)}/cancel`,
    })
  },

  updatePreorder(
    id: string,
    data: UpdateMyO2oPreorderPayload,
    options: ApiRequestOptions = {},
  ): Promise<O2oPreorderDetail> {
    return http.request({
      ...options,
      method: 'PATCH',
      url: `/o2o/mall/preorders/${encodePathSegment(id)}`,
      data,
    })
  },

  createReturnRequest(
    id: string,
    data: SubmitO2oReturnRequestPayload,
    options: ApiRequestOptions = {},
  ): Promise<O2oReturnRequestDetail> {
    return http.request({
      ...options,
      method: 'POST',
      url: `/o2o/mall/preorders/${encodePathSegment(id)}/returns`,
      data,
    })
  },
})
