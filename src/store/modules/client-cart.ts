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
  thumbnail: string | null
  limitPerUser: number
  availableStock: number
  preOrderedStock: number
  qty: number
  selected: boolean
}

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
    const snapshot: ClientCartSnapshotItem[] = items.value.map((item) => ({
      productId: item.productId,
      productCode: item.productCode,
      productName: item.productName,
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
