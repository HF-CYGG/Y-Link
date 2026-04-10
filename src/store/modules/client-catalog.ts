import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { O2oMallProduct } from '@/api/modules/o2o'
import { persistClientCatalogSnapshot, readPersistedClientCatalogSnapshot } from '@/utils/client-catalog-storage'

const CLIENT_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000

export const useClientCatalogStore = defineStore('client-catalog', () => {
  const products = ref<O2oMallProduct[]>([])
  const activeCategoryKey = ref('all')
  const keyword = ref('')
  const updatedAt = ref(0)
  const initialized = ref(false)

  const isFresh = computed(() => Date.now() - updatedAt.value <= CLIENT_CATALOG_CACHE_TTL_MS)

  const persist = () => {
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
      products.value = snapshot.products
      activeCategoryKey.value = snapshot.activeCategoryKey
      keyword.value = snapshot.keyword
      updatedAt.value = snapshot.updatedAt
    }
    initialized.value = true
  }

  const setProducts = (nextProducts: O2oMallProduct[]) => {
    products.value = nextProducts
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
