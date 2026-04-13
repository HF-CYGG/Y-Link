import { request } from '@/api/http'

export interface SubmitInboundItemInput {
  productId: string
  qty: number
}

export interface SubmitInboundInput {
  remark?: string
  items: SubmitInboundItemInput[]
}

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

export interface InboundOrderItem {
  id: string
  orderId: string
  productId: string
  productNameSnapshot: string
  qty: string
}

export interface InboundOrderDetail {
  order: InboundOrder
  items: InboundOrderItem[]
}

// 供货方提交送货单
export const submitSupplierDelivery = (data: SubmitInboundInput) =>
  request<InboundOrderDetail>({
    method: 'POST',
    url: '/inbound/supplier/submit',
    data,
  })

// 供货方查看历史送货单
export const getSupplierDeliveries = () =>
  request<InboundOrder[]>({
    method: 'GET',
    url: '/inbound/supplier/list',
  })

// 查看详情 (通用)
export const getInboundDetail = (verifyCode: string) =>
  request<InboundOrderDetail>({
    method: 'GET',
    url: `/inbound/detail/${verifyCode}`,
  })

// 按送货单号查看详情（用于扫码失败后的人工录入兜底）
export const getInboundDetailByShowNo = (showNo: string) =>
  request<InboundOrderDetail>({
    method: 'GET',
    url: `/inbound/detail/show-no/${showNo}`,
  })

// 管理端核销入库
export const verifyInboundOrder = (verifyCode: string) =>
  request<InboundOrderDetail>({
    method: 'POST',
    url: '/inbound/admin/verify',
    data: { verifyCode },
  })
