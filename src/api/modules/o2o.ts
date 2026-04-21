/**
 * 模块说明：src/api/modules/o2o.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { request, type RequestConfig } from '@/api/http'
import type {
  ClientOrderReportScenario,
  O2oOrderBusinessStatus,
  O2oOrderStatus,
} from '@/constants/o2o-order-status'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

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
  subTotal?: string
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
    totalQty: number
    timeoutAt: string | null
    verifiedAt: string | null
    createdAt: string
  }
  items: O2oPreorderDetailItem[]
  amountSummary?: {
    totalAmount: string
    totalQty: number
    totalItemCount: number
  }
  qrPayload: string
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
  remark?: string
  items: Array<{ productId: string | number; qty: number }>
}

export const getO2oMallProducts = (config?: RequestConfig) =>
  request<O2oMallProduct[]>({
    method: 'GET',
    url: '/o2o/mall/products',
    ...config,
  })

export const submitO2oPreorder = (payload: SubmitO2oPreorderPayload) =>
  request<O2oPreorderDetail>({
    method: 'POST',
    url: '/o2o/mall/preorders',
    data: payload,
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
  params: { status?: O2oOrderStatus; keyword?: string; limit?: number },
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

export const getO2oVerifyDetail = (verifyCode: string) =>
  request<O2oPreorderDetail>({
    method: 'GET',
    url: `/o2o/verify/${encodeURIComponent(verifyCode)}`,
  })

export const getO2oVerifyDetailByShowNo = (showNo: string) =>
  request<O2oPreorderDetail>({
    method: 'GET',
    url: `/o2o/verify/show-no/${encodeURIComponent(showNo)}`,
  })

export const verifyO2oPreorder = (verifyCode: string) =>
  request<O2oPreorderDetail>({
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
