/** 退货提交成功后同步已确认申请及明细待退数量；口径与后端一致，仅累计 pending。 */
import type { O2oPreorderDetail, O2oReturnRequestDetail } from '@/api/modules/o2o'

export const applyConfirmedReturnRequest = <T extends Pick<O2oPreorderDetail, 'items' | 'returnRequests'>>(
  detail: T,
  confirmed: O2oReturnRequestDetail,
): T => {
  // 回读可能先于提交响应到达，同一申请只保留一份。
  const returnRequests = [confirmed, ...detail.returnRequests.filter((request) => request.id !== confirmed.id)]
  const pending = new Map<string, number>()
  const key = (item: { productId: string; skuId: string | null }) => JSON.stringify([item.productId, item.skuId])
  for (const request of returnRequests) {
    if (request.status !== 'pending') continue
    for (const item of request.items) {
      const id = key(item)
      pending.set(id, (pending.get(id) ?? 0) + Math.max(0, item.qty))
    }
  }
  return {
    ...detail,
    returnRequests,
    items: detail.items.map((item) => {
      const returnedQty = Math.min(item.qty, pending.get(key(item)) ?? 0)
      return { ...item, returnedQty, availableReturnQty: Math.max(0, item.qty - returnedQty) }
    }),
  }
}
