<script setup lang="ts">
import { useVirtualList } from '@vueuse/core'
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getO2oMallProducts, type O2oMallProduct } from '@/api/modules/o2o'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import { useClientCartStore, useClientCatalogStore } from '@/store'
import { normalizeRequestError } from '@/utils/error'

interface ProductCategoryGroup {
  key: string
  label: string
  items: O2oMallProduct[]
}

const router = useRouter()
const clientCartStore = useClientCartStore()
const clientCatalogStore = useClientCatalogStore()
const { runLatest } = useStableRequest()

const loading = ref(false)
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const keyword = computed({
  get: () => clientCatalogStore.keyword,
  set: (value: string) => clientCatalogStore.setKeyword(value),
})
const activeCategoryKey = computed({
  get: () => clientCatalogStore.activeCategoryKey,
  set: (value: string) => clientCatalogStore.setActiveCategoryKey(value),
})
const detailVisible = ref(false)
const detailQty = ref(1)
const detailProduct = ref<O2oMallProduct | null>(null)
const miniCartVisible = ref(false)
const settlePulsing = ref(false)

const listScrollerRef = ref<HTMLElement | null>(null)
const sectionRefMap = reactive<Record<string, HTMLElement | null>>({})
const scrollingByCategoryClick = ref(false)

clientCartStore.initialize()
clientCatalogStore.initialize()

const products = computed(() => clientCatalogStore.products)

const classifyProduct = (product: O2oMallProduct) => {
  const code = product.productCode.trim()
  if (code.includes('-')) {
    return code.split('-')[0] || '默认分组'
  }
  if (code.length >= 2) {
    return code.slice(0, 2)
  }
  return '默认分组'
}

const categoryGroups = computed<ProductCategoryGroup[]>(() => {
  const groupMap = new Map<string, O2oMallProduct[]>()
  products.value.forEach((product) => {
    const key = classifyProduct(product)
    const grouped = groupMap.get(key)
    if (grouped) {
      grouped.push(product)
      return
    }
    groupMap.set(key, [product])
  })

  return [...groupMap.entries()]
    .sort((prev, next) => prev[0].localeCompare(next[0], 'zh-Hans-CN'))
    .map(([key, items]) => ({
      key,
      label: key,
      items,
    }))
})

const searchMode = computed(() => keyword.value.trim().length > 0)
const largeDatasetMode = computed(() => products.value.length > 100)

const categoryOptions = computed(() => {
  return [{ key: 'all', label: '全部', count: products.value.length }].concat(
    categoryGroups.value.map((group) => ({
      key: group.key,
      label: group.label,
      count: group.items.length,
    })),
  )
})

const searchResults = computed(() => {
  const normalizedKeyword = keyword.value.trim().toLowerCase()
  if (!normalizedKeyword) {
    return []
  }

  return products.value.filter((product) => {
    const text = `${product.productName} ${product.productCode} ${product.detailContent ?? ''}`.toLowerCase()
    return text.includes(normalizedKeyword)
  })
})

const bottomSelectedQty = computed(() => clientCartStore.totalQty)
const bottomSelectedTypeCount = computed(() => clientCartStore.items.length)
const isOffline = computed(() => requestError.value?.type === 'offline')
const activeCategoryItems = computed(() => {
  if (activeCategoryKey.value === 'all') {
    return products.value
  }
  return categoryGroups.value.find((group) => group.key === activeCategoryKey.value)?.items ?? []
})
const virtualSource = computed(() => {
  if (searchMode.value) {
    return searchResults.value
  }
  if (largeDatasetMode.value) {
    return activeCategoryItems.value
  }
  return [] as O2oMallProduct[]
})
const { list: virtualRows, containerProps: virtualContainerProps, wrapperProps: virtualWrapperProps } = useVirtualList(virtualSource, {
  itemHeight: 98,
  overscan: 6,
})

const triggerSettlePulse = () => {
  settlePulsing.value = false
  globalThis.window.setTimeout(() => {
    settlePulsing.value = true
    globalThis.window.setTimeout(() => {
      settlePulsing.value = false
    }, 360)
  }, 12)
}

const warmupProductImages = (items: O2oMallProduct[]) => {
  if (typeof globalThis.window === 'undefined') {
    return
  }
  const warmup = () => {
    items
      .filter((item) => Boolean(item.thumbnail))
      .slice(0, 12)
      .forEach((item) => {
        if (!item.thumbnail) {
          return
        }
        const image = new Image()
        image.src = item.thumbnail
      })
  }
  if (typeof globalThis.window.requestIdleCallback === 'function') {
    globalThis.window.requestIdleCallback(warmup, { timeout: 800 })
    return
  }
  globalThis.window.setTimeout(warmup, 180)
}

const loadProducts = async (force = false) => {
  if (!force && clientCatalogStore.products.length > 0 && clientCatalogStore.isFresh) {
    requestError.value = null
    clientCartStore.syncWithCatalog(clientCatalogStore.products)
    return
  }
  loading.value = clientCatalogStore.products.length === 0
  requestError.value = null
  await runLatest({
    executor: (signal) => getO2oMallProducts({ signal }),
    onSuccess: async (result) => {
      clientCatalogStore.setProducts(result)
      clientCartStore.syncWithCatalog(result)
      warmupProductImages(result)
      const activeExists = categoryOptions.value.some((option) => option.key === activeCategoryKey.value)
      if (!activeExists) {
        activeCategoryKey.value = 'all'
      }
      await nextTick()
      handleProductListScroll()
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '商品加载失败，请稍后重试')
      requestError.value = {
        type: globalThis.navigator.onLine === false ? 'offline' : 'error',
        message: normalizedError.message,
      }
    },
    onFinally: () => {
      loading.value = false
    },
  })
}

const setSectionRef = (key: string, element: unknown) => {
  sectionRefMap[key] = element instanceof HTMLElement ? element : null
}

const openProductDetail = (product: O2oMallProduct) => {
  detailProduct.value = product
  detailQty.value = 1
  detailVisible.value = true
}

const changeDetailQty = (delta: number) => {
  if (!detailProduct.value) {
    return
  }
  const maxQty = Math.max(0, Math.min(detailProduct.value.availableStock, detailProduct.value.limitPerUser))
  detailQty.value = Math.min(maxQty, Math.max(1, detailQty.value + delta))
}

const addCurrentDetailToCart = () => {
  if (!detailProduct.value) {
    return
  }
  const finalQty = clientCartStore.addProduct(detailProduct.value, detailQty.value)
  if (finalQty <= 0) {
    ElMessage.warning('该商品当前不可预订')
    return
  }
  ElMessage.success('已加入购物车')
  triggerSettlePulse()
  detailVisible.value = false
}

const quickAdd = (product: O2oMallProduct) => {
  const qty = clientCartStore.addProduct(product, 1)
  if (qty <= 0) {
    ElMessage.warning('库存不足或已达限购上限')
    return
  }
  ElMessage.success('已加入购物车')
  triggerSettlePulse()
}

const scrollToCategory = async (categoryKey: string) => {
  activeCategoryKey.value = categoryKey
  if (largeDatasetMode.value) {
    return
  }
  if (categoryKey === 'all') {
    listScrollerRef.value?.scrollTo({
      top: 0,
      behavior: 'smooth',
    })
    return
  }

  scrollingByCategoryClick.value = true
  await nextTick()
  const section = sectionRefMap[categoryKey]
  if (!section) {
    scrollingByCategoryClick.value = false
    return
  }

  section.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  })
  globalThis.window.setTimeout(() => {
    scrollingByCategoryClick.value = false
  }, 320)
}

const handleProductListScroll = () => {
  if (searchMode.value || scrollingByCategoryClick.value || largeDatasetMode.value) {
    return
  }

  const scroller = listScrollerRef.value
  if (!scroller) {
    return
  }

  const top = scroller.scrollTop + 24
  let matched = 'all'
  for (const group of categoryGroups.value) {
    const element = sectionRefMap[group.key]
    if (!element) {
      continue
    }
    const sectionTop = element.offsetTop
    if (sectionTop <= top) {
      matched = group.key
    } else {
      break
    }
  }
  activeCategoryKey.value = matched
}

const goToCheckout = async () => {
  if (!clientCartStore.selectedValidItems.length) {
    if (clientCartStore.validItems.length > 0) {
      clientCartStore.toggleAllValidSelected(true)
    } else {
      ElMessage.warning('购物车暂无可结算商品')
      return
    }
  }

  miniCartVisible.value = false
  await router.push('/client/checkout')
}

onMounted(async () => {
  await loadProducts()
})
</script>

<template>
  <section class="space-y-4 pb-20">
    <div class="overflow-hidden rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">CLIENT MALL</p>
          <p class="mt-1 text-xl font-semibold text-slate-900">商城</p>
          <p class="mt-1 text-sm text-slate-500">浏览分类、查看库存并快速加入购物车</p>
        </div>
        <button
          type="button"
          class="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600"
          :disabled="loading"
          @click="loadProducts(true)"
        >
          刷新库存
        </button>
      </div>
      <div class="mt-4 grid gap-3 sm:grid-cols-3">
        <div class="rounded-2xl bg-teal-50 px-3 py-3 text-sm text-teal-700">营业时间：08:30 - 20:30</div>
        <div class="rounded-2xl bg-slate-100 px-3 py-3 text-sm text-slate-700">提货须知：请在订单有效期内到店核销</div>
        <div class="rounded-2xl bg-amber-50 px-3 py-3 text-sm text-amber-700">公告：库存实时刷新，请以下单结果为准</div>
      </div>
    </div>

    <div class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex items-center gap-3">
        <input
          v-model.trim="keyword"
          class="h-11 flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-teal-300"
          placeholder="搜索商品名称 / 编码"
        />
        <button
          type="button"
          class="h-11 rounded-full border border-slate-200 px-4 text-sm text-slate-600"
          @click="keyword = ''"
        >
          清空
        </button>
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <span class="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">推荐：热销</span>
        <span class="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">推荐：新品</span>
        <span class="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">推荐：低库存优先</span>
      </div>
    </div>

    <div v-if="loading" class="grid gap-3 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div v-for="index in 6" :key="index" class="h-[5.8rem] animate-pulse rounded-2xl bg-slate-100" />
    </div>
    <BaseRequestState
      v-else-if="requestError"
      :type="isOffline ? 'offline' : 'error'"
      :title="isOffline ? '网络异常' : '加载失败'"
      :description="requestError.message"
      action-text="重试"
      @retry="loadProducts(true)"
    />
    <BaseRequestState
      v-else-if="!products.length"
      type="empty"
      title="暂无上架商品"
      description="请稍后刷新或联系管理员补货"
      action-text="刷新库存"
      @retry="loadProducts(true)"
    />
    <BaseRequestState
      v-else-if="searchMode && !searchResults.length"
      type="empty"
      title="未找到相关商品"
      description="请尝试其他关键字"
      action-text="清空搜索"
      @retry="keyword = ''"
    />

    <section v-else-if="searchMode || largeDatasetMode" class="space-y-3 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <header class="flex items-center justify-between">
        <p class="text-sm font-semibold text-slate-700">
          {{ searchMode ? `搜索结果 ${searchResults.length} 条` : `大数据模式 · 当前展示 ${activeCategoryItems.length} 条` }}
        </p>
      </header>
      <div class="max-h-[64vh] overflow-y-auto pr-1" v-bind="virtualContainerProps">
        <div v-bind="virtualWrapperProps">
          <article v-for="row in virtualRows" :key="row.index" class="client-product-card mb-2">
            <button type="button" class="client-product-card__body" @click="openProductDetail(row.data)">
              <img
                v-if="row.data.thumbnail"
                :src="row.data.thumbnail"
                :alt="row.data.productName"
                class="client-product-card__cover"
                loading="lazy"
                decoding="async"
              />
              <div v-else class="client-product-card__cover grid place-content-center text-xs text-slate-400">暂无图片</div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-base font-semibold text-slate-900">{{ row.data.productName }}</p>
                <p class="mt-1 text-xs text-slate-400">{{ row.data.productCode }}</p>
                <div class="mt-2 flex flex-wrap gap-2 text-xs">
                  <span class="rounded-full bg-emerald-50 px-2 py-1 text-emerald-600">可预订 {{ row.data.availableStock }}</span>
                  <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-600">已预订 {{ row.data.preOrderedStock }}</span>
                </div>
              </div>
            </button>
            <button type="button" class="client-product-card__add-button" @click="quickAdd(row.data)">+ 加购</button>
          </article>
        </div>
      </div>
    </section>

    <section v-else class="grid grid-cols-[88px_minmax(0,1fr)] gap-3 rounded-[1.4rem] bg-white p-3 shadow-[var(--ylink-shadow-soft)]">
      <aside class="max-h-[64vh] overflow-y-auto pr-1">
        <button
          v-for="category in categoryOptions"
          :key="category.key"
          type="button"
          class="mb-2 w-full rounded-xl px-2 py-2 text-left text-xs text-slate-500"
          :class="activeCategoryKey === category.key ? 'bg-slate-900 text-white' : 'bg-slate-100'"
          @click="scrollToCategory(category.key)"
        >
          <p class="truncate font-medium">{{ category.label }}</p>
          <p class="mt-0.5 opacity-75">{{ category.count }} 款</p>
        </button>
      </aside>
      <div ref="listScrollerRef" class="max-h-[64vh] overflow-y-auto pr-1" @scroll="handleProductListScroll">
        <section
          v-for="group in categoryGroups"
          :key="group.key"
          :ref="(el) => setSectionRef(group.key, el)"
          class="mb-4"
        >
          <header class="sticky top-0 z-10 mb-2 rounded-lg bg-white/95 px-1 py-1.5 text-sm font-semibold text-slate-700">
            {{ group.label }}
          </header>
          <article v-for="product in group.items" :key="product.id" class="client-product-card mb-2">
            <button type="button" class="client-product-card__body" @click="openProductDetail(product)">
              <img
                v-if="product.thumbnail"
                :src="product.thumbnail"
                :alt="product.productName"
                class="client-product-card__cover"
                loading="lazy"
                decoding="async"
              />
              <div v-else class="client-product-card__cover grid place-content-center text-xs text-slate-400">暂无图片</div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-base font-semibold text-slate-900">{{ product.productName }}</p>
                <p class="mt-1 text-xs text-slate-400">{{ product.productCode }}</p>
                <div class="mt-2 flex flex-wrap gap-2 text-xs">
                  <span class="rounded-full bg-emerald-50 px-2 py-1 text-emerald-600">可预订 {{ product.availableStock }}</span>
                  <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-600">已预订 {{ product.preOrderedStock }}</span>
                </div>
              </div>
            </button>
            <button type="button" class="client-product-card__add-button" @click="quickAdd(product)">+ 加购</button>
          </article>
        </section>
      </div>
    </section>

    <div
      class="client-mall-settle fixed bottom-[82px] left-1/2 z-20 flex w-[min(640px,calc(100vw-1.5rem))] -translate-x-1/2 items-center justify-between rounded-[1.2rem] border border-white/55 bg-slate-900/90 px-4 py-3 text-white backdrop-blur-2xl"
      :class="settlePulsing ? 'is-pulse' : ''"
    >
      <button type="button" class="text-left" @click="miniCartVisible = true">
        <p class="text-sm font-semibold">购物车 {{ bottomSelectedTypeCount }} 种 · {{ bottomSelectedQty }} 件</p>
        <p class="text-xs text-white/70">点击展开迷你购物车</p>
      </button>
      <button type="button" class="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900" @click="goToCheckout">
        去结算
      </button>
    </div>

    <ElDrawer
      v-model="detailVisible"
      title="商品详情"
      direction="btt"
      size="74%"
      append-to-body
      :with-header="false"
    >
      <section v-if="detailProduct" class="space-y-4 pb-2">
        <img
          v-if="detailProduct.thumbnail"
          :src="detailProduct.thumbnail"
          :alt="detailProduct.productName"
          class="h-44 w-full rounded-2xl object-cover"
          loading="lazy"
          decoding="async"
        />
        <div class="space-y-2">
          <p class="text-lg font-semibold text-slate-900">{{ detailProduct.productName }}</p>
          <p class="text-sm text-slate-500">{{ detailProduct.detailContent || '暂无商品描述' }}</p>
          <div class="flex flex-wrap gap-2 text-xs">
            <span class="rounded-full bg-emerald-50 px-3 py-1 text-emerald-600">可预订 {{ detailProduct.availableStock }}</span>
            <span class="rounded-full bg-amber-50 px-3 py-1 text-amber-600">已预订 {{ detailProduct.preOrderedStock }}</span>
            <span class="rounded-full bg-slate-100 px-3 py-1 text-slate-600">限购 {{ detailProduct.limitPerUser }}</span>
          </div>
        </div>
        <div class="flex items-center justify-between rounded-2xl bg-slate-100 px-3 py-2">
          <span class="text-sm text-slate-600">数量</span>
          <div class="flex items-center gap-2">
            <button type="button" class="client-qty-button" @click="changeDetailQty(-1)">-</button>
            <span class="min-w-8 text-center text-sm font-semibold">{{ detailQty }}</span>
            <button type="button" class="client-qty-button" @click="changeDetailQty(1)">+</button>
          </div>
        </div>
        <button type="button" class="h-11 w-full rounded-full bg-slate-900 text-sm font-semibold text-white" @click="addCurrentDetailToCart">
          加入购物车
        </button>
      </section>
    </ElDrawer>

    <ElDrawer
      v-model="miniCartVisible"
      title="迷你购物车"
      direction="btt"
      size="62%"
      append-to-body
    >
      <section class="space-y-3">
        <article v-for="item in clientCartStore.items" :key="item.productId" class="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-slate-800">{{ item.productName }}</p>
            <p class="text-xs text-slate-400">可预订 {{ item.availableStock }} · 限购 {{ item.limitPerUser }}</p>
          </div>
          <div class="ml-3 flex items-center gap-2">
            <button type="button" class="client-qty-button" @click="clientCartStore.incrementQty(item.productId, -1)">-</button>
            <span class="min-w-7 text-center text-sm">{{ item.qty }}</span>
            <button type="button" class="client-qty-button" @click="clientCartStore.incrementQty(item.productId, 1)">+</button>
          </div>
        </article>
        <div v-if="!clientCartStore.items.length" class="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
          购物车为空，先挑选商品吧
        </div>
        <div class="flex gap-2 pt-2">
          <button
            type="button"
            class="h-10 flex-1 rounded-full border border-slate-200 text-sm text-slate-600"
            @click="router.push('/client/cart')"
          >
            进入购物车
          </button>
          <button type="button" class="h-10 flex-1 rounded-full bg-slate-900 text-sm font-semibold text-white" @click="goToCheckout">
            去结算
          </button>
        </div>
      </section>
    </ElDrawer>
  </section>
</template>

<style scoped>
.client-product-card {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border-radius: 1rem;
  background: #f8fafc;
  padding: 0.45rem;
}

.client-product-card__body {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 0.7rem;
  border: none;
  background: transparent;
  text-align: left;
  padding: 0;
}

.client-product-card__cover {
  height: 4.4rem;
  width: 4.4rem;
  flex-shrink: 0;
  border-radius: 0.9rem;
  background: #e2e8f0;
  object-fit: cover;
}

.client-product-card__add-button {
  height: 2.15rem;
  border-radius: 9999px;
  border: none;
  background: #0f172a;
  color: #ffffff;
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0 0.8rem;
}

.client-qty-button {
  height: 1.85rem;
  width: 1.85rem;
  border-radius: 9999px;
  border: none;
  background: #0f172a;
  color: #ffffff;
}

.client-mall-settle {
  box-shadow: var(--ylink-shadow-floating);
}

.client-mall-settle.is-pulse {
  animation: settle-pulse 0.36s ease;
}

@keyframes settle-pulse {
  0% {
    transform: translate(-50%, 0) scale(1);
  }
  50% {
    transform: translate(-50%, -2px) scale(1.02);
  }
  100% {
    transform: translate(-50%, 0) scale(1);
  }
}
</style>
