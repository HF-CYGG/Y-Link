/**
 * 模块说明：src/composables/useIdempotentAction.ts
 * 文件职责：提供“单飞执行 + 重复触发拦截”的前端幂等门禁能力，统一保护登录、验证码、下单等敏感操作。
 * 维护说明：若后续要扩展为“相同参数级别幂等”，可在 actionKey 之外追加 payload 指纹维度。
 */

import { ref } from 'vue'

interface IdempotentActionOptions<T> {
  actionKey: string
  executor: () => Promise<T>
  onDuplicated?: () => void
}

/**
 * 前端敏感动作幂等门禁：
 * - 同一 actionKey 在执行中时，后续触发会被直接拦截；
 * - 执行结束（成功/失败）后自动释放门禁，不影响下一次合法提交；
 * - 适用于“按钮连续点击 + 网络抖动重触发”的重复提交防护。
 */
export const useIdempotentAction = () => {
  const inFlightActionKeys = ref<Set<string>>(new Set())

  const isRunning = (actionKey: string) => {
    return inFlightActionKeys.value.has(actionKey)
  }

  const runWithGate = async <T>(options: IdempotentActionOptions<T>): Promise<T | null> => {
    if (isRunning(options.actionKey)) {
      options.onDuplicated?.()
      return null
    }

    inFlightActionKeys.value.add(options.actionKey)
    try {
      return await options.executor()
    } finally {
      inFlightActionKeys.value.delete(options.actionKey)
    }
  }

  return {
    isRunning,
    runWithGate,
  }
}
