/**
 * 模块说明：src/api/modules/inbound.ts
 * 文件职责：封装送货单与入库核销的相关接口。
 * 维护说明：包含供货方提交、历史单据查询以及管理端扫码核销逻辑。
 */

import { request } from '@/api/http'

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
  createdAt: string
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
 * - 获取当前登录供货方自己的所有单据。
 */
export const getSupplierDeliveries = () =>
  request<InboundOrder[]>({
    method: 'GET',
    url: '/inbound/supplier/list',
  })

/**
 * 查看送货单详情 (通用)：
 * - 基于核销码查询，可用于扫码场景。
 */
export const getInboundDetail = (verifyCode: string) =>
  request<InboundOrderDetail>({
    method: 'GET',
    url: `/inbound/detail/${verifyCode}`,
  })

/**
 * 按送货单号查看详情：
 * - 用于扫码失败后的人工录入兜底。
 */
export const getInboundDetailByShowNo = (showNo: string) =>
  request<InboundOrderDetail>({
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
