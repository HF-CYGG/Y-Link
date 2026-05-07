/**
 * 模块说明：src/utils/client-order-refresh.ts
 * 文件职责：提供客户端订单状态变更的共享广播与订阅能力，供客户端列表、详情与门店核销台复用。
 * 实现逻辑：
 * - 统一通过浏览器 `CustomEvent` 在当前页面广播订单变更，保证同标签页内不同模块能立即感知；
 * - 同时把最新事件写入 `localStorage`，借助 `storage` 事件让其它标签页也能收到刷新信号；
 * - 订阅方只关心“收到订单变更事件”这一件事，具体是刷新详情还是列表，由页面按自身上下文决定。
 * 维护说明：
 * - 若后续需要细分更多订单变更原因，只需在 `ClientOrderRefreshReason` 中补齐枚举即可；
 * - 本工具只负责广播信号，不直接发请求，避免共享层与具体业务接口耦合。
 */

export type ClientOrderRefreshReason =
  | 'verified'
  | 'return_verified'
  | 'cancelled'
  | 'updated'
  | 'return_requested'
  | 'compliance_updated'

export interface ClientOrderRefreshEventDetail {
  orderId: string
  reason: ClientOrderRefreshReason
  eventAt: number
}

const CLIENT_ORDER_REFRESH_EVENT_NAME = 'y-link:client-order-refresh'
const CLIENT_ORDER_REFRESH_STORAGE_KEY = 'y-link.client-order.refresh'

const normalizeOrderId = (value: unknown) => {
  return typeof value === 'string' ? value.trim() : ''
}

const normalizeRefreshReason = (value: unknown): ClientOrderRefreshReason => {
  switch (value) {
    case 'verified':
    case 'return_verified':
    case 'cancelled':
    case 'updated':
    case 'return_requested':
    case 'compliance_updated':
      return value
    default:
      return 'updated'
  }
}

const normalizeRefreshDetail = (value: unknown): ClientOrderRefreshEventDetail | null => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  return {
    orderId: normalizeOrderId(candidate.orderId),
    reason: normalizeRefreshReason(candidate.reason),
    eventAt: Number.isFinite(candidate.eventAt) ? Number(candidate.eventAt) : Date.now(),
  }
}

const dispatchRefreshEvent = (detail: ClientOrderRefreshEventDetail) => {
  if (globalThis.window === undefined) {
    return
  }
  globalThis.window.dispatchEvent(
    new CustomEvent<ClientOrderRefreshEventDetail>(CLIENT_ORDER_REFRESH_EVENT_NAME, {
      detail,
    }),
  )
}

export const notifyClientOrderRefresh = (payload: { orderId?: string | null; reason: ClientOrderRefreshReason }) => {
  if (globalThis.window === undefined) {
    return
  }

  const detail: ClientOrderRefreshEventDetail = {
    orderId: normalizeOrderId(payload.orderId),
    reason: payload.reason,
    eventAt: Date.now(),
  }

  dispatchRefreshEvent(detail)

  try {
    globalThis.window.localStorage.setItem(CLIENT_ORDER_REFRESH_STORAGE_KEY, JSON.stringify(detail))
  } catch {
    // 详细注释：本地存储写入失败时，至少保留当前标签页内的即时广播，不阻断主业务流程。
  }
}

export const subscribeClientOrderRefresh = (
  listener: (detail: ClientOrderRefreshEventDetail) => void | Promise<void>,
) => {
  if (globalThis.window === undefined) {
    return () => undefined
  }

  const handleWindowEvent = (event: Event) => {
    const customEvent = event as CustomEvent<ClientOrderRefreshEventDetail>
    const detail = normalizeRefreshDetail(customEvent.detail)
    if (!detail) {
      return
    }
    void listener(detail)
  }

  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key !== CLIENT_ORDER_REFRESH_STORAGE_KEY || !event.newValue) {
      return
    }
    try {
      const parsed = JSON.parse(event.newValue) as unknown
      const detail = normalizeRefreshDetail(parsed)
      if (!detail) {
        return
      }
      void listener(detail)
    } catch {
      // 详细注释：外部标签页若写入了损坏值，这里直接忽略，避免把异常扩散到页面层。
    }
  }

  globalThis.window.addEventListener(CLIENT_ORDER_REFRESH_EVENT_NAME, handleWindowEvent as EventListener)
  globalThis.window.addEventListener('storage', handleStorageEvent)

  return () => {
    globalThis.window?.removeEventListener(CLIENT_ORDER_REFRESH_EVENT_NAME, handleWindowEvent as EventListener)
    globalThis.window?.removeEventListener('storage', handleStorageEvent)
  }
}
