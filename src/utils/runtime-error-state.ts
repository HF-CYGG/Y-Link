/**
 * 模块说明：src/utils/runtime-error-state.ts
 * 文件职责：集中维护前端运行时错误的页面级兜底状态，供入口、路由和布局壳层统一消费。
 * 实现逻辑：
 * - 将运行时错误按管理端/客户端两条链路收口，避免异常信息散落在各页面组件内；
 * - 仅对真正需要用户感知的异常写入页面兜底状态，忽略类异常继续由分类器过滤；
 * - 布局层通过响应式状态直接展示错误兜底页，路由切换前再显式清空旧错误。
 * 维护说明：
 * - 若后续扩展更多运行时异常展示位，优先在此文件补充分流逻辑，而不是在页面里各自维护一份状态；
 * - 文案必须保持最终用户可理解，不要泄露内部异常分类、技术标签或调试细节。
 */

import { computed, ref } from 'vue'
import type { RuntimeErrorClassification } from '@/utils/runtime-error-guard'

export type RuntimeRouteScope = 'management' | 'client'

export interface RouteRuntimeErrorState {
  scope: RuntimeRouteScope
  title: string
  message: string
  occurredAt: number
  reason: string
}

const managementRouteError = ref<RouteRuntimeErrorState | null>(null)
const clientRouteError = ref<RouteRuntimeErrorState | null>(null)
const latestGlobalAppErrorScope = ref<string | null>(null)

const buildRouteErrorTitle = (classification: RuntimeErrorClassification) => {
  if (classification.category === 'chunk-stale') {
    return '页面资源已更新'
  }
  return '页面暂时无法打开'
}

const buildRouteErrorMessage = (classification: RuntimeErrorClassification) => {
  if (classification.category === 'chunk-stale') {
    return '检测到页面资源已经更新，请重新加载当前页面后再继续操作。'
  }
  return '当前页面在加载过程中遇到异常，你可以重试当前页面，或先返回首页后重新进入。'
}

const resolveRouteScope = (scope: string): RuntimeRouteScope => {
  return scope.startsWith('router:/client') || scope.includes('/client') ? 'client' : 'management'
}

const assignRouteError = (scope: RuntimeRouteScope, classification: RuntimeErrorClassification) => {
  if (classification.category === 'ignore') {
    return
  }

  const nextState: RouteRuntimeErrorState = {
    scope,
    title: buildRouteErrorTitle(classification),
    message: buildRouteErrorMessage(classification),
    occurredAt: Date.now(),
    reason: classification.reason,
  }

  if (scope === 'client') {
    clientRouteError.value = nextState
    return
  }

  managementRouteError.value = nextState
}

export const reportGlobalAppError = (
  scope: string,
  classification: RuntimeErrorClassification,
  _detail?: unknown,
) => {
  if (classification.category === 'ignore') {
    return
  }

  latestGlobalAppErrorScope.value = scope
  assignRouteError(resolveRouteScope(scope), classification)
}

export const clearRouteError = (scope: RuntimeRouteScope | 'all') => {
  if (scope === 'all' || scope === 'management') {
    managementRouteError.value = null
  }
  if (scope === 'all' || scope === 'client') {
    clientRouteError.value = null
  }
}

export const runtimeErrorState = {
  managementRouteError,
  clientRouteError,
  latestGlobalAppErrorScope,
  hasRouteError: computed(() => Boolean(managementRouteError.value || clientRouteError.value)),
}
