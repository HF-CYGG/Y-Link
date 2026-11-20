import type { OrderRecord } from '@/api/modules/order'
export const KINGDEE_STATUS_LABELS = { not_applied: '未申请', applied_pending: '已申请待补编号', registered: '已登记', unknown: '待确认' } as const
/** 合并单逐来源展示，不用父单申请 OR 代替来源状态。 */
export function formatOrderKingdeeStatus(order: Pick<OrderRecord, 'orderType' | 'inventoryMode' | 'isSystemApplied' | 'sourcePreorderRegistrations'>): string {
  if (order.orderType !== 'department') return '不适用'
  const sources = order.sourcePreorderRegistrations ?? []
  if (sources.length > 1) return sources.map((source) => `${source.businessNo}：${KINGDEE_STATUS_LABELS[source.kingdeeStatus ?? 'unknown']}`).join('；')
  if (sources.length) return KINGDEE_STATUS_LABELS[sources[0]!.kingdeeStatus ?? 'unknown']
  return order.inventoryMode === 'o2o_preapplied' ? '待确认' : order.isSystemApplied ? '已申请' : '未申请'
}

const getSourceStatusLabel = (status: keyof typeof KINGDEE_STATUS_LABELS | null) =>
  status === null ? '不适用' : KINGDEE_STATUS_LABELS[status ?? 'unknown']

/** 合并父单按原单顺序显示父单及子单，线上登记只匹配对应的原单。 */
export function getOrderKingdeeStatusLines(
  order: Parameters<typeof formatOrderKingdeeStatus>[0] & Partial<Pick<OrderRecord, 'id' | 'businessNo' | 'merge'>>,
): string[] {
  const sources = order.sourcePreorderRegistrations ?? []
  const { id, businessNo, merge, orderType, inventoryMode, isSystemApplied } = order
  if (merge?.role === 'parent' && merge.children.length && id && businessNo) {
    const registrationsByOrderId = new Map(sources.map((source) => [source.sourceOrderId, source]))
    const members = [{ id, businessNo, orderType, inventoryMode, isSystemApplied }, ...merge.children]
    return members.map((member) => {
      const registration = registrationsByOrderId.get(member.id)
      const label = registration ? getSourceStatusLabel(registration.kingdeeStatus) : formatOrderKingdeeStatus(member)
      return `${member.businessNo}：${label}`
    })
  }
  if (sources.length > 1) {
    return sources.map((source) => `${source.businessNo}：${getSourceStatusLabel(source.kingdeeStatus)}`)
  }
  return [formatOrderKingdeeStatus(order)]
}
