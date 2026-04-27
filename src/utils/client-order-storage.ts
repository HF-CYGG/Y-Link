/**
 * 模块说明：src/utils/client-order-storage.ts
 * 文件职责：负责客户端订单列表快照的本地持久化与恢复，保证返回列表页时筛选状态和订单摘要口径一致。
 * 维护说明：
 * - 订单详情页、订单列表页、退货提交后的售后态刷新都会读写这里的快照；
 * - 若后端新增订单摘要字段，需要同步补齐恢复逻辑，避免刷新后退化成旧口径。
 */

import type { O2oPreorderSummary } from '@/api/modules/o2o'
import {
  getClientOrderReportScenario,
  isO2oOrderStatus,
  O2O_ORDER_BUSINESS_STATUSES,
  type ClientOrderReportScenario,
  type O2oOrderBusinessStatus,
  type O2oOrderCancelReason,
} from '@/constants/o2o-order-status'

export interface ClientOrderSnapshot {
  activeStatus: 'all' | O2oPreorderSummary['status']
  orders: O2oPreorderSummary[]
  updatedAt: number
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const CLIENT_ORDER_SNAPSHOT_KEY = 'y-link.client-order.snapshot'

const getStorage = () => {
  if (globalThis.window === undefined) {
    return null
  }
  return globalThis.window.localStorage
}

const normalizeStatusReport = (
  row: Record<string, unknown>,
  status: O2oPreorderSummary['status'],
  timeoutAt: string | null,
) => {
  const rawStatusReport = row.statusReport && typeof row.statusReport === 'object'
    ? (row.statusReport as Record<string, unknown>)
    : null
  const fallbackScenario = getClientOrderReportScenario(status, timeoutAt)
  const scenario = typeof rawStatusReport?.scenario === 'string'
    ? (rawStatusReport.scenario as ClientOrderReportScenario)
    : fallbackScenario
  const cancelReason = rawStatusReport?.cancelReason === 'manual' || rawStatusReport?.cancelReason === 'timeout'
    ? (rawStatusReport.cancelReason as O2oOrderCancelReason)
    : null
  return {
    scenario,
    cancelReason,
    timeoutReached: rawStatusReport?.timeoutReached === true,
    timeoutSoon: rawStatusReport?.timeoutSoon === true,
  }
}

// 详细注释：退货申请提交后订单可能进入 after_sale / after_sale_done 等售后态，
// 本地缓存恢复时必须继续保留该字段，避免用户刷新后列表页状态提示退化。
const normalizeBusinessStatus = (value: unknown): O2oOrderBusinessStatus | null => {
  return O2O_ORDER_BUSINESS_STATUSES.includes(value as O2oOrderBusinessStatus)
    ? (value as O2oOrderBusinessStatus)
    : null
}

// 详细注释：商家留言用于补充退货、异常处理等上下文，缓存恢复时统一裁剪空白并将空串视为 null。
const normalizeMerchantMessage = (value: unknown) => {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null
}

const normalizeClientOrderType = (value: unknown): O2oPreorderSummary['clientOrderType'] => {
  return value === 'department' ? 'department' : 'walkin'
}

const normalizeDepartmentNameSnapshot = (value: unknown) => {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null
}

const normalizeOrderRow = (item: unknown): O2oPreorderSummary | null => {
  if (!item || typeof item !== 'object') {
    return null
  }
  const row = item as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  const showNo = typeof row.showNo === 'string' ? row.showNo : ''
  const verifyCode = typeof row.verifyCode === 'string' ? row.verifyCode : ''
  const status = isO2oOrderStatus(row.status) ? row.status : null
  if (!id || !showNo || !verifyCode || !status) {
    return null
  }
  const timeoutAt = typeof row.timeoutAt === 'string' ? row.timeoutAt : null
  return {
    id,
    showNo,
    verifyCode,
    status,
    businessStatus: normalizeBusinessStatus(row.businessStatus),
    merchantMessage: normalizeMerchantMessage(row.merchantMessage),
    clientOrderType: normalizeClientOrderType(row.clientOrderType),
    departmentNameSnapshot: normalizeDepartmentNameSnapshot(row.departmentNameSnapshot),
    // 缓存恢复时尽量沿用服务端原始状态报告，确保“已撤回/超时取消”文案不会在刷新后退化。
    statusReport: normalizeStatusReport(row, status, timeoutAt),
    totalQty: Number.isFinite(row.totalQty) ? Number(row.totalQty) : 0,
    totalAmount: typeof row.totalAmount === 'string' ? row.totalAmount : undefined,
    expireInSeconds: Number.isFinite(row.expireInSeconds) ? Number(row.expireInSeconds) : undefined,
    timeoutAt,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeOrders = (orders: unknown): O2oPreorderSummary[] => {
  if (!Array.isArray(orders)) {
    return []
  }
  return orders.map(normalizeOrderRow).filter((item): item is O2oPreorderSummary => item !== null)
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
  } catch (error) {
    if (!(error instanceof Error)) {
      return null
    }
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
