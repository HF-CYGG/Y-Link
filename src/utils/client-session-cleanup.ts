/**
 * 客户端账号切换与登出的轻量清理入口，独立于业务 Store 和快照编解码。
 * 已初始化的 Store 先取消延迟落盘并清理内存，再删除旧账号的持久化数据。
 */
import type { Pinia } from 'pinia'
import { getBrowserStorage, resolveUserScopedStorageKey } from '@/utils/storage-user-scope'

export const CLIENT_CART_SNAPSHOT_KEY_PREFIX = 'y-link.client-cart.snapshot'
export const LEGACY_CLIENT_CART_SNAPSHOT_KEY = CLIENT_CART_SNAPSHOT_KEY_PREFIX
export const CLIENT_CATALOG_DATA_SNAPSHOT_KEY_PREFIX = 'y-link.client-catalog.data'
export const CLIENT_CATALOG_CONTEXT_SNAPSHOT_KEY_PREFIX = 'y-link.client-catalog.context'
export const LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX = 'y-link.client-catalog.snapshot'
export const LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY = LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX
export const CLIENT_ORDER_SNAPSHOT_META_KEY_PREFIX = 'y-link.client-order.snapshot.meta'
export const CLIENT_ORDER_SNAPSHOT_ORDERS_KEY_PREFIX = 'y-link.client-order.snapshot.orders'
export const LEGACY_CLIENT_ORDER_SNAPSHOT_KEY_PREFIX = 'y-link.client-order.snapshot'
export const LEGACY_CLIENT_ORDER_SNAPSHOT_KEY = LEGACY_CLIENT_ORDER_SNAPSHOT_KEY_PREFIX

const legacyKeys = [LEGACY_CLIENT_CART_SNAPSHOT_KEY, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY, LEGACY_CLIENT_ORDER_SNAPSHOT_KEY]
const accountKeyPrefixes = [
  CLIENT_CART_SNAPSHOT_KEY_PREFIX,
  CLIENT_CATALOG_DATA_SNAPSHOT_KEY_PREFIX,
  CLIENT_CATALOG_CONTEXT_SNAPSHOT_KEY_PREFIX,
  LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX,
  CLIENT_ORDER_SNAPSHOT_META_KEY_PREFIX,
  CLIENT_ORDER_SNAPSHOT_ORDERS_KEY_PREFIX,
  LEGACY_CLIENT_ORDER_SNAPSHOT_KEY_PREFIX,
]
const resetsByPinia = new WeakMap<Pinia, Set<() => void>>()

export const registerClientSessionReset = (pinia: Pinia, reset: () => void): (() => void) => {
  const resets = resetsByPinia.get(pinia) ?? new Set<() => void>()
  resetsByPinia.set(pinia, resets)
  resets.add(reset)
  return () => { resets.delete(reset) }
}

export const clearClientSessionData = (pinia: Pinia, previousUserId: unknown): void => {
  for (const reset of resetsByPinia.get(pinia) ?? []) reset()
  let storage: Storage | null
  try { storage = getBrowserStorage('local') } catch { return }
  if (!storage) return

  const scopedKeys = accountKeyPrefixes.map((prefix) => resolveUserScopedStorageKey(prefix, previousUserId))
  for (const key of [...legacyKeys, ...scopedKeys]) {
    if (!key) continue
    try { storage.removeItem(key) } catch { /* 单个存储键不可访问时继续清理其他键。 */ }
  }
}
