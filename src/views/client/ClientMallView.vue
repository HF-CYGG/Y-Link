<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientMallView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { useVirtualList } from '@vueuse/core'
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowDown, ArrowRight, ShoppingCart } from '@element-plus/icons-vue'
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
// 搜索词与激活分类直接映射到 Store，保证页面切走后仍能恢复到用户上次浏览上下文。
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

// 商城页属于高频返回页面，初始化时优先恢复购物车与目录缓存，避免每次进入都重置上下文。
clientCartStore.initialize()
clientCatalogStore.initialize()

const products = computed(() => clientCatalogStore.products)

// 当前后端未直接返回业务分类字段，因此前端临时根据商品编码前缀做稳定分组。
// 这样既能满足双栏联动结构，又不会引入额外接口改造。
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

// 搜索模式与大数据模式互斥：
// - 有关键字时优先进入搜索结果态，弱化分类导航；
// - 数据量较大时启用虚拟列表，仅渲染当前分类内的可视区域。
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
    // 搜索同时命中名称、编码与详情文案，兼顾运营配置与用户口语化输入。
    const text = `${product.productName} ${product.productCode} ${product.detailContent ?? ''}`.toLowerCase()
    return text.includes(normalizedKeyword)
  })
})

const bottomSelectedQty = computed(() => clientCartStore.totalQty)
const bottomSelectedTypeCount = computed(() => clientCartStore.items.length)
const isOffline = computed(() => requestError.value?.type === 'offline')
const cartProductPriceMap = computed(() => {
  return new Map(
    products.value.map((product) => [product.id, Math.max(0, Number(product.defaultPrice ?? 0))]),
  )
})
const miniCartTotalAmount = computed(() => {
  return clientCartStore.items.reduce((sum, item) => {
    const unitPrice = cartProductPriceMap.value.get(item.productId) ?? 0
    return sum + unitPrice * item.qty
  }, 0)
})
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

// 结算栏脉冲动效只负责视觉反馈，不参与真实业务状态；通过短暂切换 class 保证重复加购时也能触发。
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
  if (globalThis.window === undefined) {
    return
  }
  // 仅预热首屏附近的小批量图片，避免在慢网环境下一次性抢占过多带宽。
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
  // 如果缓存仍在有效期内，则直接复用本地目录快照，并只同步购物车库存信息。
  // 这样从订单页返回商城页时可以“秒开”，同时避免旧库存继续污染购物车状态。
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
      // 成功返回后同步更新两个域：
      // 1. 目录 Store 负责商品列表、分类与搜索上下文；
      // 2. 购物车 Store 负责把已选商品映射到最新库存/限购规则。
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
        // 网络断开与普通异常拆成两类，便于空态组件输出不同文案与图形提示。
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
  // 详情抽屉中的数量调整同时受库存与单人限购约束，避免前端先放出一个后端必定拒绝的数量。
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
    // 大数据模式下列表按当前分类单独渲染，不再进行 DOM 锚点滚动。
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
    // 搜索模式、点击触发滚动与虚拟列表模式都不适合反向计算激活分类，直接跳过。
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
      // 若用户尚未主动勾选，则默认全选有效商品，减少从商城直达结算的操作成本。
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
    <div class="overflow-hidden rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">CLIENT MALL</p>
          <p class="mt-1 text-xl font-semibold text-slate-900">商城</p>
          <p class="mt-1 text-sm text-slate-500">浏览分类、查看库存并快速加入购物车</p>
        </div>
        <button
          type="button"
          class="rounded-full border border-[var(--ylink-color-border)] bg-[var(--ylink-color-surface-soft)] px-4 py-2 text-sm text-slate-600"
          :disabled="loading"
          @click="loadProducts(true)"
        >
          刷新库存
        </button>
      </div>
      <div class="mt-4 grid gap-3 sm:grid-cols-3">
        <div class="rounded-2xl bg-[var(--ylink-color-primary-weak)] px-3 py-3 text-sm text-[var(--ylink-color-primary-strong)]">营业时间：08:30 - 20:30</div>
        <div class="rounded-2xl bg-[var(--ylink-color-surface-muted)] px-3 py-3 text-sm text-slate-700">提货须知：请在订单有效期内到店核销</div>
        <div class="rounded-2xl bg-amber-50 px-3 py-3 text-sm text-amber-700">公告：库存实时刷新，请以下单结果为准</div>
      </div>
    </div>

    <div class="rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex items-center gap-3">
        <input
          v-model.trim="keyword"
          class="h-11 flex-1 rounded-full border border-[var(--ylink-color-border)] bg-[var(--ylink-color-surface-soft)] px-4 text-sm outline-none focus:border-[var(--ylink-color-primary-soft)]"
          placeholder="搜索商品名称 / 编码"
        />
        <button
          type="button"
          class="h-11 rounded-full border border-[var(--ylink-color-border)] px-4 text-sm text-slate-600"
          @click="keyword = ''"
        >
          清空
        </button>
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <span class="rounded-full bg-[var(--ylink-color-surface-muted)] px-3 py-1 text-xs text-slate-500">推荐：热销</span>
        <span class="rounded-full bg-[var(--ylink-color-surface-muted)] px-3 py-1 text-xs text-slate-500">推荐：新品</span>
        <span class="rounded-full bg-[var(--ylink-color-surface-muted)] px-3 py-1 text-xs text-slate-500">推荐：低库存优先</span>
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

    <section
      v-else-if="searchMode"
      class="space-y-3 rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]"
    >
      <header class="flex items-center justify-between">
        <p class="text-sm font-semibold text-slate-700">搜索结果 {{ searchResults.length }} 条</p>
      </header>
      <div class="client-product-grid">
        <article v-for="product in searchResults" :key="product.id" class="client-product-card">
          <button type="button" class="client-product-card__body" @click="openProductDetail(product)">
            <img
              v-if="product.thumbnail"
              :src="product.thumbnail"
              :alt="product.productName"
              class="client-product-card__cover"
              loading="lazy"
              decoding="async"
            />
            <div v-else class="client-product-card__cover grid place-content-center text-xs text-slate-400">
              暂无图片
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-base font-semibold text-slate-900">{{ product.productName }}</p>
              <p class="mt-1 text-xs text-slate-400">{{ product.productCode }}</p>
              <div class="mt-2 flex flex-wrap gap-2 text-xs">
                <span class="rounded-full bg-[var(--ylink-color-primary-weak)] px-2 py-1 text-[var(--ylink-color-primary-strong)]">
                  可预订 {{ product.availableStock }}
                </span>
                <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">
                  已预订 {{ product.preOrderedStock }}
                </span>
              </div>
            </div>
          </button>
          <button type="button" class="client-product-card__add-button" @click="quickAdd(product)">+ 加购</button>
        </article>
      </div>
    </section>

    <section
      v-else-if="largeDatasetMode"
      class="space-y-3 rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]"
    >
      <header class="flex items-center justify-between">
        <p class="text-sm font-semibold text-slate-700">大数据模式 · 当前展示 {{ activeCategoryItems.length }} 条</p>
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
                  <span class="rounded-full bg-[var(--ylink-color-primary-weak)] px-2 py-1 text-[var(--ylink-color-primary-strong)]">可预订 {{ row.data.availableStock }}</span>
                  <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">已预订 {{ row.data.preOrderedStock }}</span>
                </div>
              </div>
            </button>
            <button type="button" class="client-product-card__add-button" @click="quickAdd(row.data)">+ 加购</button>
          </article>
        </div>
      </div>
    </section>

    <section v-else class="grid grid-cols-[88px_minmax(0,1fr)] gap-3 rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-3 shadow-[var(--ylink-shadow-soft)]">
      <aside class="max-h-[64vh] overflow-y-auto pr-1">
        <button
          v-for="category in categoryOptions"
          :key="category.key"
          type="button"
          class="mb-2 w-full rounded-xl px-2 py-2 text-left text-xs text-slate-500"
          :class="activeCategoryKey === category.key ? 'bg-[var(--ylink-color-primary-strong)] text-white' : 'bg-[var(--ylink-color-surface-muted)]'"
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
          <div class="client-product-grid">
            <article v-for="product in group.items" :key="product.id" class="client-product-card">
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
                    <span class="rounded-full bg-[var(--ylink-color-primary-weak)] px-2 py-1 text-[var(--ylink-color-primary-strong)]">可预订 {{ product.availableStock }}</span>
                    <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">已预订 {{ product.preOrderedStock }}</span>
                  </div>
                </div>
              </button>
              <button type="button" class="client-product-card__add-button" @click="quickAdd(product)">+ 加购</button>
            </article>
          </div>
        </section>
      </div>
    </section>

    <div class="mini-cart-backdrop" :class="{ 'is-expanded': miniCartVisible }" @click="miniCartVisible = false"></div>
    <div class="mini-cart-wrapper" :class="{ 'is-expanded': miniCartVisible }">
      <section class="mini-cart-card" :class="{ 'is-pulse': settlePulsing }">
        <div class="cart-summary-bar" @click="miniCartVisible = !miniCartVisible">
          <div class="summary-info">
            <div class="cart-icon-wrapper">
              <el-icon><ShoppingCart /></el-icon>
              <span v-if="bottomSelectedQty > 0" class="badge">{{ bottomSelectedQty }}</span>
            </div>
            <div class="text-group">
              <p class="main-text">购物车 {{ bottomSelectedTypeCount }} 种商品</p>
              <p class="sub-text">{{ miniCartVisible ? '点击收起明细' : '点击展开明细' }}</p>
            </div>
          </div>
          <div class="summary-actions">
            <button class="btn-checkout" @click.stop="goToCheckout">
              去结算
              <el-icon class="ml-1"><ArrowRight /></el-icon>
            </button>
            <button type="button" class="cart-expand-trigger" @click.stop="miniCartVisible = !miniCartVisible">
              <el-icon :class="miniCartVisible ? 'is-expanded' : ''"><ArrowDown /></el-icon>
            </button>
          </div>
        </div>

        <div class="cart-expand-content">
          <div class="expand-inner">
            <header class="expand-header">
              <span class="title">已选商品</span>
              <button type="button" class="expand-clear-btn" @click="clientCartStore.clearAll()">清空</button>
            </header>

            <div class="item-list">
              <div v-if="clientCartStore.items.length === 0" class="empty-state">购物车还是空的，去挑挑好物吧</div>
              <article v-for="item in clientCartStore.items" :key="item.productId" class="cart-item">
                <div class="item-main">
                  <p class="item-name">{{ item.productName }}</p>
                  <p class="item-price">¥{{ ((cartProductPriceMap.get(item.productId) ?? 0) * item.qty).toFixed(2) }}</p>
                </div>
                <div class="item-stepper">
                  <button type="button" class="step-btn" @click="clientCartStore.incrementQty(item.productId, -1)">-</button>
                  <span class="step-val">{{ item.qty }}</span>
                  <button type="button" class="step-btn" @click="clientCartStore.incrementQty(item.productId, 1)">+</button>
                </div>
              </article>
            </div>

            <div class="expand-footer">
              <button type="button" class="expand-link-btn" @click="router.push('/client/cart')">进入购物车</button>
              <p class="total-price">
                合计：<span class="price-num">¥{{ miniCartTotalAmount.toFixed(2) }}</span>
              </p>
            </div>
          </div>
        </div>
      </section>
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

  </section>
</template>

<style scoped>
.client-product-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.65rem;
}

.client-product-card {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border-radius: 1rem;
  border: 1px solid var(--ylink-color-border);
  background: var(--ylink-color-surface-soft);
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
  background: var(--ylink-color-primary-strong);
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
  background: var(--ylink-color-primary-strong);
  color: #ffffff;
}

.mini-cart-wrapper {
  position: fixed;
  bottom: calc(82px + 0.75rem);
  left: 50%;
  z-index: 50;
  width: min(var(--client-shell-max, 1100px), calc(100vw - var(--client-shell-inline, 1.25rem) * 2));
  transform: translateX(-50%);
  pointer-events: none;
}

.mini-cart-wrapper.is-expanded {
  pointer-events: auto;
}

.mini-cart-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(15, 23, 42, 0.32);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.4s ease;
}

.mini-cart-backdrop.is-expanded {
  opacity: 1;
  pointer-events: auto;
}

.mini-cart-card {
  overflow: hidden;
  border: 1px solid rgba(226, 232, 240, 0.82);
  border-radius: 1.5rem;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.12);
  pointer-events: auto;
  transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.mini-cart-card.is-pulse {
  animation: settle-pulse 0.3s ease;
}

.cart-summary-bar {
  display: flex;
  min-height: 64px;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  cursor: pointer;
  padding: 0.8rem 1.1rem;
}

.summary-info {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.75rem;
}

.cart-icon-wrapper {
  position: relative;
  display: flex;
  height: 44px;
  width: 44px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 0.85rem;
  background: var(--ylink-color-primary-strong);
  color: #ffffff;
  font-size: 1.1rem;
}

.badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 20px;
  border: 2px solid #ffffff;
  border-radius: 9999px;
  background: #f43f5e;
  color: #ffffff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  padding: 2px 6px;
  text-align: center;
}

.text-group {
  min-width: 0;
}

.main-text {
  color: #1e293b;
  font-size: 0.92rem;
  font-weight: 700;
}

.sub-text {
  margin-top: 0.1rem;
  color: #94a3b8;
  font-size: 0.72rem;
}

.summary-actions {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}

.btn-checkout {
  display: inline-flex;
  align-items: center;
  border: none;
  border-radius: 0.9rem;
  background: #0f172a;
  color: #ffffff;
  font-size: 0.88rem;
  font-weight: 600;
  padding: 0.7rem 1rem;
}

.cart-expand-trigger {
  display: inline-flex;
  height: 40px;
  width: 40px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 0.85rem;
  background: #ffffff;
  color: #64748b;
}

.cart-expand-trigger .el-icon {
  transition: transform 0.35s ease;
}

.cart-expand-trigger .el-icon.is-expanded {
  transform: rotate(180deg);
}

.cart-expand-content {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.mini-cart-wrapper.is-expanded .cart-expand-content {
  grid-template-rows: 1fr;
}

.expand-inner {
  overflow: hidden;
  padding: 0 1.1rem;
}

.expand-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-top: 1px dashed #e2e8f0;
  border-bottom: 1px dashed #e2e8f0;
  padding: 0.9rem 0;
}

.expand-header .title {
  color: #475569;
  font-size: 0.82rem;
  font-weight: 700;
}

.expand-clear-btn {
  border: none;
  background: transparent;
  color: #e11d48;
  font-size: 0.78rem;
}

.item-list {
  max-height: 280px;
  overflow-y: auto;
  padding: 0.9rem 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(148, 163, 184, 0.6) transparent;
}

.item-list::-webkit-scrollbar {
  width: 6px;
}

.item-list::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background: rgba(148, 163, 184, 0.55);
}

.cart-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.65rem 0;
}

.item-main {
  min-width: 0;
  flex: 1;
}

.item-name {
  color: #1e293b;
  font-size: 0.88rem;
  font-weight: 600;
}

.item-price {
  margin-top: 0.15rem;
  color: #0d9488;
  font-size: 0.76rem;
  font-weight: 700;
}

.item-stepper {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  border-radius: 0.8rem;
  background: #f1f5f9;
  padding: 0.25rem;
}

.step-btn {
  height: 26px;
  width: 26px;
  border: none;
  border-radius: 0.5rem;
  background: #ffffff;
  color: #1e293b;
  font-weight: 700;
}

.step-val {
  min-width: 20px;
  color: #1e293b;
  font-size: 0.82rem;
  font-weight: 700;
  text-align: center;
}

.expand-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-top: 1px solid #f1f5f9;
  padding: 1rem 0 1.05rem;
}

.expand-link-btn {
  border: 1px solid #e2e8f0;
  border-radius: 9999px;
  background: #ffffff;
  color: #64748b;
  font-size: 0.82rem;
  padding: 0.6rem 1rem;
}

.total-price {
  color: #64748b;
  font-size: 0.88rem;
}

.price-num {
  margin-left: 0.25rem;
  color: #0d9488;
  font-size: 1.08rem;
  font-weight: 800;
}

.empty-state {
  padding: 2.1rem 0;
  color: #94a3b8;
  font-size: 0.82rem;
  text-align: center;
}

@keyframes settle-pulse {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.03);
  }
  100% {
    transform: scale(1);
  }
}

@media (min-width: 768px) {
  .client-product-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

}

@media (min-width: 1200px) {
  .client-product-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 767px) {
  .mini-cart-wrapper {
    bottom: calc(82px + env(safe-area-inset-bottom));
  }

  .cart-summary-bar {
    align-items: stretch;
    padding: 0.75rem 0.85rem;
  }

  .summary-actions {
    flex-direction: column;
    justify-content: center;
  }

  .btn-checkout {
    justify-content: center;
    padding-inline: 0.8rem;
  }

  .cart-expand-trigger {
    height: 36px;
    width: 36px;
  }

  .expand-inner {
    padding: 0 0.85rem;
  }

  .item-list {
    max-height: 240px;
  }

  .expand-footer {
    flex-direction: column;
    align-items: stretch;
  }

  .expand-link-btn {
    width: 100%;
  }
}
</style>
