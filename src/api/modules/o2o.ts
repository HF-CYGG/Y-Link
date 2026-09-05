/**
 * 模块说明：O2O 预购业务 API 模块。
 * 文件职责：封装商城商品、预订单、退货申请、核销台查询与门店核销等 O2O 前端共享接口与类型。
 * 实现逻辑：
 * - 客户端目录、预订单和退货 DTO 从 shared-types import/re-export，现有页面 import path 保持不变；
 * - 管理端核销、库存和治理专属结构继续留在 Web API 模块，避免扩大本轮迁移范围；
 * - 核销接口虽然共用一个入口，但会通过 `verifyTargetType` 和 `operationType` 明确区分取货核销与退货回库。
 * 维护说明：
 * - 客户端共享 DTO 必须先按后端 route/service/entity 校准，再修改 shared-types；
 * - 若后端新增或删减状态，需同步共享 Contract、Web 常量与消费页面分支。
 */

import { request, type RequestConfig } from '@/api/http'
import type {
  O2oOrderBusinessStatus,
  O2oOrderStatus,
} from '@/constants/o2o-order-status'
import type { ClientUserAccountType } from '@/api/modules/client-user-manage'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'
import type {
  O2oClientOrderType,
  O2oMallProductsResult,
  O2oMallStorefrontConfig,
  O2oMyOrderListQuery,
  O2oMyOrderListResult,
  O2oPreorderDetail,
  O2oPreorderSummary,
  O2oReturnRequestDetail,
  SubmitO2oPreorderPayload,
  SubmitO2oReturnRequestPayload,
  UpdateMyO2oPreorderPayload,
} from '../../../packages/shared-types/src/index'

export type {
  O2oClientOrderType,
  O2oMallProduct,
  O2oMallProductsResult,
  O2oMallSku,
  O2oMallStorefrontConfig,
  O2oMyOrderListQuery,
  O2oOrderStatusReport,
  O2oPreorderDetail,
  O2oPreorderDetailItem,
  O2oPreorderSummary,
  O2oReturnRequestDetail,
  O2oReturnRequestItem,
  O2oReturnRequestStatus,
  SubmitO2oPreorderPayload,
  SubmitO2oReturnRequestPayload,
  UpdateMyO2oPreorderPayload,
} from '../../../packages/shared-types/src/index'

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

export type O2oInventoryLogListQuery = PaginationQueryInput

export interface UpdateConsoleO2oPreorderPayload {
  remark?: string
  items: Array<{ productId: string | number; skuId?: string | number | null; qty: number }>
}

export interface UpdateO2oComplianceFlagsPayload {
  hasCustomerOrder?: boolean
  isSystemApplied?: boolean
}

export interface DeleteO2oConsoleOrderPayload {
  confirmShowNo: string
  permanentDeletePassword?: string
}

export interface DeleteO2oConsoleOrderResult {
  id: string
  showNo: string
  status: O2oOrderStatus
  clientOrderType: O2oClientOrderType
  releasedPreorderedQty: number
  returnRequestCount: number
  outboundOrderShowNo: string | null
  outboundOrderDeleted: boolean
  preorderSerialRolledBack: boolean
  outboundSerialRolledBack: boolean
}

/**
 * 管理端订单池查询参数：
 * - 与后端 `/o2o/orders` 路由保持一致；
 * - 补齐时间筛选字段，避免页面后续接入筛选时再次出现契约漂移。
 */
export interface O2oConsoleOrderListQuery {
  status?: O2oOrderStatus
  keyword?: string
  accountType?: ClientUserAccountType
  departmentName?: string
  staffNo?: string
  startTime?: string
  endTime?: string
  limit?: number
}

/**
 * 客户端展示订单号时，优先使用核销后沉淀出的正式出库单号：
 * - 已生成管理端正式出库单时，客户端应与管理端保持完全一致；
 * - 尚未核销或历史数据未关联正式出库单时，再回退显示预订单号。
 */
export const resolveO2oDisplayShowNo = (
  orderLike: Pick<O2oPreorderSummary, 'showNo' | 'customerOrderShowNo'>,
) => {
  const normalizedCustomerOrderShowNo = orderLike.customerOrderShowNo?.trim()
  if (normalizedCustomerOrderShowNo) {
    return normalizedCustomerOrderShowNo
  }
  return orderLike.showNo
}

export const getO2oMallProducts = (config?: RequestConfig) =>
  request<O2oMallProductsResult>({
    method: 'GET',
    url: '/o2o/mall/products',
    ...config,
  })

export const getO2oMallStorefront = (config?: RequestConfig) =>
  request<O2oMallStorefrontConfig>({
    method: 'GET',
    url: '/o2o/mall/storefront',
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
  const result = await request<O2oMyOrderListResult>({
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

/**
 * 读取当前客户端订单的轻量摘要：
 * - 供订单列表在收到外部变更广播后按订单 id 增量刷新单条卡片；
 * - 返回结构与列表项保持一致，避免为了同步一条订单而重拉整页；
 * - 若订单已无权限访问或已被移除，调用方可据此清理本地缓存。
 */
export const getMyO2oPreorderSummary = (id: string, config?: RequestConfig) =>
  request<O2oPreorderSummary>({
    method: 'GET',
    url: `/o2o/mall/preorders/${id}/summary`,
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

export const deleteO2oConsoleOrder = (
  id: string,
  payload: DeleteO2oConsoleOrderPayload,
  config?: RequestConfig,
) =>
  request<DeleteO2oConsoleOrderResult>({
    method: 'DELETE',
    url: `/o2o/orders/${id}`,
    data: payload,
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

export const inboundO2oStock = (payload: { productId: string; skuId?: string | null; qty: number; remark?: string }) =>
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

export const getO2oInventoryLogsPaged = (
  params: O2oInventoryLogListQuery,
): Promise<{
  page: number
  pageSize: number
  total: number
  list: O2oInventoryLog[]
}> =>
  request<{
    page: number
    pageSize: number
    total: number
    list: O2oInventoryLog[]
  }>({
    method: 'GET',
    url: '/o2o/inventory/logs',
    params,
  })
