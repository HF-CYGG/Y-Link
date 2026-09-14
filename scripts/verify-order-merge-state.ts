/**
 * Issue #71 合并冲突状态机验证：必须消费统一 AppRequestError.status，不能依赖 Axios response。
 */
import { AppRequestError } from '../src/utils/error'
import {
  canCommitOrderMerge,
  invalidateOrderMergePreviewRequestState,
  isOrderMergePreviewRequestPending,
  resolveOrderMergeConflictState,
  settleOrderMergePreviewRequest,
  startOrderMergePreviewRequest,
  type OrderMergePreviewState,
} from '../src/views/order-list/order-merge-state'

const readyState: OrderMergePreviewState = {
  preview: { ready: true },
  idempotencyKey: 'merge-preview-key',
}
const conflict = new AppRequestError('版本冲突', { status: 409 })
;(conflict as unknown as { response: { status: number } }).response = { status: 500 }
const invalidated = resolveOrderMergeConflictState(conflict, readyState)

if (invalidated.preview !== null) throw new Error('409 冲突后预检结果必须清空')
if (invalidated.idempotencyKey !== '') throw new Error('409 冲突后幂等键必须清空')
if (canCommitOrderMerge(invalidated, false)) throw new Error('预检为空时确认合并必须禁用')

const nonConflict = resolveOrderMergeConflictState(new AppRequestError('普通失败', { status: 400 }), readyState)
if (nonConflict !== readyState) throw new Error('非 409 错误不得清空预检状态')
if (!canCommitOrderMerge(nonConflict, false)) throw new Error('ready 预检在非提交中应允许确认')

const activeRequest = {
  latestRequestVersion: 4,
  activeRequestVersion: 4,
}
const invalidatedRequest = invalidateOrderMergePreviewRequestState(activeRequest)
if (isOrderMergePreviewRequestPending(invalidatedRequest)) {
  throw new Error('修改目标或原因废弃预检后，旧请求没有接管者时必须释放 loading')
}

const nextRequest = startOrderMergePreviewRequest(invalidatedRequest)
if (!isOrderMergePreviewRequestPending(nextRequest.state)) {
  throw new Error('新预检开始后必须进入 loading')
}
const afterOldRequestSettles = settleOrderMergePreviewRequest(nextRequest.state, 4)
if (!isOrderMergePreviewRequestPending(afterOldRequestSettles)) {
  throw new Error('旧预检完成不得释放已接管的新预检 loading')
}
const afterCurrentRequestSettles = settleOrderMergePreviewRequest(afterOldRequestSettles, nextRequest.requestVersion)
if (isOrderMergePreviewRequestPending(afterCurrentRequestSettles)) {
  throw new Error('当前预检完成后必须释放 loading')
}

console.log('Issue #71 订单合并冲突状态机验证通过。')
