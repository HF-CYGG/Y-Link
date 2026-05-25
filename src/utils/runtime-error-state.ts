/**
 * 模块说明：src/utils/runtime-error-state.ts
 * 文件职责：维护前端全局运行时错误与路由加载错误的统一状态，供管理端/客户端壳层展示可恢复错误面板。
 * 实现逻辑：
 * - 把错误分为 `global`、`management`、`client` 三个目标域，避免不同端错误互相覆盖；
 * - 统一把任意 error 归一化为 `title/message/updatedAt` 快照；
 * - 暴露只读状态给视图层，写入与清理只通过工具函数进行。
 * 维护说明：新增错误展示位时，优先复用现有 target 维度；若必须扩展 target，请同步更新路由守卫与壳层订阅逻辑。
 */

import { readonly, ref } from 'vue'

export type RuntimeErrorTarget = 'global' | 'management' | 'client'

export interface RuntimeErrorSnapshot {
  title: string
  message: string
  updatedAt: number
}

const globalError = ref<RuntimeErrorSnapshot | null>(null)
const managementRouteError = ref<RuntimeErrorSnapshot | null>(null)
const clientRouteError = ref<RuntimeErrorSnapshot | null>(null)

const normalizeErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  return fallback
}

const buildSnapshot = (title: string, error: unknown, fallbackMessage: string): RuntimeErrorSnapshot => ({
  title,
  message: normalizeErrorMessage(error, fallbackMessage),
  updatedAt: Date.now(),
})

export const reportGlobalAppError = (error: unknown, title = '应用出现异常') => {
  globalError.value = buildSnapshot(title, error, '页面运行异常，请刷新后重试')
}

export const clearGlobalAppError = () => {
  globalError.value = null
}

export const reportRouteError = (target: Exclude<RuntimeErrorTarget, 'global'>, error: unknown) => {
  const snapshot = buildSnapshot('页面加载失败', error, '页面资源加载失败，请重试或返回上一页')
  if (target === 'client') {
    clientRouteError.value = snapshot
    return
  }
  managementRouteError.value = snapshot
}

export const clearRouteError = (target: Exclude<RuntimeErrorTarget, 'global'>) => {
  if (target === 'client') {
    clientRouteError.value = null
    return
  }
  managementRouteError.value = null
}

export const runtimeErrorState = {
  globalError: readonly(globalError),
  managementRouteError: readonly(managementRouteError),
  clientRouteError: readonly(clientRouteError),
}
