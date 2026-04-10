/**
 * 模块说明：src/store/modules/client-catalog.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { O2oMallProduct } from '@/api/modules/o2o'
import { persistClientCatalogSnapshot, readPersistedClientCatalogSnapshot } from '@/utils/client-catalog-storage'

// 商品目录缓存时间不宜过长：
// - 过短会导致用户切页返回时仍频繁请求接口；
// - 过长则容易让库存、上下架状态过旧。
const CLIENT_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000

export const useClientCatalogStore = defineStore('client-catalog', () => {
  const products = ref<O2oMallProduct[]>([])
  const activeCategoryKey = ref('all')
  const keyword = ref('')
  const updatedAt = ref(0)
  const initialized = ref(false)

  const isFresh = computed(() => Date.now() - updatedAt.value <= CLIENT_CATALOG_CACHE_TTL_MS)

  const persist = () => {
    // 目录快照除了商品数据，还需要保留“当前分类 + 搜索词”，这样用户返回商城页时能完整恢复浏览上下文。
    persistClientCatalogSnapshot({
      products: products.value,
      activeCategoryKey: activeCategoryKey.value,
      keyword: keyword.value,
      updatedAt: updatedAt.value,
    })
  }

  const initialize = () => {
    if (initialized.value) {
      return
    }
    const snapshot = readPersistedClientCatalogSnapshot()
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
    products.value = nextProducts
    // 只要商品列表发生刷新，就更新时间戳，让页面层能判断当前缓存是否仍可复用。
    updatedAt.value = Date.now()
    persist()
  }

  const setActiveCategoryKey = (key: string) => {
    activeCategoryKey.value = key || 'all'
    persist()
  }

  const setKeyword = (value: string) => {
    keyword.value = value
    persist()
  }

  return {
    products,
    activeCategoryKey,
    keyword,
    updatedAt,
    initialized,
    isFresh,
    initialize,
    setProducts,
    setActiveCategoryKey,
    setKeyword,
  }
})
