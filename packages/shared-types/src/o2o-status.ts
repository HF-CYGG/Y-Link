export type O2oOrderStatus = 'pending' | 'verified' | 'cancelled'

export type O2oOrderBusinessStatus =
  | 'preparing'
  | 'ready'
  | 'awaiting_shipment'
  | 'shipped'
  | 'partially_shipped'
  | 'closed'
  | 'completed'
  | 'after_sale'
  | 'after_sale_done'
  | 'verifying'
  | 'verify_failed'

export type O2oClientOrderType = 'department' | 'walkin'
export type O2oOrderCancelReason = 'timeout' | 'manual'
export type ClientOrderReportScenario =
  | 'pending'
  | 'timeout_soon'
  | 'cancelled'
  | 'timeout_cancelled'
  | 'verified'

export interface O2oOrderStatusReport {
  scenario: ClientOrderReportScenario
  cancelReason: O2oOrderCancelReason | null
  timeoutReached: boolean
  timeoutSoon: boolean
}

export type O2oReturnRequestStatus = 'pending' | 'verified' | 'rejected'
