/**
 * 模块说明：src/utils/client-catalog-storage.ts
 * 文件职责：负责客户端商品目录快照的本地持久化、按账号隔离恢复与历史全局缓存清理。
 * 实现逻辑：
 * 1. 商品目录快照按 `clientUserId` 分片，避免浏览器切换账号后把上一个账号的浏览上下文直接还原给新账号；
 * 2. 恢复时同时保留商品列表、激活分类、搜索词和更新时间，让商城页支持“秒开 + 上下文恢复”；
 * 3. 升级到新版本后会自动清理历史全局 key，确保旧缓存不再污染当前账号。
 * 维护说明：
 * - 若目录快照继续新增字段，请同步补齐 `readPersistedClientCatalogSnapshot()` 的兼容恢复逻辑；
 * - 若后续目录缓存要按更多业务维度分片，可继续复用统一的作用域 key 工具。
 */

import type { O2oMallProduct } from '@/api/modules/o2o'
import {
  clearLegacyScopedStorageKey,
  getBrowserStorage,
  resolveUserScopedStorageKey,
} from '@/utils/storage-user-scope'

export interface ClientCatalogSnapshot {
  products: O2oMallProduct[]
  activeCategoryKey: string
  keyword: string
  updatedAt: number
}

// 统一抽出客户端账号作用域类型，避免同一联合类型在多个持久化函数签名里重复展开。
type ClientCatalogStorageScopeId = string | number | null | undefined

// 详细注释：
// - 历史版本使用单一全局 key，会导致不同客户端账号共享同一份商品目录浏览上下文；
// - 新版本改为“前缀 + clientUserId”的隔离键；
// - legacy key 仅用于平滑升级时的自动清理。
const CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX = 'y-link.client-catalog.snapshot'
const LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY = 'y-link.client-catalog.snapshot'

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
const normalizeProducts = (products: unknown): O2oMallProduct[] => {
  if (!Array.isArray(products)) {
    return []
  }

  return products
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }
      const row = item as Record<string, unknown>
      const id = typeof row.id === 'string' ? row.id : ''
      const productCode = typeof row.productCode === 'string' ? row.productCode : ''
      const productName = typeof row.productName === 'string' ? row.productName : ''
      if (!id || !productCode || !productName) {
        return null
      }
      return {
        id,
        productCode,
        productName,
        defaultPrice: normalizePrice(row.defaultPrice),
        tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
        thumbnail: typeof row.thumbnail === 'string' ? row.thumbnail : null,
        detailContent: typeof row.detailContent === 'string' ? row.detailContent : null,
        limitPerUser: Number.isFinite(row.limitPerUser) ? Number(row.limitPerUser) : 0,
        currentStock: Number.isFinite(row.currentStock) ? Number(row.currentStock) : 0,
        preOrderedStock: Number.isFinite(row.preOrderedStock) ? Number(row.preOrderedStock) : 0,
        availableStock: Number.isFinite(row.availableStock) ? Number(row.availableStock) : 0,
      } satisfies O2oMallProduct
    })
    .filter((item): item is O2oMallProduct => item !== null)
}

export const readPersistedClientCatalogSnapshot = (
  clientUserId: ClientCatalogStorageScopeId,
): ClientCatalogSnapshot | null => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return null
  }

  clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
  const scopedKey = resolveUserScopedStorageKey(CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId)
  if (!scopedKey) {
    return null
  }

  const raw = storage.getItem(scopedKey)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      products: normalizeProducts(parsed.products),
      activeCategoryKey: typeof parsed.activeCategoryKey === 'string' ? parsed.activeCategoryKey : 'all',
      keyword: typeof parsed.keyword === 'string' ? parsed.keyword : '',
      updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : 0,
    }
  } catch (error) {
    console.warn('读取客户端商品目录缓存失败，已清理损坏快照。', error)
    storage.removeItem(scopedKey)
    return null
  }
}

export const persistClientCatalogSnapshot = (
  clientUserId: ClientCatalogStorageScopeId,
  snapshot: ClientCatalogSnapshot,
) => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return
  }

  clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
  const scopedKey = resolveUserScopedStorageKey(CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId)
  if (!scopedKey) {
    return
  }

  storage.setItem(scopedKey, JSON.stringify(snapshot))
}

export const clearPersistedClientCatalogSnapshot = (clientUserId: ClientCatalogStorageScopeId) => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return
  }

  clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
  const scopedKey = resolveUserScopedStorageKey(CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId)
  if (!scopedKey) {
    return
  }

  storage.removeItem(scopedKey)
}
