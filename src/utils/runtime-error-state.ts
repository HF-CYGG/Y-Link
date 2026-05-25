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
