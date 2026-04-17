/**
 * 模块说明：src/utils/client-catalog-storage.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import type { O2oMallProduct } from '@/api/modules/o2o'

export interface ClientCatalogSnapshot {
  products: O2oMallProduct[]
  activeCategoryKey: string
  keyword: string
  updatedAt: number
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const CLIENT_CATALOG_SNAPSHOT_KEY = 'y-link.client-catalog.snapshot'

const getStorage = () => {
  if (globalThis.window === undefined) {
    return null
  }
  return globalThis.window.localStorage
}

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

export const readPersistedClientCatalogSnapshot = (): ClientCatalogSnapshot | null => {
  const storage = getStorage()
  if (!storage) {
    return null
  }
  const raw = storage.getItem(CLIENT_CATALOG_SNAPSHOT_KEY)
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
    storage.removeItem(CLIENT_CATALOG_SNAPSHOT_KEY)
    return null
  }
}

export const persistClientCatalogSnapshot = (snapshot: ClientCatalogSnapshot) => {
  const storage = getStorage()
  if (!storage) {
    return
  }
  storage.setItem(CLIENT_CATALOG_SNAPSHOT_KEY, JSON.stringify(snapshot))
}

export const clearPersistedClientCatalogSnapshot = () => {
  getStorage()?.removeItem(CLIENT_CATALOG_SNAPSHOT_KEY)
}
