<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientMallView.vue
 * 文件职责：承载客户端商城的商品浏览、标签联动、加购与结算入口能力。
 * 维护说明：重点维护“左侧标签高亮 <-> 右侧分组定位”一致性，避免快速切换时出现错位与回跳。
 */


import { useVirtualList } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ArrowDown, ArrowRight, Close, Search, ShoppingCart } from '@element-plus/icons-vue'
import { getO2oMallProducts, getO2oMallStorefront, type O2oMallProduct, type O2oMallSku } from '@/api/modules/o2o'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import { useClientAuthStore, useClientCartStore, useClientCatalogStore } from '@/store'
import pinia from '@/store/pinia'
import { normalizeRequestError } from '@/utils/error'
import { useDevice } from '@/composables/useDevice'
import { resolveProductPlaceholder } from '@/utils/product-placeholder'
import { resolveO2oPriceView } from '@/utils/o2o-price'

import ClientCartView from './ClientCartView.vue'
import ClientCheckoutView from './ClientCheckoutView.vue'


import { showAppSuccess, showAppWarning } from '@/utils/app-alert'

interface ProductCategoryGroup {
  key: string
  label: string
  items: O2oMallProduct[]
}

interface ProductSearchEntry {
  product: O2oMallProduct
  searchText: string
}

interface ProductCardDisplay {
  thumbnail: string
  priceView: ReturnType<typeof resolveO2oPriceView>
  description: string
}

type ProductSortMode = 'default' | 'recommended'

interface ProductSortOption {
  value: ProductSortMode
  label: string
}

interface MallBrowseIndexSnapshot {
  categoryGroups: ProductCategoryGroup[]
  categoryOptions: Array<{ key: string; label: string; count: number }>
  categoryItemMap: Map<string, O2oMallProduct[]>
  searchEntries: ProductSearchEntry[]
}

const clientCartStore = useClientCartStore(pinia)
const clientCatalogStore = useClientCatalogStore(pinia)
const clientAuthStore = useClientAuthStore(pinia)
const { runLatest } = useStableRequest()
const { isPhone } = useDevice()
const route = useRoute()

const loading = ref(false)
const refreshing = ref(false)
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
const sortMode = computed<ProductSortMode>({
  get: () => clientCatalogStore.sortMode,
  set: (value) => clientCatalogStore.setSortMode(value),
})
const detailVisible = ref(false)
const detailQty = ref(1)
const detailProduct = ref<O2oMallProduct | null>(null)
const selectedDetailSku = ref<O2oMallSku | null>(null)
const imagePreviewVisible = ref(false)
const previewImageUrl = ref('')
const miniCartVisible = ref(false)
const settlePulsing = ref(false)
const searchInputFocused = ref(false)
const mobileSearchVisible = ref(false)
const mobileSearchInputRef = ref<HTMLInputElement | null>(null)
const compactAnnouncementTextRef = ref<HTMLElement | null>(null)
const compactAnnouncementOverflowing = ref(false)
const announcementDialogVisible = ref(false)
const sortModeAnimating = ref(false)
const isMallRoute = computed(() => route.path.startsWith('/client/mall'))
const shouldShowMobileSearchEntry = computed(() => isPhone.value && isMallRoute.value)
const productCardElementMap = new Map<string, HTMLElement>()
const productCardStableKeyMap = new Map<string, string>()
const productCardStableElementMap = new Map<string, HTMLElement>()

const listScrollerRef = ref<HTMLElement | null>(null)
const sectionRefMap = reactive<Record<string, HTMLElement | null>>({})
const scrollingByCategoryClick = ref(false)
const pendingCategoryKey = ref<string | null>(null)
const categoryScrollUnlockTimer = ref<number | null>(null)
const categoryScrollSessionId = ref(0)
const currentLockedSessionId = ref(0)
const pendingCategoryTargetTop = ref<number | null>(null)
const DEFAULT_LIST_VIEWPORT_BOTTOM_SPACER = 220
const PHONE_FLOATING_CLEARANCE_FALLBACK = 196
const DESKTOP_FLOATING_CLEARANCE_FALLBACK = 124
const listViewportBottomSpacer = ref(DEFAULT_LIST_VIEWPORT_BOTTOM_SPACER)

const CATEGORY_SCROLL_HIT_THRESHOLD = 12
const CATEGORY_SCROLL_FALLBACK_MS = 420
const CATEGORY_VIEWPORT_ACTIVATE_OFFSET = 28
const CATEGORY_BOTTOM_VISIBLE_PADDING = 56
const DEFAULT_PRODUCT_IMAGE_WARMUP_BATCH = 12
const DEFAULT_PRODUCT_IMAGE_WARMUP_DELAY_MS = 180
const PRODUCT_CARD_SEARCH_DETAIL_MAX_LENGTH = 80

// 商城页属于高频返回页面，初始化时优先恢复购物车与目录缓存，避免每次进入都重置上下文。
clientCartStore.initialize(clientAuthStore.currentUser?.id)
clientCatalogStore.initialize(clientAuthStore.currentUser?.id)

const products = computed(() => clientCatalogStore.products)
const storeBusinessHoursText = computed(() => clientCatalogStore.storefront.businessHoursText || '10:00 - 22:00')
const mallAnnouncementText = computed(() => clientCatalogStore.storefront.mallAnnouncementText?.trim() ?? '')
const normalizedKeyword = computed(() => keyword.value.trim().toLowerCase())
const hasKeyword = computed(() => normalizedKeyword.value.length > 0)
const hasRenderableProducts = computed(() => products.value.length > 0)
const blockingRequestError = computed(() => {
  return hasRenderableProducts.value ? null : requestError.value
})
const passiveRefreshErrorMessage = computed(() => {
  return hasRenderableProducts.value ? requestError.value?.message ?? '' : ''
})

const REORDER_MOTION_EASING = 'cubic-bezier(0.20, 0, 0, 1)'
const REORDER_MOTION_DESKTOP_MS = 420
const REORDER_MOTION_TABLET_MS = 360
const REORDER_MOTION_PHONE_MS = 280
const REORDER_MOTION_DESKTOP_STAGGER_MS = 12
const REORDER_MOTION_PHONE_STAGGER_MS = 6
const REORDER_MOTION_DESKTOP_MAX_DELAY_MS = 96
const REORDER_MOTION_PHONE_MAX_DELAY_MS = 42

const productSortOptions: ProductSortOption[] = [
  { value: 'default', label: '默认' },
  { value: 'recommended', label: '推荐' },
]

const resolveSoldQty = (product: Pick<O2oMallProduct, 'soldQty'>) => {
  return Math.max(0, Math.floor(Number(product.soldQty ?? 0)))
}

const isSkuRecommended = (sku: O2oMallSku, product: O2oMallProduct) => {
  return product.o2oRecommended || sku.o2oRecommended === true
}

const isCurrentActiveSku = (sku: Pick<O2oMallSku, 'isCurrent' | 'isActive'>) => sku.isCurrent !== false && sku.isActive !== false

const isProductRecommended = (product: O2oMallProduct) => {
  return product.o2oRecommended || (product.skus ?? []).some((sku) => isCurrentActiveSku(sku) && sku.o2oRecommended === true)
}

const resolveRecommendedSortBucket = (product: O2oMallProduct) => {
  if (resolveSoldQty(product) > 0) {
    return 0
  }
  return isProductRecommended(product) ? 1 : 2
}

const originalProductIndexMap = computed(() => {
  return new Map(products.value.map((product, index) => [String(product.id), index]))
})

const sortProductsForDisplay = (items: O2oMallProduct[]) => {
  if (sortMode.value !== 'recommended') {
    return items
  }
  const indexMap = originalProductIndexMap.value
  return [...items].sort((prev, next) => {
    const prevBucket = resolveRecommendedSortBucket(prev)
    const nextBucket = resolveRecommendedSortBucket(next)
    const bucketDiff = prevBucket - nextBucket
    if (bucketDiff !== 0) {
      return bucketDiff
    }
    if (prevBucket === 0) {
      const soldDiff = resolveSoldQty(next) - resolveSoldQty(prev)
      if (soldDiff !== 0) {
        return soldDiff
      }
    }
    return (indexMap.get(String(prev.id)) ?? 0) - (indexMap.get(String(next.id)) ?? 0)
  })
}

const classifyProduct = (product: O2oMallProduct) => {
  return product.tags && product.tags.length > 0 ? product.tags : ['默认标签']
}

const resolveSortedActivePreviewSkus = (product: Pick<O2oMallProduct, 'skus'>) => {
  return (product.skus ?? [])
    .filter(isCurrentActiveSku)
    .slice()
    .sort((leftSku, rightSku) => {
      const leftOrder = Number.isFinite(Number(leftSku.sortOrder)) ? Number(leftSku.sortOrder) : 0
      const rightOrder = Number.isFinite(Number(rightSku.sortOrder)) ? Number(rightSku.sortOrder) : 0
      return leftOrder - rightOrder
    })
}

const hasSkuAvailableStock = (sku: Pick<O2oMallSku, 'availableStock'>) => Math.max(0, Number(sku.availableStock ?? 0)) > 0

const resolveHallProductPreviewSku = (product: Pick<O2oMallProduct, 'o2oRecommended' | 'skus'>) => {
  const sortedPreviewSkus = resolveSortedActivePreviewSkus(product)
  if (!sortedPreviewSkus.length) {
    return null
  }

  const recommendedPreviewSkus = product.o2oRecommended
    ? sortedPreviewSkus
    : sortedPreviewSkus.filter((sku) => sku.o2oRecommended === true)
  const candidateSkus = recommendedPreviewSkus.length ? recommendedPreviewSkus : sortedPreviewSkus
  const stockPreferredSkus = candidateSkus.filter(hasSkuAvailableStock)

  return stockPreferredSkus[0] ?? candidateSkus[0] ?? sortedPreviewSkus[0]
}

const resolveHallProductThumbnail = (product: Pick<O2oMallProduct, 'productName' | 'productCode' | 'thumbnail' | 'o2oRecommended' | 'skus'>) => {
  const previewSku = resolveHallProductPreviewSku(product)
  return resolveProductPlaceholder(previewSku?.thumbnail || product.thumbnail)
}

const normalizeProductCardDescription = (product: Pick<O2oMallProduct, 'detailContent'>) => product.detailContent?.trim() ?? ''

const normalizeProductCardSearchText = (product: O2oMallProduct, categoryKeys: string[]) => {
  const boundedDetailText = normalizeProductCardDescription(product).slice(0, PRODUCT_CARD_SEARCH_DETAIL_MAX_LENGTH)
  return [
    product.productName,
    product.productCode,
    boundedDetailText,
    ...categoryKeys,
  ].filter(Boolean).join(' ').toLowerCase()
}

const buildProductCardDisplay = (product: O2oMallProduct): ProductCardDisplay => {
  const previewSku = resolveHallProductPreviewSku(product)
  return {
    thumbnail: resolveHallProductThumbnail(product),
    priceView: resolveO2oPriceView(previewSku ?? product),
    description: normalizeProductCardDescription(product),
  }
}

const productCardDisplayMap = computed(() => {
  const displayMap = new Map<string, ProductCardDisplay>()
  products.value.forEach((product) => {
    displayMap.set(String(product.id), buildProductCardDisplay(product))
  })
  return displayMap
})

const resolveProductCardDisplay = (product: O2oMallProduct) => {
  return productCardDisplayMap.value.get(String(product.id)) ?? buildProductCardDisplay(product)
}

const resolveProductThumbnail = (product: O2oMallProduct) => {
  return resolveProductCardDisplay(product).thumbnail
}

const resolveProductPriceView = (product: O2oMallProduct) => {
  return resolveProductCardDisplay(product).priceView
}

const resolveDetailProductThumbnail = (product: Pick<O2oMallProduct, 'productName' | 'productCode' | 'thumbnail'>) => {
  return resolveProductPlaceholder(selectedDetailSku.value?.thumbnail || product.thumbnail)
}

const resolveActiveSkus = (product: O2oMallProduct | null): O2oMallSku[] => product?.skus?.filter(isCurrentActiveSku) ?? []

const resolveCurrentDetailSpecText = () => {
  if (resolveActiveSkus(detailProduct.value).length <= 1) {
    return ''
  }
  const sku = selectedDetailSku.value
  return sku?.specText?.trim() || sku?.skuCode?.trim() || ''
}

const resolveCurrentDetailDisplayName = (product: O2oMallProduct) => {
  const specText = resolveCurrentDetailSpecText()
  return specText ? `${product.productName} · ${specText}` : product.productName
}

const resolveCurrentDetailDescription = (product: O2oMallProduct) => {
  const specText = resolveCurrentDetailSpecText()
  const detailContent = product.detailContent?.trim()
  if (!specText) {
    return detailContent || '暂无商品描述'
  }
  return detailContent ? `${detailContent} · 当前规格：${specText}` : `当前规格：${specText}`
}

const resolveCurrentDetailPriceView = (product: O2oMallProduct) => {
  return resolveO2oPriceView(selectedDetailSku.value ?? product)
}

const resolveCurrentDetailAvailableStock = (product: O2oMallProduct) => {
  return Math.max(0, Number(selectedDetailSku.value?.availableStock ?? product.availableStock ?? 0))
}

const resolveCurrentDetailPreOrderedStock = (product: O2oMallProduct) => {
  return Math.max(0, Number(selectedDetailSku.value?.preOrderedStock ?? product.preOrderedStock ?? 0))
}

const resolveDefaultSku = (product: O2oMallProduct | null): O2oMallSku | null => {
  return product ? resolveHallProductPreviewSku(product) : null
}

const hasDetailSkuChoices = computed(() => resolveActiveSkus(detailProduct.value).length > 1)

const detailMaxQty = computed(() => {
  const limit = Math.max(0, Number(detailProduct.value?.limitPerUser ?? 0))
  const stock = Math.max(0, Number(selectedDetailSku.value?.availableStock ?? detailProduct.value?.availableStock ?? 0))
  return Math.max(0, Math.min(stock, limit || stock))
})

// 商城图片预览统一走同一套状态，避免商品卡和详情抽屉各自维护一套弹层开关。
const openProductImagePreview = (product: O2oMallProduct) => {
  previewImageUrl.value = resolveProductThumbnail(product)
  imagePreviewVisible.value = true
}

const openDetailImagePreview = () => {
  if (!detailProduct.value) {
    return
  }
  previewImageUrl.value = resolveDetailProductThumbnail(detailProduct.value)
  imagePreviewVisible.value = true
}

const closeProductImagePreview = () => {
  imagePreviewVisible.value = false
}

const mallBrowseIndex = computed<MallBrowseIndexSnapshot>(() => {
  // 分类分组与搜索索引统一在单次遍历里完成，避免商品数组在多个 computed 中被重复扫描。
  const groupMap = new Map<string, ProductCategoryGroup>()
  const searchEntries: ProductSearchEntry[] = []

  products.value.forEach((product) => {
    const categoryKeys = classifyProduct(product)
    searchEntries.push({
      product,
      // 搜索索引预先拼好常用字段，减少用户每次输入关键字时的字符串拼接成本。
      searchText: normalizeProductCardSearchText(product, categoryKeys),
    })
    categoryKeys.forEach((key) => {
      const grouped = groupMap.get(key)
      if (grouped) {
        grouped.items.push(product)
        return
      }
      groupMap.set(key, {
        key,
        label: key,
        items: [product],
      })
    })
  })

  const categoryGroups = [...groupMap.values()]
    .map((group) => ({
      ...group,
      items: sortProductsForDisplay(group.items),
    }))
    .sort((prev, next) => prev.label.localeCompare(next.label, 'zh-Hans-CN'))
  return {
    categoryGroups,
    categoryOptions: [{ key: 'all', label: '全部', count: products.value.length }].concat(
      categoryGroups.map((group) => ({
        key: group.key,
        label: group.label,
        count: group.items.length,
      })),
    ),
    categoryItemMap: new Map(categoryGroups.map((group) => [group.key, group.items])),
    searchEntries,
  }
})

// 搜索模式与大数据模式互斥：
// - 有关键字时优先进入搜索结果态，弱化标签导航；
// - 数据量较大时启用虚拟列表，仅渲染当前标签内的可视区域。
const categoryGroups = computed(() => mallBrowseIndex.value.categoryGroups)
const categoryOptions = computed(() => mallBrowseIndex.value.categoryOptions)
const searchMode = computed(() => hasKeyword.value)
const largeDatasetMode = computed(() => products.value.length > 100)
const isRecommendedSortMode = computed(() => sortMode.value === 'recommended')
const useRecommendedAllProductFlow = computed(() => isRecommendedSortMode.value && !largeDatasetMode.value)
const recommendedAllProducts = computed(() => sortProductsForDisplay(products.value))

const searchResults = computed(() => {
  if (!normalizedKeyword.value) {
    return []
  }

  const matchedProducts: O2oMallProduct[] = []
  mallBrowseIndex.value.searchEntries.forEach((entry) => {
    if (entry.searchText.includes(normalizedKeyword.value)) {
      matchedProducts.push(entry.product)
    }
  })
  return sortProductsForDisplay(matchedProducts)
})

const bottomSelectedQty = computed(() => clientCartStore.totalQty)
const bottomSelectedTypeCount = computed(() => clientCartStore.items.length)
const isOffline = computed(() => requestError.value?.type === 'offline')
const miniCartTotalAmount = computed(() => {
  return clientCartStore.items.reduce((sum, item) => {
    return sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty
  }, 0)
})
const activeCategoryItems = computed(() => {
  if (isRecommendedSortMode.value || activeCategoryKey.value === 'all') {
    return sortProductsForDisplay(products.value)
  }
  return mallBrowseIndex.value.categoryItemMap.get(activeCategoryKey.value) ?? []
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

const isWechatMallScene = computed(() => {
  if (globalThis.navigator === undefined) {
    return false
  }
  return /MicroMessenger/i.test(globalThis.navigator.userAgent ?? '')
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

const resolveProductImageWarmupBatch = () => {
  if (globalThis.navigator === undefined) {
    return DEFAULT_PRODUCT_IMAGE_WARMUP_BATCH
  }
  const networkConnection = 'connection' in globalThis.navigator
    ? (globalThis.navigator.connection as { saveData?: boolean; effectiveType?: string } | undefined)
    : undefined
  if (networkConnection?.saveData || /(?:^|-)2g$/i.test(networkConnection?.effectiveType ?? '')) {
    return 0
  }
  // Task6.1：微信 WebView 下彻底停用商城主动图片预热，改由原生懒加载 + 浏览器缓存自行接管。
  // 这样既不破坏缓存恢复后的秒开结构，也避免主动 new Image() 与真实首屏请求争抢带宽。
  if (isWechatMallScene.value) {
    return 0
  }
  return DEFAULT_PRODUCT_IMAGE_WARMUP_BATCH
}

const warmupProductImages = (items: O2oMallProduct[]) => {
  if (globalThis.window === undefined || !items.length) {
    return
  }
  const warmupBatch = resolveProductImageWarmupBatch()
  if (warmupBatch <= 0) {
    return
  }
  const warmupImageUrls = [...new Set(
    items
      .map((item) => resolveProductCardDisplay(item).thumbnail)
      .filter((thumbnail): thumbnail is string => Boolean(thumbnail)),
  )].slice(0, warmupBatch)
  if (!warmupImageUrls.length) {
    return
  }
  // 非微信场景仍只预热首屏附近的小批量图片，主链路继续由模板内 loading="lazy" 负责。
  const warmup = () => {
    warmupImageUrls.forEach((thumbnail) => {
      const image = new Image()
      image.src = thumbnail
    })
  }
  if (typeof globalThis.window.requestIdleCallback === 'function') {
    globalThis.window.requestIdleCallback(warmup, { timeout: 800 })
    return
  }
  globalThis.window.setTimeout(warmup, DEFAULT_PRODUCT_IMAGE_WARMUP_DELAY_MS)
}

const refreshStorefrontConfig = async () => {
  try {
    const storefront = await getO2oMallStorefront()
    clientCatalogStore.setStorefront(storefront)
  } catch (error) {
    console.warn('刷新客户端商城公告配置失败，继续使用本地缓存', error)
  }
}

const updateCompactAnnouncementOverflow = async () => {
  await nextTick()
  const textElement = compactAnnouncementTextRef.value
  compactAnnouncementOverflowing.value = Boolean(
    textElement && textElement.scrollWidth > textElement.clientWidth + 1,
  )
}

const openFullAnnouncement = () => {
  if (!compactAnnouncementOverflowing.value || !mallAnnouncementText.value) {
    return
  }
  announcementDialogVisible.value = true
}

watch(
  () => clientAuthStore.currentUser?.id,
  (nextClientUserId) => {
    clientCartStore.initialize(nextClientUserId)
    clientCatalogStore.initialize(nextClientUserId)
  },
)

watch([mallAnnouncementText, isPhone], () => {
  void updateCompactAnnouncementOverflow()
})

const loadProducts = async (force = false) => {
  // 如果缓存仍在有效期内，则直接复用本地目录快照，并只同步购物车库存信息。
  // 这样从订单页返回商城页时可以“秒开”，同时避免旧库存继续污染购物车状态。
  if (!force && clientCatalogStore.products.length > 0 && clientCatalogStore.isFresh) {
    requestError.value = null
    await refreshStorefrontConfig()
    clientCartStore.syncWithCatalog(clientCatalogStore.products)
    warmupProductImages(clientCatalogStore.products)
    return
  }
  loading.value = clientCatalogStore.products.length === 0
  refreshing.value = true
  requestError.value = null
  await runLatest({
    executor: (signal) => getO2oMallProducts({ signal }),
    onSuccess: async (result) => {
      // 成功返回后同步更新两个域：
      // 1. 目录 Store 负责商品列表、分类与搜索上下文；
      // 2. 购物车 Store 负责把已选商品映射到最新库存/限购规则。
      clientCatalogStore.setProducts(result)
      clientCartStore.syncWithCatalog(result.list)
      warmupProductImages(result.list)
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
      refreshing.value = false
    },
  })
}

const setSectionRef = (key: string, element: unknown) => {
  sectionRefMap[key] = element instanceof HTMLElement ? element : null
}

const openProductDetail = (product: O2oMallProduct) => {
  detailProduct.value = product
  selectedDetailSku.value = resolveDefaultSku(product)
  detailQty.value = 1
  detailVisible.value = true
}

const clearSearch = () => {
  keyword.value = ''
}

const openMobileSearch = async () => {
  mobileSearchVisible.value = true
  await nextTick()
  mobileSearchInputRef.value?.focus()
}

const closeMobileSearch = () => {
  mobileSearchVisible.value = false
}

const promoteStableProductCardElement = (stableProductId: string) => {
  for (const [cardKey, element] of productCardElementMap.entries()) {
    if (productCardStableKeyMap.get(cardKey) === stableProductId && element.isConnected) {
      productCardStableElementMap.set(stableProductId, element)
      return
    }
  }
  productCardStableElementMap.delete(stableProductId)
}

const setProductCardRef = (cardKey: string | number, element: unknown, stableProductId: string | number = cardKey) => {
  const normalizedCardKey = String(cardKey)
  const normalizedStableProductId = String(stableProductId)
  if (element instanceof HTMLElement) {
    productCardElementMap.set(normalizedCardKey, element)
    productCardStableKeyMap.set(normalizedCardKey, normalizedStableProductId)
    const currentStableElement = productCardStableElementMap.get(normalizedStableProductId)
    if (!currentStableElement || !currentStableElement.isConnected) {
      productCardStableElementMap.set(normalizedStableProductId, element)
    }
    return
  }
  const previousElement = productCardElementMap.get(normalizedCardKey)
  const previousStableProductId = productCardStableKeyMap.get(normalizedCardKey)
  productCardElementMap.delete(normalizedCardKey)
  productCardStableKeyMap.delete(normalizedCardKey)
  if (previousStableProductId && productCardStableElementMap.get(previousStableProductId) === previousElement) {
    promoteStableProductCardElement(previousStableProductId)
  }
}

const captureProductCardRects = () => {
  const rectMap = new Map<string, DOMRect>()
  productCardStableElementMap.forEach((element, productId) => {
    rectMap.set(productId, element.getBoundingClientRect())
  })
  return rectMap
}

const animateProductCardReorder = (previousRects: Map<string, DOMRect>) => {
  const viewportWidth = globalThis.window?.innerWidth ?? 1280
  if (globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return 0
  }
  const duration = isPhone.value ? REORDER_MOTION_PHONE_MS : viewportWidth < 1024 ? REORDER_MOTION_TABLET_MS : REORDER_MOTION_DESKTOP_MS
  const staggerStep = isPhone.value ? REORDER_MOTION_PHONE_STAGGER_MS : REORDER_MOTION_DESKTOP_STAGGER_MS
  const maxDelay = isPhone.value ? REORDER_MOTION_PHONE_MAX_DELAY_MS : REORDER_MOTION_DESKTOP_MAX_DELAY_MS
  const maxPhoneDistance = isPhone.value ? Math.max(240, (globalThis.window?.innerHeight ?? 480) * 0.72) : Number.POSITIVE_INFINITY
  const movedCards: Array<{
    element: HTMLElement
    deltaX: number
    deltaY: number
    currentRect: DOMRect
    distance: number
  }> = []

  productCardStableElementMap.forEach((element, productId) => {
    const previousRect = previousRects.get(productId)
    if (!previousRect) {
      return
    }
    const currentRect = element.getBoundingClientRect()
    const deltaX = previousRect.left - currentRect.left
    const deltaY = previousRect.top - currentRect.top
    const distance = Math.hypot(deltaX, deltaY)
    if (distance < 1) {
      return
    }
    movedCards.push({ element, deltaX, deltaY, currentRect, distance })
  })

  movedCards
    .sort((prev, next) => prev.currentRect.top - next.currentRect.top || prev.currentRect.left - next.currentRect.left)
    .forEach(({ element, deltaX, deltaY, distance }, index) => {
      const delay = Math.min(maxDelay, index * staggerStep)
      const largePhoneMove = distance > maxPhoneDistance
      const startTransform = largePhoneMove
        ? 'translate3d(0, 10px, 0) scale(0.992)'
        : `translate3d(${deltaX}px, ${deltaY}px, 0) scale(0.986)`
      const settleTransform = largePhoneMove
        ? 'translate3d(0, 1px, 0) scale(1)'
        : `translate3d(${deltaX * 0.04}px, ${deltaY * 0.04}px, 0) scale(1.002)`
      element.style.willChange = 'transform, opacity'
      const animation = element.animate(
        [
          { opacity: largePhoneMove ? 0.82 : 0.9, transform: startTransform },
          { opacity: 1, transform: settleTransform, offset: 0.82 },
          { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
        ],
        {
          duration,
          delay,
          easing: REORDER_MOTION_EASING,
          fill: 'both',
        },
      )
      animation.addEventListener('finish', () => {
        element.style.willChange = ''
      }, { once: true })
      animation.addEventListener('cancel', () => {
        element.style.willChange = ''
      }, { once: true })
    })

  return movedCards.length > 0 ? duration + Math.min(maxDelay, (movedCards.length - 1) * staggerStep) : 0
}

const resetProductListToTopForSortChange = async () => {
  releaseCategoryScrollLock()
  activeCategoryKey.value = 'all'
  await nextTick()
  const scroller = listScrollerRef.value
  if (scroller) {
    scroller.scrollTop = 0
  }
}

const handleSortModeChange = async (nextMode: ProductSortMode) => {
  if (sortMode.value === nextMode || sortModeAnimating.value) {
    return
  }
  const previousRects = captureProductCardRects()
  sortModeAnimating.value = true
  sortMode.value = nextMode
  await resetProductListToTopForSortChange()
  await nextTick()
  try {
    const animationDuration = animateProductCardReorder(previousRects)
    if (animationDuration > 0) {
      await new Promise((resolve) => globalThis.window.setTimeout(resolve, animationDuration))
    }
  } finally {
    sortModeAnimating.value = false
    await nextTick()
    handleProductListScroll()
  }
}

const changeDetailQty = (delta: number) => {
  if (!detailProduct.value) {
    return
  }
  const maxQty = detailMaxQty.value
  const nextQty = Math.min(maxQty, Math.max(1, detailQty.value + delta))
  if (detailQty.value === maxQty && delta > 0) {
    if (maxQty >= detailProduct.value.limitPerUser) {
      showAppWarning('已达单人限购上限')
    } else {
      showAppWarning('库存不足')
    }
  }
  detailQty.value = nextQty
}

const selectDetailSku = (sku: O2oMallSku) => {
  selectedDetailSku.value = sku
  detailQty.value = Math.min(Math.max(1, detailQty.value), Math.max(1, detailMaxQty.value))
}

const addCurrentDetailToCart = () => {
  if (!detailProduct.value) {
    return
  }
  const addedQty = clientCartStore.addProduct(detailProduct.value, detailQty.value, selectedDetailSku.value)
  if (addedQty <= 0) {
    return
  }
  showAppSuccess('已加入购物车')
  triggerSettlePulse()
  detailVisible.value = false
}

const quickAdd = (product: O2oMallProduct) => {
  const activeSkus = resolveActiveSkus(product)
  if (activeSkus.length > 1) {
    openProductDetail(product)
    return
  }
  const addedQty = clientCartStore.addProduct(product, 1, resolveDefaultSku(product))
  if (addedQty <= 0) {
    return
  }
  showAppSuccess('已加入购物车')
  triggerSettlePulse()
}

const clearCategoryUnlockTimer = () => {
  if (categoryScrollUnlockTimer.value !== null) {
    globalThis.window.clearTimeout(categoryScrollUnlockTimer.value)
    categoryScrollUnlockTimer.value = null
  }
}

const resolveMallFloatingBottomClearance = (element: HTMLElement) => {
  if (globalThis.window === undefined) {
    return isPhone.value ? PHONE_FLOATING_CLEARANCE_FALLBACK : DESKTOP_FLOATING_CLEARANCE_FALLBACK
  }
  // 读取布局层透出的底部导航安全区变量，让商城内部滚动容器与悬浮购物车共用同一套底部留白基线。
  const resolvedValue = globalThis.window
    .getComputedStyle(element)
    .getPropertyValue('--mall-floating-bottom-clearance')
    .trim()
  const parsedValue = Number.parseFloat(resolvedValue.replace('px', ''))
  if (Number.isFinite(parsedValue) && parsedValue > 0) {
    return parsedValue
  }
  return isPhone.value ? PHONE_FLOATING_CLEARANCE_FALLBACK : DESKTOP_FLOATING_CLEARANCE_FALLBACK
}

const resolveListViewportBottomSpacer = (scroller: HTMLElement) => {
  const floatingBottomClearance = resolveMallFloatingBottomClearance(scroller)
  // 手机端底部有“悬浮购物车 + 底部导航”两层固定区，因此尾部缓冲区至少要覆盖整块可视遮挡区。
  const viewportTailRoom = Math.floor(scroller.clientHeight * (isPhone.value ? 0.96 : 0.75))
  return Math.max(
    180,
    viewportTailRoom,
    Math.ceil(floatingBottomClearance + CATEGORY_VIEWPORT_ACTIVATE_OFFSET),
  )
}

const releaseCategoryScrollLock = () => {
  clearCategoryUnlockTimer()
  scrollingByCategoryClick.value = false
  pendingCategoryKey.value = null
  pendingCategoryTargetTop.value = null
}

const syncListViewportBottomSpacer = () => {
  const scroller = listScrollerRef.value
  if (!scroller) {
    listViewportBottomSpacer.value = DEFAULT_LIST_VIEWPORT_BOTTOM_SPACER
    return
  }
  // 为右侧分组列表补一个“可滚动缓冲尾部”，确保末尾分组在手机端也能越过底部固定购物车后平滑顶到定位线。
  listViewportBottomSpacer.value = resolveListViewportBottomSpacer(scroller)
}

const resolveSectionTopWithinScroller = (section: HTMLElement, scroller: HTMLElement) => {
  const sectionRect = section.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  // 统一转换为“相对于滚动容器内容区”的坐标，避免 offsetTop 因 offsetParent 不一致而计算失真。
  return Math.max(0, sectionRect.top - scrollerRect.top + scroller.scrollTop)
}

const resolveCategoryScrollMetrics = (categoryKey: string, scroller: HTMLElement) => {
  if (categoryKey === 'all') {
    return {
      rawTargetTop: 0,
      reachableTargetTop: 0,
      maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      relativeTop: 0,
      relativeBottom: 0,
    }
  }
  const section = sectionRefMap[categoryKey]
  if (!section) {
    return null
  }
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const sectionTopWithinScroller = resolveSectionTopWithinScroller(section, scroller)
  // 统一以分组容器起点作为锚点：
  // 1. 点击标签时，分组标题与第一行商品一起进入顶部视口；
  // 2. “全部”和第一个标签天然对应同一顶部位置，不会再点击首标签后异常下滑。
  const rawTargetTop = sectionTopWithinScroller
  const relativeTop = sectionTopWithinScroller - scroller.scrollTop
  const relativeBottom = sectionTopWithinScroller + section.offsetHeight - scroller.scrollTop
  return {
    rawTargetTop,
    reachableTargetTop: Math.min(rawTargetTop, maxScrollTop),
    maxScrollTop,
    relativeTop,
    relativeBottom,
  }
}

const lockCategoryScrollSession = (categoryKey: string, targetTop: number) => {
  const nextSessionId = categoryScrollSessionId.value + 1
  categoryScrollSessionId.value = nextSessionId
  currentLockedSessionId.value = nextSessionId
  scrollingByCategoryClick.value = true
  pendingCategoryKey.value = categoryKey
  pendingCategoryTargetTop.value = targetTop
  clearCategoryUnlockTimer()
  categoryScrollUnlockTimer.value = globalThis.window.setTimeout(() => {
    // 只允许最后一次标签点击会话解锁，避免旧回调覆盖新状态。
    if (currentLockedSessionId.value !== nextSessionId) {
      return
    }
    releaseCategoryScrollLock()
    handleProductListScroll()
  }, CATEGORY_SCROLL_FALLBACK_MS)
}

const scrollToCategory = async (categoryKey: string) => {
  activeCategoryKey.value = categoryKey
  releaseCategoryScrollLock()
  if (largeDatasetMode.value) {
    // 大数据模式下列表按当前分类单独渲染，不再进行 DOM 锚点滚动。
    return
  }
  await nextTick()
  const scroller = listScrollerRef.value
  if (!scroller) {
    return
  }

  syncListViewportBottomSpacer()
  await nextTick()
  const nextScroller = listScrollerRef.value
  if (!nextScroller) {
    return
  }

  const targetMetrics = resolveCategoryScrollMetrics(categoryKey, nextScroller)
  if (!targetMetrics) {
    return
  }
  lockCategoryScrollSession(categoryKey, targetMetrics.reachableTargetTop)
  // 只驱动右侧滚动容器，避免 scrollIntoView 在不同浏览器下误触发页面级滚动或无滚动。
  nextScroller.scrollTo({
    top: targetMetrics.reachableTargetTop,
    behavior: 'smooth',
  })
}

const handleCategoryManualInterrupt = () => {
  if (!scrollingByCategoryClick.value) {
    return
  }
  releaseCategoryScrollLock()
  handleProductListScroll()
}

const resolveActiveCategoryByViewport = (scroller: HTMLElement) => {
  const firstCategoryKey = categoryGroups.value[0]?.key ?? 'all'
  if (scroller.scrollTop <= CATEGORY_SCROLL_HIT_THRESHOLD) {
    // 顶部位置允许“全部”和首个标签共用同一滚动位置：
    // - 用户主动点“全部”时保留“全部”高亮；
    // - 其余情况下顶部默认归属第一个真实分类。
    return activeCategoryKey.value === 'all' ? 'all' : firstCategoryKey
  }
  const anchorLine = Math.min(
    CATEGORY_VIEWPORT_ACTIVATE_OFFSET,
    Math.max(18, Math.floor(scroller.clientHeight * 0.12)),
  )
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  let passedCategoryKey = 'all'
  let visibleCategoryKey = 'all'

  for (const group of categoryGroups.value) {
    const section = sectionRefMap[group.key]
    if (!section) {
      continue
    }
    const sectionTopWithinScroller = resolveSectionTopWithinScroller(section, scroller)
    const relativeTop = sectionTopWithinScroller - scroller.scrollTop
    const relativeBottom = sectionTopWithinScroller + section.offsetHeight - scroller.scrollTop

    if (relativeTop <= anchorLine) {
      passedCategoryKey = group.key
    }
    if (relativeBottom > 0 && relativeTop < scroller.clientHeight - CATEGORY_BOTTOM_VISIBLE_PADDING) {
      visibleCategoryKey = group.key
    }
    if (relativeTop <= anchorLine && relativeBottom > anchorLine) {
      return group.key
    }
  }

  // 当列表接近底部时，后续分组可能无法再顶到顶部，此时优先采用“最后一个清晰可见分组”。
  if (maxScrollTop - scroller.scrollTop <= CATEGORY_SCROLL_HIT_THRESHOLD) {
    return visibleCategoryKey
  }
  return passedCategoryKey
}

const handleProductListScroll = () => {
  const scroller = listScrollerRef.value
  if (!scroller) {
    return
  }

  const lockHit = getPendingLockedCategory(scroller)
  if (lockHit === 'target-hit') {
    releaseCategoryScrollLock()
  } else if (lockHit) {
    activeCategoryKey.value = lockHit
    // 搜索模式、点击触发滚动与虚拟列表模式都不适合反向计算激活分类，直接跳过。
    return
  }

  if (isCategorySyncTemporarilyBlocked()) {
    // 搜索模式与虚拟列表模式都不适合反向计算激活分类，直接跳过。
    return
  }

  activeCategoryKey.value = resolveActiveCategoryByViewport(scroller)
}

const isCategorySyncTemporarilyBlocked = () => {
  return searchMode.value || largeDatasetMode.value || useRecommendedAllProductFlow.value || scrollingByCategoryClick.value
}

const getPendingLockedCategory = (scroller: HTMLElement): string | 'target-hit' | null => {
  // 用户点击分类后，在滚动抵达目标分组前锁定激活项，
  // 防止“先跳到目标后又瞬间回到上一个分类”的回写抖动。
  const pendingKey = pendingCategoryKey.value
  if (!pendingKey || !scrollingByCategoryClick.value) {
    return null
  }
  const targetMetrics = resolveCategoryScrollMetrics(pendingKey, scroller)
  if (!targetMetrics) {
    return null
  }
  const distanceToTarget = Math.abs(targetMetrics.reachableTargetTop - scroller.scrollTop)
  const nearBottom = targetMetrics.maxScrollTop - scroller.scrollTop <= CATEGORY_SCROLL_HIT_THRESHOLD
  const sectionReachedViewport = targetMetrics.relativeTop <= CATEGORY_VIEWPORT_ACTIVATE_OFFSET
    || (nearBottom
      && targetMetrics.relativeBottom > CATEGORY_VIEWPORT_ACTIVATE_OFFSET
      && targetMetrics.relativeTop < scroller.clientHeight - CATEGORY_BOTTOM_VISIBLE_PADDING)
  return distanceToTarget <= CATEGORY_SCROLL_HIT_THRESHOLD || sectionReachedViewport ? 'target-hit' : pendingKey
}

const handleMallViewportResize = () => {
  syncListViewportBottomSpacer()
  handleProductListScroll()
  void updateCompactAnnouncementOverflow()
}

const syncMallViewportAfterRender = async () => {
  await nextTick()
  syncListViewportBottomSpacer()
  handleProductListScroll()
  await updateCompactAnnouncementOverflow()
}

const cartDrawerVisible = ref(false)
const checkoutDrawerVisible = ref(false)

const openCartDrawer = () => {
  miniCartVisible.value = false
  cartDrawerVisible.value = true
}

const goToCheckout = () => {
  if (!clientCartStore.selectedValidItems.length) {
    if (clientCartStore.validItems.length > 0) {
      // 若用户尚未主动勾选，则默认全选有效商品，减少从商城直达结算的操作成本。
      clientCartStore.toggleAllValidSelected(true)
    } else {
      showAppWarning('购物车暂无可结算商品')
      return
    }
  }

  miniCartVisible.value = false
  cartDrawerVisible.value = false
  checkoutDrawerVisible.value = true
}

// 切离商城路由时立即收拢 mini-cart：
// 1. 防止 fixed 全屏遮罩在切页过渡阶段覆盖下一页；
// 2. 避免用户返回商城时误看到“上一次展开状态”。
watch(
  () => route.path,
  (nextPath) => {
    if (!nextPath.startsWith('/client/mall')) {
      miniCartVisible.value = false
      mobileSearchVisible.value = false
      searchInputFocused.value = false
    }
  },
)

onDeactivated(() => {
  mobileSearchVisible.value = false
  searchInputFocused.value = false
})

onMounted(async () => {
  globalThis.window.addEventListener('resize', handleMallViewportResize, { passive: true })
  const hasHydratedCatalog = products.value.length > 0
  if (hasHydratedCatalog) {
    // 已有缓存时先把现有内容稳定渲染出来，再后台刷新，避免首屏等待被网络重新拉长。
    warmupProductImages(products.value)
  }

  const loadPromise = loadProducts()
  if (hasHydratedCatalog) {
    await syncMallViewportAfterRender()
    await loadPromise
    await syncMallViewportAfterRender()
    return
  }

  await loadPromise
  await syncMallViewportAfterRender()
})

onBeforeUnmount(() => {
  clearCategoryUnlockTimer()
  globalThis.window.removeEventListener('resize', handleMallViewportResize)
})
</script>

<template>
  <section class="mall-page space-y-4">
    <Teleport v-if="shouldShowMobileSearchEntry" to="body">
      <button
        type="button"
        class="mall-mobile-search-trigger mall-mobile-search-trigger--floating"
        :class="{ 'is-hidden': mobileSearchVisible }"
        @click="openMobileSearch"
      >
        <el-icon><Search /></el-icon>
        <span>搜索</span>
      </button>
      <Transition name="mall-mobile-search">
        <div v-if="mobileSearchVisible" class="mall-mobile-search-overlay" @click.self="closeMobileSearch">
          <section class="mall-mobile-search-sheet">
            <header class="mall-mobile-search-sheet__header">
              <p class="mall-mobile-search-sheet__title">搜索商品</p>
              <button type="button" class="mall-mobile-search-sheet__close" @click="closeMobileSearch">完成</button>
            </header>
            <div class="mall-mobile-search-inline" :class="{ 'is-focused': searchInputFocused }">
              <span class="mall-search-launcher__icon">
                <el-icon><Search /></el-icon>
              </span>
              <input
                ref="mobileSearchInputRef"
                v-model.trim="keyword"
                type="search"
                class="mall-search-inline-input"
                placeholder="搜索商品名称"
                @focus="searchInputFocused = true"
                @blur="searchInputFocused = false"
              />
              <button
                v-if="hasKeyword"
                type="button"
                class="mall-search-inline-clear"
                aria-label="清空搜索"
                @click="clearSearch"
              >
                x
              </button>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="mall-image-preview">
        <div v-if="imagePreviewVisible" class="mall-image-preview-overlay" @click.self="closeProductImagePreview">
          <section class="mall-image-preview-panel">
            <button type="button" class="mall-image-preview-close" @click="closeProductImagePreview">关闭</button>
            <img :src="previewImageUrl" alt="商品" class="mall-image-preview-photo" />
          </section>
        </div>
      </Transition>
    </Teleport>

    <div
      class="mall-hero-card overflow-hidden rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]"
      :class="isPhone ? 'mall-hero-card--compact-mobile' : ''"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div v-if="!isPhone" class="mall-hero-card__heading">
          <p class="text-xs font-semibold tracking-[0.16em] text-slate-400">CLIENT MALL</p>
          <p class="mall-hero-card__title mt-1 text-xl font-semibold text-slate-900">商城</p>
          <p class="mall-hero-card__desc mt-1 text-sm text-slate-500">浏览标签、查看库存并快速加入购物车</p>
        </div>
        <button
          v-else-if="mallAnnouncementText"
          type="button"
          class="mall-hero-card__compact-banner"
          :class="{ 'is-actionable': compactAnnouncementOverflowing }"
          :disabled="!compactAnnouncementOverflowing"
          :title="compactAnnouncementOverflowing ? '点击查看完整公告' : undefined"
          aria-live="polite"
          @click="openFullAnnouncement"
        >
          <span class="mall-hero-card__compact-badge">公告</span>
          <p ref="compactAnnouncementTextRef" class="mall-hero-card__compact-text">{{ mallAnnouncementText }}</p>
        </button>
        <button
          type="button"
          class="mall-hero-card__refresh rounded-full border border-[var(--ylink-color-border)] bg-[var(--ylink-color-surface-soft)] px-4 py-2 text-sm text-slate-600"
          :disabled="refreshing"
          @click="loadProducts(true)"
        >
          {{ refreshing ? '刷新中...' : '刷新库存' }}
        </button>
      </div>
      <div v-if="!isPhone" class="mall-hero-card__meta-grid mt-4 grid gap-3 sm:grid-cols-3">
        <div class="mall-hero-card__meta-item rounded-2xl bg-[var(--ylink-color-surface-muted)] px-3 py-3 text-sm text-slate-700">营业时间：{{ storeBusinessHoursText }}</div>
        <div class="mall-hero-card__meta-item rounded-2xl bg-[var(--ylink-color-surface-muted)] px-3 py-3 text-sm text-slate-700">提货须知：请在订单有效期内到店核销</div>
        <div v-if="mallAnnouncementText" class="mall-hero-card__meta-item mall-hero-card__meta-item--notice rounded-2xl bg-amber-50 px-3 py-3 text-sm text-amber-700">公告：{{ mallAnnouncementText }}</div>
      </div>
      <div
        v-if="passiveRefreshErrorMessage"
        class="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700"
      >
        当前先展示本地缓存，后台刷新失败：{{ passiveRefreshErrorMessage }}
      </div>
    </div>
    <ElDialog
      v-model="announcementDialogVisible"
      :width="isPhone ? '88%' : '420px'"
      append-to-body
      align-center
      class="mall-announcement-dialog ylink-dialog-height-mode--auto"
      modal-class="mall-announcement-dialog-overlay"
    >
      <section class="mall-announcement-dialog__panel">
        <span class="mall-announcement-dialog__badge">公告</span>
        <h3 class="mall-announcement-dialog__title">商城公告</h3>
        <p class="mall-announcement-dialog__content">{{ mallAnnouncementText }}</p>
      </section>
    </ElDialog>
    <div v-if="loading" class="grid gap-3 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div v-for="index in 6" :key="index" class="h-[5.8rem] animate-pulse rounded-2xl bg-slate-100" />
    </div>
    <BaseRequestState
      v-else-if="blockingRequestError"
      :type="isOffline ? 'offline' : 'error'"
      :title="isOffline ? '网络异常' : '加载失败'"
      :description="blockingRequestError.message"
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

    <template v-else>
      <div v-if="searchMode" class="mall-sort-row">
        <div class="mall-sort-control" :class="{ 'is-animating': sortModeAnimating }" role="group" aria-label="商品排序">
          <button
            v-for="option in productSortOptions"
            :key="option.value"
            type="button"
            class="mall-sort-control__button"
            :class="{ 'is-active': sortMode === option.value }"
            :disabled="sortModeAnimating"
            @click="handleSortModeChange(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <section
        v-if="searchMode"
        class="mall-search-results space-y-3 rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-4 shadow-[var(--ylink-shadow-soft)]"
      >
      <div class="mall-search-launcher-wrap mall-search-launcher-wrap--inside">
        <div class="mall-search-toolbar mall-search-toolbar--minimal" :class="{ 'is-focused': searchInputFocused }">
          <span class="mall-search-launcher__icon">
            <el-icon><Search /></el-icon>
          </span>
          <input
            v-model.trim="keyword"
            type="search"
            class="mall-search-inline-input"
            placeholder="搜索商品名称 / 标签"
            @focus="searchInputFocused = true"
            @blur="searchInputFocused = false"
          />
          <button
            v-if="hasKeyword"
            type="button"
            class="mall-search-inline-clear"
            @click="clearSearch"
            aria-label="清空搜索"
          >
            x
          </button>
        </div>
      </div>
      <header class="flex items-center justify-between gap-3">
        <p class="text-sm font-semibold text-slate-700">搜索结果 {{ searchResults.length }} 条</p>
      </header>
      <div class="client-product-grid mall-product-grid">
        <article
          v-for="product in searchResults"
          :key="product.id"
          :ref="(el) => setProductCardRef(`search:${product.id}`, el, product.id)"
          class="client-product-card"
        >
          <button type="button" class="client-product-card__image-button" @click="openProductImagePreview(product)">
            <img
              :src="resolveProductThumbnail(product)"
              :alt="product.productName"
              class="client-product-card__cover"
              loading="lazy"
              decoding="async"
            />
          </button>
          <button type="button" class="client-product-card__body" @click="openProductDetail(product)">
            <div class="client-product-card__content">
              <p class="client-product-card__name">{{ product.productName }}</p>
              <div class="client-product-card__price-wrap">
                <p class="client-product-card__price">¥{{ Number(resolveProductPriceView(product).discountedPrice).toFixed(2) }}</p>
                <p v-if="resolveProductPriceView(product).isDiscounted" class="client-product-card__price-extra">
                  原价 ¥{{ Number(resolveProductPriceView(product).originalPrice).toFixed(2) }} · {{ resolveProductPriceView(product).discountLabel }}
                </p>
              </div>
              <div class="client-product-card__meta">
                <span class="rounded-full bg-[var(--ylink-color-primary-weak)] px-2 py-1 text-[var(--ylink-color-primary-strong)]">
                  可预订 {{ product.availableStock }}
                </span>
                <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">
                  已预订 {{ product.preOrderedStock }}
                </span>
                <span class="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                  已售 {{ resolveSoldQty(product) }}
                </span>
              </div>
            </div>
          </button>
          <button type="button" class="client-product-card__add-button" @click="quickAdd(product)">+ 加购</button>
        </article>
      </div>
    </section>

    <section
      v-else
      class="mall-browse-panel grid rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-3 sm:p-4 shadow-[var(--ylink-shadow-soft)]"
      :class="{ 'is-recommended-flow': isRecommendedSortMode }"
    >
      <div class="mall-search-launcher-wrap mall-search-launcher-wrap--inside mall-search-launcher-wrap--browse">
        <div class="mall-search-toolbar mall-search-toolbar--minimal" :class="{ 'is-focused': searchInputFocused }">
          <span class="mall-search-launcher__icon">
            <el-icon><Search /></el-icon>
          </span>
          <input
            v-model.trim="keyword"
            type="search"
            class="mall-search-inline-input"
            placeholder="搜索商品名称 / 标签"
            @focus="searchInputFocused = true"
            @blur="searchInputFocused = false"
          />
          <button
            v-if="hasKeyword"
            type="button"
            class="mall-search-inline-clear"
            @click="clearSearch"
            aria-label="清空搜索"
          >
            x
          </button>
        </div>
      </div>
      <div class="mall-sort-row mall-sort-row--category">
        <div class="mall-sort-control" :class="{ 'is-animating': sortModeAnimating }" role="group" aria-label="商品排序">
          <button
            v-for="option in productSortOptions"
            :key="option.value"
            type="button"
            class="mall-sort-control__button"
            :class="{ 'is-active': sortMode === option.value }"
            :disabled="sortModeAnimating"
            @click="handleSortModeChange(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <Transition name="mall-category-panel">
        <aside
          v-if="!isRecommendedSortMode"
          class="mall-browse-categories overflow-y-auto pr-1 sm:pr-2 hide-scrollbar"
        >
          <button
            v-for="category in categoryOptions"
            :key="category.key"
            type="button"
            class="mall-category-button mb-2 w-full rounded-xl px-2 py-2 sm:px-3 sm:py-3 text-left transition-colors duration-200"
            :class="activeCategoryKey === category.key ? 'bg-[var(--ylink-color-primary-strong)] text-white shadow-md' : 'bg-[var(--ylink-color-surface-muted)] text-slate-500 hover:bg-slate-200'"
            @click="scrollToCategory(category.key)"
          >
            <p class="truncate text-xs sm:text-sm font-medium">{{ category.label }}</p>
            <p class="mt-0.5 text-[10px] sm:text-xs opacity-75">{{ category.count }} 款</p>
          </button>
        </aside>
      </Transition>

      <div v-if="largeDatasetMode" class="mall-browse-list mall-browse-list--virtual overflow-y-auto pr-1" v-bind="virtualContainerProps">
        <div v-bind="virtualWrapperProps" class="client-product-grid mall-product-grid mall-virtual-wrapper">
          <article
            v-for="row in virtualRows"
            :key="row.data.id"
            :ref="(el) => setProductCardRef(`virtual:${row.data.id}`, el, row.data.id)"
            class="client-product-card mb-2"
          >
            <button type="button" class="client-product-card__image-button" @click="openProductImagePreview(row.data)">
              <img
                :src="resolveProductThumbnail(row.data)"
                :alt="row.data.productName"
                class="client-product-card__cover"
                loading="lazy"
                decoding="async"
              />
            </button>
            <button type="button" class="client-product-card__body" @click="openProductDetail(row.data)">
              <div class="client-product-card__content">
                <p class="client-product-card__name">{{ row.data.productName }}</p>
                <div class="client-product-card__price-wrap">
                  <p class="client-product-card__price">¥{{ Number(resolveProductPriceView(row.data).discountedPrice).toFixed(2) }}</p>
                  <p v-if="resolveProductPriceView(row.data).isDiscounted" class="client-product-card__price-extra">
                    原价 ¥{{ Number(resolveProductPriceView(row.data).originalPrice).toFixed(2) }} · {{ resolveProductPriceView(row.data).discountLabel }}
                  </p>
                </div>
                <div class="client-product-card__meta">
                  <span class="rounded-full bg-[var(--ylink-color-primary-weak)] px-2 py-1 text-[var(--ylink-color-primary-strong)]">可预订 {{ row.data.availableStock }}</span>
                  <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">已预订 {{ row.data.preOrderedStock }}</span>
                  <span class="rounded-full bg-slate-100 px-2 py-1 text-slate-600">已售 {{ resolveSoldQty(row.data) }}</span>
                </div>
              </div>
            </button>
            <button type="button" class="client-product-card__add-button" @click="quickAdd(row.data)">+ 加购</button>
          </article>
        </div>
      </div>

      <div
        v-else
        ref="listScrollerRef"
        class="mall-browse-list mall-browse-list--group overflow-y-auto pr-1"
        @scroll="handleProductListScroll"
        @wheel.passive="handleCategoryManualInterrupt"
        @touchstart.passive="handleCategoryManualInterrupt"
      >
        <section v-if="useRecommendedAllProductFlow" class="mall-category-section mb-4">
          <header class="mall-category-section__header sticky top-0 z-10 mb-2 rounded-lg bg-white/95 px-1 py-1.5 text-sm font-semibold text-slate-700 backdrop-blur-sm">
            推荐排序
          </header>
          <div class="client-product-grid mall-product-grid">
            <article
              v-for="product in recommendedAllProducts"
              :key="product.id"
              :ref="(el) => setProductCardRef(`recommended:${product.id}`, el, product.id)"
              class="client-product-card"
            >
              <button type="button" class="client-product-card__image-button" @click="openProductImagePreview(product)">
                <img
                  :src="resolveProductThumbnail(product)"
                  :alt="product.productName"
                  class="client-product-card__cover"
                  loading="lazy"
                  decoding="async"
                />
              </button>
              <button type="button" class="client-product-card__body" @click="openProductDetail(product)">
                <div class="client-product-card__content">
                  <p class="client-product-card__name">{{ product.productName }}</p>
                  <div class="client-product-card__price-wrap">
                    <p class="client-product-card__price">¥{{ Number(resolveProductPriceView(product).discountedPrice).toFixed(2) }}</p>
                    <p v-if="resolveProductPriceView(product).isDiscounted" class="client-product-card__price-extra">
                      原价 ¥{{ Number(resolveProductPriceView(product).originalPrice).toFixed(2) }} · {{ resolveProductPriceView(product).discountLabel }}
                    </p>
                  </div>
                  <div class="client-product-card__meta">
                    <span class="rounded-full bg-[var(--ylink-color-primary-weak)] px-2 py-1 text-[var(--ylink-color-primary-strong)]">可预订 {{ product.availableStock }}</span>
                    <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">已预订 {{ product.preOrderedStock }}</span>
                    <span class="rounded-full bg-slate-100 px-2 py-1 text-slate-600">已售 {{ resolveSoldQty(product) }}</span>
                  </div>
                </div>
              </button>
              <button type="button" class="client-product-card__add-button" @click="quickAdd(product)">+ 加购</button>
            </article>
          </div>
        </section>
        <template v-else>
          <section
            v-for="group in categoryGroups"
            :key="group.key"
            :ref="(el) => setSectionRef(group.key, el)"
            class="mall-category-section mb-4"
          >
            <header class="mall-category-section__header sticky top-0 z-10 mb-2 rounded-lg bg-white/95 px-1 py-1.5 text-sm font-semibold text-slate-700 backdrop-blur-sm">
              {{ group.label }}
            </header>
            <div class="client-product-grid mall-product-grid">
              <article
                v-for="product in group.items"
                :key="product.id"
                :ref="(el) => setProductCardRef(`${group.key}:${product.id}`, el, product.id)"
                class="client-product-card"
              >
                <button type="button" class="client-product-card__image-button" @click="openProductImagePreview(product)">
                  <img
                    :src="resolveProductThumbnail(product)"
                    :alt="product.productName"
                    class="client-product-card__cover"
                    loading="lazy"
                    decoding="async"
                  />
                </button>
                <button type="button" class="client-product-card__body" @click="openProductDetail(product)">
                  <div class="client-product-card__content">
                    <p class="client-product-card__name">{{ product.productName }}</p>
                    <div class="client-product-card__price-wrap">
                      <p class="client-product-card__price">¥{{ Number(resolveProductPriceView(product).discountedPrice).toFixed(2) }}</p>
                      <p v-if="resolveProductPriceView(product).isDiscounted" class="client-product-card__price-extra">
                        原价 ¥{{ Number(resolveProductPriceView(product).originalPrice).toFixed(2) }} · {{ resolveProductPriceView(product).discountLabel }}
                      </p>
                    </div>
                    <div class="client-product-card__meta">
                      <span class="rounded-full bg-[var(--ylink-color-primary-weak)] px-2 py-1 text-[var(--ylink-color-primary-strong)]">可预订 {{ product.availableStock }}</span>
                      <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">已预订 {{ product.preOrderedStock }}</span>
                      <span class="rounded-full bg-slate-100 px-2 py-1 text-slate-600">已售 {{ resolveSoldQty(product) }}</span>
                    </div>
                  </div>
                </button>
                <button type="button" class="client-product-card__add-button" @click="quickAdd(product)">+ 加购</button>
              </article>
            </div>
          </section>
        </template>
        <div class="mall-category-bottom-spacer" :style="{ height: `${listViewportBottomSpacer}px` }" aria-hidden="true"></div>
      </div>
    </section>
    </template>

    <div class="mini-cart-backdrop" :class="{ 'is-expanded': miniCartVisible }" @click="miniCartVisible = false"></div>
    <div class="mini-cart-wrapper" :class="{ 'is-expanded': miniCartVisible }">
      <section class="mini-cart-card" :class="{ 'is-pulse': settlePulsing }">
        <div class="cart-summary-bar" @click="miniCartVisible = !miniCartVisible">
          <div class="summary-info">
            <div class="cart-icon-wrapper">
              <el-icon><ShoppingCart /></el-icon>
              <Transition name="qty-pop" mode="out-in">
                <span v-if="bottomSelectedQty > 0" :key="`mini-badge-${bottomSelectedQty}`" class="badge">{{ bottomSelectedQty }}</span>
              </Transition>
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

            <TransitionGroup name="cart-item-flow" tag="div" class="item-list">
              <div v-if="clientCartStore.items.length === 0" key="mini-empty" class="empty-state">购物车还是空的，去挑挑好物吧</div>
              <article v-for="item in clientCartStore.items" :key="`mini-${item.skuId || item.productId}`" class="cart-item">
                <div class="item-main">
                  <p class="item-name">{{ item.productName }}</p>
                  <p class="item-price">¥{{ Number(resolveO2oPriceView(item).discountedPrice).toFixed(2) }}</p>
                  <p v-if="resolveO2oPriceView(item).isDiscounted" class="client-product-card__price-extra">
                    原价 ¥{{ Number(resolveO2oPriceView(item).originalPrice).toFixed(2) }} · {{ resolveO2oPriceView(item).discountLabel }}
                  </p>
                </div>
                <div class="item-stepper">
                  <p v-if="item.specText" class="text-xs text-slate-500">{{ item.specText }}</p>
                  <button type="button" class="step-btn" @click="clientCartStore.incrementQty(item.skuId || item.productId, -1)">-</button>
                  <span class="step-val">
                    <Transition name="qty-pop" mode="out-in">
                      <span :key="`mini-qty-${item.skuId || item.productId}-${item.qty}`" class="step-val__num">{{ item.qty }}</span>
                    </Transition>
                  </span>
                  <button type="button" class="step-btn" @click="clientCartStore.incrementQty(item.skuId || item.productId, 1)">+</button>
                </div>
              </article>
            </TransitionGroup>

            <div class="expand-footer">
              <button type="button" class="expand-link-btn" @click="openCartDrawer">进入购物车</button>
              <p class="total-price">
                合计：
                <Transition name="qty-pop" mode="out-in">
                  <span :key="`mini-total-${miniCartTotalAmount.toFixed(2)}`" class="price-num">¥{{ miniCartTotalAmount.toFixed(2) }}</span>
                </Transition>
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>

    <ElDrawer
      v-model="detailVisible"
      title="商品详情"
      :direction="isPhone ? 'btt' : 'rtl'"
      :size="isPhone ? 'auto' : '400px'"
      append-to-body
      :with-header="false"
      class="client-drawer-responsive"
    >
      <section
        v-if="detailProduct"
        class="client-detail-panel"
        :class="{ 'client-detail-panel--compact': !hasDetailSkuChoices }"
      >
        <div class="client-detail-scroll">
          <header v-if="hasDetailSkuChoices" class="client-detail-header client-detail-header--split">
            <div class="client-detail-summary">
              <p class="client-detail-title">{{ resolveCurrentDetailDisplayName(detailProduct) }}</p>
              <p class="client-detail-price">¥{{ Number(resolveCurrentDetailPriceView(detailProduct).discountedPrice).toFixed(2) }}</p>
              <p v-if="resolveCurrentDetailPriceView(detailProduct).isDiscounted" class="client-product-card__price-extra">
                原价 ¥{{ Number(resolveCurrentDetailPriceView(detailProduct).originalPrice).toFixed(2) }} · {{ resolveCurrentDetailPriceView(detailProduct).discountLabel }}
              </p>
              <p class="client-detail-desc">{{ resolveCurrentDetailDescription(detailProduct) }}</p>
              <div class="client-detail-tags">
                <span>可预订 {{ resolveCurrentDetailAvailableStock(detailProduct) }}</span>
                <span>已预订 {{ resolveCurrentDetailPreOrderedStock(detailProduct) }}</span>
                <span>已售 {{ resolveSoldQty(detailProduct) }}</span>
                <span>限购 {{ detailProduct.limitPerUser }}</span>
              </div>
            </div>
            <div class="client-detail-side-actions">
              <button
                type="button"
                class="client-detail-close-button"
                aria-label="Close product detail"
                @click="detailVisible = false"
              >
                <ElIcon>
                  <Close />
                </ElIcon>
              </button>
              <button type="button" class="client-detail-thumb-button" aria-label="Preview product image" @click="openDetailImagePreview">
                <img
                  :src="resolveDetailProductThumbnail(detailProduct)"
                  :alt="resolveCurrentDetailDisplayName(detailProduct)"
                  loading="lazy"
                  decoding="async"
                />
                <span>查看大图</span>
              </button>
            </div>
          </header>
          <header v-else class="client-detail-header client-detail-header--hero">
            <div class="client-detail-hero">
              <img
                :src="resolveDetailProductThumbnail(detailProduct)"
                :alt="resolveCurrentDetailDisplayName(detailProduct)"
                class="client-detail-hero-image"
                loading="lazy"
                decoding="async"
                @click="openDetailImagePreview"
              />
              <span class="client-detail-hero-tip" @click="openDetailImagePreview">查看大图</span>
              <button
                type="button"
                class="client-detail-hero-close"
                aria-label="Close product detail"
                @click="detailVisible = false"
              >
                <ElIcon>
                  <Close />
                </ElIcon>
              </button>
            </div>
            <div class="client-detail-summary">
              <p class="client-detail-title">{{ resolveCurrentDetailDisplayName(detailProduct) }}</p>
              <p class="client-detail-price">¥{{ Number(resolveCurrentDetailPriceView(detailProduct).discountedPrice).toFixed(2) }}</p>
              <p v-if="resolveCurrentDetailPriceView(detailProduct).isDiscounted" class="client-product-card__price-extra">
                原价 ¥{{ Number(resolveCurrentDetailPriceView(detailProduct).originalPrice).toFixed(2) }} · {{ resolveCurrentDetailPriceView(detailProduct).discountLabel }}
              </p>
              <p class="client-detail-desc">{{ resolveCurrentDetailDescription(detailProduct) }}</p>
              <div class="client-detail-tags">
                <span>可预订 {{ resolveCurrentDetailAvailableStock(detailProduct) }}</span>
                <span>已预订 {{ resolveCurrentDetailPreOrderedStock(detailProduct) }}</span>
                <span>已售 {{ resolveSoldQty(detailProduct) }}</span>
                <span>限购 {{ detailProduct.limitPerUser }}</span>
              </div>
            </div>
          </header>
          <div v-if="hasDetailSkuChoices" class="client-detail-sku-section">
            <p class="client-detail-section-title">选择规格</p>
            <div class="grid gap-2">
              <button
              v-for="sku in resolveActiveSkus(detailProduct)"
              :key="sku.id"
              type="button"
              class="relative flex min-h-11 flex-col items-start rounded-lg border bg-white px-3 py-2 pr-14 text-left text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              :class="selectedDetailSku?.id === sku.id ? 'border-cyan-500 bg-cyan-50' : 'border-slate-200'"
              :disabled="sku.availableStock <= 0"
              @click="selectDetailSku(sku)"
            >
              <span
                v-if="isSkuRecommended(sku, detailProduct)"
                class="sku-recommend-badge absolute right-2 top-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
              >
                推荐
              </span>
              <span>{{ sku.specText || '默认规格' }}</span>
              <small class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                <strong class="text-[var(--ylink-color-primary-strong)]">¥{{ Number(resolveO2oPriceView(sku).discountedPrice).toFixed(2) }}</strong>
                <template v-if="resolveO2oPriceView(sku).isDiscounted">
                  <span class="sku-discount-badge rounded-full bg-rose-50 px-1.5 py-0.5 text-[11px] font-semibold text-rose-600">
                    {{ resolveO2oPriceView(sku).discountLabel }}
                  </span>
                  <span class="text-slate-400 line-through">¥{{ Number(resolveO2oPriceView(sku).originalPrice).toFixed(2) }}</span>
                </template>
                <span>库存 {{ sku.availableStock }}</span>
              </small>
              </button>
            </div>
          </div>
        </div>
        <footer class="client-detail-action-bar">
          <div class="client-detail-qty-row">
            <span>数量</span>
            <div class="client-detail-qty-control">
              <button type="button" class="client-qty-button" aria-label="减少数量" @click="changeDetailQty(-1)">-</button>
              <span>{{ detailQty }}</span>
              <button type="button" class="client-qty-button" aria-label="增加数量" @click="changeDetailQty(1)">+</button>
            </div>
          </div>
          <button type="button" class="client-detail-cart-button" @click="addCurrentDetailToCart">
            加入购物车
          </button>
        </footer>
      </section>
    </ElDrawer>

    <ElDrawer
      v-model="cartDrawerVisible"
      title="购物车"
      direction="btt"
      size="92%"
      append-to-body
      :with-header="false"
      class="client-drawer-responsive"
      destroy-on-close
    >
      <ClientCartView
        @close="cartDrawerVisible = false"
        @checkout="goToCheckout"
      />
    </ElDrawer>

    <ElDrawer
      v-model="checkoutDrawerVisible"
      title="确认订单"
      direction="btt"
      size="92%"
      append-to-body
      :with-header="false"
      class="client-drawer-responsive"
      destroy-on-close
    >
      <ClientCheckoutView
        @close="checkoutDrawerVisible = false"
      />
    </ElDrawer>

  </section>
</template>

<style scoped>
.mall-page {
  /* 商城页仅为底部导航预留页面级安全区，悬浮购物车改为覆盖在内容上方，让商品选择区继续向下延伸。 */
  --mall-mini-cart-height: 4.7rem;
  --mall-floating-bottom-clearance: calc(var(--client-tab-bar-clearance, 5.5rem) + var(--mall-mini-cart-height) + 1rem);
  padding-bottom: calc(var(--client-tab-bar-clearance, 5.5rem) + 0.65rem);
}

.mall-search-results,
.mall-browse-panel {
  position: relative;
}

.mall-hero-card {
  position: relative;
}

.mall-hero-card__compact-banner {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 0.55rem;
  border: none;
  background: transparent;
  color: inherit;
  cursor: default;
  padding: 0;
  text-align: left;
}

.mall-hero-card__compact-banner:disabled {
  opacity: 1;
}

.mall-hero-card__compact-banner.is-actionable {
  cursor: pointer;
}

.mall-hero-card__compact-banner.is-actionable .mall-hero-card__compact-text {
  text-decoration: underline;
  text-decoration-color: rgba(146, 64, 14, 0.32);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.16rem;
}

.mall-hero-card__compact-banner.is-actionable:active {
  transform: scale(0.995);
}

.mall-hero-card__compact-badge {
  flex-shrink: 0;
  border-radius: 9999px;
  background: #ffedd5;
  color: #7c2d12;
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1;
  padding: 0.34rem 0.58rem;
}

.mall-hero-card__compact-text {
  overflow: hidden;
  color: #92400e;
  font-size: 0.76rem;
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.mall-announcement-dialog-overlay) {
  overflow: hidden;
}

:global(.mall-announcement-dialog-overlay .el-overlay-dialog) {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: max(1.25rem, env(safe-area-inset-top)) 1.25rem max(1.25rem, env(safe-area-inset-bottom));
  overflow-y: auto;
}

:global(.mall-announcement-dialog.el-dialog) {
  --el-dialog-width: min(420px, calc(100vw - 2.5rem));
  margin: 0 !important;
  overflow: hidden;
  border-radius: 1.35rem;
  background:
    linear-gradient(180deg, rgba(255, 251, 235, 0.92), rgba(255, 255, 255, 0.98) 46%),
    #ffffff;
  display: flex;
  flex-direction: column;
  align-self: center;
  width: var(--el-dialog-width) !important;
  height: fit-content !important;
  max-height: min(72vh, 28rem);
  min-height: unset !important;
  box-shadow:
    0 22px 60px rgba(15, 23, 42, 0.24),
    0 0 0 1px rgba(245, 158, 11, 0.12);
}

:global(.mall-announcement-dialog .el-dialog__header) {
  min-height: 0;
  margin: 0;
  padding: 0;
}

:global(.mall-announcement-dialog .el-dialog__headerbtn) {
  top: 0.78rem;
  right: 0.78rem;
  z-index: 2;
  height: 2.1rem;
  width: 2.1rem;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.78);
  transition:
    background var(--ylink-motion-fast) var(--ylink-motion-ease),
    transform var(--ylink-motion-fast) var(--ylink-motion-ease);
}

:global(.mall-announcement-dialog .el-dialog__headerbtn:hover) {
  background: rgba(255, 247, 237, 0.96);
  transform: scale(1.04);
}

:global(.mall-announcement-dialog .el-dialog__headerbtn .el-dialog__close) {
  color: #94a3b8;
  font-size: 1rem;
}

:global(.mall-announcement-dialog .el-dialog__body) {
  display: flex;
  flex: 0 0 auto !important;
  justify-content: center;
  height: auto !important;
  min-height: unset !important;
  max-height: inherit;
  overflow: visible !important;
  padding: 0;
}

.mall-announcement-dialog__panel {
  display: flex;
  width: 100%;
  min-height: 0;
  flex-direction: column;
  align-items: center;
  padding: 1.15rem 1.15rem 1.25rem;
}

.mall-announcement-dialog__badge {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  background: #ffedd5;
  color: #9a3412;
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1;
  padding: 0.38rem 0.68rem;
}

.mall-announcement-dialog__title {
  margin-top: 0.78rem;
  color: #0f172a;
  font-size: 1.12rem;
  font-weight: 750;
  line-height: 1.28;
  text-align: center;
}

.mall-announcement-dialog__content {
  margin-top: 0.86rem;
  width: 100%;
  max-height: min(42vh, 18rem);
  max-width: 23rem;
  overflow-y: auto;
  border-radius: 1rem;
  background: rgba(255, 247, 237, 0.72);
  color: #475569;
  font-size: 0.92rem;
  line-height: 1.75;
  padding: 0.85rem 0.95rem;
  text-align: center;
  white-space: pre-wrap;
  word-break: break-word;
}

.mall-browse-panel {
  --mall-category-rail-width: 76px;
  --mall-browse-gap: 0.75rem;
  --mall-reorder-layout-duration: 420ms;
  --mall-reorder-layout-easing: cubic-bezier(0.20, 0, 0, 1);
  align-items: start;
  gap: var(--mall-browse-gap);
  grid-template-columns: minmax(0, var(--mall-category-rail-width)) minmax(0, 1fr);
  transition:
    grid-template-columns var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing),
    grid-template-rows var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing),
    gap var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing);
}

.mall-browse-categories,
.mall-browse-list {
  max-height: clamp(18rem, calc(100dvh - var(--mall-floating-bottom-clearance) - 13.5rem), 42rem);
}

.mall-browse-categories {
  grid-column: 1;
  grid-row: 2;
}

.mall-browse-list {
  grid-column: 2;
  grid-row: 2;
  justify-self: stretch;
  min-width: 0;
  transition:
    opacity var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing),
    transform var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing);
}

.mall-browse-panel.is-recommended-flow {
  --mall-category-rail-width: 0px;
  --mall-browse-gap: 0rem;
}

.mall-browse-panel.is-recommended-flow .mall-browse-list {
  grid-column: 2;
}

.mall-browse-panel.is-recommended-flow .mall-sort-row--category {
  grid-column: 1;
  grid-row: 1;
  justify-self: flex-start;
  transform: translateX(0);
}

.mall-browse-panel.is-recommended-flow .mall-browse-list {
  grid-row: 2;
  justify-self: center;
  width: min(100%, 58rem);
  transform: translateX(0);
}

.mall-browse-panel.is-recommended-flow .mall-category-section {
  margin-right: auto;
  margin-left: auto;
  width: 100%;
}

.mall-browse-panel.is-recommended-flow .mall-product-grid {
  justify-content: center;
}

.mall-browse-panel.is-recommended-flow .client-product-grid {
  width: 100%;
}

.mall-category-panel-enter-active,
.mall-category-panel-leave-active {
  overflow: hidden;
  transition:
    opacity var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing),
    transform var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing),
    max-height var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing);
}

.mall-category-panel-enter-from,
.mall-category-panel-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateX(-0.65rem);
}

.mall-category-panel-enter-to,
.mall-category-panel-leave-from {
  max-height: 48rem;
  opacity: 1;
  transform: translateX(0);
}

.mall-product-grid {
  align-content: start;
}

.client-product-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.5rem;
}

.mall-category-bottom-spacer {
  width: 100%;
  pointer-events: none;
}

.client-product-card {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 3.9rem minmax(0, 1fr) auto;
  min-height: 6.8rem;
  align-items: stretch;
  gap: 0.68rem;
  border-radius: 0.85rem;
  border: 1px solid var(--ylink-color-border);
  background: var(--ylink-color-surface-soft);
  padding: 0.64rem 0.7rem;
}

.client-product-card__image-button {
  display: inline-flex;
  align-self: center;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  padding: 0;
}

.client-product-card__body {
  display: block;
  align-self: stretch;
  min-width: 0;
  height: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 0;
}

.client-product-card__content {
  display: flex;
  height: 100%;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  justify-content: space-between;
  text-align: left;
}

.client-product-card__name {
  overflow: visible;
  color: #0f172a;
  font-size: 0.98rem;
  font-weight: 700;
  line-height: 1.22;
  overflow-wrap: normal;
  text-overflow: clip;
  white-space: nowrap;
  word-break: keep-all;
}

.client-product-card__price-wrap {
  display: flex;
  min-height: 2.6rem;
  flex-direction: column;
  justify-content: flex-start;
}

.client-product-card__price {
  margin-top: 0.1rem;
  color: var(--ylink-color-primary-strong);
  font-size: 0.92rem;
  font-weight: 700;
  line-height: 1.16;
  font-variant-numeric: tabular-nums;
}

.client-product-card__meta {
  margin-top: auto;
  display: grid;
  grid-template-columns: max-content max-content;
  min-width: 0;
  align-items: center;
  gap: 0.26rem 0.32rem;
  overflow: visible;
  font-size: 0.72rem;
}

.client-product-card__meta > span {
  overflow: hidden;
  max-width: 5.4rem;
  padding: 0.2rem 0.42rem !important;
  line-height: 1.12;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client-product-card__meta > span:first-child {
  grid-column: 1 / -1;
  justify-self: start;
  max-width: 100%;
}

.client-product-card__price-extra {
  margin-top: 0.08rem;
  overflow: hidden;
  color: #94a3b8;
  font-size: 0.72rem;
  line-height: 1.16;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client-product-card__cover {
  height: 3.9rem;
  width: 3.9rem;
  flex-shrink: 0;
  border-radius: 0.7rem;
  background: #e2e8f0;
  object-fit: cover;
}

.client-detail-panel {
  display: flex;
  width: min(100%, 30rem);
  height: 100%;
  max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 0.75rem);
  min-height: 0;
  flex-direction: column;
  margin: 0 auto;
}

.client-detail-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.1rem 0.1rem 1rem;
}

.client-detail-panel--compact {
  max-height: min(72dvh, calc(100dvh - env(safe-area-inset-top, 0px) - 0.75rem));
}

.client-detail-panel--compact .client-detail-scroll {
  flex: 1;
  overflow-y: visible;
  padding-bottom: 0.55rem;
}

.client-detail-panel--compact .client-detail-action-bar {
  border-top: 0;
  padding-top: 0.3rem;
}

.client-detail-header--hero {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.client-detail-header--split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.85rem;
  align-items: start;
}

.client-detail-hero {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: 1rem;
  overflow: hidden;
  background: #f8fafc;
  flex-shrink: 0;
}

.client-detail-hero-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: pointer;
  display: block;
}

.client-detail-hero-close {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 10;
  display: inline-flex;
  width: 1.9rem;
  height: 1.9rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(203, 213, 225, 0.75);
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.9);
  color: #64748b;
  box-shadow: none;
  font-size: 0.78rem;
}

.client-detail-hero-tip {
  position: absolute;
  right: 0.5rem;
  bottom: 0.5rem;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.72);
  color: #ffffff;
  font-size: 0.62rem;
  font-weight: 700;
  line-height: 1;
  padding: 0.28rem 0.42rem;
  cursor: pointer;
}

.client-detail-hero-close:active,
.client-detail-cart-button:active {
  transform: scale(0.98);
}

.client-detail-summary {
  min-width: 0;
  padding-top: 0.15rem;
}

.client-detail-title {
  color: #0f172a;
  font-size: 1.12rem;
  font-weight: 700;
  line-height: 1.32;
  word-break: break-word;
}

.client-detail-price {
  margin-top: 0.48rem;
  color: var(--ylink-color-primary-strong);
  font-size: 1.02rem;
  font-weight: 800;
  line-height: 1.1;
}

.client-detail-desc {
  margin-top: 0.55rem;
  color: #64748b;
  font-size: 0.86rem;
  line-height: 1.45;
  word-break: break-word;
}

.client-detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.48rem;
  margin-top: 0.75rem;
  color: #475569;
  font-size: 0.75rem;
}

.client-detail-tags span {
  border-radius: 9999px;
  background: #f1f5f9;
  line-height: 1;
  padding: 0.45rem 0.72rem;
}

.client-detail-tags span:first-child {
  background: #ecfdf5;
  color: #059669;
}

.client-detail-tags span:nth-child(2) {
  background: #fffbeb;
  color: #b45309;
}

.client-detail-side-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5rem;
  flex-shrink: 0;
  padding-top: 0.15rem;
}

.client-detail-thumb-button {
  position: relative;
  display: block;
  width: 5rem;
  height: 5rem;
  overflow: hidden;
  border: 1px solid rgba(203, 213, 225, 0.88);
  border-radius: 1.15rem;
  background: #f8fafc;
  padding: 0;
  box-shadow: 0 12px 26px rgba(15, 23, 42, 0.1);
}

.client-detail-thumb-button img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.client-detail-thumb-button span {
  position: absolute;
  right: 0.35rem;
  bottom: 0.35rem;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.72);
  color: #ffffff;
  font-size: 0.62rem;
  font-weight: 700;
  line-height: 1;
  padding: 0.28rem 0.42rem;
}

.client-detail-close-button {
  display: inline-flex;
  width: 1.9rem;
  height: 1.9rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(203, 213, 225, 0.75);
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.9);
  color: #64748b;
  box-shadow: none;
  font-size: 0.78rem;
}

.client-detail-close-button:active,
.client-detail-thumb-button:active {
  transform: scale(0.98);
}

.client-detail-sku-section {
  margin-top: 1rem;
  border-radius: 1rem;
  background: #f8fafc;
  padding: 0.85rem;
}

.client-detail-section-title {
  margin-bottom: 0.6rem;
  color: #334155;
  font-size: 0.9rem;
  font-weight: 800;
}

.client-detail-action-bar {
  flex-shrink: 0;
  border-top: 1px solid rgba(226, 232, 240, 0.9);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.9), #ffffff 18%),
    #ffffff;
  padding: 0.72rem 0.1rem 1rem;
}

.client-detail-qty-row {
  display: flex;
  min-height: 3rem;
  align-items: center;
  justify-content: space-between;
  border-radius: 1rem;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.9rem;
  padding: 0.48rem 0.75rem;
}

.client-detail-qty-control {
  display: flex;
  align-items: center;
  gap: 0.62rem;
}

.client-detail-qty-control span {
  min-width: 1.7rem;
  color: #0f172a;
  font-size: 0.95rem;
  font-weight: 800;
  text-align: center;
}

.client-detail-cart-button {
  width: 100%;
  min-height: 2.9rem;
  margin-top: 0.75rem;
  border: none;
  border-radius: 9999px;
  background: #0f172a;
  color: #ffffff;
  font-size: 0.92rem;
  font-weight: 800;
}

@media (max-width: 640px) {
  .client-detail-panel {
    width: 100%;
    height: 100%;
    max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 0.5rem);
  }

  .client-detail-panel--compact {
    height: 100%;
    max-height: min(68dvh, calc(100dvh - env(safe-area-inset-top, 0px) - 0.5rem));
  }

  .client-detail-scroll {
    padding-bottom: 0.85rem;
  }

  .client-detail-panel--compact .client-detail-scroll {
    padding-bottom: 0.45rem;
    min-height: 20dvh;
  }

  .client-detail-header {
    gap: 0.68rem;
  }

  .client-detail-title {
    font-size: 1.04rem;
  }

  .client-detail-sku-section {
    margin-top: 0.85rem;
    padding: 0.75rem;
  }

  .client-detail-action-bar {
    padding-bottom: max(1rem, calc(env(safe-area-inset-bottom, 0px) + 0.65rem));
  }
}

.client-detail-image-button {
  position: relative;
  display: block;
  overflow: hidden;
  border: none;
  border-radius: 1rem;
  background: transparent;
  padding: 0;
  text-align: left;
}

.client-detail-image-button__hint {
  position: absolute;
  right: 0.75rem;
  bottom: 0.75rem;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.72);
  color: #ffffff;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  padding: 0.4rem 0.68rem;
}

.mall-image-preview-overlay {
  position: fixed;
  inset: 0;
  /* 预览层必须高于 Element Plus 抽屉/遮罩层，避免从详情页触发时被右侧抽屉覆盖。 */
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.82);
  padding: 1rem;
}

.mall-image-preview-panel {
  position: relative;
  display: flex;
  max-height: 100%;
  max-width: min(1100px, 100%);
  align-items: center;
  justify-content: center;
}

.mall-image-preview-close {
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
  z-index: 1;
  border: none;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.94);
  color: #0f172a;
  font-size: 0.82rem;
  font-weight: 600;
  line-height: 1;
  padding: 0.65rem 0.9rem;
}

.mall-image-preview-photo {
  display: block;
  max-height: min(88vh, 100%);
  max-width: min(94vw, 1100px);
  border-radius: 1.25rem;
  background: #ffffff;
  object-fit: contain;
  box-shadow: 0 24px 56px rgba(15, 23, 42, 0.28);
}

.mall-image-preview-enter-active,
.mall-image-preview-leave-active {
  transition: opacity var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mall-image-preview-enter-active .mall-image-preview-photo,
.mall-image-preview-leave-active .mall-image-preview-photo {
  transition:
    transform var(--ylink-motion-normal) var(--ylink-motion-ease),
    opacity var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mall-image-preview-enter-from,
.mall-image-preview-leave-to {
  opacity: 0;
}

.mall-image-preview-enter-from .mall-image-preview-photo,
.mall-image-preview-leave-to .mall-image-preview-photo {
  opacity: 0;
  transform: scale(0.97);
}

.client-product-card__add-button {
  height: 1.95rem;
  align-self: center;
  justify-self: end;
  border-radius: 9999px;
  border: none;
  background: var(--ylink-color-primary-strong);
  color: #ffffff;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0 0.72rem;
  white-space: nowrap;
}

.client-qty-button {
  height: 2.55rem;
  width: 2.55rem;
  border-radius: 9999px;
  border: none;
  background: var(--ylink-color-primary-strong);
  color: #ffffff;
  font-size: 1.05rem;
  font-weight: 800;
}

.mall-search-launcher-wrap {
  display: flex;
  justify-content: center;
  margin-top: -0.3rem;
  margin-bottom: -0.1rem;
}

.mall-search-toolbar {
  display: flex;
  width: min(100%, 36rem);
  align-items: center;
  gap: 0.42rem;
  border: 1px solid rgba(203, 213, 225, 0.92);
  border-radius: 9999px;
  background: rgba(248, 250, 252, 0.96);
  padding: 0.34rem 0.42rem;
  box-shadow: 0 6px 14px rgba(15, 23, 42, 0.05);
  transition:
    transform var(--ylink-motion-normal) var(--ylink-motion-ease),
    border-color var(--ylink-motion-normal) var(--ylink-motion-ease),
    box-shadow var(--ylink-motion-normal) var(--ylink-motion-ease),
    background var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mall-search-toolbar--minimal {
  min-height: 2.75rem;
}

.mall-search-toolbar.is-focused {
  transform: translateY(-1px);
  border-color: rgba(13, 148, 136, 0.28);
  background: rgba(255, 255, 255, 0.98);
  box-shadow:
    0 10px 22px rgba(15, 23, 42, 0.08),
    0 0 0 2px rgba(13, 148, 136, 0.08);
}

.mall-search-launcher-wrap--inside {
  margin-top: 0;
  margin-bottom: 0.1rem;
}

.mall-search-launcher-wrap--browse {
  grid-column: 2;
  grid-row: 1;
  margin-bottom: 0.15rem;
}

.mall-sort-row {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
  margin-top: -0.1rem;
  margin-bottom: 0.1rem;
}

.mall-sort-row--category {
  grid-column: 1;
  grid-row: 1;
  align-self: center;
  justify-content: flex-start;
  margin: 0;
}

.mall-sort-control {
  display: inline-flex;
  max-width: 100%;
  flex-shrink: 0;
  align-items: center;
  gap: 0.18rem;
  border: 1px solid rgba(203, 213, 225, 0.9);
  border-radius: 9999px;
  background: rgba(248, 250, 252, 0.94);
  padding: 0.18rem;
  box-shadow: 0 6px 14px rgba(15, 23, 42, 0.05);
}

.mall-sort-control__button {
  height: 1.85rem;
  min-width: 3.15rem;
  border: none;
  border-radius: 9999px;
  background: transparent;
  color: #64748b;
  font-size: 0.72rem;
  font-weight: 700;
  padding: 0 0.72rem;
  transition:
    background var(--ylink-motion-normal) var(--ylink-motion-ease),
    color var(--ylink-motion-normal) var(--ylink-motion-ease),
    transform var(--ylink-motion-fast) var(--ylink-motion-ease);
}

.mall-sort-control__button.is-active {
  background: var(--ylink-color-primary-strong);
  color: #ffffff;
  box-shadow: 0 8px 16px rgba(13, 116, 109, 0.18);
}

.mall-sort-control__button:disabled {
  cursor: wait;
}

.mall-sort-control__button:not(:disabled):active {
  transform: scale(0.96);
}

@media (prefers-reduced-motion: reduce) {
  .mall-sort-control__button {
    transition: none;
  }
}

.mall-mobile-search-trigger {
  display: inline-flex;
  height: 2rem;
  min-width: 4.6rem;
  align-items: center;
  justify-content: center;
  gap: 0.28rem;
  border: 1px solid rgba(148, 163, 184, 0.56);
  border-radius: 9999px;
  background: #ffffff;
  color: #0f172a;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0 0.65rem;
  box-shadow:
    0 10px 22px rgba(15, 23, 42, 0.14),
    0 0 0 1px rgba(255, 255, 255, 0.9) inset;
}

.mall-mobile-search-trigger--floating {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  top: calc(env(safe-area-inset-top) + 0.95rem);
  z-index: 220;
  transition:
    opacity var(--ylink-motion-normal) var(--ylink-motion-ease),
    visibility var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mall-mobile-search-trigger--floating.is-hidden {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.mall-search-launcher__icon {
  display: inline-flex;
  height: 1.65rem;
  width: 1.65rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: #0f766e;
  color: #ffffff;
  pointer-events: none;
}

.mall-search-inline-input {
  min-width: 0;
  flex: 1;
  border: none;
  background: transparent;
  overflow: hidden;
  color: #64748b;
  font-size: 0.84rem;
  font-weight: 500;
  line-height: 1.2;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
  outline: none;
}

.mall-search-inline-input::placeholder {
  color: #94a3b8;
}

.mall-search-inline-input[type='search']::-webkit-search-cancel-button {
  display: none;
}

.mall-search-inline-clear {
  display: inline-flex;
  height: 1.15rem;
  width: 1.15rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 9999px;
  background: #64748b;
  color: #ffffff;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  padding: 0;
  transition:
    transform var(--ylink-motion-normal) var(--ylink-motion-ease),
    background var(--ylink-motion-normal) var(--ylink-motion-ease),
    color var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mall-search-inline-clear:hover {
  transform: scale(1.08);
  background: #475569;
  color: #ffffff;
}

.mall-search-inline-clear:active {
  transform: scale(0.94);
}

.mall-mobile-search-overlay {
  position: fixed;
  inset: 0;
  z-index: 190;
  background: rgba(15, 23, 42, 0.34);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: max(0.65rem, env(safe-area-inset-top)) 0.75rem 0.75rem;
}

.mall-mobile-search-sheet {
  width: min(var(--client-shell-max, 1100px), calc(100vw - 1.5rem));
  border: 1px solid rgba(226, 232, 240, 0.95);
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.98);
  padding: 0.72rem;
  box-shadow: 0 18px 36px rgba(15, 23, 42, 0.2);
}

.mall-mobile-search-sheet__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.55rem;
}

.mall-mobile-search-sheet__title {
  color: #0f172a;
  font-size: 0.88rem;
  font-weight: 700;
}

.mall-mobile-search-sheet__close {
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 0.76rem;
  font-weight: 600;
  padding: 0;
}

.mall-mobile-search-inline {
  display: flex;
  align-items: center;
  gap: 0.38rem;
  min-height: 2.5rem;
  border: 1px solid rgba(203, 213, 225, 0.92);
  border-radius: 9999px;
  background: rgba(248, 250, 252, 0.96);
  padding: 0.3rem 0.38rem;
  transition:
    border-color var(--ylink-motion-normal) var(--ylink-motion-ease),
    box-shadow var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mall-mobile-search-inline.is-focused {
  border-color: rgba(13, 148, 136, 0.3);
  box-shadow: 0 0 0 2px rgba(13, 148, 136, 0.08);
}

.mall-mobile-search-enter-active,
.mall-mobile-search-leave-active {
  transition: opacity var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mall-mobile-search-enter-from,
.mall-mobile-search-leave-to {
  opacity: 0;
}

.mall-mobile-search-enter-active .mall-mobile-search-sheet,
.mall-mobile-search-leave-active .mall-mobile-search-sheet {
  transition:
    transform var(--ylink-motion-normal) var(--ylink-motion-ease),
    opacity var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mall-mobile-search-enter-from .mall-mobile-search-sheet,
.mall-mobile-search-leave-to .mall-mobile-search-sheet {
  transform: translateY(-8px);
  opacity: 0;
}

.mini-cart-wrapper {
  position: fixed;
  bottom: calc(var(--client-tab-bar-clearance, 5.5rem) + 0.75rem);
  left: 50%;
  z-index: 50;
  width: min(var(--client-shell-max, 1100px), calc(100vw - var(--client-shell-inline, 1.25rem) * 2));
  transform: translateX(-50%);
  pointer-events: none;
  transition:
    opacity var(--ylink-motion-normal) var(--ylink-motion-ease),
    transform var(--ylink-motion-normal) var(--ylink-motion-ease);
}

/* 当整个页面正在发生进入/离开过渡动画时，强制隐藏固定定位的购物车，避免重叠闪跳 */
.slide-left-enter-active .mini-cart-wrapper,
.slide-left-leave-active .mini-cart-wrapper,
.slide-right-enter-active .mini-cart-wrapper,
.slide-right-leave-active .mini-cart-wrapper {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* 与购物车卡片同策略：切页中禁用 backdrop，避免遮罩拦截下一页点击。 */
.slide-left-enter-active .mini-cart-backdrop,
.slide-left-leave-active .mini-cart-backdrop,
.slide-right-enter-active .mini-cart-backdrop,
.slide-right-leave-active .mini-cart-backdrop {
  opacity: 0 !important;
  pointer-events: none !important;
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
  transition: opacity var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mini-cart-backdrop.is-expanded {
  opacity: 1;
  pointer-events: auto;
}

.mini-cart-card {
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 1.5rem;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.68)),
    linear-gradient(135deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.08));
  backdrop-filter: blur(28px) saturate(1.35);
  -webkit-backdrop-filter: blur(28px) saturate(1.35);
  box-shadow:
    0 22px 54px rgba(15, 23, 42, 0.12),
    0 6px 18px rgba(15, 23, 42, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.72);
  pointer-events: auto;
  transition:
    transform var(--ylink-motion-normal) var(--ylink-motion-ease),
    box-shadow var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.mini-cart-card::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at top left, rgba(255, 255, 255, 0.42), transparent 34%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.26), transparent 52%);
  opacity: 0.95;
}

.mini-cart-card::after {
  content: '';
  position: absolute;
  inset: 1px;
  border-radius: calc(1.5rem - 1px);
  pointer-events: none;
  border: 1px solid rgba(255, 255, 255, 0.28);
  opacity: 0.9;
}

.mini-cart-card.is-pulse {
  animation: settle-pulse var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.cart-summary-bar {
  position: relative;
  z-index: 1;
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
  background: #e11d48;
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
  color: #64748b;
  font-size: 0.72rem;
}

.summary-actions {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-shrink: 0;
  flex-wrap: nowrap;
}

.btn-checkout {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 0.9rem;
  background: #0f172a;
  color: #ffffff;
  font-size: 0.88rem;
  font-weight: 600;
  padding: 0.7rem 1rem;
  white-space: nowrap;
  flex-shrink: 0;
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

@media (max-width: 640px) {
  .cart-expand-trigger {
    display: none;
  }
}

.cart-expand-trigger .el-icon {
  transition: transform var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.cart-expand-trigger .el-icon.is-expanded {
  transform: rotate(180deg);
}

.cart-expand-content {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--ylink-motion-normal) var(--ylink-motion-ease);
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

.cart-item-flow-enter-active,
.cart-item-flow-leave-active {
  transition:
    transform var(--ylink-motion-normal) var(--ylink-motion-ease),
    opacity var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.cart-item-flow-enter-from,
.cart-item-flow-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.cart-item-flow-move {
  transition: transform var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.qty-pop-enter-active,
.qty-pop-leave-active {
  transition:
    transform var(--ylink-motion-normal) var(--ylink-motion-ease),
    opacity var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.qty-pop-enter-from,
.qty-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.92);
}

.step-val__num {
  display: inline-block;
  min-width: 20px;
  text-align: center;
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

.hide-scrollbar {
  scrollbar-width: none;
}
.hide-scrollbar::-webkit-scrollbar {
  display: none;
}

.mall-category-section:last-of-type {
  margin-bottom: 0;
}

.mall-category-section__header {
  top: 0;
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
  .mall-browse-panel {
    --mall-category-rail-width: 140px;
  }

  .mall-search-toolbar {
    width: min(100%, 28rem);
    min-height: 2.65rem;
    padding: 0.3rem 0.38rem;
  }

  .mall-search-inline-input {
    font-size: 0.8rem;
  }

  .mall-mobile-search-trigger {
    display: none;
  }

  .client-product-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

}

@media (min-width: 1200px) {
  .mall-search-toolbar {
    width: min(100%, 36rem);
    min-height: 2.75rem;
    padding: 0.34rem 0.42rem;
  }

  .mall-search-inline-input {
    font-size: 0.84rem;
  }

  .client-product-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 767px) {
  :global(.mall-announcement-dialog-overlay .el-overlay-dialog) {
    padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom));
  }

  :global(.mall-announcement-dialog.el-dialog) {
    --el-dialog-width: min(88vw, 23rem);
    border-radius: 1.25rem;
    max-height: min(68vh, 24rem);
  }

  .mall-announcement-dialog__panel {
    padding: 1rem 1rem 1.1rem;
  }

  .mall-announcement-dialog__title {
    font-size: 1.05rem;
  }

  .mall-announcement-dialog__content {
    max-height: min(38vh, 16rem);
    font-size: 0.88rem;
    line-height: 1.68;
    padding: 0.78rem 0.85rem;
  }

  .mall-browse-panel {
    --mall-reorder-layout-duration: 280ms;
    --mall-browse-gap: 0.7rem;
    --mall-category-rail-width: 76px;
    grid-template-columns: minmax(0, var(--mall-category-rail-width)) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .mall-search-launcher-wrap {
    margin-top: -0.2rem;
  }

  .mall-search-launcher-wrap--inside {
    margin-top: 0;
  }

  .mall-search-launcher-wrap--browse {
    margin-bottom: 0.05rem;
  }

  .mall-sort-row {
    grid-column: 1 / -1;
    grid-row: 1;
    justify-content: flex-start;
    margin-bottom: 0.05rem;
  }

  .mall-sort-control {
    padding: 0.16rem;
  }

  .mall-sort-row--category .mall-sort-control {
    width: auto;
    flex-direction: row;
    border-radius: 9999px;
  }

  .mall-sort-control__button {
    height: 1.72rem;
    min-width: 2.85rem;
    font-size: 0.68rem;
    padding: 0 0.58rem;
  }

  .mall-sort-row--category .mall-sort-control__button {
    width: auto;
    min-width: 2.85rem;
  }

  .mall-browse-panel.is-recommended-flow {
    --mall-category-rail-width: 0px;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .mall-browse-panel.is-recommended-flow .mall-sort-row--category {
    grid-column: 1 / -1;
    grid-row: 1;
  }

  .mall-browse-panel.is-recommended-flow .mall-browse-list {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-self: stretch;
    width: 100%;
  }

  .mall-search-toolbar {
    display: none;
  }

  .mall-mobile-search-trigger {
    display: inline-flex;
    min-width: 4.2rem;
    height: 1.9rem;
    font-size: 0.68rem;
    padding-inline: 0.58rem;
  }

  .mall-mobile-search-trigger--floating {
    top: calc(env(safe-area-inset-top) + 1.15rem);
  }

  .mall-page {
    --mall-mini-cart-height: 4.95rem;
    --mall-floating-bottom-clearance: calc(var(--client-tab-bar-clearance, 5.5rem) + var(--mall-mini-cart-height) + 0.85rem);
    padding-bottom: calc(var(--client-tab-bar-clearance, 5.5rem) + 0.35rem);
    gap: 0.7rem;
  }

  .mall-hero-card {
    border-radius: 1.15rem;
    padding: 0.8rem;
  }

  .mall-hero-card--compact-mobile {
    border-radius: 1rem;
    padding: 0.68rem 0.78rem;
  }

  .mall-hero-card__heading {
    min-width: 0;
    flex: 1;
  }

  .mall-hero-card__title {
    font-size: 1rem;
    line-height: 1.2;
  }

  .mall-hero-card__desc {
    margin-top: 0.2rem;
    font-size: 0.74rem;
    line-height: 1.3;
  }

  .mall-hero-card__refresh {
    padding: 0.45rem 0.8rem;
    font-size: 0.78rem;
    line-height: 1.1;
  }

  .mall-hero-card--compact-mobile .mall-hero-card__refresh {
    flex-shrink: 0;
    padding: 0.42rem 0.72rem;
    font-size: 0.74rem;
  }

  .mall-hero-card__meta-grid {
    margin-top: 0.65rem;
    gap: 0.45rem;
  }

  .mall-hero-card__meta-item {
    border-radius: 0.9rem;
    padding: 0.58rem 0.75rem;
    font-size: 0.75rem;
    line-height: 1.3;
  }

  .mall-hero-card__meta-item:not(.mall-hero-card__meta-item--notice) {
    display: none;
  }

  .mall-browse-panel {
    gap: 0.65rem;
    padding: 0.7rem;
  }

  .mall-browse-categories {
    grid-column: 1;
    grid-row: 2;
    display: block;
    max-height: clamp(28rem, calc(100dvh - var(--client-tab-bar-clearance, 5.5rem) - 5.1rem), 48rem);
    overflow-x: hidden;
    overflow-y: auto;
    padding: 0 0.12rem 0 0;
  }

  .mall-category-panel-enter-active,
  .mall-category-panel-leave-active {
    transition:
      opacity var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing),
      transform var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing),
      max-height var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing),
      margin var(--mall-reorder-layout-duration) var(--mall-reorder-layout-easing);
  }

  .mall-category-panel-enter-from,
  .mall-category-panel-leave-to {
    max-height: 0;
    opacity: 0;
    transform: translateX(-0.45rem);
  }

  .mall-category-panel-enter-to,
  .mall-category-panel-leave-from {
    max-height: 48rem;
    opacity: 1;
    transform: translateX(0);
  }

  .mall-browse-list {
    grid-column: 2;
    grid-row: 2;
    justify-self: stretch;
    width: 100%;
  }

  .mall-browse-categories,
  .mall-browse-list {
    /*
     * 移动端商品选择区继续向下延伸：
     * 1. 页面级不再为悬浮购物车完整让位；
     * 2. 列表高度仅主要避让底部导航，让购物车亚克力卡片覆盖在上方；
     * 3. 末尾商品是否会被挡住，交给列表内部 spacer 处理，而不是提前牺牲可视高度。
     */
    max-height: clamp(28rem, calc(100dvh - var(--client-tab-bar-clearance, 5.5rem) - 5.1rem), 48rem);
  }

  .mall-browse-categories.mall-category-panel-enter-from,
  .mall-browse-categories.mall-category-panel-leave-to {
    max-height: 0;
    opacity: 0;
    transform: translateX(-0.45rem);
  }

  .mall-browse-categories.mall-category-panel-enter-to,
  .mall-browse-categories.mall-category-panel-leave-from {
    max-height: 48rem;
    opacity: 1;
    transform: translateX(0);
  }

  .mall-category-button {
    margin-bottom: 0.45rem;
    border-radius: 0.95rem;
    padding: 0.65rem 0.45rem;
    text-align: center;
  }

  .mall-category-button p:first-child {
    font-size: 0.74rem;
    line-height: 1.2;
  }

  .mall-category-button p:last-child {
    margin-top: 0.18rem;
    font-size: 0.62rem;
  }

  .mall-category-section__header {
    margin-bottom: 0.45rem;
    padding: 0.32rem 0.45rem;
    font-size: 0.78rem;
  }

  .mall-product-grid {
    gap: 0.5rem;
  }

  .mall-virtual-wrapper {
    padding-bottom: 0.2rem;
  }

  .client-product-card {
    grid-template-columns: 3.45rem minmax(0, 1fr) auto;
    min-height: 6.25rem;
    gap: 0.5rem;
    border-radius: 0.85rem;
    padding: 0.58rem 0.56rem;
  }

  .client-product-card__cover {
    height: 3.45rem;
    width: 3.45rem;
    border-radius: 0.68rem;
  }

  .client-product-card__name {
    font-size: 0.94rem;
  }

  .client-product-card__price {
    font-size: 0.88rem;
  }

  .client-product-card__meta {
    margin-top: 0.34rem;
    gap: 0.22rem;
  }

  .client-product-card__meta > span {
    padding: 0.18rem 0.38rem !important;
    font-size: 0.68rem;
  }

  .client-product-card__add-button {
    height: 1.9rem;
    font-size: 0.7rem;
    padding: 0 0.58rem;
  }

  .mini-cart-wrapper {
    bottom: calc(var(--client-tab-bar-clearance, 5.5rem) + 0.4rem);
  }

  .cart-summary-bar {
    align-items: center;
    min-height: 58px;
    padding: 0.75rem 0.85rem;
  }

  .summary-info {
    gap: 0.55rem;
  }

  .cart-icon-wrapper {
    height: 40px;
    width: 40px;
    border-radius: 0.8rem;
  }

  .main-text {
    font-size: 0.84rem;
  }

  .sub-text {
    font-size: 0.68rem;
  }

  .summary-actions {
    justify-content: center;
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

@media (max-width: 520px) {
  .cart-summary-bar {
    align-items: stretch;
  }

  .summary-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .btn-checkout {
    min-height: 38px;
    font-size: 0.82rem;
    padding-inline: 0.8rem;
  }

  .cart-expand-trigger {
    align-self: flex-end;
  }
}

@media (min-width: 640px) and (max-width: 767px) {
  .mall-browse-panel {
    --mall-category-rail-width: 105px;
    grid-template-columns: minmax(0, var(--mall-category-rail-width)) minmax(0, 1fr);
  }

  .mall-browse-panel.is-recommended-flow {
    --mall-category-rail-width: 0px;
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (min-width: 641px) {
  :deep(.client-drawer-responsive .el-drawer) {
    border-top-left-radius: 1.5rem;
    border-bottom-left-radius: 1.5rem;
  }
}

/* =========================================================
   Apple VisionOS / Windows 11 Acrylic Panel Paradigm
   ========================================================= */

/* --------------------------------------------------------- 
   2. 托盘内边距与网格间距优化 (Apple Grid Breathability) 
   --------------------------------------------------------- */ 

/* 大托盘底座：适度外扩四周内边距，给边缘留白 */ 
.mall-browse-panel { 
  padding: 1rem !important; 
  background: rgba(255, 255, 255, 0.45) !important; 
  backdrop-filter: blur(24px) saturate(150%) !important; 
  -webkit-backdrop-filter: blur(24px) saturate(150%) !important; 
  border: 1px solid rgba(255, 255, 255, 0.6) !important; 
  border-radius: 1.6rem !important; 
  box-shadow: 
    inset 0 1px 2px rgba(255, 255, 255, 0.5), 
    0 12px 36px -12px rgba(15, 23, 42, 0.05) !important; 
} 

@media (min-width: 768px) { 
  .mall-browse-panel { 
    padding: 1.5rem 1.6rem !important; /* 桌面端更宽绰，给几何体呼吸感 */ 
    --mall-browse-gap: 1.5rem; /* 分类栏和网格栏推开 24px */ 
  } 
} 

/* ========================================================= 
   Apple 级滚动边界羽化 (Apple Scroll Edge Feathering) 
   ========================================================= */ 

/* --------------------------------------------------------- 
   1. 滚动区域：双向渐变遮罩 (Zero-clipping WebKit Mask) 
   为商品卡片滚动提供极致丝滑的羽化边缘。
   顶部和底部各留出 1.5rem（24px）的无缝羽化淡出区，让卡片像在迷雾中升起又消融。
   --------------------------------------------------------- */ 
.mall-browse-list { 
  /* 启用双向线性渐变遮罩：上下两端羽化淡出 */ 
  -webkit-mask-image: linear-gradient( 
    to bottom, 
    transparent 0%,           /* 顶部透明起点 */
    #000 1.5rem,              /* 顶部 24px 范围渐变淡入 */ 
    #000 calc(100% - 1.5rem), /* 中间部分保持完全显示 */ 
    transparent 100%          /* 底部 24px 范围渐变淡出 */ 
  ) !important; 
  
  mask-image: linear-gradient( 
    to bottom, 
    transparent 0%, 
    #000 1.5rem, 
    #000 calc(100% - 1.5rem), 
    transparent 100% 
  ) !important; 
} 

/* 重新配置网格间距，稍微紧凑一点以适应卡片内容 */ 
.client-product-grid { 
  display: grid; 
  grid-template-columns: minmax(0, 1fr); 
  gap: 0.5rem; /* 移动端保持更紧凑的 8px */ 
} 

@media (min-width: 768px) { 
  .client-product-grid { 
    grid-template-columns: repeat(2, minmax(0, 1fr)); 
    gap: 0.6rem !important; /* 中屏卡片间距收缩至 9.6px */ 
  } 
} 

@media (min-width: 1200px) { 
  .client-product-grid { 
    grid-template-columns: repeat(3, minmax(0, 1fr)); 
    gap: 0.75rem !important; /* 大屏卡片间距收缩至 12px，使网格排布更加精致 */ 
  } 
} 

/* 适配分类标题的边距与磨砂模糊过渡 (Frosted Glass Sticky Header) */ 
.mall-category-section__header { 
  position: sticky; 
  top: 0; 
  z-index: 10; 
  margin-bottom: 0.65rem !important; /* 配合网格收缩，减少标题下方空白 */ 
  padding: 0.5rem 0.75rem !important; /* 增加小幅留白 */ 
  border-radius: 0.75rem; 
  
  /* 恢复为完全透明背景，放弃磨砂吸顶，配合外层的双向渐变遮罩 */ 
  background: transparent !important; 
  backdrop-filter: none !important; 
  -webkit-backdrop-filter: none !important; 
  border-bottom: none !important; 
  
  color: #1e293b !important; 
  font-weight: 750; 
  
  /* 告诉浏览器准备进行独立硬件图层复合，提升滚动帧率 */ 
  will-change: transform; 
} 

/* ---------------------------------------------------------
   2. 悬浮的物理亚克力商品卡片 (Floating Acrylic Product Card)
   纯白实体卡片，叠在微彩色折射的托盘上，边界感与悬浮感瞬间拉满！
   --------------------------------------------------------- */
.client-product-card {
  /* 100% 不透明的高亮白，与背景的半透磨砂拉开绝对色差 */
  background: #ffffff !important;
  
  /* 极细的白色高光包边（Rim Light），模拟压克力倒角折射 */
  border: 1px solid rgba(255, 255, 255, 0.85) !important;
  border-radius: 1.15rem !important;
  
  /* 散落式的物理阴影，烘托卡片悬浮于玻璃面板之上的高度感 */
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.02),
    0 12px 24px -10px rgba(15, 23, 42, 0.06) !important;
  transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1) !important;
}

/* 悬停高度抬升动效 */
.client-product-card:hover {
  transform: translate3d(0, -3px, 0) scale(1.005);
  background: #ffffff !important;
  border-color: rgba(13, 148, 136, 0.25) !important; /* 触碰时微透品牌绿 */
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.02),
    0 20px 32px -8px rgba(15, 23, 42, 0.08) !important;
}

/* 商品略缩图占位符高亮柔化 */
.client-product-card__cover {
  border-radius: 0.85rem;
  background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%) !important;
  border: 1px solid rgba(0, 0, 0, 0.015) !important;
}

/* ========================================================= 
   Apple macOS Sidebar & Breathing Grid Refinement 
   ========================================================= */ 

/* --------------------------------------------------------- 
   1. 侧边栏重构 (macOS 无界侧边栏体系 - 彻底消除卡片违和感) 
   --------------------------------------------------------- */ 

/* 真正的无界侧边栏：彻底去除实体分割线，纯靠“空间留白（Negative Space）”划定控制域 */ 
.mall-browse-categories { 
  border-right: none !important; /* 移除生硬的物理边界线 */
  /* padding-right: 1.25rem !important; 移除全局 padding-right，避免在移动端挤压标签 */ 
  max-height: clamp(28rem, calc(100dvh - var(--client-tab-bar-clearance, 5.5rem) - 5.1rem), 48rem); 
} 

/* 仅在桌面端应用 macOS 风格的呼吸感留白，保护移动端有限的宽度 */
@media (min-width: 768px) {
  .mall-browse-categories {
    padding-right: 1.25rem !important; 
  }
}

/* 未激活项：纯白实体卡片，配合白色高光包边与散落环境软影，实现极致的弱边界感 */ 
.mall-browse-categories .mall-category-button:not(.bg-\[var\(--ylink-color-primary-strong\)\]) { 
  background: #ffffff !important; 
  border: 1px solid rgba(255, 255, 255, 0.85) !important; /* 白色高光包边（Rim Light），无灰色硬线 */
  box-shadow: 
    0 1px 2px rgba(15, 23, 42, 0.02), /* 极弱的顶层接触影 */
    0 8px 16px -6px rgba(15, 23, 42, 0.04) !important; /* 散落开来的环境软投影 */
  color: #334155 !important; 
  font-weight: 500;
  border-radius: 0.75rem !important; 
  margin-bottom: 0.35rem !important; 
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1) !important; 
} 

/* 悬停响应：边缘微微透出品牌绿，轻微上浮 */ 
.mall-browse-categories .mall-category-button:not(.bg-\[var\(--ylink-color-primary-strong\)\]):hover { 
  background: #ffffff !important; 
  border-color: rgba(13, 148, 136, 0.15) !important; /* 悬浮时透出极淡品牌色边界 */
  color: #0f172a !important; 
  transform: translateY(-1px) translateX(2px); 
  box-shadow: 
    0 1px 3px rgba(0, 0, 0, 0.02), 
    0 12px 24px -8px rgba(15, 23, 42, 0.06) !important; 
} 

/* 激活标签：采用富有品牌特色、饱满圆润的胶囊微光块 */ 
.mall-browse-categories .mall-category-button.bg-\[var\(--ylink-color-primary-strong\)\] { 
  background: #0d9488 !important; 
  border: 1px solid transparent !important; /* 保持 1px 边框位，彻底解决切换标签时的像素级布局抖动 */
  color: #ffffff !important; 
  border-radius: 0.75rem !important; 
  box-shadow: 
    0 8px 16px -3px rgba(13, 148, 136, 0.22), 
    0 2px 6px -2px rgba(13, 148, 136, 0.1) !important; 
  transform: scale(1.02) translateX(2px); 
} 

/* ---------------------------------------------------------
   4. 检索、排序组件白净化（配合半透托盘）
   --------------------------------------------------------- */

/* 搜索框：纯白底色，在折射托盘上极为醒目 */
.mall-search-toolbar {
  background: #ffffff !important;
  border: 1px solid rgba(148, 163, 184, 0.15) !important;
}

/* ========================================================= 
   分段选择器：iOS 17 标准高对比物理音轨 (iOS Segmented Control) 
   ========================================================= */ 

/* 1. 滑块音盘轨道：加深底色，营造精致的下沉物理滑槽 */ 
.mall-sort-control { 
  background: rgba(100, 116, 139, 0.12) !important; 
  border: 1px solid rgba(148, 163, 184, 0.22) !important; 
  padding: 2.5px !important; /* 紧凑贴合边界 */ 
  box-shadow: 
    inset 0 1px 2px rgba(15, 23, 42, 0.04), /* 下凹内阴影 */ 
    0 1px 0 rgba(255, 255, 255, 0.8) !important; /* 底部高光亮线，产生凹槽折射感 */ 
} 

/* 2. 未激活选项文字：适当加深色值，提升在强光下的易读性 */ 
.mall-sort-control__button { 
  color: #475569 !important; /* 略深的 Slate 灰 */ 
  font-weight: 600; 
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important; 
} 

/* 悬停反馈 */ 
.mall-sort-control__button:hover { 
  color: #0f172a !important; 
} 

/* 3. 激活状态：强化边缘接触阴影，凸显悬浮厚度 */ 
.mall-sort-control__button.is-active { 
  background: #ffffff !important; 
  color: #0f172a !important; 
  font-weight: 700; 
  box-shadow: 
    0 3px 8px rgba(15, 23, 42, 0.12), 
    0 1px 3px rgba(15, 23, 42, 0.04) !important; 
} 

/* =========================================================
   5. 顶部公告面板 & 悬浮购物车 (Liquid Glass & Acrylic 规范)
   ========================================================= */

/* 顶部 Hero Card：Apple 液态半透玻璃 */
.mall-hero-card {
  background: rgba(255, 255, 255, 0.55) !important;
  backdrop-filter: blur(24px) saturate(165%);
  -webkit-backdrop-filter: blur(24px) saturate(165%);
  border: 1px solid rgba(255, 255, 255, 0.55) !important;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.01),
    0 16px 36px -12px rgba(15, 23, 42, 0.03) !important;
  border-radius: 1.6rem !important;
}

/* 内层置顶指示框 */
.mall-hero-card__meta-item {
  background: rgba(241, 245, 249, 0.45) !important;
  border: 1px solid rgba(255, 255, 255, 0.6) !important;
  border-radius: 1.1rem !important;
}

/* 底部悬浮购物车 (Fluent Acrylic 压克力材料规范) */
.mini-cart-card {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(255, 255, 255, 0.58)),
    linear-gradient(135deg, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.06)) !important;
  backdrop-filter: blur(32px) saturate(150%) !important;
  -webkit-backdrop-filter: blur(32px) saturate(150%) !important;
  border: 1px solid rgba(255, 255, 255, 0.55) !important;
  box-shadow:
    0 20px 48px -10px rgba(15, 23, 42, 0.12),
    0 4px 12px -2px rgba(15, 23, 42, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 0.6) !important;
}
</style>
