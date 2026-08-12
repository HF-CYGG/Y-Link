import type { PaginationListResult, PaginationQueryInput } from './common.ts'
import type { O2oMallStorefrontConfig } from './catalog.ts'
import type {
  O2oClientOrderType,
  O2oOrderBusinessStatus,
  O2oOrderStatus,
  O2oOrderStatusReport,
  O2oReturnRequestStatus,
} from './o2o-status.ts'
import type { O2oReturnRequestDetail } from './returns.ts'

export interface O2oLatestReturnRequestSummary {
  id: string
  returnNo: string
  status: O2oReturnRequestStatus
  createdAt: string
  handledAt: string | null
  rejectedReason: string | null
}

export interface O2oPreorderSummary {
  statusReport: O2oOrderStatusReport
  totalAmount: string
  expireInSeconds: number
  id: string
  showNo: string
  customerOrderShowNo: string | null
  verifyCode: string
  status: O2oOrderStatus
  businessStatus: O2oOrderBusinessStatus | null
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  merchantMessage: string | null
  clientOrderType: O2oClientOrderType
  departmentNameSnapshot: string | null
  staffNoSnapshot: string | null
  returnRequestCount: number
  pendingReturnRequestCount: number
  latestReturnRequest: O2oLatestReturnRequestSummary | null
  totalQty: number
  timeoutAt: string | null
  createdAt: string
}

export interface O2oMyOrderListQuery extends PaginationQueryInput {
  status?: O2oOrderStatus
  keyword?: string
}

export type O2oMyOrderListResult = PaginationListResult<O2oPreorderSummary>

export interface O2oPreorderDetailItem {
  id: string
  productId: string
  skuId: string | null
  productCode: string
  productName: string
  skuCode: string | null
  specText: string | null
  skuImage: string | null
  defaultPrice: string
  originalPrice: string
  discountRate: string
  discountedPrice: string
  unitPrice: string
  lineAmount: string
  qty: number
  returnedQty: number
  availableReturnQty: number
  subTotal: string
}

export interface O2oPreorderDetailOrder {
  statusReport: O2oOrderStatusReport
  totalAmount: string
  expireInSeconds: number
  id: string
  showNo: string
  customerOrderShowNo: string | null
  verifyCode: string
  status: O2oOrderStatus
  businessStatus: O2oOrderBusinessStatus | null
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  pickupContact: string | null
  merchantMessage: string | null
  clientOrderType: O2oClientOrderType
  departmentNameSnapshot: string | null
  staffNoSnapshot: string | null
  remark: string | null
  updateCount: number
  remainingUpdateCount: number
  maxUpdateCount: number
  totalQty: number
  timeoutAt: string | null
  verifiedAt: string | null
  createdAt: string
}

export interface O2oPreorderCustomerProfile {
  id: string
  username: string
  realName: string
  mobile: string | null
  email: string | null
  departmentName: string | null
  accountType: 'personal' | 'department'
  staffNo: string | null
}

export interface O2oPreorderAmountSummary {
  totalAmount: string
  totalQty: number
  totalItemCount: number
}

export interface O2oPreorderDetail {
  order: O2oPreorderDetailOrder
  customerProfile: O2oPreorderCustomerProfile | null
  items: O2oPreorderDetailItem[]
  returnRequests: O2oReturnRequestDetail[]
  amountSummary: O2oPreorderAmountSummary
  storefront: O2oMallStorefrontConfig
  qrPayload: string
}

export interface SubmitO2oPreorderPayload {
  /** 同一次下单及其弱网重试必须复用同一请求键。 */
  clientRequestId: string
  isSystemApplied: boolean
  pickupContact: string
  remark?: string
  items: Array<{
    productId: string | number
    skuId?: string | number | null
    qty: number
  }>
}

export interface UpdateMyO2oPreorderPayload {
  remark?: string
  items: Array<{
    productId: string | number
    skuId?: string | number | null
    qty: number
  }>
}
