/** 管理端领取人只读显示：按正式来源单保留顺序与缺失项，不按姓名去重。 */
import type { OrderRecord, OrderDetailResult } from '@/api/modules/order'
type OrderMergeOrderReference = OrderRecord['merge']['children'][number]
type RecipientOrder = Pick<OrderRecord, 'id' | 'orderType' | 'customerName' | 'customerDepartmentName' | 'inventoryMode' | 'sourceDocType'> & {
  merge?: OrderRecord['merge']
  sourcePreorderPickupContacts?: OrderRecord['sourcePreorderPickupContacts']
  sourcePreorderPickups?: OrderDetailResult['sourcePreorderPickups']
}
const isOnline = (order: Pick<RecipientOrder, 'sourceDocType' | 'inventoryMode'>) => order.sourceDocType === 'o2o_preorder' || order.inventoryMode === 'o2o_preapplied'
export const formatOrderRecipient = (order: RecipientOrder, member?: OrderMergeOrderReference): string => {
  const subject = member ?? order
  if (!isOnline(subject)) return subject.orderType === 'department'
    ? subject.customerDepartmentName || subject.customerName || '-'
    : subject.customerName || subject.customerDepartmentName || '-'
  const records = order.sourcePreorderPickups ?? order.sourcePreorderPickupContacts ?? []
  const lookup = new Map(records.map((entry) => [entry.sourceOrderId, entry.pickupContact]))
  const sources = member ? [member] : [order, ...(order.merge?.role === 'parent' ? order.merge.children : [])]
  return sources.filter(isOnline).map((source) => lookup.get(source.id)?.trim() || '未记录').join('、') || '未记录'
}
