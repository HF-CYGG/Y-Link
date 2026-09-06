/**
 * 模块说明：src/utils/client-catalog-storage.ts
 * 文件职责：负责客户端商品目录轻量快照、本地浏览上下文与历史全量缓存迁移。
 * 实现逻辑：
 * 1. 公开商品卡片快照全浏览器只保存一份，账号维度仅保存分类/搜索上下文，避免多账号重复占用 localStorage；
 * 2. 持久化目录只保留卡片所需的有界描述，完整商品详情继续以内存和网络响应为准；
 * 3. 恢复阶段兼容旧版按账号全量快照，并立即迁移为轻量公共快照。
 * 维护说明：
 * - 若目录快照继续新增字段，请同步补齐 `readPersistedClientCatalogSnapshot()` 的兼容恢复逻辑；
 * - 若后续目录缓存要按更多业务维度分片，可继续复用统一的作用域 key 工具。
 */

import type { O2oMallProduct, O2oMallSku, O2oMallStorefrontConfig } from '@/api/modules/o2o'
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
  requiresNetworkRefresh: boolean
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
const CLIENT_CATALOG_PUBLIC_DATA_SNAPSHOT_KEY = 'y-link.client-catalog.public-data.v2'
const CLIENT_CATALOG_PUBLIC_STOREFRONT_SNAPSHOT_KEY = 'y-link.client-catalog.public-storefront.v2'
const CLIENT_CATALOG_DATA_SCHEMA_VERSION = 2
const CLIENT_CATALOG_CARD_DESCRIPTION_MAX_LENGTH = 240

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
const normalizeBoolean = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true'

const normalizeSkuRecords = (skus: unknown): O2oMallSku[] => {
  if (!Array.isArray(skus)) {
    return []
  }

  return skus
    .map((item): O2oMallSku | null => {
      if (!item || typeof item !== 'object') {
        return null
      }
      const row = item as Record<string, unknown>
      const id = typeof row.id === 'string' ? row.id : ''
      const productId = typeof row.productId === 'string' ? row.productId : ''
      if (!id || !productId) {
        return null
      }
      const originalPrice = normalizePrice(row.originalPrice ?? row.defaultPrice)
      const discountRate = normalizeDiscountRateText(row.discountRate as string | number | null | undefined)
      const specValues = row.specValues && typeof row.specValues === 'object'
        ? Object.fromEntries(
          Object.entries(row.specValues as Record<string, unknown>)
            .map(([key, value]) => [key, String(value ?? '')])
            .filter(([key, value]) => key && value),
        )
        : {}

      return {
        id,
        productId,
        skuCode: typeof row.skuCode === 'string' ? row.skuCode : '',
        specValues,
        specText: typeof row.specText === 'string' && row.specText.trim() ? row.specText : '默认规格',
        defaultPrice: normalizePrice(row.defaultPrice ?? row.originalPrice),
        originalPrice,
        discountRate,
        discountedPrice: normalizePrice(row.discountedPrice ?? calculateDiscountedPriceText(originalPrice, discountRate)),
        currentStock: normalizeNonNegativeInteger(row.currentStock),
        preOrderedStock: normalizeNonNegativeInteger(row.preOrderedStock),
        availableStock: normalizeNonNegativeInteger(row.availableStock),
        isActive: row.isActive === false || row.isActive === 0 || row.isActive === '0' || row.isActive === 'false' ? false : true,
        isCurrent: row.isCurrent === false || row.isCurrent === 0 || row.isCurrent === '0' || row.isCurrent === 'false' ? false : true,
        o2oRecommended: normalizeBoolean(row.o2oRecommended),
        thumbnail: typeof row.thumbnail === 'string' ? row.thumbnail : null,
        sortOrder: normalizeNonNegativeInteger(row.sortOrder),
      } satisfies O2oMallSku
    })
    .filter((item): item is O2oMallSku => item !== null)
}

const normalizeProducts = (products: unknown): O2oMallProduct[] => {
  if (!Array.isArray(products)) {
    return []
  }

  return products
    .map((item): O2oMallProduct | null => {
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
        o2oRecommended: normalizeBoolean(row.o2oRecommended),
        tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
        thumbnail: typeof row.thumbnail === 'string' ? row.thumbnail : null,
        detailContent: typeof row.detailContent === 'string' ? row.detailContent : null,
        limitPerUser: Number.isFinite(row.limitPerUser) ? Number(row.limitPerUser) : 0,
        currentStock: Number.isFinite(row.currentStock) ? Number(row.currentStock) : 0,
        preOrderedStock: Number.isFinite(row.preOrderedStock) ? Number(row.preOrderedStock) : 0,
        availableStock: Number.isFinite(row.availableStock) ? Number(row.availableStock) : 0,
        soldQty: normalizeNonNegativeInteger(row.soldQty),
        skus: normalizeSkuRecords(row.skus),
      } satisfies O2oMallProduct
    })
    .filter((item): item is O2oMallProduct => item !== null)
}

/**
 * localStorage 只承担“尽快画出商品卡片”的职责：
 * - SKU、价格和库存仍需保留，保证卡片与购物车恢复后不会失去数量约束；
 * - 商品长描述是目录响应中最容易膨胀的字段，只保留卡片可见的短摘要；
 * - 页面恢复后会后台请求完整目录，因此该快照永远不会被视为权威新鲜数据。
 */
const createCompactCatalogProducts = (products: O2oMallProduct[]): O2oMallProduct[] => {
  return products.map((product) => ({
    ...product,
    detailContent: product.detailContent?.trim().slice(0, CLIENT_CATALOG_CARD_DESCRIPTION_MAX_LENGTH) || null,
  }))
}

const createCompactCatalogDataSnapshot = (snapshot: ClientCatalogDataSnapshot) => ({
  schemaVersion: CLIENT_CATALOG_DATA_SCHEMA_VERSION,
  completeness: 'card' as const,
  products: createCompactCatalogProducts(snapshot.products),
  storefront: snapshot.storefront,
  updatedAt: snapshot.updatedAt,
})

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
    const parsedPublicData = readScopedJson(storage, CLIENT_CATALOG_PUBLIC_DATA_SNAPSHOT_KEY)
    const parsedPublicStorefront = readScopedJson(storage, CLIENT_CATALOG_PUBLIC_STOREFRONT_SNAPSHOT_KEY)
    const parsedData = readScopedJson(storage, dataScopedKey)
    const parsedContext = readScopedJson(storage, contextScopedKey)
    const parsedLegacy = readScopedJson(storage, legacyScopedKey)
      ?? readScopedJson(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)

    const sourceData = parsedPublicData ?? parsedData ?? parsedLegacy
    const sourceContext = parsedContext ?? parsedLegacy
    if (!sourceData && !sourceContext) {
      clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
      return null
    }

    clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
    const products = normalizeProducts(sourceData?.products)
    const storefront = normalizeStorefront(parsedPublicStorefront?.storefront ?? sourceData?.storefront)
    const updatedAt = normalizeUpdatedAt(sourceData?.updatedAt)

    // 首次读取旧版全量按账号快照时立即收敛为一份公共轻量数据，避免继续复制长描述。
    if (!parsedPublicData && sourceData) {
      try {
        storage.setItem(CLIENT_CATALOG_PUBLIC_DATA_SNAPSHOT_KEY, JSON.stringify(createCompactCatalogDataSnapshot({
          products,
          storefront,
          updatedAt,
        })))
      } catch {
        // 迁移写入失败不影响当前页面继续使用已经成功解析的旧快照。
      }
    }
    removeScopedKey(storage, dataScopedKey)
    removeScopedKey(storage, legacyScopedKey)

    return {
      products,
      storefront,
      activeCategoryKey: normalizeActiveCategoryKey(sourceContext?.activeCategoryKey),
      keyword: normalizeKeyword(sourceContext?.keyword),
      sortMode: normalizeSortMode(sourceContext?.sortMode),
      updatedAt,
      // 本地只保存卡片摘要；即使时间戳仍在 TTL 内，也必须在首屏绘制后后台补齐完整目录。
      requiresNetworkRefresh: true,
    }
  } catch (error) {
    console.warn('读取客户端商品目录缓存失败，已清理损坏快照。', error)
    removeScopedKey(storage, resolveUserScopedStorageKey(CLIENT_CATALOG_DATA_SNAPSHOT_KEY_PREFIX, clientUserId))
    removeScopedKey(storage, resolveUserScopedStorageKey(CLIENT_CATALOG_CONTEXT_SNAPSHOT_KEY_PREFIX, clientUserId))
    removeScopedKey(storage, resolveUserScopedStorageKey(LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId))
    clearLegacyScopedStorageKey(storage, LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY)
    removeScopedKey(storage, CLIENT_CATALOG_PUBLIC_DATA_SNAPSHOT_KEY)
    removeScopedKey(storage, CLIENT_CATALOG_PUBLIC_STOREFRONT_SNAPSHOT_KEY)
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

  try {
    storage.setItem(CLIENT_CATALOG_PUBLIC_DATA_SNAPSHOT_KEY, JSON.stringify(createCompactCatalogDataSnapshot(snapshot)))
    storage.setItem(CLIENT_CATALOG_PUBLIC_STOREFRONT_SNAPSHOT_KEY, JSON.stringify({
      schemaVersion: CLIENT_CATALOG_DATA_SCHEMA_VERSION,
      storefront: snapshot.storefront,
    }))
    // 新版公共快照写入成功后删除当前账号的旧全量数据分片；浏览上下文仍保持账号隔离。
    removeScopedKey(storage, scopedKey)
    removeScopedKey(storage, resolveUserScopedStorageKey(LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId))
  } catch (error) {
    // 本地快照只是首屏加速项，配额不足或隐私模式拒绝写入时不能让已成功的目录请求变成页面错误。
    console.warn('持久化客户端商品目录轻量快照失败，当前会话继续使用内存数据。', error)
  }
}

/**
 * 营业时间与公告更新频率高于商品目录，只写独立小快照：
 * - 避免每次刷新公告都重新 JSON.stringify 整份商品/SKU 数组；
 * - 下次恢复时以该小快照覆盖目录快照中可能较旧的门店配置。
 */
export const persistClientCatalogStorefrontSnapshot = (storefront: O2oMallStorefrontConfig) => {
  const storage = getBrowserStorage('local')
  if (!storage) {
    return
  }
  try {
    storage.setItem(CLIENT_CATALOG_PUBLIC_STOREFRONT_SNAPSHOT_KEY, JSON.stringify({
      schemaVersion: CLIENT_CATALOG_DATA_SCHEMA_VERSION,
      storefront,
    }))
  } catch (error) {
    console.warn('持久化客户端门店配置失败，当前会话继续使用内存数据。', error)
  }
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

  try {
    storage.setItem(scopedKey, JSON.stringify(snapshot))
    removeScopedKey(storage, resolveUserScopedStorageKey(LEGACY_CLIENT_CATALOG_SNAPSHOT_KEY_PREFIX, clientUserId))
  } catch (error) {
    console.warn('持久化客户端商城浏览上下文失败，当前会话继续使用内存数据。', error)
  }
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
  // 公共目录与门店配置均不含账号数据，退出登录时保留，以便下一个账号先渲染卡片再后台校准库存。
}
