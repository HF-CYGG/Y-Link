/**
 * 模块说明：src/composables/useStableRequest.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { onBeforeUnmount, onDeactivated } from 'vue'
import { isRequestCanceled } from '@/utils/error'

interface RunLatestOptions<T> {
  // executor 负责真正发起请求，并显式接收 AbortSignal，确保上层能安全取消旧请求。
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
  // 自增请求编号用于解决“旧请求比新请求更晚返回”的乱序问题。
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

    // 发起新请求前先主动终止旧请求，避免相同页面上的多次筛选/切换并发回写。
    activeController?.abort()
    const controller = new AbortController()
    activeController = controller

    let status: 'success' | 'error' | 'canceled' = 'canceled'

    try {
      const result = await options.executor(controller.signal)
      if (controller.signal.aborted || requestId !== latestRequestId) {
        // 当前结果已被更新请求淘汰，静默丢弃即可，不再回写页面。
        return
      }

      status = 'success'
      await options.onSuccess(result)
    } catch (error) {
      if (controller.signal.aborted || requestId !== latestRequestId || isRequestCanceled(error)) {
        // 取消类异常不视为真正失败，避免页面误弹错误提示。
        return
      }

      status = 'error'
      await options.onError?.(error)
    } finally {
      if (activeController !== controller) {
        // 如果 activeController 已指向更新请求，说明当前请求已过期，不再执行其 finally 收尾。
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
