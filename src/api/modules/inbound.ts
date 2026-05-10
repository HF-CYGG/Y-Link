/**
 * 模块说明：src/api/modules/inbound.ts
 * 文件职责：封装送货单与入库核销的相关接口。
 * 维护说明：包含供货方提交、历史单据查询以及管理端扫码核销逻辑。
 */

import { request, type RequestConfig } from '@/api/http'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

/**
 * 入库单号识别：
 * - 供货单展示号当前采用 IN + 日期 + 4 位流水 的格式；
 * - 共享详情查询会基于该规则自动分流到 showNo 详情接口，避免页面误把展示单号当成核销码时直接 404。
 */
const isInboundShowNo = (value: string) => /^IN\d{12}$/i.test(value.trim())

/**
 * 供货方提交明细项参数：
 */
export interface SubmitInboundItemInput {
  productId: string
  qty: number
}

/**
 * 供货方提交整单参数：
 */
export interface SubmitInboundInput {
  remark?: string
  items: SubmitInboundItemInput[]
}

/**
 * 供货方改单参数：
 */
export interface UpdateSupplierInboundInput {
  remark?: string
  items: SubmitInboundItemInput[]
}

/**
 * 供货方撤销参数：
 */
export interface CancelSupplierInboundInput {
  reason: string
}

/**
 * 入库送货单模型：
 * - status: pending (待核销), verified (已核销), cancelled (已取消)
 */
export interface InboundOrder {
  id: string
  showNo: string
  verifyCode: string
  supplierId: string
  supplierName: string
  status: 'pending' | 'verified' | 'cancelled'
  totalQty: string
  remark: string | null
  cancelReason: string | null
  cancelledAt: string | null
  cancelledByUserId: string | null
  cancelledByUsername: string | null
  cancelledByDisplayName: string | null
  createdAt: string
  updatedAt: string
  verifiedAt: string | null
}

/**
 * 入库送货单明细：
 */
export interface InboundOrderItem {
  id: string
  orderId: string
  productId: string
  productNameSnapshot: string
  qty: string
}

/**
 * 入库送货单完整详情：
 */
export interface InboundOrderDetail {
  order: InboundOrder
  items: InboundOrderItem[]
}

/**
 * 供货方历史送货单查询参数：
 * - keyword 支持送货单号与供货方名称模糊查询；
 * - status/page/pageSize 用于服务端筛选与分页。
 */
export interface SupplierDeliveryListQuery extends PaginationQueryInput {
  keyword?: string
  status?: 'pending' | 'verified' | 'cancelled'
}

/**
 * 供货方历史送货单统计：
 * - total 为当前供货方全部单据总数；
 * - 其它字段用于顶部统计卡展示真实状态分布。
 */
export interface SupplierDeliverySummary {
  total: number
  pending: number
  verified: number
  cancelled: number
}

/**
 * 供货方历史送货单分页结果：
 * - records 承载当前页数据；
 * - summary 额外返回全量统计，避免前端为了统计卡再次拉全量。
 */
export interface SupplierDeliveryListResult extends PaginationResult<InboundOrder> {
  summary: SupplierDeliverySummary
}

/**
 * 管理端入库单列表查询参数：
 * - 与后端 `/inbound/admin/list` 保持一致；
 * - 先补齐轻量封装，供后续页面直接复用。
 */
export interface InboundAdminListQuery {
  status?: InboundOrder['status']
  limit?: number
}

/**
 * 供货方提交送货单：
 * - 成功后生成待核销的单据和二维码。
 */
export const submitSupplierDelivery = (data: SubmitInboundInput) =>
  request<InboundOrderDetail>({
    method: 'POST',
    url: '/inbound/supplier/submit',
    data,
  })

/**
 * 供货方查看历史送货单：
 * - 改为服务端筛选与分页，避免历史记录增长后继续全量拉取。
 */
export const getSupplierDeliveries = (params: SupplierDeliveryListQuery = {}, requestConfig: RequestConfig = {}) =>
  request<SupplierDeliveryListResult>({
    ...requestConfig,
    method: 'GET',
    url: '/inbound/supplier/list',
    params,
  })

/**
 * 供货方修改待入库送货单：
 * - 仅允许本人待入库单据修改商品、数量和备注。
 */
export const updateSupplierDelivery = (id: string, data: UpdateSupplierInboundInput, requestConfig: RequestConfig = {}) =>
  request<InboundOrderDetail>({
    ...requestConfig,
    method: 'PATCH',
    url: `/inbound/supplier/${id}`,
    data,
  })

/**
 * 供货方撤销待入库送货单：
 * - 撤销后历史单据继续保留，只变更状态并记录撤销原因。
 */
export const cancelSupplierDelivery = (id: string, data: CancelSupplierInboundInput, requestConfig: RequestConfig = {}) =>
  request<InboundOrderDetail>({
    ...requestConfig,
    method: 'POST',
    url: `/inbound/supplier/${id}/cancel`,
    data,
  })

/**
 * 查看送货单详情 (通用)：
 * - 默认仍优先兼容核销码查询；
 * - 若调用方传入的是送货单号，则自动改走 showNo 详情接口，避免历史页面或管理端回查直接报 404。
 */
export const getInboundDetail = (verifyCodeOrShowNo: string, requestConfig: RequestConfig = {}) => {
  const normalizedCode = verifyCodeOrShowNo.trim()
  const detailPath = isInboundShowNo(normalizedCode)
    ? `/inbound/detail/show-no/${normalizedCode.toUpperCase()}`
    : `/inbound/detail/${normalizedCode}`

  return request<InboundOrderDetail>({
    ...requestConfig,
    method: 'GET',
    url: detailPath,
  })
}

/**
 * 按送货单号查看详情：
 * - 用于扫码失败后的人工录入兜底。
 */
export const getInboundDetailByShowNo = (showNo: string, requestConfig: RequestConfig = {}) =>
  request<InboundOrderDetail>({
    ...requestConfig,
    method: 'GET',
    url: `/inbound/detail/show-no/${showNo}`,
  })

/**
 * 管理端核销入库：
 * - 验证核销码并将商品真实库存增加。
 */
export const verifyInboundOrder = (verifyCode: string) =>
  request<InboundOrderDetail>({
    method: 'POST',
    url: '/inbound/admin/verify',
    data: { verifyCode },
  })

/**
 * 管理端现场改单：
 * - 仅允许对待入库单据修改商品、数量和备注；
 * - 改单后仍停留在扫码页，方便继续核对后直接入库。
 */
export const updateInboundOrderForAdmin = (id: string, data: UpdateSupplierInboundInput, requestConfig: RequestConfig = {}) =>
  request<InboundOrderDetail>({
    ...requestConfig,
    method: 'PATCH',
    url: `/inbound/admin/${id}`,
    data,
  })

/**
 * 管理端查看入库单列表：
 * - 用于后续工作台或统计页按状态查看最近送货单；
 * - 当前仅做契约补齐，不改变现有页面行为。
 */
export const getInboundAdminOrders = (params: InboundAdminListQuery = {}) =>
  request<InboundOrder[]>({
    method: 'GET',
    url: '/inbound/admin/list',
    params,
  })
