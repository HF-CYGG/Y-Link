/** 金蝶登记只以原预订单为真源，历史未选择记录不得按日期猜测。 */
import { BizError } from './errors.js'
export type KingdeeStatus = 'not_applied' | 'applied_pending' | 'registered' | 'unknown'
export function normalizeKingdeeVoucherNo(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new BizError('金蝶单据编号不能包含控制字符', 400)
  const normalized = value.trim()
  if ([...normalized].length > 128) throw new BizError('金蝶单据编号最多 128 个字符', 400)
  return normalized || null
}
export function kingdeeRegistrationView(order: { clientOrderType: string; kingdeeVoucherNo?: string | null; kingdeeVersion?: number; isSystemApplied: boolean; isDeleted?: boolean; status: string; timeoutAt?: Date | null }) {
  const kingdeeVoucherNo = normalizeKingdeeVoucherNo(order.kingdeeVoucherNo)
  const kingdeeVersion = Number(order.kingdeeVersion ?? 0)
  const kingdeeStatus: KingdeeStatus | null = order.clientOrderType !== 'department' ? null
    : kingdeeVoucherNo ? 'registered' : order.isSystemApplied ? 'applied_pending' : kingdeeVersion > 0 ? 'not_applied' : 'unknown'
  const kingdeeEditable = order.clientOrderType === 'department' && !order.isDeleted
    && (order.status === 'verified' || (order.status === 'pending' && (!order.timeoutAt || order.timeoutAt.getTime() > Date.now())))
  return { kingdeeVoucherNo, kingdeeVersion, kingdeeStatus, kingdeeEditable }
}
