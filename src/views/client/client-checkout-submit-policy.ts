/**
 * 模块说明：src/views/client/client-checkout-submit-policy.ts
 * 文件职责：为客户端结算页归一化“最新目录校验、结果未知幂等重试、新提交”的提交决策。
 * 实现逻辑：
 * - 目录刷新失败时统一阻断，避免新订单依赖过期库存快照；
 * - 仅完全相同的未决意图可复用原 requestKey 与点击时冻结的 payload，交给服务端幂等层回查原单；
 * - 任何不同意图都不能用新 key 越过未决订单，新订单只接受刷新后的无冲突快照。
 * 维护说明：本文件不负责发请求、落锁或弹窗；调用方必须把 `new_submit` 才交给创建新锁的流程。
 */

export interface ClientCheckoutSubmitItem {
  productId: string
  skuId: string | null
  qty: number
}

export interface ActiveClientCheckoutSubmitLock {
  intentKey: string
  requestKey: string
}

export type ClientCheckoutSubmitDecision =
  | { type: 'blocked'; reason: 'refresh_failed' | 'pending_intent_changed' | 'selected_conflicts' | 'empty_snapshot' | 'selection_changed_after_refresh' }
  | { type: 'retry_pending'; items: ClientCheckoutSubmitItem[]; intentKey: string; requestKey: string }
  | { type: 'new_submit'; items: ClientCheckoutSubmitItem[]; intentKey: string }

export const decideClientCheckoutSubmit = ({
  refreshSucceeded,
  requestedItems,
  requestedIntentKey,
  activeSubmitLock,
  selectedConflictCount,
  freshItems,
  freshIntentKey,
}: {
  refreshSucceeded: boolean
  requestedItems: ClientCheckoutSubmitItem[]
  requestedIntentKey: string
  activeSubmitLock: ActiveClientCheckoutSubmitLock | null
  selectedConflictCount: number
  freshItems: ClientCheckoutSubmitItem[] | null
  freshIntentKey: string | null
}): ClientCheckoutSubmitDecision => {
  if (!refreshSucceeded) {
    return { type: 'blocked', reason: 'refresh_failed' }
  }

  if (activeSubmitLock) {
    if (activeSubmitLock.intentKey !== requestedIntentKey) {
      return { type: 'blocked', reason: 'pending_intent_changed' }
    }
    return {
      type: 'retry_pending',
      items: requestedItems,
      intentKey: requestedIntentKey,
      requestKey: activeSubmitLock.requestKey,
    }
  }

  if (selectedConflictCount > 0) {
    return { type: 'blocked', reason: 'selected_conflicts' }
  }
  if (!freshItems?.length || !freshIntentKey) {
    return { type: 'blocked', reason: 'empty_snapshot' }
  }
  if (freshIntentKey !== requestedIntentKey) {
    return { type: 'blocked', reason: 'selection_changed_after_refresh' }
  }
  return {
    type: 'new_submit',
    // 目录校验确认意图未变后，仍使用点击时冻结的 payload，避免 await 期间的状态回写改写本次操作。
    items: requestedItems,
    intentKey: requestedIntentKey,
  }
}
