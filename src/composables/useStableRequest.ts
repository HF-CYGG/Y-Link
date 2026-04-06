import { onBeforeUnmount, onDeactivated } from 'vue'
import { isRequestCanceled } from '@/utils/error'

interface RunLatestOptions<T> {
  executor: (signal: AbortSignal) => Promise<T>
  onSuccess: (result: T) => void | Promise<void>
  onError?: (error: unknown) => void | Promise<void>
  onFinally?: (context: { status: 'success' | 'error' | 'canceled' }) => void | Promise<void>
}

/**
 * 稳定请求执行器：
 * - 新请求发起时自动中止上一次同类请求，避免高频筛选/切页导致结果乱序；
 * - 仅允许“最后一次有效请求”回写页面状态，保证界面最终与最近交互保持一致；
 * - 组件卸载或进入 keep-alive 非激活态时自动取消未完成请求，防止离页后仍回写旧数据。
 */
export const useStableRequest = () => {
  let activeController: AbortController | null = null
  let latestRequestId = 0

  /**
   * 主动取消当前请求：
   * - 路由切走、页面失活或发起更新请求前统一复用；
   * - 只终止当前实例下的“同一类最新请求”，不影响其它独立请求通道。
   */
  const cancel = () => {
    activeController?.abort()
    activeController = null
  }

  /**
   * 执行“仅保留最后一次结果”的异步任务：
   * - 成功、失败、取消的收尾时机由通用层统一处理；
   * - 被新请求抢占或被手动取消的任务不会再触发页面提示与 loading 收尾，避免闪烁。
   */
  const runLatest = async <T>(options: RunLatestOptions<T>) => {
    latestRequestId += 1
    const requestId = latestRequestId

    activeController?.abort()
    const controller = new AbortController()
    activeController = controller

    let status: 'success' | 'error' | 'canceled' = 'canceled'

    try {
      const result = await options.executor(controller.signal)
      if (controller.signal.aborted || requestId !== latestRequestId) {
        return
      }

      status = 'success'
      await options.onSuccess(result)
    } catch (error) {
      if (controller.signal.aborted || requestId !== latestRequestId || isRequestCanceled(error)) {
        return
      }

      status = 'error'
      await options.onError?.(error)
    } finally {
      if (activeController !== controller) {
        return
      }

      activeController = null
      await options.onFinally?.({ status })
    }
  }

  onDeactivated(cancel)
  onBeforeUnmount(cancel)

  return {
    runLatest,
    cancel,
  }
}
