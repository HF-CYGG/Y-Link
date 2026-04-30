/**
 * 模块说明：src/utils/client-order-storage.ts
 * 文件职责：负责客户端“我的订单”列表快照的本地持久化、按用户隔离恢复与退出清理。
 * 实现逻辑：
 * - 每个客户端账号使用独立的 localStorage key，避免不同 clientUserId 之间复用同一份订单缓存而串号；
 * - 快照除订单摘要外，还会保存当前状态筛选、关键词、分页进度与总数，保证返回列表页时上下文完整恢复；
 * - 升级后会主动清理历史遗留的全局缓存 key，防止旧版本缓存继续污染新版本读取结果。
 * 维护说明：
 * - 订单详情页、订单列表页、退货提交后的售后态刷新都会读写这里的快照；
 * - 若后端新增订单摘要字段或前端新增列表查询条件，需要同步补齐恢复逻辑，避免刷新后退化成旧口径。
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
  keyword: string
  orders: O2oPreorderSummary[]
  page: number
  pageSize: number
  total: number
  updatedAt: number
}

// 详细注释：
// - 历史版本只使用单一全局 key，会导致不同客户端账号读取到同一份订单缓存；
// - 新版本改为“前缀 + clientUserId”分片存储；
// - 同时保留 legacy key，便于升级时统一清理旧数据。
const CLIENT_ORDER_SNAPSHOT_KEY_PREFIX = 'y-link.client-order.snapshot'
const LEGACY_CLIENT_ORDER_SNAPSHOT_KEY = 'y-link.client-order.snapshot'

const getStorage = () => {
  if (globalThis.window === undefined) {
    return null
  }
  return globalThis.window.localStorage
}

const normalizeClientUserId = (value: unknown) => {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : ''
}

const getSnapshotKey = (clientUserId: string) => {
  return `${CLIENT_ORDER_SNAPSHOT_KEY_PREFIX}:${clientUserId}`
}

const clearLegacySnapshotIfNeeded = (storage: Storage) => {
  storage.removeItem(LEGACY_CLIENT_ORDER_SNAPSHOT_KEY)
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
  return normalizeOptionalTrimmedText(value)
}

const normalizeClientOrderType = (value: unknown): O2oPreorderSummary['clientOrderType'] => {
  return value === 'department' ? 'department' : 'walkin'
}

const normalizeDepartmentNameSnapshot = (value: unknown) => {
  return normalizeOptionalTrimmedText(value)
}

// 详细注释：分页相关字段只允许回填为有效整数，避免 localStorage 被污染后把负数或 NaN 带回页面状态。
const normalizePositiveInteger = (value: unknown, fallback: number) => {
  const normalizedValue = Number(value)
  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    return fallback
  }
  return normalizedValue
}

// 详细注释：总数允许为 0，但不允许为负数或 NaN，避免“还有更多”判断失真。
const normalizeNonNegativeInteger = (value: unknown, fallback = 0) => {
  const normalizedValue = Number(value)
  if (!Number.isInteger(normalizedValue) || normalizedValue < 0) {
    return fallback
  }
  return normalizedValue
}

const normalizeKeyword = (value: unknown) => {
  return typeof value === 'string'
    ? value.trim()
    : ''
}

const normalizeStringField = (value: unknown, fallback = '') => {
  return typeof value === 'string' ? value : fallback
}

// 详细注释：统一收敛“可为空的文本快照”恢复规则，避免多个字段各自复制相同的裁剪与空值判断逻辑。
const normalizeOptionalTrimmedText = (value: unknown) => {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null
}

const normalizeLatestReturnRequest = (value: unknown): O2oPreorderSummary['latestReturnRequest'] => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const latestReturnRequest = value as Record<string, unknown>
  return {
    id: normalizeStringField(latestReturnRequest.id),
    returnNo: normalizeStringField(latestReturnRequest.returnNo),
    status:
      latestReturnRequest.status === 'verified' || latestReturnRequest.status === 'rejected'
        ? latestReturnRequest.status
        : 'pending',
    createdAt: normalizeStringField(latestReturnRequest.createdAt),
    handledAt: typeof latestReturnRequest.handledAt === 'string' ? latestReturnRequest.handledAt : null,
    rejectedReason: typeof latestReturnRequest.rejectedReason === 'string' ? latestReturnRequest.rejectedReason : null,
  }
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
    returnRequestCount: Number.isFinite(row.returnRequestCount) ? Number(row.returnRequestCount) : 0,
    pendingReturnRequestCount: Number.isFinite(row.pendingReturnRequestCount) ? Number(row.pendingReturnRequestCount) : 0,
    latestReturnRequest: normalizeLatestReturnRequest(row.latestReturnRequest),
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

export const readPersistedClientOrderSnapshot = (clientUserId: string): ClientOrderSnapshot | null => {
  const storage = getStorage()
  if (!storage) {
    return null
  }
  const normalizedClientUserId = normalizeClientUserId(clientUserId)
  clearLegacySnapshotIfNeeded(storage)
  if (!normalizedClientUserId) {
    return null
  }
  const raw = storage.getItem(getSnapshotKey(normalizedClientUserId))
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const activeStatus = isO2oOrderStatus(parsed.activeStatus) ? parsed.activeStatus : 'all'
    return {
      activeStatus,
      keyword: normalizeKeyword(parsed.keyword),
      orders: normalizeOrders(parsed.orders),
      page: normalizePositiveInteger(parsed.page, 1),
      pageSize: normalizePositiveInteger(parsed.pageSize, 20),
      total: normalizeNonNegativeInteger(parsed.total),
      updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : 0,
    }
  } catch (error) {
    if (!(error instanceof Error)) {
      return null
    }
    storage.removeItem(getSnapshotKey(normalizedClientUserId))
    return null
  }
}

export const persistClientOrderSnapshot = (clientUserId: string, snapshot: ClientOrderSnapshot) => {
  const storage = getStorage()
  if (!storage) {
    return
  }
  const normalizedClientUserId = normalizeClientUserId(clientUserId)
  if (!normalizedClientUserId) {
    return
  }
  clearLegacySnapshotIfNeeded(storage)
  storage.setItem(getSnapshotKey(normalizedClientUserId), JSON.stringify(snapshot))
}

// 详细注释：退出登录或检测到账号切换时，优先清掉当前账号快照，避免后续软跳转继续读到旧用户订单列表。
export const clearPersistedClientOrderSnapshot = (clientUserId: string) => {
  const storage = getStorage()
  if (!storage) {
    return
  }
  const normalizedClientUserId = normalizeClientUserId(clientUserId)
  if (!normalizedClientUserId) {
    return
  }
  storage.removeItem(getSnapshotKey(normalizedClientUserId))
  clearLegacySnapshotIfNeeded(storage)
}

// 详细注释：客户端退出登录时直接清理全部订单快照，保证浏览器被多人轮流使用时不会残留历史账号订单。
export const clearAllPersistedClientOrderSnapshots = () => {
  const storage = getStorage()
  if (!storage) {
    return
  }
  const keysToRemove: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const currentKey = storage.key(index)
    if (!currentKey) {
      continue
    }
    if (currentKey === LEGACY_CLIENT_ORDER_SNAPSHOT_KEY || currentKey.startsWith(`${CLIENT_ORDER_SNAPSHOT_KEY_PREFIX}:`)) {
      keysToRemove.push(currentKey)
    }
  }
  keysToRemove.forEach((key) => {
    storage.removeItem(key)
  })
}
