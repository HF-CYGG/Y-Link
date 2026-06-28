/**
 * 模块说明：src/utils/client-preorder-submit-guard.ts
 * 文件职责：为客户端预订单提交提供基于 `sessionStorage` 的短时提交锁，降低弱网或重复进入场景的重复提交流量。
 * 实现逻辑：
 * - 按“当前客户端账号 + 提交意图摘要”生成稳定指纹，用于识别是否为同一笔预订意图；
 * - 在提交开始时写入短时 pending 锁，若用户短时间内重复打开结算页再提交，会直接命中拦截；
 * - 锁仅保留短时间窗口，既能拦截高并发误触，也不会长期阻塞用户下一次真实下单。
 * 维护说明：
 * - 若后续服务端正式接入 O2O 预订单幂等键，可继续复用本文件生成的 `requestKey` 与 `intentKey`；
 * - 若客户端需要跨标签页共享提交锁，可把 `sessionStorage` 升级为 `localStorage` 并补充广播同步。
 */
import type { O2oClientOrderType } from '@/api/modules/o2o'

export interface ClientPreorderSubmitItemInput {
  productId: string | number
  skuId?: string | number | null
  qty: number
}

export interface ClientPreorderSubmitIntentInput {
  clientUserId: ClientPreorderSubmitUserId
  clientOrderType: O2oClientOrderType
  isSystemApplied: boolean
  pickupContact: string
  remark?: string
  items: ClientPreorderSubmitItemInput[]
}

interface ClientPreorderSubmitLockSnapshot {
  intentKey: string
  requestKey: string
  createdAt: number
}

const CLIENT_PREORDER_SUBMIT_LOCK_KEY_PREFIX = 'ylink:client:preorder:submit-lock:'
const CLIENT_PREORDER_SUBMIT_LOCK_TTL_MS = 20 * 1000
type ClientPreorderSubmitUserId = string | number | null | undefined

const normalizeClientUserId = (value: ClientPreorderSubmitUserId) => {
  return String(value ?? '').trim() || 'anonymous'
}

const resolveSubmitLockStorageKey = (clientUserId: ClientPreorderSubmitUserId) => {
  return `${CLIENT_PREORDER_SUBMIT_LOCK_KEY_PREFIX}${normalizeClientUserId(clientUserId)}`
}

const getSubmitLockStorage = () => {
  if (globalThis.window === undefined) {
    return null
  }
  return globalThis.window.sessionStorage
}

const normalizeText = (value: string | null | undefined) => {
  return (value ?? '').trim()
}

const normalizeRemark = (value: string | null | undefined) => {
  return normalizeText(value).replaceAll(/\s+/g, ' ')
}

const normalizeItemsForFingerprint = (items: ClientPreorderSubmitItemInput[]) => {
  return items
    .map((item) => ({
      productId: String(item.productId ?? '').trim(),
      skuId: item.skuId === null || item.skuId === undefined ? '' : String(item.skuId).trim(),
      qty: Math.max(0, Math.floor(Number(item.qty ?? 0))),
    }))
    .filter((item) => item.productId && item.qty > 0)
    .sort((prev, next) => {
      const productCompare = prev.productId.localeCompare(next.productId, 'en')
      return productCompare || prev.skuId.localeCompare(next.skuId, 'en')
    })
}

export const buildClientPreorderSubmitIntentKey = (input: ClientPreorderSubmitIntentInput) => {
  const normalizedItems = normalizeItemsForFingerprint(input.items)
  return JSON.stringify({
    clientUserId: normalizeClientUserId(input.clientUserId),
    clientOrderType: input.clientOrderType,
    isSystemApplied: Boolean(input.isSystemApplied),
    pickupContact: normalizeText(input.pickupContact),
    remark: normalizeRemark(input.remark),
    items: normalizedItems,
  })
}

const readRawSubmitLock = (clientUserId: ClientPreorderSubmitUserId): ClientPreorderSubmitLockSnapshot | null => {
  const storage = getSubmitLockStorage()
  if (!storage) {
    return null
  }

  const raw = storage.getItem(resolveSubmitLockStorageKey(clientUserId))
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ClientPreorderSubmitLockSnapshot>
    if (
      typeof parsed.intentKey !== 'string'
      || typeof parsed.requestKey !== 'string'
      || !Number.isFinite(parsed.createdAt)
    ) {
      storage.removeItem(resolveSubmitLockStorageKey(clientUserId))
      return null
    }
    return {
      intentKey: parsed.intentKey,
      requestKey: parsed.requestKey,
      createdAt: Number(parsed.createdAt),
    }
  } catch {
    storage.removeItem(resolveSubmitLockStorageKey(clientUserId))
    return null
  }
}

export const readActiveClientPreorderSubmitLock = (clientUserId: ClientPreorderSubmitUserId) => {
  const storage = getSubmitLockStorage()
  if (!storage) {
    return null
  }

  const snapshot = readRawSubmitLock(clientUserId)
  if (!snapshot) {
    return null
  }
  if (Date.now() - snapshot.createdAt > CLIENT_PREORDER_SUBMIT_LOCK_TTL_MS) {
    storage.removeItem(resolveSubmitLockStorageKey(clientUserId))
    return null
  }
  return snapshot
}

export const createClientPreorderSubmitLock = (
  clientUserId: ClientPreorderSubmitUserId,
  intentKey: string,
) => {
  const storage = getSubmitLockStorage()
  const requestKey = `client-preorder-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  if (storage) {
    const snapshot: ClientPreorderSubmitLockSnapshot = {
      intentKey,
      requestKey,
      createdAt: Date.now(),
    }
    storage.setItem(resolveSubmitLockStorageKey(clientUserId), JSON.stringify(snapshot))
  }

  return requestKey
}

export const refreshClientPreorderSubmitLock = (
  clientUserId: ClientPreorderSubmitUserId,
  intentKey: string,
  requestKey: string,
) => {
  const storage = getSubmitLockStorage()
  if (!storage) {
    return
  }
  storage.setItem(
    resolveSubmitLockStorageKey(clientUserId),
    JSON.stringify({
      intentKey,
      requestKey,
      createdAt: Date.now(),
    } satisfies ClientPreorderSubmitLockSnapshot),
  )
}

export const clearClientPreorderSubmitLock = (
  clientUserId: ClientPreorderSubmitUserId,
  requestKey?: string,
) => {
  const storage = getSubmitLockStorage()
  if (!storage) {
    return
  }

  const storageKey = resolveSubmitLockStorageKey(clientUserId)
  if (!requestKey) {
    storage.removeItem(storageKey)
    return
  }

  const snapshot = readRawSubmitLock(clientUserId)
  if (!snapshot || snapshot.requestKey === requestKey) {
    storage.removeItem(storageKey)
  }
}
