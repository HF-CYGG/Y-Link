/**
 * 模块说明：src/utils/client-catalog-storage.ts
 * 文件职责：负责客户端商品目录快照的本地持久化、按账号隔离恢复与历史全局缓存清理。
 * 实现逻辑：
 * 1. 商品目录缓存按 `clientUserId` 分片，避免浏览器切换账号后把上一个账号的浏览上下文直接还原给新账号；
 * 2. 商品数据与浏览上下文拆分持久化，减少切分类/搜关键字时对整份商品数组的重复序列化；
 * 3. 恢复阶段兼容旧版合并快照，保证发布后用户仍能平滑继承既有商城缓存。
 * 维护说明：
 * - 若目录快照继续新增字段，请同步补齐 `readPersistedClientCatalogSnapshot()` 的兼容恢复逻辑；
 * - 若后续目录缓存要按更多业务维度分片，可继续复用统一的作用域 key 工具。
 */

import type { O2oMallProduct, O2oMallStorefrontConfig } from '@/api/modules/o2o'
import { calculateDiscountedPriceText, normalizeDiscountRateText } from '@/utils/o2o-price'
import {
  clearLegacyScopedStorageKey,
  getBrowserStorage,
  resolveUserScopedStorageKey,
} from '@/utils/storage-user-scope'

export interface ClientCatalogSnapshot {
  products: O2oMallProduct[]
  storefront: O2oMallStorefrontConfig
  activeCategoryKey: string
  keyword: string
  sortMode: ClientCatalogSortMode
  updatedAt: number
}

export interface ClientCatalogDataSnapshot {
  products: O2oMallProduct[]
  storefront: O2oMallStorefrontConfig
  updatedAt: number
}

export interface ClientCatalogBrowseContextSnapshot {
  activeCategoryKey: string
  keyword: string
  sortMode: ClientCatalogSortMode
}

export type ClientCatalogSortMode = 'default' | 'recommended'

// 统一抽出客户端账号作用域类型，避免同一联合类型在多个持久化函数签名里重复展开。
type ClientCatalogStorageScopeId = string | number | null | undefined

// 详细注释：
// - 旧版本使用“商品数据 + 浏览上下文”合并快照；
// - 新版本拆成 data/context 两个分片，减少高频筛选造成的大对象重复写入；
// - legacy key 同时保留“全局 key + 旧版按用户分片 key”两种兼容读取入口。
const CLIENT_CATALOG_DATA_SNAPSHOT_KEY_PREFIX = 'y-link.client-catalog.data'
const CLIENT_CATALOG_CONTEXT_SNAPSHOT_KEY_PREFIX = 'y-link.client-catalog.context'
const LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX = 'y-link.client-catalog.snapshot'
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

const normalizeNonNegativeInteger = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
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
        defaultPrice: normalizePrice(row.discountedPrice ?? row.defaultPrice),
        originalPrice: normalizePrice(row.originalPrice ?? row.defaultPrice),
        discountRate: normalizeDiscountRateText(row.discountRate as string | number | null | undefined),
        discountedPrice: normalizePrice(row.discountedPrice ?? calculateDiscountedPriceText((row.originalPrice ?? row.defaultPrice) as string | number | null | undefined, row.discountRate as string | number | null | undefined)),
        o2oRecommended: row.o2oRecommended === true || row.o2oRecommended === 1 || row.o2oRecommended === '1' || row.o2oRecommended === 'true',
        tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
        thumbnail: typeof row.thumbnail === 'string' ? row.thumbnail : null,
        detailContent: typeof row.detailContent === 'string' ? row.detailContent : null,
        limitPerUser: Number.isFinite(row.limitPerUser) ? Number(row.limitPerUser) : 0,
        currentStock: Number.isFinite(row.currentStock) ? Number(row.currentStock) : 0,
        preOrderedStock: Number.isFinite(row.preOrderedStock) ? Number(row.preOrderedStock) : 0,
        availableStock: Number.isFinite(row.availableStock) ? Number(row.availableStock) : 0,
        soldQty: normalizeNonNegativeInteger(row.soldQty),
      } satisfies O2oMallProduct
    })
    .filter((item): item is O2oMallProduct => item !== null)
}

const normalizeUpdatedAt = (value: unknown) => {
  return Number.isFinite(value) ? Number(value) : 0
}

const normalizeStorefront = (value: unknown): O2oMallStorefrontConfig => {
  if (!value || typeof value !== 'object') {
    return {
      businessHoursText: '10:00 - 22:00',
      mallAnnouncementText: '',
    }
  }
  const row = value as Record<string, unknown>
  const businessHoursText = typeof row.businessHoursText === 'string' && row.businessHoursText.trim()
    ? row.businessHoursText.trim()
    : '10:00 - 22:00'
  return {
    businessHoursText,
    mallAnnouncementText: typeof row.mallAnnouncementText === 'string' ? row.mallAnnouncementText.trim() : '',
  }
}

const normalizeActiveCategoryKey = (value: unknown) => {
  return typeof value === 'string' && value.trim() ? value : 'all'
}

const normalizeKeyword = (value: unknown) => {
  return typeof value === 'string' ? value : ''
}

const normalizeSortMode = (value: unknown): ClientCatalogSortMode => {
  return value === 'recommended' ? 'recommended' : 'default'
}

const readScopedJson = (storage: Storage, scopedKey: string | null): Record<string, unknown> | null => {
  if (!scopedKey) {
    return null
  }
  const raw = storage.getItem(scopedKey)
  if (!raw) {
    return null
  }
  return JSON.parse(raw) as Record<string, unknown>
}

const removeScopedKey = (storage: Storage, scopedKey: string | null) => {
  if (!scopedKey) {
    return
  }
  storage.removeItem(scopedKey)
}

export const readPersistedClientCatalogSnapshot = (
  clientUserId: ClientCatalogStorageScopeId,
): ClientCatalogSnapshot | null => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return null
  }

  try {
    const dataScopedKey = resolveUserScopedStorageKey(CLIENT_CATALOG_DATA_SNAPSHOT_KEY_PREFIX, clientUserId)
    const contextScopedKey = resolveUserScopedStorageKey(CLIENT_CATALOG_CONTEXT_SNAPSHOT_KEY_PREFIX, clientUserId)
    const legacyScopedKey = resolveUserScopedStorageKey(LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId)
    const parsedData = readScopedJson(storage, dataScopedKey)
    const parsedContext = readScopedJson(storage, contextScopedKey)
    const parsedLegacy = readScopedJson(storage, legacyScopedKey)
      ?? readScopedJson(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)

    const sourceData = parsedData ?? parsedLegacy
    const sourceContext = parsedContext ?? parsedLegacy
    if (!sourceData && !sourceContext) {
      clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
      return null
    }

    clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
    return {
      products: normalizeProducts(sourceData?.products),
      storefront: normalizeStorefront(sourceData?.storefront),
      activeCategoryKey: normalizeActiveCategoryKey(sourceContext?.activeCategoryKey),
      keyword: normalizeKeyword(sourceContext?.keyword),
      sortMode: normalizeSortMode(sourceContext?.sortMode),
      updatedAt: normalizeUpdatedAt(sourceData?.updatedAt),
    }
  } catch (error) {
    console.warn('读取客户端商品目录缓存失败，已清理损坏快照。', error)
    removeScopedKey(storage, resolveUserScopedStorageKey(CLIENT_CATALOG_DATA_SNAPSHOT_KEY_PREFIX, clientUserId))
    removeScopedKey(storage, resolveUserScopedStorageKey(CLIENT_CATALOG_CONTEXT_SNAPSHOT_KEY_PREFIX, clientUserId))
    removeScopedKey(storage, resolveUserScopedStorageKey(LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId))
    clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
    return null
  }
}

export const persistClientCatalogDataSnapshot = (
  clientUserId: ClientCatalogStorageScopeId,
  snapshot: ClientCatalogDataSnapshot,
) => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return
  }

  clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
  const scopedKey = resolveUserScopedStorageKey(CLIENT_CATALOG_DATA_SNAPSHOT_KEY_PREFIX, clientUserId)
  if (!scopedKey) {
    return
  }

  storage.setItem(scopedKey, JSON.stringify(snapshot))
  removeScopedKey(storage, resolveUserScopedStorageKey(LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId))
}

export const persistClientCatalogBrowseContextSnapshot = (
  clientUserId: ClientCatalogStorageScopeId,
  snapshot: ClientCatalogBrowseContextSnapshot,
) => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return
  }

  clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
  const scopedKey = resolveUserScopedStorageKey(CLIENT_CATALOG_CONTEXT_SNAPSHOT_KEY_PREFIX, clientUserId)
  if (!scopedKey) {
    return
  }

  storage.setItem(scopedKey, JSON.stringify(snapshot))
  removeScopedKey(storage, resolveUserScopedStorageKey(LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId))
}

export const clearPersistedClientCatalogSnapshot = (clientUserId: ClientCatalogStorageScopeId) => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return
  }

  clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
  const dataScopedKey = resolveUserScopedStorageKey(CLIENT_CATALOG_DATA_SNAPSHOT_KEY_PREFIX, clientUserId)
  const contextScopedKey = resolveUserScopedStorageKey(CLIENT_CATALOG_CONTEXT_SNAPSHOT_KEY_PREFIX, clientUserId)
  const legacyScopedKey = resolveUserScopedStorageKey(LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId)
  if (!dataScopedKey && !contextScopedKey && !legacyScopedKey) {
    return
  }

  removeScopedKey(storage, dataScopedKey)
  removeScopedKey(storage, contextScopedKey)
  removeScopedKey(storage, legacyScopedKey)
}
