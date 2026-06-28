/**
 * 模块说明：src/store/modules/client-cart.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { O2oMallProduct, O2oMallSku } from '@/api/modules/o2o'
import { showAppWarning } from '@/utils/app-alert'
import { resolveO2oPriceView } from '@/utils/o2o-price'
import {
  clearPersistedClientCartSnapshot,
  persistClientCartSnapshot,
  readPersistedClientCartSnapshot,
  type ClientCartSnapshotItem,
} from '@/utils/client-cart-storage'

export interface ClientCartItem {
  productId: string
  skuId: string | null
  productName: string
  thumbnail: string | null
  specText: string | null
  defaultPrice: string
  originalPrice: string
  discountRate: string
  discountedPrice: string
  limitPerUser: number
  availableStock: number
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

const resolveDefaultSku = (product: O2oMallProduct): O2oMallSku | null => {
  const activeSkus = (product.skus ?? []).filter((sku) => sku.isActive !== false)
  return activeSkus[0] ?? null
}

const resolveCartItemId = (productId: string, skuId: string | null) => skuId || productId

const resolveCartItemThumbnail = (product: Pick<O2oMallProduct, 'thumbnail'>, sku: Pick<O2oMallSku, 'thumbnail'> | null) => {
  const thumbnail = sku?.thumbnail?.trim() || product.thumbnail?.trim() || ''
  return thumbnail || null
}

const createCartItemFromProduct = (product: O2oMallProduct, qty: number, sku: O2oMallSku | null = resolveDefaultSku(product)): ClientCartItem => {
  const skuUnavailable = (product.skus?.length ?? 0) > 0 && (!sku || sku.isActive === false)
  const productPrice = resolveO2oPriceView(product)
  const price = skuUnavailable ? productPrice : (sku ?? productPrice)
  const skuId = skuUnavailable ? null : (sku?.id ?? null)
  return {
    productId: product.id,
    skuId,
    productName: product.productName,
    thumbnail: resolveCartItemThumbnail(product, sku),
    specText: skuUnavailable ? null : (sku?.specText ?? null),
    defaultPrice: !skuUnavailable && sku ? sku.discountedPrice : productPrice.unitPrice,
    originalPrice: price.originalPrice,
    discountRate: price.discountRate,
    discountedPrice: price.discountedPrice,
    limitPerUser: Math.max(0, Number(product.limitPerUser ?? 0)),
    availableStock: skuUnavailable ? 0 : Math.max(0, Number(sku?.availableStock ?? product.availableStock ?? 0)),
    qty: Math.max(0, Math.floor(qty)),
    selected: true,
  }
}

export const useClientCartStore = defineStore('client-cart', () => {
  const clientUserId = ref('')
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
    if (!clientUserId.value) {
      return
    }

    // 本地快照除了数量，还保留库存与限购字段：
    // 这样页面刷新后仍能先恢复可视状态，再等待目录接口回填最新库存。
    const snapshot: ClientCartSnapshotItem[] = items.value.map((item) => ({
      productId: item.productId,
      skuId: item.skuId,
      productName: item.productName,
      thumbnail: item.thumbnail,
      specText: item.specText,
      defaultPrice: item.defaultPrice,
      originalPrice: item.originalPrice,
      discountRate: item.discountRate,
      discountedPrice: item.discountedPrice,
      limitPerUser: item.limitPerUser,
      availableStock: item.availableStock,
      qty: item.qty,
      selected: item.selected,
    }))

    persistClientCartSnapshot(clientUserId.value, snapshot)
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

  const resetState = () => {
    items.value = []
  }

  const normalizeClientUserId = (value: string | number | null | undefined): string => {
    if (typeof value === 'string') {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value).trim()
    }
    return ''
  }

  const replaceItems = (nextItems: ClientCartItem[]) => {
    items.value = nextItems.map(normalizeItem).filter((item) => item.qty > 0)
    persist()
  }

  const initialize = (nextClientUserId: string | number | null | undefined) => {
    const normalizedClientUserId = normalizeClientUserId(nextClientUserId)
    if (!normalizedClientUserId) {
      clientUserId.value = ''
      resetState()
      initialized.value = true
      return
    }

    const switchedUser = clientUserId.value !== normalizedClientUserId
    if (initialized.value && !switchedUser) {
      return
    }

    clientUserId.value = normalizedClientUserId
    resetState()
    const persisted = readPersistedClientCartSnapshot(normalizedClientUserId)
    // 持久化快照读取后仍需再次标准化，避免旧版本缓存或异常值污染当前会话。
    replaceItems(persisted)
    initialized.value = true
  }

  const ensureInitialized = () => {
    if (!initialized.value) {
      initialize(clientUserId.value)
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
        const latestSku = item.skuId
          ? latest.skus?.find((sku) => sku.id === item.skuId && sku.isActive !== false) ?? null
          : resolveDefaultSku(latest)
        const productPrice = resolveO2oPriceView(latest)
        const latestPrice = latestSku ?? productPrice
        const skuUnavailable = (latest.skus?.length ?? 0) > 0 && !latestSku
        return normalizeItem({
          ...item,
          skuId: latestSku?.id ?? item.skuId,
          specText: latestSku?.specText ?? item.specText,
          productName: latest.productName,
          thumbnail: resolveCartItemThumbnail(latest, latestSku),
          defaultPrice: latestSku ? latestSku.discountedPrice : productPrice.unitPrice,
          originalPrice: latestPrice.originalPrice,
          discountRate: latestPrice.discountRate,
          discountedPrice: latestPrice.discountedPrice,
          availableStock: skuUnavailable ? 0 : Math.max(0, Number(latestSku?.availableStock ?? latest.availableStock ?? 0)),
          limitPerUser: Math.max(0, Number(latest.limitPerUser ?? 0)),
          selected: skuUnavailable ? false : item.selected,
        })
      })
      .filter((item) => item.qty > 0)

    replaceItems(nextItems)
  }

  const addProduct = (product: O2oMallProduct, qty = 1, sku: O2oMallSku | null = resolveDefaultSku(product)) => {
    ensureInitialized()
    const targetQty = Math.max(1, Math.floor(qty))
    const itemId = resolveCartItemId(product.id, sku?.id ?? null)
    const itemIndex = items.value.findIndex((item) => resolveCartItemId(item.productId, item.skuId) === itemId)

    if (itemIndex === -1) {
      const draft = createCartItemFromProduct(product, targetQty, sku)
      const maxQty = toMaxQty(draft)
      if (maxQty <= 0) {
        showAppWarning('该商品库存不足或已达单人限购上限')
        return 0
      }
      const actualAdd = Math.min(targetQty, maxQty)
      if (targetQty > maxQty) {
        showAppWarning(`最多只能加购 ${maxQty} 件`)
      }
      items.value.push({
        ...draft,
        qty: actualAdd,
      })
      persist()
      return actualAdd
    }

    const existing = items.value[itemIndex]
    const merged = createCartItemFromProduct(product, existing.qty + targetQty, sku)
    const maxQty = toMaxQty(merged)

    if (existing.qty >= maxQty) {
      showAppWarning('购物车内已达单人限购上限或最大库存')
      return 0
    }

    const nextQty = Math.min(existing.qty + targetQty, maxQty)
    if (existing.qty + targetQty > maxQty) {
      showAppWarning(`最多只能加购至 ${maxQty} 件`)
    }

    items.value[itemIndex] = {
      ...existing,
      ...merged,
      selected: maxQty > 0 ? existing.selected : false,
      qty: Math.max(0, nextQty),
    }
    items.value = items.value.filter((item) => item.qty > 0)
    persist()
    return nextQty - existing.qty
  }

  const updateQty = (productId: string, qty: number) => {
    ensureInitialized()
    const itemIndex = items.value.findIndex((item) => resolveCartItemId(item.productId, item.skuId) === productId || item.productId === productId)
    if (itemIndex === -1) {
      return
    }

    const item = items.value[itemIndex]
    const maxQty = toMaxQty(item)
    const nextQty = Math.min(Math.max(0, Math.floor(qty)), maxQty)

    if (qty > item.qty && item.qty >= maxQty) {
      showAppWarning('购物车内已达单人限购上限或最大库存')
      return
    }

    if (nextQty <= 0) {
      items.value = items.value.filter((entry) => resolveCartItemId(entry.productId, entry.skuId) !== productId && entry.productId !== productId)
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
    const target = items.value.find((item) => resolveCartItemId(item.productId, item.skuId) === productId || item.productId === productId)
    if (!target) {
      return
    }
    updateQty(productId, target.qty + delta)
  }

  const removeItem = (productId: string) => {
    ensureInitialized()
    items.value = items.value.filter((item) => resolveCartItemId(item.productId, item.skuId) !== productId && item.productId !== productId)
    persist()
  }

  const clearSelectedItems = () => {
    ensureInitialized()
    // 这里按“勾选状态”而非“有效状态”清理，便于购物车页做批量删除操作。
    items.value = items.value.filter((item) => !item.selected)
    persist()
  }

  const clearAll = () => {
    const currentClientUserId = clientUserId.value
    resetState()
    clientUserId.value = ''
    initialized.value = false
    clearPersistedClientCartSnapshot(currentClientUserId)
  }

  const toggleItemSelected = (productId: string, selected: boolean) => {
    ensureInitialized()
    items.value = items.value.map((item) => {
      if ((resolveCartItemId(item.productId, item.skuId) !== productId && item.productId !== productId) || toMaxQty(item) <= 0) {
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
    clientUserId,
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
