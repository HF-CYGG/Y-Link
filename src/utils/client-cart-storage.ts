/**
 * 模块说明：src/utils/client-cart-storage.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const CLIENT_CART_SNAPSHOT_KEY = 'y-link.client-cart.snapshot'

const getStorage = () => {
  if (globalThis.window === undefined) {
    return null
  }

  return globalThis.window.localStorage
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
      const defaultPrice = typeof row.defaultPrice === 'string' ? row.defaultPrice : '0.00'
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

export const readPersistedClientCartSnapshot = () => {
  const storage = getStorage()
  if (!storage) {
    return [] as ClientCartSnapshotItem[]
  }

  const raw = storage.getItem(CLIENT_CART_SNAPSHOT_KEY)
  if (!raw) {
    return [] as ClientCartSnapshotItem[]
  }

  try {
    return normalizeSnapshotItems(JSON.parse(raw))
  } catch {
    storage.removeItem(CLIENT_CART_SNAPSHOT_KEY)
    return [] as ClientCartSnapshotItem[]
  }
}

export const persistClientCartSnapshot = (items: ClientCartSnapshotItem[]) => {
  const storage = getStorage()
  if (!storage) {
    return
  }

  if (!items.length) {
    storage.removeItem(CLIENT_CART_SNAPSHOT_KEY)
    return
  }

  storage.setItem(CLIENT_CART_SNAPSHOT_KEY, JSON.stringify(items))
}

export const clearPersistedClientCartSnapshot = () => {
  getStorage()?.removeItem(CLIENT_CART_SNAPSHOT_KEY)
}
