import type { O2oOrderStatus, O2oReturnRequestStatus } from './o2o-status.ts'

export interface O2oReturnRequestItem {
  id: string
  productId: string
  skuId: string | null
  productCode: string
  productName: string
  skuCode: string | null
  specText: string | null
  qty: number
}

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

export interface SubmitO2oReturnRequestPayload {
  reason: string
  items: Array<{
    productId: string | number
    skuId?: string | number | null
    qty: number
  }>
}
