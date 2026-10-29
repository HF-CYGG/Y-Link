import type { OrderRecord } from '@/api/modules/order'
export const KINGDEE_STATUS_LABELS = { not_applied: '未申请', applied_pending: '已申请待补编号', registered: '已登记', unknown: '待确认' } as const
/** 合并单逐来源展示，不用父单申请 OR 代替来源状态。 */
export function formatOrderKingdeeStatus(order: Pick<OrderRecord, 'orderType' | 'inventoryMode' | 'isSystemApplied' | 'sourcePreorderRegistrations'>): string {
  if (order.orderType !== 'department') return '不适用'
  const sources = order.sourcePreorderRegistrations ?? []
  if (sources.length > 1) return sources.map((source) => `${source.businessNo}：${KINGDEE_STATUS_LABELS[source.kingdeeStatus ?? 'unknown']}${source.kingdeeVoucherNo ? `（${source.kingdeeVoucherNo}）` : ''}`).join('；')
  if (sources.length) return `${KINGDEE_STATUS_LABELS[sources[0]!.kingdeeStatus ?? 'unknown']}${sources[0]!.kingdeeVoucherNo ? `（${sources[0]!.kingdeeVoucherNo}）` : ''}`
  return order.inventoryMode === 'o2o_preapplied' ? '待确认' : order.isSystemApplied ? '已申请' : '未申请'
}
