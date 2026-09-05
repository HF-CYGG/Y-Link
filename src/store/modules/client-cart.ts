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
  availabilityStatus: ClientCartAvailabilityStatus
}

export type ClientCartAvailabilityStatus = 'available' | 'out_of_stock' | 'product_unavailable' | 'sku_unavailable'

export interface ClientCartCheckoutConflict {
  item: ClientCartItem
  availableQty: number
  message: string
}

// 购物车单项最大可购买数量由“可预订库存”和“单人限购”共同决定。
// 统一用于主动增减和冲突提示，不得用它在缓存恢复或目录刷新时静默缩量。
export const resolveClientCartMaxQty = (item: Pick<ClientCartItem, 'availableStock' | 'limitPerUser'>) => {
  const stock = Math.max(0, item.availableStock)
  const limit = Math.max(0, item.limitPerUser)
  if (limit <= 0) {
    return stock
  }
  return Math.min(stock, limit)
}

const resolveAvailabilityStatus = (availableStock: number): ClientCartAvailabilityStatus => (
  availableStock > 0 ? 'available' : 'out_of_stock'
)

const resolveCartConflict = (item: ClientCartItem): ClientCartCheckoutConflict | null => {
  const availableQty = resolveClientCartMaxQty(item)
  if (item.availabilityStatus === 'product_unavailable') {
    return { item, availableQty: 0, message: '商品已下架或不再可购买' }
  }
  if (item.availabilityStatus === 'sku_unavailable') {
    return { item, availableQty: 0, message: '所选规格已下架或不可购买' }
  }
  if (availableQty <= 0) {
    return { item, availableQty, message: '当前无可购库存或已达限购上限' }
  }
  if (item.qty > availableQty) {
    return { item, availableQty, message: `原选 ${item.qty} 件，当前最多可购 ${availableQty} 件` }
  }
  return null
}

export const resolveClientCartConflictMessage = (item: ClientCartItem) => resolveCartConflict(item)?.message ?? ''

const isCartSkuAvailable = (sku: Pick<O2oMallSku, 'isCurrent' | 'isActive'> | null | undefined) => !!sku && sku.isCurrent !== false && sku.isActive !== false

const resolveDefaultSku = (product: O2oMallProduct): O2oMallSku | null => {
  const activeSkus = (product.skus ?? []).filter(isCartSkuAvailable)
  return activeSkus[0] ?? null
}

const resolveCartItemId = (productId: string, skuId: string | null) => skuId || productId

const resolveCartItemThumbnail = (product: Pick<O2oMallProduct, 'thumbnail'>, sku: Pick<O2oMallSku, 'thumbnail'> | null) => {
  const thumbnail = sku?.thumbnail?.trim() || product.thumbnail?.trim() || ''
  return thumbnail || null
}

const createCartItemFromProduct = (product: O2oMallProduct, qty: number, sku: O2oMallSku | null = resolveDefaultSku(product)): ClientCartItem => {
  const skuUnavailable = (product.skus?.length ?? 0) > 0 && !isCartSkuAvailable(sku)
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
    availabilityStatus: skuUnavailable
      ? 'sku_unavailable'
      : resolveAvailabilityStatus(Math.max(0, Number(sku?.availableStock ?? product.availableStock ?? 0))),
  }
}

export const useClientCartStore = defineStore('client-cart', () => {
  const clientUserId = ref('')
  const items = ref<ClientCartItem[]>([])
  const initialized = ref(false)

  // 这些派生状态尽量只从 items 推导，避免同时维护多份可结算/失效/选中列表造成同步偏差。
  const totalQty = computed(() => items.value.reduce((sum, item) => sum + item.qty, 0))
  const validItems = computed(() => {
    return items.value.filter((item) => !resolveCartConflict(item))
  })
  const invalidItems = computed(() => {
    return items.value.filter((item) => Boolean(resolveCartConflict(item)))
  })
  const selectedValidItems = computed(() => {
    return validItems.value.filter((item) => item.selected)
  })
  const selectedItems = computed(() => items.value.filter((item) => item.selected))
  const selectedQty = computed(() => {
    return selectedItems.value.reduce((sum, item) => sum + item.qty, 0)
  })
  const checkoutConflicts = computed(() => items.value.flatMap((item) => {
    const conflict = resolveCartConflict(item)
    return conflict ? [conflict] : []
  }))
  const selectedCheckoutConflicts = computed(() => checkoutConflicts.value.filter(({ item }) => item.selected))
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
      availabilityStatus: item.availabilityStatus,
    }))

    persistClientCartSnapshot(clientUserId.value, snapshot)
  }

  /**
   * 结算请求只能使用一次性复制出的当前快照：
   * - 调用前页面必须先完成最新目录刷新；
   * - 任何仍被选中的失效/超量行都会让本函数返回 null；
   * - 返回值脱离响应式 item，后续后台刷新不会改写已发出的请求载荷。
   */
  const createSelectedCheckoutSnapshot = () => {
    if (!selectedItems.value.length || selectedCheckoutConflicts.value.length) {
      return null
    }
    return selectedItems.value.map((item) => ({
      productId: item.productId,
      skuId: item.skuId,
      qty: item.qty,
    }))
  }

  const normalizeItem = (item: ClientCartItem) => {
    // 缓存恢复与目录同步只能清理明显非法值，不能代替用户缩量、移除或取消勾选。
    // 可购量变化会由 checkoutConflicts 明确暴露，待用户主动处理后才允许提交。
    const nextQty = Math.max(0, Math.floor(item.qty))
    return {
      ...item,
      qty: nextQty,
      selected: item.selected !== false,
      availabilityStatus: item.availabilityStatus || resolveAvailabilityStatus(item.availableStock),
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
    // 目录刷新只更新可购快照，不能静默缩减 qty、移除行或取消用户原有勾选。
    // 目录中不存在的商品也必须写成不可购，避免继续沿用旧缓存库存。
    const productMap = new Map(products.map((product) => [product.id, product]))
    const nextItems = items.value
      .map((item) => {
        const latest = productMap.get(item.productId)
        if (!latest) {
          return normalizeItem({
            ...item,
            availableStock: 0,
            availabilityStatus: 'product_unavailable',
          })
        }
        const latestSku = item.skuId
          ? latest.skus?.find((sku) => sku.id === item.skuId && isCartSkuAvailable(sku)) ?? null
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
          availabilityStatus: skuUnavailable
            ? 'sku_unavailable'
            : resolveAvailabilityStatus(Math.max(0, Number(latestSku?.availableStock ?? latest.availableStock ?? 0))),
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
      const maxQty = resolveClientCartMaxQty(draft)
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
    const maxQty = resolveClientCartMaxQty(merged)

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
      selected: existing.selected,
      availabilityStatus: merged.availabilityStatus,
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
    const maxQty = resolveClientCartMaxQty(item)
    const nextQty = Math.min(Math.max(0, Math.floor(qty)), maxQty)

    if (qty > maxQty) {
      showAppWarning(maxQty > 0 ? `当前最多可购 ${maxQty} 件，已按可购数量调整` : '该商品库存不足或已达单人限购上限')
      if (maxQty <= 0) {
        return
      }
    }

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
      if (resolveCartItemId(item.productId, item.skuId) !== productId && item.productId !== productId) {
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
      return resolveCartConflict(item) ? item : { ...item, selected }
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
    selectedItems,
    checkoutConflicts,
    selectedCheckoutConflicts,
    createSelectedCheckoutSnapshot,
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
