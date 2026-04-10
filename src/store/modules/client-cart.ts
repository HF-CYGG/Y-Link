/**
 * 模块说明：src/store/modules/client-cart.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { O2oMallProduct } from '@/api/modules/o2o'
import {
  clearPersistedClientCartSnapshot,
  persistClientCartSnapshot,
  readPersistedClientCartSnapshot,
  type ClientCartSnapshotItem,
} from '@/utils/client-cart-storage'

export interface ClientCartItem {
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

// 购物车单项最大可购买数量由“可预订库存”和“单人限购”共同决定。
// 该函数是购物车所有增减、初始化、目录同步逻辑的统一约束入口，避免各处重复计算口径不一致。
const toMaxQty = (item: Pick<ClientCartItem, 'availableStock' | 'limitPerUser'>) => {
  const stock = Math.max(0, item.availableStock)
  const limit = Math.max(0, item.limitPerUser)
  if (limit <= 0) {
    return stock
  }
  return Math.min(stock, limit)
}

const createCartItemFromProduct = (product: O2oMallProduct, qty: number): ClientCartItem => {
  return {
    productId: product.id,
    productCode: product.productCode,
    productName: product.productName,
    defaultPrice: product.defaultPrice,
    thumbnail: product.thumbnail,
    limitPerUser: Math.max(0, Number(product.limitPerUser ?? 0)),
    availableStock: Math.max(0, Number(product.availableStock ?? 0)),
    preOrderedStock: Math.max(0, Number(product.preOrderedStock ?? 0)),
    qty: Math.max(0, Math.floor(qty)),
    selected: true,
  }
}

export const useClientCartStore = defineStore('client-cart', () => {
  const items = ref<ClientCartItem[]>([])
  const initialized = ref(false)

  // 这些派生状态尽量只从 items 推导，避免同时维护多份可结算/失效/选中列表造成同步偏差。
  const totalQty = computed(() => items.value.reduce((sum, item) => sum + item.qty, 0))
  const validItems = computed(() => {
    return items.value.filter((item) => toMaxQty(item) > 0)
  })
  const invalidItems = computed(() => {
    return items.value.filter((item) => toMaxQty(item) <= 0)
  })
  const selectedValidItems = computed(() => {
    return validItems.value.filter((item) => item.selected)
  })
  const selectedQty = computed(() => {
    return selectedValidItems.value.reduce((sum, item) => sum + item.qty, 0)
  })
  const allValidSelected = computed(() => {
    return validItems.value.length > 0 && validItems.value.every((item) => item.selected)
  })

  const persist = () => {
    // 本地快照除了数量，还保留库存与限购字段：
    // 这样页面刷新后仍能先恢复可视状态，再等待目录接口回填最新库存。
    const snapshot: ClientCartSnapshotItem[] = items.value.map((item) => ({
      productId: item.productId,
      productCode: item.productCode,
      productName: item.productName,
      defaultPrice: item.defaultPrice,
      thumbnail: item.thumbnail,
      limitPerUser: item.limitPerUser,
      availableStock: item.availableStock,
      preOrderedStock: item.preOrderedStock,
      qty: item.qty,
      selected: item.selected,
    }))

    persistClientCartSnapshot(snapshot)
  }

  const normalizeItem = (item: ClientCartItem) => {
    // 任何进入 Store 的购物车项都会在这里统一“夹紧”到合法范围，
    // 包括：负数纠正、超库存回收、失效商品自动取消勾选。
    const maxQty = toMaxQty(item)
    const nextQty = Math.min(Math.max(0, Math.floor(item.qty)), maxQty)
    return {
      ...item,
      qty: nextQty,
      selected: maxQty > 0 ? item.selected : false,
    } satisfies ClientCartItem
  }

  const replaceItems = (nextItems: ClientCartItem[]) => {
    items.value = nextItems.map(normalizeItem).filter((item) => item.qty > 0)
    persist()
  }

  const initialize = () => {
    if (initialized.value) {
      return
    }

    const persisted = readPersistedClientCartSnapshot()
    // 持久化快照读取后仍需再次标准化，避免旧版本缓存或异常值污染当前会话。
    replaceItems(persisted)
    initialized.value = true
  }

  const ensureInitialized = () => {
    if (!initialized.value) {
      initialize()
    }
  }

  const syncWithCatalog = (products: O2oMallProduct[]) => {
    ensureInitialized()
    // 目录刷新后，购物车不会直接丢弃原有选择，而是把同 ID 商品映射到最新名称、缩略图、库存与限购规则。
    // 这样既能保持用户已选状态，又能保证后续结算基于最新库存。
    const productMap = new Map(products.map((product) => [product.id, product]))
    const nextItems = items.value
      .map((item) => {
        const latest = productMap.get(item.productId)
        if (!latest) {
          return item
        }
        return normalizeItem({
          ...item,
          productCode: latest.productCode,
          productName: latest.productName,
          defaultPrice: latest.defaultPrice,
          thumbnail: latest.thumbnail,
          availableStock: Math.max(0, Number(latest.availableStock ?? 0)),
          preOrderedStock: Math.max(0, Number(latest.preOrderedStock ?? 0)),
          limitPerUser: Math.max(0, Number(latest.limitPerUser ?? 0)),
        })
      })
      .filter((item) => item.qty > 0)

    replaceItems(nextItems)
  }

  const addProduct = (product: O2oMallProduct, qty = 1) => {
    ensureInitialized()
    const targetQty = Math.max(1, Math.floor(qty))
    const itemIndex = items.value.findIndex((item) => item.productId === product.id)
    if (itemIndex === -1) {
      const draft = createCartItemFromProduct(product, targetQty)
      const maxQty = toMaxQty(draft)
      if (maxQty <= 0) {
        return 0
      }
      items.value.push({
        ...draft,
        qty: Math.min(targetQty, maxQty),
      })
      persist()
      return Math.min(targetQty, maxQty)
    }

    const existing = items.value[itemIndex]
    // 已存在商品时走“合并后再统一裁剪”的路径，保证追加数量也受同一套 maxQty 约束。
    const merged = createCartItemFromProduct(product, existing.qty + targetQty)
    const maxQty = toMaxQty(merged)
    const nextQty = Math.min(existing.qty + targetQty, maxQty)
    items.value[itemIndex] = {
      ...existing,
      ...merged,
      selected: maxQty > 0 ? existing.selected : false,
      qty: Math.max(0, nextQty),
    }
    items.value = items.value.filter((item) => item.qty > 0)
    persist()
    return nextQty
  }

  const updateQty = (productId: string, qty: number) => {
    ensureInitialized()
    const itemIndex = items.value.findIndex((item) => item.productId === productId)
    if (itemIndex === -1) {
      return
    }

    const item = items.value[itemIndex]
    const maxQty = toMaxQty(item)
    const nextQty = Math.min(Math.max(0, Math.floor(qty)), maxQty)
    if (nextQty <= 0) {
      // 数量归零直接视为移出购物车，避免保留“0 件商品”造成后续统计异常。
      items.value = items.value.filter((entry) => entry.productId !== productId)
      persist()
      return
    }

    items.value[itemIndex] = {
      ...item,
      qty: nextQty,
      selected: maxQty > 0 ? item.selected : false,
    }
    persist()
  }

  const incrementQty = (productId: string, delta = 1) => {
    const target = items.value.find((item) => item.productId === productId)
    if (!target) {
      return
    }
    updateQty(productId, target.qty + delta)
  }

  const removeItem = (productId: string) => {
    ensureInitialized()
    items.value = items.value.filter((item) => item.productId !== productId)
    persist()
  }

  const clearSelectedItems = () => {
    ensureInitialized()
    // 这里按“勾选状态”而非“有效状态”清理，便于购物车页做批量删除操作。
    items.value = items.value.filter((item) => !item.selected)
    persist()
  }

  const clearAll = () => {
    items.value = []
    initialized.value = true
    clearPersistedClientCartSnapshot()
  }

  const toggleItemSelected = (productId: string, selected: boolean) => {
    ensureInitialized()
    items.value = items.value.map((item) => {
      if (item.productId !== productId || toMaxQty(item) <= 0) {
        // 失效商品永远不允许被选中结算，只能等待库存恢复或被用户移除。
        return item
      }
      return {
        ...item,
        selected,
      }
    })
    persist()
  }

  const toggleAllValidSelected = (selected: boolean) => {
    ensureInitialized()
    items.value = items.value.map((item) => {
      if (toMaxQty(item) <= 0) {
        return {
          ...item,
          selected: false,
        }
      }
      return {
        ...item,
        selected,
      }
    })
    persist()
  }

  return {
    items,
    initialized,
    totalQty,
    validItems,
    invalidItems,
    selectedValidItems,
    selectedQty,
    allValidSelected,
    initialize,
    syncWithCatalog,
    addProduct,
    updateQty,
    incrementQty,
    removeItem,
    clearSelectedItems,
    clearAll,
    toggleItemSelected,
    toggleAllValidSelected,
  }
})
