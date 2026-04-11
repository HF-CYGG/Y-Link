/**
 * 模块说明：src/utils/client-order-storage.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { O2oPreorderSummary } from '@/api/modules/o2o'
import { getClientOrderReportScenario, isO2oOrderStatus } from '@/constants/o2o-order-status'

export interface ClientOrderSnapshot {
  activeStatus: 'all' | O2oPreorderSummary['status']
  orders: O2oPreorderSummary[]
  updatedAt: number
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const CLIENT_ORDER_SNAPSHOT_KEY = 'y-link.client-order.snapshot'

const getStorage = () => {
  if (typeof globalThis.window === 'undefined') {
    return null
  }
  return globalThis.window.localStorage
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeOrders = (orders: unknown): O2oPreorderSummary[] => {
  if (!Array.isArray(orders)) {
    return []
  }
  const normalized = orders.map((item): O2oPreorderSummary | null => {
      if (!item || typeof item !== 'object') {
        return null
      }
      const row = item as Record<string, unknown>
      const id = typeof row.id === 'string' ? row.id : ''
      const showNo = typeof row.showNo === 'string' ? row.showNo : ''
      const verifyCode = typeof row.verifyCode === 'string' ? row.verifyCode : ''
      const status = isO2oOrderStatus(row.status) ? row.status : null
      const timeoutAt = typeof row.timeoutAt === 'string' ? row.timeoutAt : null
      if (!id || !showNo || !verifyCode || !status) {
        return null
      }
      return {
        id,
        showNo,
        verifyCode,
        status,
        statusReport: {
          scenario: getClientOrderReportScenario(status, timeoutAt),
          cancelReason: null,
          timeoutReached: false,
          timeoutSoon: false,
        },
        totalQty: Number.isFinite(row.totalQty) ? Number(row.totalQty) : 0,
        timeoutAt,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
      }
    })
  return normalized.filter((item): item is O2oPreorderSummary => item !== null)
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
    const activeStatus = isO2oOrderStatus(parsed.activeStatus) ? parsed.activeStatus : 'all'
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
