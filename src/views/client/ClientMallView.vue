<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientMallView.vue
 * 文件职责：承载客户端商城的商品浏览、标签联动、加购与结算入口能力。
 * 维护说明：重点维护“左侧标签高亮 <-> 右侧分组定位”一致性，避免快速切换时出现错位与回跳。
 */


import { useVirtualList } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ArrowDown, ArrowRight, Search, ShoppingCart } from '@element-plus/icons-vue'
import { getO2oMallProducts, type O2oMallProduct } from '@/api/modules/o2o'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import { useClientAuthStore, useClientCartStore, useClientCatalogStore } from '@/store'
import pinia from '@/store/pinia'
import { normalizeRequestError } from '@/utils/error'
import { useDevice } from '@/composables/useDevice'
import { resolveProductPlaceholder } from '@/utils/product-placeholder'

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
const detailVisible = ref(false)
const detailQty = ref(1)
const detailProduct = ref<O2oMallProduct | null>(null)
const imagePreviewVisible = ref(false)
const previewImageUrl = ref('')
const miniCartVisible = ref(false)
const settlePulsing = ref(false)
const searchInputFocused = ref(false)
const mobileSearchVisible = ref(false)
const mobileSearchInputRef = ref<HTMLInputElement | null>(null)
const isMallRoute = computed(() => route.path.startsWith('/client/mall'))
const shouldShowMobileSearchEntry = computed(() => isPhone.value && isMallRoute.value)

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

// 商城页属于高频返回页面，初始化时优先恢复购物车与目录缓存，避免每次进入都重置上下文。
clientCartStore.initialize(clientAuthStore.currentUser?.id)
clientCatalogStore.initialize(clientAuthStore.currentUser?.id)

const products = computed(() => clientCatalogStore.products)
const storeBusinessHoursText = computed(() => clientCatalogStore.storefront.businessHoursText || '10:00 - 22:00')
const normalizedKeyword = computed(() => keyword.value.trim().toLowerCase())
const hasKeyword = computed(() => normalizedKeyword.value.length > 0)
const hasRenderableProducts = computed(() => products.value.length > 0)
const blockingRequestError = computed(() => {
  return hasRenderableProducts.value ? null : requestError.value
})
const passiveRefreshErrorMessage = computed(() => {
  return hasRenderableProducts.value ? requestError.value?.message ?? '' : ''
})

const classifyProduct = (product: O2oMallProduct) => {
  return product.tags && product.tags.length > 0 ? product.tags : ['默认标签']
}

const resolveProductThumbnail = (product: Pick<O2oMallProduct, 'productName' | 'productCode' | 'thumbnail'>) => {
  return resolveProductPlaceholder(product.thumbnail)
}

// 商城图片预览统一走同一套状态，避免商品卡和详情抽屉各自维护一套弹层开关。
const openProductImagePreview = (product: Pick<O2oMallProduct, 'productName' | 'productCode' | 'thumbnail'>) => {
  previewImageUrl.value = resolveProductThumbnail(product)
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
      searchText: `${product.productName} ${product.productCode} ${product.detailContent ?? ''} ${categoryKeys.join(' ')}`.toLowerCase(),
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

  const categoryGroups = [...groupMap.values()].sort((prev, next) => prev.label.localeCompare(next.label, 'zh-Hans-CN'))
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
  return matchedProducts
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
  if (activeCategoryKey.value === 'all') {
    return products.value
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
  const warmupCandidates = items.filter((item) => Boolean(item.thumbnail)).slice(0, warmupBatch)
  if (!warmupCandidates.length) {
    return
  }
  // 非微信场景仍只预热首屏附近的小批量图片，主链路继续由模板内 loading="lazy" 负责。
  const warmup = () => {
    warmupCandidates.forEach((item) => {
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
  globalThis.window.setTimeout(warmup, DEFAULT_PRODUCT_IMAGE_WARMUP_DELAY_MS)
}

watch(
  () => clientAuthStore.currentUser?.id,
  (nextClientUserId) => {
    clientCartStore.initialize(nextClientUserId)
    clientCatalogStore.initialize(nextClientUserId)
  },
)

const loadProducts = async (force = false) => {
  // 如果缓存仍在有效期内，则直接复用本地目录快照，并只同步购物车库存信息。
  // 这样从订单页返回商城页时可以“秒开”，同时避免旧库存继续污染购物车状态。
  if (!force && clientCatalogStore.products.length > 0 && clientCatalogStore.isFresh) {
    requestError.value = null
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

const changeDetailQty = (delta: number) => {
  if (!detailProduct.value) {
    return
  }
  const maxQty = Math.max(0, Math.min(detailProduct.value.availableStock, detailProduct.value.limitPerUser))
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

const addCurrentDetailToCart = () => {
  if (!detailProduct.value) {
    return
  }
  const addedQty = clientCartStore.addProduct(detailProduct.value, detailQty.value)
  if (addedQty <= 0) {
    return
  }
  showAppSuccess('已加入购物车')
  triggerSettlePulse()
  detailVisible.value = false
}

const quickAdd = (product: O2oMallProduct) => {
  const addedQty = clientCartStore.addProduct(product, 1)
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
  return searchMode.value || largeDatasetMode.value || scrollingByCategoryClick.value
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
}

const syncMallViewportAfterRender = async () => {
  await nextTick()
  syncListViewportBottomSpacer()
  handleProductListScroll()
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
        <output v-else class="mall-hero-card__compact-banner" aria-live="polite">
          <span class="mall-hero-card__compact-badge">公告</span>
          <p class="mall-hero-card__compact-text">库存实时刷新，请以下单结果为准</p>
        </output>
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
        <div class="mall-hero-card__meta-item mall-hero-card__meta-item--notice rounded-2xl bg-amber-50 px-3 py-3 text-sm text-amber-700">公告：库存实时刷新，请以下单结果为准</div>
      </div>
      <div
        v-if="passiveRefreshErrorMessage"
        class="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700"
      >
        当前先展示本地缓存，后台刷新失败：{{ passiveRefreshErrorMessage }}
      </div>
    </div>
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

    <section
      v-else-if="searchMode"
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
      <header class="flex items-center justify-between">
        <p class="text-sm font-semibold text-slate-700">搜索结果 {{ searchResults.length }} 条</p>
      </header>
      <div class="client-product-grid mall-product-grid">
        <article v-for="product in searchResults" :key="product.id" class="client-product-card">
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
              <p class="client-product-card__price">¥{{ Number(product.defaultPrice).toFixed(2) }}</p>
              <p v-if="product.detailContent" class="client-product-card__desc">{{ product.detailContent }}</p>
              <div class="client-product-card__meta">
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

    <section v-else class="mall-browse-panel grid grid-cols-[76px_minmax(0,1fr)] sm:grid-cols-[140px_minmax(0,1fr)] gap-3 rounded-[1.4rem] bg-[var(--ylink-color-surface)] p-3 sm:p-4 shadow-[var(--ylink-shadow-soft)]">
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
      <aside class="mall-browse-categories overflow-y-auto pr-1 sm:pr-2 hide-scrollbar">
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

      <div v-if="largeDatasetMode" class="mall-browse-list mall-browse-list--virtual overflow-y-auto pr-1" v-bind="virtualContainerProps">
        <div v-bind="virtualWrapperProps" class="client-product-grid mall-product-grid mall-virtual-wrapper">
          <article v-for="row in virtualRows" :key="row.index" class="client-product-card mb-2">
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
                <p class="client-product-card__price">¥{{ Number(row.data.defaultPrice).toFixed(2) }}</p>
                <p v-if="row.data.detailContent" class="client-product-card__desc">{{ row.data.detailContent }}</p>
                <div class="client-product-card__meta">
                  <span class="rounded-full bg-[var(--ylink-color-primary-weak)] px-2 py-1 text-[var(--ylink-color-primary-strong)]">可预订 {{ row.data.availableStock }}</span>
                  <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">已预订 {{ row.data.preOrderedStock }}</span>
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
            <article v-for="product in group.items" :key="product.id" class="client-product-card">
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
                  <p class="client-product-card__price">¥{{ Number(product.defaultPrice).toFixed(2) }}</p>
                  <p v-if="product.detailContent" class="client-product-card__desc">{{ product.detailContent }}</p>
                  <div class="client-product-card__meta">
                    <span class="rounded-full bg-[var(--ylink-color-primary-weak)] px-2 py-1 text-[var(--ylink-color-primary-strong)]">可预订 {{ product.availableStock }}</span>
                    <span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">已预订 {{ product.preOrderedStock }}</span>
                  </div>
                </div>
              </button>
              <button type="button" class="client-product-card__add-button" @click="quickAdd(product)">+ 加购</button>
            </article>
          </div>
        </section>
        <div class="mall-category-bottom-spacer" :style="{ height: `${listViewportBottomSpacer}px` }" aria-hidden="true"></div>
      </div>
    </section>

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
              <article v-for="item in clientCartStore.items" :key="`mini-${item.productId}`" class="cart-item">
                <div class="item-main">
                  <p class="item-name">{{ item.productName }}</p>
                  <p class="item-price">¥{{ Number(item.defaultPrice).toFixed(2) }}</p>
                </div>
                <div class="item-stepper">
                  <button type="button" class="step-btn" @click="clientCartStore.incrementQty(item.productId, -1)">-</button>
                  <span class="step-val">
                    <Transition name="qty-pop" mode="out-in">
                      <span :key="`mini-qty-${item.productId}-${item.qty}`" class="step-val__num">{{ item.qty }}</span>
                    </Transition>
                  </span>
                  <button type="button" class="step-btn" @click="clientCartStore.incrementQty(item.productId, 1)">+</button>
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
      <section v-if="detailProduct" class="space-y-4 pb-2 max-w-[480px] mx-auto h-full max-h-[85vh] flex flex-col">
        <button type="button" class="client-detail-image-button" @click="openProductImagePreview(detailProduct)">
          <img
            :src="resolveProductThumbnail(detailProduct)"
            :alt="detailProduct.productName"
            class="h-44 sm:h-56 w-full rounded-2xl object-cover flex-shrink-0"
            loading="lazy"
            decoding="async"
          />
          <span class="client-detail-image-button__hint">点击查看大图</span>
        </button>
        <div class="space-y-2 flex-shrink-0">
          <p class="text-lg font-semibold text-slate-900">{{ detailProduct.productName }}</p>
          <p class="text-sm font-bold text-[var(--ylink-color-primary-strong)]">¥{{ Number(detailProduct.defaultPrice).toFixed(2) }}</p>
          <p class="text-sm text-slate-500">{{ detailProduct.detailContent || '暂无商品描述' }}</p>
          <div class="flex flex-wrap gap-2 text-xs">
            <span class="rounded-full bg-emerald-50 px-3 py-1 text-emerald-600">可预订 {{ detailProduct.availableStock }}</span>
            <span class="rounded-full bg-amber-50 px-3 py-1 text-amber-600">已预订 {{ detailProduct.preOrderedStock }}</span>
            <span class="rounded-full bg-slate-100 px-3 py-1 text-slate-600">限购 {{ detailProduct.limitPerUser }}</span>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto"></div>
        <div class="flex items-center justify-between rounded-2xl bg-slate-100 px-3 py-2 flex-shrink-0 mt-auto">
          <span class="text-sm text-slate-600">数量</span>
          <div class="flex items-center gap-2">
            <button type="button" class="client-qty-button" @click="changeDetailQty(-1)">-</button>
            <span class="min-w-8 text-center text-sm font-semibold">{{ detailQty }}</span>
            <button type="button" class="client-qty-button" @click="changeDetailQty(1)">+</button>
          </div>
        </div>
        <button type="button" class="h-11 w-full rounded-full bg-slate-900 text-sm font-semibold text-white flex-shrink-0" @click="addCurrentDetailToCart">
          加入购物车
        </button>
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

.mall-browse-panel {
  align-items: start;
}

.mall-browse-categories,
.mall-browse-list {
  max-height: clamp(18rem, calc(100dvh - var(--mall-floating-bottom-clearance) - 13.5rem), 42rem);
}

.mall-product-grid {
  align-content: start;
}

.client-product-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.65rem;
}

.mall-category-bottom-spacer {
  width: 100%;
  pointer-events: none;
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

.client-product-card__image-button {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  padding: 0;
}

.client-product-card__body {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  border: none;
  background: transparent;
  text-align: left;
  padding: 0;
}

.client-product-card__content {
  min-width: 0;
  flex: 1;
  text-align: left;
}

.client-product-card__name {
  overflow: hidden;
  color: #0f172a;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client-product-card__price {
  margin-top: 0.18rem;
  color: var(--ylink-color-primary-strong);
  font-size: 0.92rem;
  font-weight: 700;
  line-height: 1.25;
}

.client-product-card__desc {
  margin-top: 0.2rem;
  overflow: hidden;
  color: #64748b;
  font-size: 0.76rem;
  line-height: 1.45;
  display: -webkit-box;
  line-clamp: 2;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.client-product-card__meta {
  margin-top: 0.45rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  font-size: 0.75rem;
}

.client-product-card__cover {
  height: 4.4rem;
  width: 4.4rem;
  flex-shrink: 0;
  border-radius: 0.9rem;
  background: #e2e8f0;
  object-fit: cover;
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
  grid-column: 1 / -1;
  margin-bottom: 0.15rem;
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
  .mall-search-launcher-wrap {
    margin-top: -0.2rem;
  }

  .mall-search-launcher-wrap--inside {
    margin-top: 0;
  }

  .mall-search-launcher-wrap--browse {
    margin-bottom: 0.05rem;
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
    gap: 0.5rem;
    border-radius: 0.95rem;
    padding: 0.4rem;
  }

  .client-product-card__cover {
    height: 3.8rem;
    width: 3.8rem;
    border-radius: 0.8rem;
  }

  .client-product-card__name {
    font-size: 0.9rem;
  }

  .client-product-card__price {
    font-size: 0.84rem;
  }

  .client-product-card__desc {
    margin-top: 0.12rem;
    font-size: 0.7rem;
    line-height: 1.35;
  }

  .client-product-card__meta {
    margin-top: 0.28rem;
    gap: 0.25rem;
  }

  .client-product-card__meta > span {
    padding: 0.22rem 0.46rem;
    font-size: 0.65rem;
  }

  .client-product-card__add-button {
    height: 1.95rem;
    align-self: center;
    font-size: 0.72rem;
    padding: 0 0.7rem;
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
    grid-template-columns: 105px minmax(0, 1fr);
  }
}
</style>
