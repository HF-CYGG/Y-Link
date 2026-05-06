/**
 * 模块说明：O2O 预购业务 API 模块。
 * 文件职责：封装商城商品、预订单、退货申请、核销台查询与门店核销等 O2O 前端共享接口与类型。
 * 实现逻辑：
 * - 统一沉淀预订单详情、退货申请详情、核销结果等跨页面复用的数据结构；
 * - 让客户端订单页、管理端订单页、核销台都复用同一份类型定义，减少状态口径漂移；
 * - 核销接口虽然共用一个入口，但会通过 `verifyTargetType` 和 `operationType` 明确区分取货核销与退货回库。
 * 维护说明：
 * - 本文件的枚举必须与后端实体、服务返回结构保持严格一致；
 * - 若后端新增或删减退货申请状态，需优先修改本文件，再同步消费这些类型的页面分支。
 */

import { request, type RequestConfig } from '@/api/http'
import type {
  ClientOrderReportScenario,
  O2oOrderBusinessStatus,
  O2oOrderStatus,
} from '@/constants/o2o-order-status'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

export type O2oClientOrderType = 'department' | 'walkin'

export interface O2oOrderStatusReport {
  scenario: ClientOrderReportScenario
  cancelReason: 'timeout' | 'manual' | null
  timeoutReached: boolean
  timeoutSoon: boolean
}

export interface O2oMallProduct {
  id: string
  productCode: string
  productName: string
  defaultPrice: string
  tags: string[]
  thumbnail: string | null
  detailContent: string | null
  limitPerUser: number
  currentStock: number
  preOrderedStock: number
  availableStock: number
}

export interface O2oPreorderSummary {
  statusReport: O2oOrderStatusReport
  totalAmount?: string
  expireInSeconds?: number
  id: string
  showNo: string
  verifyCode: string
  status: O2oOrderStatus
  businessStatus: O2oOrderBusinessStatus | null
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  merchantMessage: string | null
  clientOrderType: O2oClientOrderType
  departmentNameSnapshot: string | null
  returnRequestCount: number
  pendingReturnRequestCount: number
  latestReturnRequest: {
    id: string
    returnNo: string
    status: O2oReturnRequestStatus
    createdAt: string
    handledAt: string | null
    rejectedReason: string | null
  } | null
  totalQty: number
  timeoutAt: string | null
  createdAt: string
}

export interface O2oMyOrderListQuery extends PaginationQueryInput {
  status?: O2oOrderStatus
  keyword?: string
}

interface O2oMyOrderListRawResult {
  page: number
  pageSize: number
  total: number
  list: O2oPreorderSummary[]
}

export interface O2oPreorderDetailItem {
  id: string
  productId: string
  productCode: string
  productName: string
  defaultPrice: string
  qty: number
  returnedQty: number
  availableReturnQty: number
  subTotal?: string
}

export interface O2oReturnRequestItem {
  id: string
  productId: string
  productCode: string
  productName: string
  qty: number
}

// 退货申请已扩展为“待核销 / 已核销 / 已拒绝”三态，所有消费端都必须按真实状态分支展示。
export type O2oReturnRequestStatus = 'pending' | 'verified' | 'rejected'

export interface O2oReturnRequestDetail {
  id: string
  returnNo: string
  verifyCode: string
  status: O2oReturnRequestStatus
  sourceOrderStatus: O2oOrderStatus
  reason: string
  totalQty: number
  createdAt: string
  handledAt: string | null
  handledBy: string | null
  verifiedAt: string | null
  verifiedBy: string | null
  rejectedReason: string | null
  qrPayload: string
  items: O2oReturnRequestItem[]
}

export interface O2oPreorderDetail {
  order: {
    statusReport: O2oOrderStatusReport
    totalAmount?: string
    expireInSeconds?: number
    id: string
    showNo: string
    verifyCode: string
    status: O2oOrderStatus
    businessStatus: O2oOrderBusinessStatus | null
    hasCustomerOrder: boolean
    isSystemApplied: boolean
    pickupContact: string | null
    merchantMessage: string | null
    clientOrderType: O2oClientOrderType
    departmentNameSnapshot: string | null
    remark: string | null
    updateCount: number
    remainingUpdateCount: number
    maxUpdateCount: number
    totalQty: number
    timeoutAt: string | null
    verifiedAt: string | null
    createdAt: string
  }
  customerProfile: {
    id: string
    username: string
    realName: string | null
    mobile: string | null
    email: string | null
    departmentName: string | null
  } | null
  items: O2oPreorderDetailItem[]
  returnRequests: O2oReturnRequestDetail[]
  amountSummary?: {
    totalAmount: string
    totalQty: number
    totalItemCount: number
  }
  qrPayload: string
}

export interface O2oVerifyDetailResult {
  verifyTargetType: 'preorder' | 'return_request'
  detail: O2oPreorderDetail | O2oReturnRequestDetail
}

export interface O2oVerifyResult extends O2oVerifyDetailResult {
  operationType: 'preorder_verify' | 'return_verify'
}

export interface O2oInboundResult {
  id: string
  productName: string
  currentStock: number
  preOrderedStock: number
}

export interface O2oInventoryLog {
  id: string
  productId: string
  productName: string
  changeType: string
  changeQty: number
  beforeCurrentStock: number
  afterCurrentStock: number
  beforePreorderedStock: number
  afterPreorderedStock: number
  operatorType: string
  operatorName: string
  refType: string
  refId: string
  createdAt: string
}

export interface SubmitO2oPreorderPayload {
  clientOrderType: O2oClientOrderType
  isSystemApplied: boolean
  pickupContact: string
  remark?: string
  items: Array<{ productId: string | number; qty: number }>
}

export interface SubmitO2oReturnRequestPayload {
  reason: string
  items: Array<{ productId: string | number; qty: number }>
}

export interface UpdateMyO2oPreorderPayload {
  remark?: string
  items: Array<{ productId: string | number; qty: number }>
}

export interface UpdateConsoleO2oPreorderPayload {
  remark?: string
  items: Array<{ productId: string | number; qty: number }>
}

export interface UpdateO2oComplianceFlagsPayload {
  hasCustomerOrder?: boolean
  isSystemApplied?: boolean
}

/**
 * 管理端订单池查询参数：
 * - 与后端 `/o2o/orders` 路由保持一致；
 * - 补齐时间筛选字段，避免页面后续接入筛选时再次出现契约漂移。
 */
export interface O2oConsoleOrderListQuery {
  status?: O2oOrderStatus
  keyword?: string
  startTime?: string
  endTime?: string
  limit?: number
}

export const getO2oMallProducts = (config?: RequestConfig) =>
  request<O2oMallProduct[]>({
    method: 'GET',
    url: '/o2o/mall/products',
    ...config,
  })

export const submitO2oPreorder = (payload: SubmitO2oPreorderPayload, config?: RequestConfig) =>
  request<O2oPreorderDetail>({
    method: 'POST',
    url: '/o2o/mall/preorders',
    data: payload,
    ...config,
  })

export const getMyO2oPreorders = async (
  params: O2oMyOrderListQuery = {},
  config?: RequestConfig,
): Promise<PaginationResult<O2oPreorderSummary>> => {
  const result = await request<O2oMyOrderListRawResult>({
    method: 'GET',
    url: '/o2o/mall/preorders',
    params,
    ...config,
  })
  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    records: result.list,
  }
}

export const getO2oConsoleOrders = (
  params: O2oConsoleOrderListQuery,
  config?: RequestConfig,
) =>
  request<O2oPreorderSummary[]>({
    method: 'GET',
    url: '/o2o/orders',
    params,
    ...config,
  })

export const getO2oPreorderDetail = (id: string, config?: RequestConfig) =>
  request<O2oPreorderDetail>({
    method: 'GET',
    url: `/o2o/mall/preorders/${id}`,
    ...config,
  })

export const markMyO2oPreorderCustomerOrderPrinted = (id: string, config?: RequestConfig) =>
  request<O2oPreorderDetail>({
    method: 'POST',
    url: `/o2o/mall/preorders/${id}/customer-order-print`,
    ...config,
  })

/**
 * 客户端主动撤回自己的预订单：
 * - 仅待核销订单允许撤回；
 * - 服务端会在同一事务内释放预订库存并返回最新详情；
 * - 页面层可直接用返回结果刷新列表与详情视图。
 */
export const cancelMyO2oPreorder = (id: string, config?: RequestConfig) =>
  request<O2oPreorderDetail>({
    method: 'POST',
    url: `/o2o/mall/preorders/${id}/cancel`,
    ...config,
  })

/**
 * 客户端修改待取货预订单：
 * - 仅订单本人且订单尚未核销时允许调用；
 * - 单个订单最多允许成功修改 3 次；
 * - 支持修改商品、数量与备注；
 * - 服务端会按明细差值同步预订库存并返回最新详情。
 */
export const updateMyO2oPreorder = (id: string, payload: UpdateMyO2oPreorderPayload, config?: RequestConfig) =>
  request<O2oPreorderDetail>({
    method: 'PATCH',
    url: `/o2o/mall/preorders/${id}`,
    data: payload,
    ...config,
  })

export const submitO2oReturnRequest = (id: string, payload: SubmitO2oReturnRequestPayload, config?: RequestConfig) =>
  request<O2oReturnRequestDetail>({
    method: 'POST',
    url: `/o2o/mall/preorders/${id}/returns`,
    data: payload,
    ...config,
  })

export const getO2oConsoleOrderDetail = (id: string, config?: RequestConfig) =>
  request<O2oPreorderDetail>({
    method: 'GET',
    url: `/o2o/orders/${id}`,
    ...config,
  })

export const updateO2oOrderBusinessStatus = (
  id: string,
  businessStatus: O2oOrderBusinessStatus | null,
  config?: RequestConfig,
) =>
  request<O2oPreorderDetail>({
    method: 'PATCH',
    url: `/o2o/orders/${id}/business-status`,
    data: { businessStatus },
    ...config,
  })

export const updateO2oOrderMerchantMessage = (id: string, merchantMessage: string | null, config?: RequestConfig) =>
  request<O2oPreorderDetail>({
    method: 'PATCH',
    url: `/o2o/orders/${id}/merchant-message`,
    data: { merchantMessage },
    ...config,
  })

export const updateO2oOrderComplianceFlags = (
  id: string,
  payload: UpdateO2oComplianceFlagsPayload,
  config?: RequestConfig,
) =>
  request<O2oPreorderDetail>({
    method: 'PATCH',
    url: `/o2o/orders/${id}/compliance-flags`,
    data: payload,
    ...config,
  })

/**
 * 门店现场改单：
 * - 仅管理端工作人员可调用；
 * - 仅待核销且满足后端校验的订单允许修改；
 * - 保存后返回最新订单详情，供核销台原位刷新核销依据。
 */
export const updateO2oOrderOnsite = (
  id: string,
  payload: UpdateConsoleO2oPreorderPayload,
  config?: RequestConfig,
) =>
  request<O2oPreorderDetail>({
    method: 'PATCH',
    url: `/o2o/orders/${id}/onsite-adjust`,
    data: payload,
    ...config,
  })

/**
 * 门店拒绝退货申请：
 * - 仅待处理退货申请允许拒绝；
 * - 必须填写拒绝原因；
 * - 返回最新退货申请详情，供核销台立即展示结果。
 */
export const rejectO2oReturnRequest = (id: string, rejectReason: string, config?: RequestConfig) =>
  request<O2oReturnRequestDetail>({
    method: 'POST',
    url: `/o2o/return-requests/${id}/reject`,
    data: { rejectReason },
    ...config,
  })

export const getO2oVerifyDetail = (verifyCode: string) =>
  request<O2oVerifyDetailResult>({
    method: 'GET',
    url: `/o2o/verify/${encodeURIComponent(verifyCode)}`,
  })

export const getO2oVerifyDetailByShowNo = (showNo: string) =>
  request<O2oVerifyDetailResult>({
    method: 'GET',
    url: `/o2o/verify/show-no/${encodeURIComponent(showNo)}`,
  })

export const verifyO2oPreorder = (verifyCode: string) =>
  request<O2oVerifyResult>({
    method: 'POST',
    url: '/o2o/verify',
    data: { verifyCode },
  })

export const inboundO2oStock = (payload: { productId: string; qty: number; remark?: string }) =>
  request<O2oInboundResult>({
    method: 'POST',
    url: '/o2o/inbound',
    data: payload,
  })

export const getO2oInventoryLogs = (limit = 50) =>
  request<O2oInventoryLog[]>({
    method: 'GET',
    url: '/o2o/inventory/logs',
    params: { limit },
  })
