import type { O2oPreorderSummary } from '@/api/modules/o2o'

export interface ClientOrderSnapshot {
  activeStatus: 'all' | O2oPreorderSummary['status']
  orders: O2oPreorderSummary[]
  updatedAt: number
}

const CLIENT_ORDER_SNAPSHOT_KEY = 'y-link.client-order.snapshot'

const getStorage = () => {
  if (typeof globalThis.window === 'undefined') {
    return null
  }
  return globalThis.window.localStorage
}

const normalizeOrders = (orders: unknown): O2oPreorderSummary[] => {
  if (!Array.isArray(orders)) {
    return []
  }
  return orders
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }
      const row = item as Record<string, unknown>
      const id = typeof row.id === 'string' ? row.id : ''
      const showNo = typeof row.showNo === 'string' ? row.showNo : ''
      const verifyCode = typeof row.verifyCode === 'string' ? row.verifyCode : ''
      const status = row.status === 'verified' || row.status === 'cancelled' ? row.status : row.status === 'pending' ? 'pending' : null
      if (!id || !showNo || !verifyCode || !status) {
        return null
      }
      return {
        id,
        showNo,
        verifyCode,
        status,
        totalQty: Number.isFinite(row.totalQty) ? Number(row.totalQty) : 0,
        timeoutAt: typeof row.timeoutAt === 'string' ? row.timeoutAt : null,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      } satisfies O2oPreorderSummary
    })
    .filter((item): item is O2oPreorderSummary => item !== null)
}

export const readPersistedClientOrderSnapshot = (): ClientOrderSnapshot | null => {
  const storage = getStorage()
  if (!storage) {
    return null
  }
  const raw = storage.getItem(CLIENT_ORDER_SNAPSHOT_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const activeStatus =
      parsed.activeStatus === 'pending' || parsed.activeStatus === 'verified' || parsed.activeStatus === 'cancelled' ? parsed.activeStatus : 'all'
    return {
      activeStatus,
      orders: normalizeOrders(parsed.orders),
      updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : 0,
    }
  } catch (_error) {
    storage.removeItem(CLIENT_ORDER_SNAPSHOT_KEY)
    return null
  }
}

export const persistClientOrderSnapshot = (snapshot: ClientOrderSnapshot) => {
  const storage = getStorage()
  if (!storage) {
    return
  }
  storage.setItem(CLIENT_ORDER_SNAPSHOT_KEY, JSON.stringify(snapshot))
}
