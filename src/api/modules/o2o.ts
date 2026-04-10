import { request } from '@/api/http'

export interface O2oMallProduct {
  id: string
  productCode: string
  productName: string
  defaultPrice: string
  thumbnail: string | null
  detailContent: string | null
  limitPerUser: number
  currentStock: number
  preOrderedStock: number
  availableStock: number
}

export interface O2oPreorderSummary {
  id: string
  showNo: string
  verifyCode: string
  status: 'pending' | 'verified' | 'cancelled'
  totalQty: number
  timeoutAt: string | null
  createdAt: string
}

export interface O2oPreorderDetailItem {
  id: string
  productId: string
  productCode: string
  productName: string
  qty: number
}

export interface O2oPreorderDetail {
  order: {
    id: string
    showNo: string
    verifyCode: string
    status: 'pending' | 'verified' | 'cancelled'
    totalQty: number
    timeoutAt: string | null
    verifiedAt: string | null
    createdAt: string
  }
  items: O2oPreorderDetailItem[]
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

export const getO2oMallProducts = () =>
  request<O2oMallProduct[]>({
    method: 'GET',
    url: '/o2o/mall/products',
  })

export const submitO2oPreorder = (payload: SubmitO2oPreorderPayload) =>
  request<O2oPreorderDetail>({
    method: 'POST',
    url: '/o2o/mall/preorders',
    data: payload,
  })

export const getMyO2oPreorders = () =>
  request<O2oPreorderSummary[]>({
    method: 'GET',
    url: '/o2o/mall/preorders',
  })

export const getO2oPreorderDetail = (id: string) =>
  request<O2oPreorderDetail>({
    method: 'GET',
    url: `/o2o/mall/preorders/${id}`,
  })

export const getO2oVerifyDetail = (verifyCode: string) =>
  request<O2oPreorderDetail>({
    method: 'GET',
    url: `/o2o/verify/${encodeURIComponent(verifyCode)}`,
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
    url: '/o2o/inventory-logs',
    params: { limit },
  })
