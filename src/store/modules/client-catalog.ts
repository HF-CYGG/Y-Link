/**
 * 模块说明：src/store/modules/client-catalog.ts
 * 文件职责：维护客户端商城商品目录、分类/搜索上下文与本地缓存，并承接下单成功后的局部库存回写。
 * 实现逻辑：
 * - 商品目录缓存按客户端账号隔离，支持商城页快速恢复列表、分类与搜索上下文；
 * - 页面层刷新商品目录时统一通过 Store 落盘，避免不同页面各自维护一份商品快照；
 * - 预订单提交成功后，仅按已提交商品局部修正预订库存与可预订库存，减少返回商城时的整页等待。
 * 维护说明：
 * - 若后续商品目录字段继续扩展，需要同步检查持久化结构与局部回写逻辑；
 * - 若库存口径改为以后端聚合字段为准，应优先调整 `applyPreorderSubmission` 的增量计算方式。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { O2oMallProduct } from '@/api/modules/o2o'
import {
  clearPersistedClientCatalogSnapshot,
  persistClientCatalogBrowseContextSnapshot,
  persistClientCatalogDataSnapshot,
  readPersistedClientCatalogSnapshot,
} from '@/utils/client-catalog-storage'

// 商品目录缓存时间不宜过长：
// - 过短会导致用户切页返回时仍频繁请求接口；
// - 过长则容易让库存、上下架状态过旧。
const CLIENT_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000

export const useClientCatalogStore = defineStore('client-catalog', () => {
  const clientUserId = ref('')
  const products = ref<O2oMallProduct[]>([])
  const activeCategoryKey = ref('all')
  const keyword = ref('')
  const updatedAt = ref(0)
  const initialized = ref(false)

  const isFresh = computed(() => Date.now() - updatedAt.value <= CLIENT_CATALOG_CACHE_TTL_MS)

  const persistCatalogDataSnapshot = () => {
    if (!clientUserId.value) {
      return
    }

    // 商品数据是最大的一块本地缓存，只在真正刷新目录或库存局部回写后落盘，
    // 避免用户每次切分类、改搜索词都重复序列化整份商品数组。
    persistClientCatalogDataSnapshot(clientUserId.value, {
      products: products.value,
      updatedAt: updatedAt.value,
    })
  }

  const persistBrowseContextSnapshot = () => {
    if (!clientUserId.value) {
      return
    }

    // 浏览上下文独立落盘后，商城页可以在不触碰商品数组缓存的前提下持续记录分类与搜索状态。
    persistClientCatalogBrowseContextSnapshot(clientUserId.value, {
      activeCategoryKey: activeCategoryKey.value,
      keyword: keyword.value,
    })
  }

  const replaceProducts = (nextProducts: O2oMallProduct[], options: { touchUpdatedAt: boolean }) => {
    products.value = nextProducts
    if (options.touchUpdatedAt) {
      // 只要商品列表发生真实刷新，就更新时间戳，让页面层能判断当前缓存是否仍可复用。
      updatedAt.value = Date.now()
    }
    persistCatalogDataSnapshot()
  }

  const resetState = () => {
    products.value = []
    activeCategoryKey.value = 'all'
    keyword.value = ''
    updatedAt.value = 0
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
    const snapshot = readPersistedClientCatalogSnapshot(normalizedClientUserId)
    if (snapshot) {
      // 初始化阶段只负责恢复本地快照，不在这里校验新鲜度；
      // 是否需要重新拉取接口由页面层结合 isFresh 决定，职责更清晰。
      products.value = snapshot.products
      activeCategoryKey.value = snapshot.activeCategoryKey
      keyword.value = snapshot.keyword
      updatedAt.value = snapshot.updatedAt
    }
    initialized.value = true
  }

  const setProducts = (nextProducts: O2oMallProduct[]) => {
    replaceProducts(nextProducts, { touchUpdatedAt: true })
  }

  const applyPreorderSubmission = (submittedItems: Array<{ productId: string | number; qty: number }>) => {
    if (!products.value.length || !submittedItems.length) {
      return
    }

    // 下单成功后的局部刷新只修正本次已知变更：
    // - `currentStock` 仍由线下核销时真实扣减，因此这里不改；
    // - `preOrderedStock` 增加本次预订数量；
    // - `availableStock` 重新按“现货库存 - 预订占用”即时回算。
    const preorderQtyMap = new Map<string, number>()
    submittedItems.forEach((item) => {
      const normalizedProductId = String(item.productId ?? '').trim()
      const normalizedQty = Math.max(0, Math.floor(Number(item.qty ?? 0)))
      if (!normalizedProductId || normalizedQty <= 0) {
        return
      }
      preorderQtyMap.set(normalizedProductId, (preorderQtyMap.get(normalizedProductId) ?? 0) + normalizedQty)
    })
    if (!preorderQtyMap.size) {
      return
    }

    let hasPatchedProduct = false
    const nextProducts = products.value.map((product) => {
      const patchQty = preorderQtyMap.get(String(product.id))
      if (!patchQty) {
        return product
      }
      hasPatchedProduct = true
      const nextPreOrderedStock = Math.max(0, Number(product.preOrderedStock ?? 0) + patchQty)
      const nextAvailableStock = Math.max(0, Number(product.currentStock ?? 0) - nextPreOrderedStock)
      return {
        ...product,
        preOrderedStock: nextPreOrderedStock,
        availableStock: nextAvailableStock,
      }
    })
    if (!hasPatchedProduct) {
      return
    }
    // 局部刷新不应把目录误判为“刚刚完成整量同步”，因此保留原始更新时间戳。
    replaceProducts(nextProducts, { touchUpdatedAt: false })
  }

  const setActiveCategoryKey = (key: string) => {
    activeCategoryKey.value = key || 'all'
    persistBrowseContextSnapshot()
  }

  const setKeyword = (value: string) => {
    keyword.value = value
    persistBrowseContextSnapshot()
  }

  const clearAll = () => {
    const currentClientUserId = clientUserId.value
    resetState()
    clientUserId.value = ''
    initialized.value = false
    clearPersistedClientCatalogSnapshot(currentClientUserId)
  }

  return {
    clientUserId,
    products,
    activeCategoryKey,
    keyword,
    updatedAt,
    initialized,
    isFresh,
    initialize,
    setProducts,
    applyPreorderSubmission,
    setActiveCategoryKey,
    setKeyword,
    clearAll,
  }
})
