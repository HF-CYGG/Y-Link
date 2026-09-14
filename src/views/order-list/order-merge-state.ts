/**
 * 模块说明：订单合并预检状态机。
 * 文件职责：集中处理预检失效、409 版本冲突与确认按钮可用性，避免 Dialog 直接依赖 Axios 异常结构。
 * 维护说明：状态码必须经 normalizeRequestError 读取；request 层抛出的 AppRequestError 不保证保留 response。
 */
import type { OrderMergePreviewResult } from '../../../packages/shared-types/src/orders'
import { normalizeRequestError } from '@/utils/error'

export interface OrderMergePreviewState<TPreview extends Pick<OrderMergePreviewResult, 'ready'> = Pick<OrderMergePreviewResult, 'ready'>> {
  preview: TPreview | null
  idempotencyKey: string
}

export const invalidateOrderMergePreviewState = <TPreview extends Pick<OrderMergePreviewResult, 'ready'>>(
  currentState: OrderMergePreviewState<TPreview>,
): OrderMergePreviewState<TPreview> => ({
  ...currentState,
  preview: null,
  idempotencyKey: '',
})

export const resolveOrderMergeConflictState = <TPreview extends Pick<OrderMergePreviewResult, 'ready'>>(
  error: unknown,
  currentState: OrderMergePreviewState<TPreview>,
): OrderMergePreviewState<TPreview> => {
  return normalizeRequestError(error).status === 409
    ? invalidateOrderMergePreviewState(currentState)
    : currentState
}

export const canCommitOrderMerge = <TPreview extends Pick<OrderMergePreviewResult, 'ready'>>(
  state: OrderMergePreviewState<TPreview>,
  committing: boolean,
) => {
  return Boolean(state.preview?.ready) && !committing
}
