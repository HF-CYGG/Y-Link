/**
 * 模块说明：src/utils/client-cart-storage.ts
 * 文件职责：负责客户端购物车快照的本地持久化、按账号隔离恢复与历史全局缓存清理。
 * 实现逻辑：
 * 1. 购物车缓存使用 `clientUserId` 作为作用域后缀，保证同一浏览器切换账号不会读到别人的加购结果；
 * 2. 恢复时统一做结构归一化，避免旧版本或被污染的缓存把非法数量、价格写回 Store；
 * 3. 每次读写顺手清理历史单一全局 key，确保升级后不会再被旧缓存串号。
 * 维护说明：
 * - 若购物车快照后续新增字段，需要同步补齐 `normalizeSnapshotItems()`；
 * - 若未来购物车还要按门店、租户隔离，可在作用域 key 的拼装逻辑上继续扩展。
 */

import {
  clearLegacyScopedStorageKey,
  getBrowserStorage,
  resolveUserScopedStorageKey,
} from '@/utils/storage-user-scope'

export interface ClientCartSnapshotItem {
  productId: string
  productCode: string
  productName: string
  defaultPrice: string
  thumbnail: string | null
  limitPerUser: number
  availableStock: number
  preOrderedStock: number
  qty: number
  selected: boolean
}

// 统一抽出客户端账号作用域类型，避免同一联合类型在读/写/清理函数签名中重复展开。
type ClientCartStorageScopeId = string | number | null | undefined

// 详细注释：
// - 历史版本使用单一全局 key，会让同一浏览器上的多个客户端账号共用一份购物车；
// - 新版本改为“前缀 + clientUserId”的隔离键；
// - legacy key 继续保留仅用于升级时清理，不再作为读取来源。
const CLIENT_CART_SNAPSHOT_KEY_PREFIX = 'y-link.client-cart.snapshot'
const LEGACY_CLIENT_CART_SNAPSHOT_KEY = 'y-link.client-cart.snapshot'

const normalizePrice = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(2)
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) {
      return parsed.toFixed(2)
    }
  }
  return '0.00'
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const normalizeSnapshotItems = (items: unknown): ClientCartSnapshotItem[] => {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const row = item as Record<string, unknown>
      const productId = typeof row.productId === 'string' ? row.productId : ''
      const productCode = typeof row.productCode === 'string' ? row.productCode : ''
      const productName = typeof row.productName === 'string' ? row.productName : ''
      const defaultPrice = normalizePrice(row.defaultPrice)
      const thumbnail = typeof row.thumbnail === 'string' ? row.thumbnail : null
      const limitPerUser = Number.isFinite(row.limitPerUser) ? Number(row.limitPerUser) : 0
      const availableStock = Number.isFinite(row.availableStock) ? Number(row.availableStock) : 0
      const preOrderedStock = Number.isFinite(row.preOrderedStock) ? Number(row.preOrderedStock) : 0
      const qty = Number.isFinite(row.qty) ? Math.max(0, Math.floor(Number(row.qty))) : 0
      const selected = row.selected !== false

      if (!productId || !productCode || !productName || qty <= 0) {
        return null
      }

      return {
        productId,
        productCode,
        productName,
        defaultPrice,
        thumbnail,
        limitPerUser: Math.max(0, Math.floor(limitPerUser)),
        availableStock: Math.max(0, Math.floor(availableStock)),
        preOrderedStock: Math.max(0, Math.floor(preOrderedStock)),
        qty,
        selected,
      } satisfies ClientCartSnapshotItem
    })
    .filter((item): item is ClientCartSnapshotItem => item !== null)
}

export const readPersistedClientCartSnapshot = (clientUserId: ClientCartStorageScopeId) => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return [] as ClientCartSnapshotItem[]
  }

  clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CART_SNAPSHOT_KEY)
  const scopedKey = resolveUserScopedStorageKey(CLIENT_CART_SNAPSHOT_KEY_PREFIX, clientUserId)
  if (!scopedKey) {
    return [] as ClientCartSnapshotItem[]
  }

  const raw = storage.getItem(scopedKey)
  if (!raw) {
    return [] as ClientCartSnapshotItem[]
  }

  try {
    return normalizeSnapshotItems(JSON.parse(raw))
  } catch {
    storage.removeItem(scopedKey)
    return [] as ClientCartSnapshotItem[]
  }
}

export const persistClientCartSnapshot = (
  clientUserId: ClientCartStorageScopeId,
  items: ClientCartSnapshotItem[],
) => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return
  }

  clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CART_SNAPSHOT_KEY)
  const scopedKey = resolveUserScopedStorageKey(CLIENT_CART_SNAPSHOT_KEY_PREFIX, clientUserId)
  if (!scopedKey) {
    return
  }

  if (!items.length) {
    storage.removeItem(scopedKey)
    return
  }

  storage.setItem(scopedKey, JSON.stringify(items))
}

export const clearPersistedClientCartSnapshot = (clientUserId: ClientCartStorageScopeId) => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return
  }

  clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CART_SNAPSHOT_KEY)
  const scopedKey = resolveUserScopedStorageKey(CLIENT_CART_SNAPSHOT_KEY_PREFIX, clientUserId)
  if (!scopedKey) {
    return
  }

  storage.removeItem(scopedKey)
}
