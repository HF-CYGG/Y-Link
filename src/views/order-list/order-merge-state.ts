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

/**
 * 预检请求所有权：字段变化会废弃正在等待的结果；只有当前持有者完成时才可解除 loading。
 */
export interface OrderMergePreviewRequestState {
  latestRequestVersion: number
  activeRequestVersion: number | null
}

export const invalidateOrderMergePreviewRequestState = (
  currentState: OrderMergePreviewRequestState,
): OrderMergePreviewRequestState => ({
  latestRequestVersion: currentState.latestRequestVersion + 1,
  activeRequestVersion: null,
})

export const startOrderMergePreviewRequest = (
  currentState: OrderMergePreviewRequestState,
): { requestVersion: number; state: OrderMergePreviewRequestState } => {
  const requestVersion = currentState.latestRequestVersion + 1
  return {
    requestVersion,
    state: {
      latestRequestVersion: requestVersion,
      activeRequestVersion: requestVersion,
    },
  }
}

export const settleOrderMergePreviewRequest = (
  currentState: OrderMergePreviewRequestState,
  requestVersion: number,
): OrderMergePreviewRequestState => {
  if (currentState.activeRequestVersion !== requestVersion) return currentState
  return {
    ...currentState,
    activeRequestVersion: null,
  }
}

export const isOrderMergePreviewRequestPending = (state: OrderMergePreviewRequestState) => {
  return state.activeRequestVersion !== null
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
