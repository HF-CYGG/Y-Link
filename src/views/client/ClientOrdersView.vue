<script lang="ts">
import type { OrderRefreshAnchorSnapshot } from '@/utils/order-refresh-visual'

interface OrderListReturnScroll {
  userId: string | number
  session: number
  position: number
  queryKey: string
  top: number
  anchor: OrderRefreshAnchorSnapshot | null
}

// 详情路由可能卸载订单列表实例，回位数据只在当前导航往返期间保留。
let orderListReturnScroll: OrderListReturnScroll | null = null
let stopTrackingOrderReturn: (() => void) | undefined
</script>

<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientOrdersView.vue
 * 文件职责：承载客户端“我的订单”列表展示、服务端筛选查询、分页加载、局部自动刷新与刷新动画反馈能力。
 * 实现逻辑：
 * - 状态筛选与关键词查询统一走服务端接口，不再只对第一页缓存做本地过滤，避免遗漏更多历史订单；
 * - 订单列表支持“加载更多”，并把当前筛选条件、关键词、页码和已加载结果缓存到按账号隔离的 Store 中；
 * - 页面层继续使用 `useStableRequest` 保证只有最新一次查询结果生效，减少频繁切换筛选时的闪烁与覆盖；
 * - 整页入场期间卡片预留布局，待页面停稳后按可见顺序揭示；只变换卡片内层，保留刷新列表的移动动效。
 * 维护说明：
 * - 若后续新增列表查询条件，需要同步修改 `buildListQuery()`、Store 快照字段与空态文案；
 * - 订单撤回等会改变服务端筛选结果的操作，要优先考虑当前列表是否需要局部剔除或整页刷新；
 * - 若调整自动刷新节奏，需要同时评估移动端流量、页面可见性监听与高亮动画时长是否仍匹配。
 */


import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRouter, type RouteLocationNormalized } from 'vue-router'
import type { O2oMyOrderSearchMode } from '@ylink/shared-types'
import { ElMessageBox } from 'element-plus'
import { RefreshRight } from '@element-plus/icons-vue'
import {
  cancelMyO2oPreorder,
  getMyO2oPreorderSummary,
  getMyO2oPreorders,
  type O2oMyOrderListQuery,
  type O2oPreorderSummary,
} from '@/api/modules/o2o'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import {
  CLIENT_O2O_ORDER_STATUS_CLASS_MAP,
  getO2oOrderBusinessStatusMeta,
  getClientOrderStatusReportConfig,
  getClientOrderReportScenario,
  O2O_ORDER_STATUS_TABS,
} from '@/constants/o2o-order-status'
import { useClientAuthStore, useClientOrderStore } from '@/store'
import pinia from '@/store/pinia'
import {
  buildClientOrderSilentRefreshPlan,
  mergeClientOrderRefreshPages,
  notifyClientOrderRefresh,
  subscribeClientOrderRefresh,
} from '@/utils/client-order-refresh'
import { buildClientOrderSummaryFromDetail, needsKingdeeRegistration } from '@/utils/client-order-summary'
import { normalizeClientOrderKeyword, normalizeClientOrderSearchMode, type PersistedO2oPreorderSummary } from '@/utils/client-order-storage'
import { shouldReduceClientMotion } from '@/utils/client-motion'
import { formatDateTime } from '@/utils/date-time'
import { normalizeRequestError } from '@/utils/error'
import { captureOrderRefreshAnchor, restoreOrderRefreshAnchor } from '@/utils/order-refresh-visual'

import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const ORDER_TYPE_LABEL_MAP = {
  department: '部门订',
  walkin: '散客',
} as const
const ORDER_SEARCH_MODES = [
  { value: 'contains', label: '模糊' },
  { value: 'prefix', label: '前缀' },
  { value: 'exact', label: '精确' },
]
const ORDER_SEARCH_HINTS: Record<O2oMyOrderSearchMode, string> = {
  contains: '多个词用空格分隔',
  prefix: '匹配字段开头',
  exact: '匹配完整字段',
}
type LatestReturnRequestMeta = (typeof RETURN_REQUEST_STATUS_META)[keyof typeof RETURN_REQUEST_STATUS_META]
type ClientOrderStatusReportConfig = ReturnType<typeof getClientOrderStatusReportConfig>

interface OrderMetaFact {
  key: string
  label: string
}

interface OrderStatusChip {
  key: string
  label: string
  className: string
}

interface OrderCardPresentation {
  order: PersistedO2oPreorderSummary
  report: ClientOrderStatusReportConfig
  metaFacts: OrderMetaFact[]
  statusChips: OrderStatusChip[]
  assistSummary: string
}

const RETURN_REQUEST_STATUS_META = {
  pending: {
    label: '待门店核销',
    className: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
    description: '退货申请已提交，请携带商品与退货码到店处理。',
  },
  verified: {
    label: '退货已完成',
    className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
    description: '门店已完成退货核销，可在订单详情中查看本次退货记录。',
  },
  rejected: {
    label: '退货已拒绝',
    className: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
    description: '门店已拒绝本次退货申请，请查看拒绝原因后再决定是否联系门店。',
  },
} as const

// 关键词防抖窗口：连续输入时只在停顿后更新筛选词，避免每次按键都触发大列表过滤。
const KEYWORD_DEBOUNCE_MS = 260
const DEFAULT_ORDER_PAGE_SIZE = 20
const ORDER_AUTO_REFRESH_INTERVAL_MS = 15 * 1000
const ORDER_REFRESH_MARK_MS = 3200
const ORDER_REFRESH_VIEWPORT_TOP_OFFSET = 104
const firstScreenLoading = ref(false)
const refreshing = ref(false)
const silentRefreshing = ref(false)
const loadingMore = ref(false)
const resetOrderLoading = () => {
  firstScreenLoading.value = false
  refreshing.value = false
  silentRefreshing.value = false
  loadingMore.value = false
}
const recallingOrderId = ref('')
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const orderListBodyRef = ref<HTMLElement | null>(null)
const orderListPageRef = ref<HTMLElement | null>(null)
const lastAutoRefreshAt = ref(0)
const orderRefreshMarkExpiresAtMap = ref<Record<string, number>>({})
const router = useRouter()
const clientAuthStore = useClientAuthStore(pinia)
const clientOrderStore = useClientOrderStore(pinia)
const { runLatest } = useStableRequest()
clientOrderStore.initialize(clientAuthStore.currentUser?.id)
let disposeClientOrderRefresh: () => void = () => {}
let refreshMarkCleanupTimer: ReturnType<typeof globalThis.setTimeout> | null = null
let autoRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null
let pageRuntimeActive = false
let pendingSearchRefresh = false
let listQueryGeneration = 0
let hasActivatedOnce = false
let orderCardObserver: IntersectionObserver | null = null
let orderCardMotionGeneration = 0
let awaitingFirstOrderCards = false
const observedOrderCards = new Set<HTMLElement>()
const clientOrderRefreshSourceId = `client-orders-${Math.random().toString(36).slice(2)}`
const runLatestListRequest = runLatest

const orders = computed(() => clientOrderStore.orders)
const total = computed(() => clientOrderStore.total)
const hasMoreOrders = computed(() => clientOrderStore.hasCurrentResults && orders.value.length < total.value)
const keywordInput = ref(clientOrderStore.keyword)
const effectiveKeyword = computed(() => clientOrderStore.keyword)
const searchMode = computed(() => clientOrderStore.searchMode)
const keywordDebounceTimer = ref<ReturnType<typeof globalThis.setTimeout> | null>(null)
const keywordDebouncing = ref(false)
const activeStatus = computed({
  get: () => clientOrderStore.activeStatus,
  set: (value: 'all' | O2oPreorderSummary['status']) => clientOrderStore.setActiveStatus(value),
})

let orderListHistoryPosition: number | undefined
let orderDetailDeparture: { route: RouteLocationNormalized; scroll: OrderListReturnScroll } | null = null
onBeforeRouteLeave((to, from) => {
  orderDetailDeparture = null
  orderListReturnScroll = null
  const userId = clientAuthStore.currentUser?.id
  const history = router.options.history
  const position = history.location === from.fullPath ? history.state.position : orderListHistoryPosition
  if (to.name !== 'client-order-detail' || userId == null || typeof position !== 'number' || !clientOrderStore.hasCurrentResults) return

  orderDetailDeparture = {
    route: to,
    scroll: {
      userId,
      session: clientAuthStore.sessionGeneration,
      position,
      queryKey: clientOrderStore.queryKey,
      top: window.scrollY,
      anchor: captureOrderRefreshAnchor({
        listRoot: orderListBodyRef.value,
        itemAttributeName: 'data-order-card-id',
        visibilityTopOffset: ORDER_REFRESH_VIEWPORT_TOP_OFFSET,
      }),
    },
  }
})

const stopSavingOrderReturn = router.afterEach((to, _from, failure) => {
  if (orderDetailDeparture?.route !== to) return
  const { scroll } = orderDetailDeparture
  orderDetailDeparture = null
  if (failure) return

  stopTrackingOrderReturn?.()
  orderListReturnScroll = scroll
  stopTrackingOrderReturn = router.afterEach((next, previous, navigationFailure) => {
    if (navigationFailure || next.name === 'client-order-detail') return
    if (next.name !== 'client-orders' || previous.name !== 'client-order-detail' || router.options.history.state.position !== scroll.position) {
      orderListReturnScroll = null
    }
    stopTrackingOrderReturn?.()
    stopTrackingOrderReturn = undefined
  })
})
onBeforeUnmount(stopSavingOrderReturn)

const getOrderListReturnScroll = () => {
  const scroll = orderListReturnScroll
  if (!scroll || router.currentRoute.value.name !== 'client-orders') return null
  if (scroll.position !== router.options.history.state.position ||
      scroll.userId !== clientAuthStore.currentUser?.id ||
      scroll.session !== clientAuthStore.sessionGeneration ||
      scroll.queryKey !== clientOrderStore.queryKey) {
    orderListReturnScroll = null
    return null
  }
  return scroll
}

const restoreOrderListReturnScroll = () => {
  const scroll = getOrderListReturnScroll()
  const listRoot = orderListBodyRef.value
  if (!scroll || !pageRuntimeActive || !listRoot?.isConnected) return

  orderListReturnScroll = null
  window.scrollTo({ top: scroll.top, left: 0, behavior: 'instant' })
  restoreOrderRefreshAnchor(scroll.anchor, { listRoot, itemAttributeName: 'data-order-card-id' })
}
const showSilentSyncStatus = computed(() =>
  silentRefreshing.value && !refreshing.value && !loadingMore.value && !keywordDebouncing.value,
)
const autoRefreshStatusText = computed(() => {
  if (showSilentSyncStatus.value) {
    return '正在同步最新订单'
  }
  if (!lastAutoRefreshAt.value) {
    return '自动刷新已开启'
  }
  return `最近同步 ${formatOrderDateTime(new Date(lastAutoRefreshAt.value).toISOString())}`
})

const stopKeywordDebounce = () => {
  if (keywordDebounceTimer.value !== null) {
    globalThis.clearTimeout(keywordDebounceTimer.value)
    keywordDebounceTimer.value = null
  }
  keywordDebouncing.value = false
}

const applySearch = (nextKeyword: string, nextMode: O2oMyOrderSearchMode) => {
  stopKeywordDebounce()
  const previousQuery = clientOrderStore.queryKey
  clientOrderStore.setSearch(nextKeyword, nextMode)
  if (clientOrderStore.queryKey !== previousQuery) void loadOrders(true)
}

// 打字只更新草稿；模式切换时提交同一份可见输入，避免先查旧词再查新词。
watch(
  () => keywordInput.value,
  (nextKeyword) => {
    stopKeywordDebounce()
    if (normalizeClientOrderKeyword(nextKeyword) === effectiveKeyword.value) return
    keywordDebouncing.value = true
    keywordDebounceTimer.value = globalThis.setTimeout(() => {
      applySearch(nextKeyword, searchMode.value)
    }, KEYWORD_DEBOUNCE_MS)
  },
)

const handleSearchModeChange = (value: unknown) =>
  applySearch(keywordInput.value, normalizeClientOrderSearchMode(value))

watch(() => clientOrderStore.queryKey, () => {
  listQueryGeneration += 1
  pendingSearchRefresh = false
}, { flush: 'sync' })
const captureListQuery = () => {
  const generation = listQueryGeneration
  const session = clientAuthStore.sessionGeneration
  const owner = clientAuthStore.currentUser?.id
  return () => generation === listQueryGeneration && session === clientAuthStore.sessionGeneration
    && owner === clientAuthStore.currentUser?.id && router.currentRoute.value.name === 'client-orders'
}

const getClientOrderTypeLabel = (order: Pick<O2oPreorderSummary, 'clientOrderType'>) => {
  return ORDER_TYPE_LABEL_MAP[order.clientOrderType]
}

const getOrderStatusReport = (order: PersistedO2oPreorderSummary) => {
  return getClientOrderStatusReportConfig({
    statusReport: order.statusReport,
    status: order.status,
    timeoutAt: order.timeoutAt,
  })
}

const getOrderStatusClassName = (order: PersistedO2oPreorderSummary) => {
  const scenario = order.statusReport?.scenario ?? getClientOrderReportScenario(order.status, order.timeoutAt)
  if (scenario === 'timeout_soon') {
    return 'bg-orange-50 text-orange-700'
  }
  if (scenario === 'timeout_cancelled') {
    return 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'
  }
  return CLIENT_O2O_ORDER_STATUS_CLASS_MAP[order.status]
}

const handleStatusChange = (value: 'all' | O2oPreorderSummary['status']) => {
  if (activeStatus.value === value) {
    return
  }
  stopKeywordDebounce()
  clientOrderStore.setSearch(keywordInput.value, searchMode.value)
  activeStatus.value = value
  void loadOrders(true)
}

const normalizeSummaryIdentifiers = (order: O2oPreorderSummary): O2oPreorderSummary => {
  return {
    ...order,
    preorderNo: order.preorderNo,
    customerOrderBusinessNo: order.customerOrderBusinessNo ?? null,
    originalCustomerOrderBusinessNo: order.originalCustomerOrderBusinessNo ?? null,
  }
}

const getOriginalCustomerOrderBusinessNo = (order: Pick<O2oPreorderSummary, 'originalCustomerOrderBusinessNo'>) => {
  return order.originalCustomerOrderBusinessNo?.trim() || ''
}

const isMergedCustomerOrder = (order: PersistedO2oPreorderSummary) => {
  const originalBusinessNo = getOriginalCustomerOrderBusinessNo(order)
  return Boolean(originalBusinessNo && originalBusinessNo !== order.customerOrderBusinessNo)
}

const getBusinessStatusMeta = (order: PersistedO2oPreorderSummary) => {
  return getO2oOrderBusinessStatusMeta(order.businessStatus)
}

const getLatestReturnRequestMeta = (order: PersistedO2oPreorderSummary) => {
  if (!order.latestReturnRequest) {
    return null
  }
  return RETURN_REQUEST_STATUS_META[order.latestReturnRequest.status]
}

// 详细注释：统一格式化订单金额，优先输出保留两位小数的“元”文案，避免移动端卡片里出现过长原始数值。
const formatOrderAmountFact = (amount: string | undefined) => {
  if (!amount) {
    return ''
  }
  const normalizedAmount = Number(amount)
  if (Number.isFinite(normalizedAmount)) {
    return `金额 ${normalizedAmount.toFixed(2)} 元`
  }
  return `金额 ${amount} 元`
}

// 详细注释：订单列表摘要中的时间、释放时间统一复用共享格式化函数，
// 这样列表与详情页对同一字段的展示口径保持一致，避免一边是原始字符串一边是格式化文本。
const formatOrderDateTime = (value?: string | null, fallback = '-') => {
  return formatDateTime(value, fallback)
}

// 详细注释：静默刷新时只高亮真正新增或摘要发生变化的订单卡片，
// 避免每次轮询都让整列卡片出现重复动画，分散用户注意力。
const hasOrderCardChanged = (previous: PersistedO2oPreorderSummary | undefined, next: O2oPreorderSummary) => {
  if (!previous) {
    return true
  }
  return (
    previous.preorderNo !== next.preorderNo
    || previous.verifyCode !== next.verifyCode
    || previous.status !== next.status
    || previous.businessStatus !== next.businessStatus
    || previous.hasCustomerOrder !== next.hasCustomerOrder
    || previous.isSystemApplied !== next.isSystemApplied
    || previous.kingdeeVersion !== next.kingdeeVersion
    || previous.kingdeeVoucherNo !== next.kingdeeVoucherNo
    || previous.merchantMessage !== next.merchantMessage
    || previous.returnRequestCount !== next.returnRequestCount
    || previous.pendingReturnRequestCount !== next.pendingReturnRequestCount
    || previous.totalQty !== next.totalQty
    || previous.totalAmount !== next.totalAmount
    || previous.timeoutAt !== next.timeoutAt
    || previous.createdAt !== next.createdAt
    || JSON.stringify(previous.latestReturnRequest) !== JSON.stringify(next.latestReturnRequest)
    || JSON.stringify(previous.statusReport) !== JSON.stringify(next.statusReport)
  )
}

const isOrderRecentlyRefreshed = (orderId: string) => {
  return (orderRefreshMarkExpiresAtMap.value[orderId] ?? 0) > Date.now()
}

const scheduleRefreshMarkCleanup = () => {
  if (refreshMarkCleanupTimer !== null) {
    globalThis.clearTimeout(refreshMarkCleanupTimer)
    refreshMarkCleanupTimer = null
  }
  const activeExpiresAtList = Object.values(orderRefreshMarkExpiresAtMap.value)
  if (!activeExpiresAtList.length) {
    return
  }
  const nextExpiresAt = Math.min(...activeExpiresAtList)
  const delay = Math.max(0, nextExpiresAt - Date.now() + 32)
  refreshMarkCleanupTimer = globalThis.setTimeout(() => {
    const now = Date.now()
    orderRefreshMarkExpiresAtMap.value = Object.fromEntries(
      Object.entries(orderRefreshMarkExpiresAtMap.value).filter(([, expiresAt]) => expiresAt > now),
    )
    scheduleRefreshMarkCleanup()
  }, delay)
}

const markRefreshedOrders = (orderIds: string[]) => {
  if (!orderIds.length) {
    return
  }
  const expiresAt = Date.now() + ORDER_REFRESH_MARK_MS
  const nextMarkMap = { ...orderRefreshMarkExpiresAtMap.value }
  for (const orderId of orderIds) {
    nextMarkMap[orderId] = expiresAt
  }
  orderRefreshMarkExpiresAtMap.value = nextMarkMap
  scheduleRefreshMarkCleanup()
}

// 详细注释：订单摘要信息压缩成可换行的小标签，减少原先“每项一整行”带来的高度浪费。
const buildOrderMetaFacts = (order: PersistedO2oPreorderSummary): OrderMetaFact[] => {
  const facts: OrderMetaFact[] = [
    {
      key: 'createdAt',
      label: `下单 ${formatOrderDateTime(order.createdAt)}`,
    },
    {
      key: 'ownership',
      label: order.departmentNameSnapshot ? `归属 ${order.departmentNameSnapshot}` : `归属 ${getClientOrderTypeLabel(order)}`,
    },
    {
      key: 'qty',
      label: `共 ${order.totalQty} 件`,
    },
  ]
  if (order.staffNoSnapshot) {
    facts.push({
      key: 'staffNo',
      label: `工号 ${order.staffNoSnapshot}`,
    })
  }
  const amountFact = formatOrderAmountFact(order.totalAmount)
  if (amountFact) {
    facts.push({
      key: 'amount',
      label: amountFact,
    })
  }
  return facts
}

// 详细注释：主状态、业务状态、退货状态与释放时间统一抽象为横向 chip，移动端优先用横向空间承载状态信息。
const buildOrderStatusChips = (
  order: PersistedO2oPreorderSummary,
  report: ClientOrderStatusReportConfig,
  businessStatusMeta: ReturnType<typeof getO2oOrderBusinessStatusMeta>,
  latestReturnRequestMeta: LatestReturnRequestMeta | null,
): OrderStatusChip[] => {
  const chips: OrderStatusChip[] = [
    {
      key: 'status',
      label: report.statusLabel,
      className: getOrderStatusClassName(order),
    },
  ]

  if (businessStatusMeta) {
    chips.push({
      key: 'businessStatus',
      label: businessStatusMeta.label,
      className: businessStatusMeta.className,
    })
  }

  if (latestReturnRequestMeta) {
    chips.push({
      key: 'returnRequest',
      label: `退货 ${latestReturnRequestMeta.label}`,
      className: latestReturnRequestMeta.className,
    })
  }

  if (order.status === 'pending' && order.timeoutAt) {
    chips.push({
      key: 'timeoutAt',
      label: `释放 ${formatOrderDateTime(order.timeoutAt)}`,
      className: 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400',
    })
  }

  return chips
}

// 详细注释：辅助说明收口成一段紧凑摘要，把原来分散在多块卡片中的补充状态压缩为可阅读的一段文本。
const buildOrderAssistSummary = (
  order: PersistedO2oPreorderSummary,
  businessStatusMeta: ReturnType<typeof getO2oOrderBusinessStatusMeta>,
  latestReturnRequestMeta: LatestReturnRequestMeta | null,
) => {
  const summarySegments: string[] = []

  if (order.status === 'pending' && order.timeoutAt) {
    summarySegments.push(`超时释放 ${formatOrderDateTime(order.timeoutAt)}`)
  }
  if (businessStatusMeta) {
    summarySegments.push(`商家状态 ${businessStatusMeta.label}`)
  }
  if (latestReturnRequestMeta) {
    const returnRequestNo = order.latestReturnRequest?.returnNo ? `（${order.latestReturnRequest.returnNo}）` : ''
    summarySegments.push(`退货状态 ${latestReturnRequestMeta.label}${returnRequestNo}`)
  }

  return summarySegments.join(' · ')
}

// 详细注释：把模板需要的展示数据提前整形成视图模型，避免模板层重复求值，也便于后续继续压缩卡片结构。
const orderCardList = computed<OrderCardPresentation[]>(() => {
  return orders.value.map((order) => {
    const report = getOrderStatusReport(order)
    const businessStatusMeta = getBusinessStatusMeta(order)
    const latestReturnRequestMeta = getLatestReturnRequestMeta(order)

    return {
      order,
      report,
      metaFacts: buildOrderMetaFacts(order),
      statusChips: buildOrderStatusChips(order, report, businessStatusMeta, latestReturnRequestMeta),
      assistSummary: buildOrderAssistSummary(order, businessStatusMeta, latestReturnRequestMeta),
    }
  })
})

// 详细注释：统一根据当前页面状态拼出服务端查询条件，保证刷新、筛选、加载更多共用同一口径。
const buildListQuery = (targetPage: number): O2oMyOrderListQuery => {
  return {
    page: targetPage,
    pageSize: clientOrderStore.pageSize || DEFAULT_ORDER_PAGE_SIZE,
    status: activeStatus.value === 'all' ? undefined : activeStatus.value,
    keyword: effectiveKeyword.value || undefined,
    searchMode: searchMode.value,
  }
}

const syncStoreWithCurrentUser = () => {
  stopKeywordDebounce()
  clientOrderStore.initialize(clientAuthStore.currentUser?.id)
  keywordInput.value = clientOrderStore.keyword
}

// 详细注释：静默轮询需要覆盖当前已加载范围并额外保留一页缓冲；
// 超过接口单页上限时按页读取，避免 pageSize > 50 被后端拒绝后静默刷新永久失效。
const fetchSilentRefreshOrders = async (query: O2oMyOrderListQuery, signal: AbortSignal) => {
  const logicalPageSize = query.pageSize || DEFAULT_ORDER_PAGE_SIZE
  const plan = buildClientOrderSilentRefreshPlan({
    loadedCount: clientOrderStore.hasCurrentResults ? clientOrderStore.orders.length : 0,
    logicalPageSize,
  })
  const buildQuery = (page: number) => ({
    ...query,
    page,
    pageSize: plan.requestPageSize,
  })
  const firstPageResult = await getMyO2oPreorders(buildQuery(1), { signal })
  const availablePageCount = Math.max(1, Math.ceil(firstPageResult.total / plan.requestPageSize))
  const requestPageCount = Math.min(plan.requestPageCount, availablePageCount)
  const remainingPageResults = await Promise.all(
    Array.from({ length: Math.max(0, requestPageCount - 1) }, (_, index) =>
      getMyO2oPreorders(buildQuery(index + 2), { signal }),
    ),
  )

  return {
    ...firstPageResult,
    records: mergeClientOrderRefreshPages(
      [firstPageResult.records, ...remainingPageResults.map((result) => result.records)],
      plan.targetRecordCount,
    ),
  }
}

const resolveSilentRefreshRecords = (latestRecords: O2oPreorderSummary[]) => {
  if (!clientOrderStore.hasCurrentResults) return latestRecords
  const currentOrders = clientOrderStore.orders
  const currentLoadedCount = currentOrders.length
  if (!currentLoadedCount) {
    return latestRecords
  }
  const currentOrderIdSet = new Set(currentOrders.map((item) => item.id))
  const insertedCount = latestRecords.filter((item) => !currentOrderIdSet.has(item.id)).length
  const nextVisibleCount = Math.min(latestRecords.length, currentLoadedCount + insertedCount)
  return latestRecords.slice(0, Math.max(currentLoadedCount, nextVisibleCount))
}

const canRunAutoRefresh = () => {
  if (!pageRuntimeActive || !clientAuthStore.currentUser?.id) {
    return false
  }
  if (globalThis.document?.visibilityState === 'hidden') {
    return false
  }
  return !firstScreenLoading.value && !refreshing.value && !loadingMore.value && !recallingOrderId.value
}

const triggerSilentOrderRefresh = async (fromSearchChangeEvent = false) => {
  if (!canRunAutoRefresh()) {
    if (fromSearchChangeEvent) pendingSearchRefresh = true
    return
  }
  pendingSearchRefresh = false
  await loadOrders(true, { silent: true, preserveScroll: true })
}

const refreshSingleOrderSummary = async (orderId: string, options?: { silent?: boolean }) => {
  if (effectiveKeyword.value) {
    await triggerSilentOrderRefresh(true)
    return
  }
  const isCurrent = captureListQuery()
  try {
    const result = normalizeSummaryIdentifiers(await getMyO2oPreorderSummary(orderId))
    if (!isCurrent()) return
    clientOrderStore.syncOrderSummary(result, { preserveFresh: true })
    markRefreshedOrders([result.id])
  } catch (error) {
    if (!isCurrent()) return
    const normalizedError = normalizeRequestError(error, '订单摘要刷新失败')
    if (normalizedError.status === 404) {
      clientOrderStore.removeOrder(orderId, { preserveFresh: true })
      if (options?.silent) {
        await triggerSilentOrderRefresh()
        return
      }
    }
    if (!options?.silent) {
      throw normalizedError
    }
    await triggerSilentOrderRefresh()
  }
}

const startClientOrderRefreshSubscription = () => {
  disposeClientOrderRefresh()
  disposeClientOrderRefresh = () => {}
  if (!pageRuntimeActive) {
    return
  }
  disposeClientOrderRefresh = subscribeClientOrderRefresh(async (event) => {
    if (event.sourceId === clientOrderRefreshSourceId || !event.orderId) {
      return
    }
    await refreshSingleOrderSummary(event.orderId, { silent: true })
  })
}

const handleVisibilityChange = () => {
  if (!pageRuntimeActive) {
    return
  }
  if (globalThis.document?.visibilityState === 'hidden') {
    scheduleAutoRefresh()
    return
  }
  scheduleAutoRefresh()
  void triggerSilentOrderRefresh()
}

const scheduleAutoRefresh = () => {
  if (autoRefreshTimer !== null) {
    globalThis.clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
  if (!pageRuntimeActive || globalThis.document?.visibilityState === 'hidden') {
    return
  }
  autoRefreshTimer = globalThis.setInterval(() => {
    void triggerSilentOrderRefresh()
  }, ORDER_AUTO_REFRESH_INTERVAL_MS)
}

const getCurrentOrderCards = () => {
  const currentOrderIds = new Set(orderCardList.value.map(({ order }) => order.id))
  const renderedCards = orderListBodyRef.value?.querySelectorAll<HTMLElement>('[data-order-card-id]') ?? []
  // TransitionGroup 会保留正在离场的旧节点，它们不参与新卡片的入场顺序。
  return [...renderedCards].filter(({ dataset, classList }) =>
    dataset.orderCardId !== undefined &&
    currentOrderIds.has(dataset.orderCardId) &&
    !classList.contains('order-list-refresh-leave-active'),
  )
}

const prepareOrderCardLeave = (card: Element) => {
  if (card instanceof HTMLElement && orderListPageRef.value?.hasAttribute('data-client-page-entering')) {
    // 入场期间被更新移除的卡片，在父页撤掉遮蔽后也要保持隐藏，直到列表离场完成。
    card.classList.add('order-card-viewport--hidden')
    card.inert = true
  }
}

// 观察列表项外壳，入场变换只作用于内部卡片，保留 TransitionGroup 的移动变换。
const syncOrderCardObserver = () => {
  if (!orderCardObserver || !pageRuntimeActive) return
  const currentCards = new Set(getCurrentOrderCards())
  for (const card of observedOrderCards) {
    if (!currentCards.has(card)) {
      orderCardObserver.unobserve(card)
      observedOrderCards.delete(card)
    }
  }
  const newCards = [...currentCards].filter((card) => !observedOrderCards.has(card))
  if (!newCards.length) return

  // 页面停稳后以实际视口中的上下顺序排首批卡片；接口未返回时仍保留首批状态。
  const firstCardDelays = new Map<HTMLElement, number>()
  if (awaitingFirstOrderCards) {
    const viewportHeight = window.innerHeight
    const visibleCards = newCards.flatMap((card) => {
      const { top, bottom } = card.getBoundingClientRect()
      return bottom > 0 && top < viewportHeight ? [{ card, top }] : []
    }).sort((a, b) => a.top - b.top)
    visibleCards.forEach(({ card }, index) => firstCardDelays.set(card, Math.min(index * 55, 220)))
    awaitingFirstOrderCards = false
  }
  for (const card of newCards) {
    card.style.setProperty('--order-card-enter-delay', `${firstCardDelays.get(card) ?? 0}ms`)
    card.classList.remove('order-card-viewport--seen')
    card.classList.add('order-card-viewport--hidden')
    observedOrderCards.add(card)
  }
  // 合批固定隐藏起点，只触发一次布局，再开始观察。
  void newCards[0].offsetHeight
  for (const card of newCards) {
    orderCardObserver.observe(card)
  }
}

const startOrderCardMotion = () => {
  if (shouldReduceClientMotion() || !('IntersectionObserver' in window)) {
    // 缓存页可能在离场后变更了系统动效设置；无观察器时不保留旧的隐藏状态。
    for (const card of getCurrentOrderCards()) {
      card.classList.remove('order-card-viewport--hidden', 'order-card-viewport--seen')
      card.style.removeProperty('--order-card-enter-delay')
    }
    return
  }
  const generation = ++orderCardMotionGeneration
  awaitingFirstOrderCards = true
  orderCardObserver = new IntersectionObserver((entries) => {
    if (generation !== orderCardMotionGeneration) return
    for (const entry of entries) {
      const card = entry.target as HTMLElement
      if (!observedOrderCards.has(card)) continue
      if (entry.isIntersecting) {
        card.classList.remove('order-card-viewport--hidden')
      } else if (!card.classList.contains('order-card-viewport--hidden')) {
        // 卡片离屏时先固定短位移起点，下次滚入不再排队。
        card.classList.add('order-card-viewport--hidden', 'order-card-viewport--seen')
        card.style.removeProperty('--order-card-enter-delay')
      }
    }
  })
  syncOrderCardObserver()
}

const stopOrderCardMotion = () => {
  orderCardMotionGeneration += 1
  orderCardObserver?.disconnect()
  orderCardObserver = null
  // KeepAlive 会在旧页离场开始时触发失活，保留旧页卡片画面直到退出窗口。
  observedOrderCards.clear()
  awaitingFirstOrderCards = false
}

watch([orderCardList, orderListBodyRef], () => {
  restoreOrderListReturnScroll()
  syncOrderCardObserver()
}, { flush: 'post' })

const activatePageRuntime = () => {
  if (pageRuntimeActive) {
    return
  }
  pageRuntimeActive = true
  const position = router.options.history.state.position
  orderListHistoryPosition = typeof position === 'number' ? position : undefined
  restoreOrderListReturnScroll()
  if (!orderListPageRef.value?.hasAttribute('data-client-page-entering')) startOrderCardMotion()
  globalThis.document?.addEventListener('visibilitychange', handleVisibilityChange)
  startClientOrderRefreshSubscription()
  scheduleAutoRefresh()
  if (hasActivatedOnce && globalThis.document?.visibilityState !== 'hidden') {
    if (normalizeClientOrderKeyword(keywordInput.value) !== effectiveKeyword.value) applySearch(keywordInput.value, searchMode.value)
    else void triggerSilentOrderRefresh()
  }
  hasActivatedOnce = true
}

const handlePageEntered = () => {
  restoreOrderListReturnScroll()
  if (pageRuntimeActive && !orderCardObserver) startOrderCardMotion()
}

const deactivatePageRuntime = () => {
  if (!pageRuntimeActive) {
    return
  }
  pageRuntimeActive = false
  listQueryGeneration += 1
  pendingSearchRefresh = false
  stopKeywordDebounce()
  resetOrderLoading()
  stopOrderCardMotion()
  globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange)
  scheduleAutoRefresh()
  disposeClientOrderRefresh()
  disposeClientOrderRefresh = () => {}
}

const loadOrders = async (force = false, options?: { append?: boolean; silent?: boolean; preserveScroll?: boolean }) => {
  const append = options?.append === true
  const hasCurrentResults = clientOrderStore.hasCurrentResults
  const silent = options?.silent === true && hasCurrentResults
  if (append && !hasMoreOrders.value) return
  if (!append && !force && clientOrderStore.orders.length > 0 && clientOrderStore.isFresh) {
    requestError.value = null
    return
  }
  const hasCachedOrders = hasCurrentResults && clientOrderStore.orders.length > 0
  const targetPage = append ? clientOrderStore.page + 1 : 1
  const query = buildListQuery(targetPage)
  const isCurrent = captureListQuery()
  const preserveScroll = options?.preserveScroll === true && !append && hasCachedOrders && !getOrderListReturnScroll()
  const scrollAnchor = preserveScroll
    ? captureOrderRefreshAnchor({
        listRoot: orderListBodyRef.value,
        itemAttributeName: 'data-order-card-id',
        visibilityTopOffset: ORDER_REFRESH_VIEWPORT_TOP_OFFSET,
      })
    : null
  if (silent) {
    silentRefreshing.value = hasCachedOrders
  } else {
    firstScreenLoading.value = !hasCachedOrders && !append
    refreshing.value = hasCachedOrders && !append
    loadingMore.value = append
  }
  if (!append) {
    requestError.value = null
  }
  await runLatestListRequest({
    executor: (signal) =>
      silent && !append
        ? fetchSilentRefreshOrders(query, signal)
        : getMyO2oPreorders(query, { signal }),
    onSuccess: async (result) => {
      if (!isCurrent()) return
      if (append) {
        clientOrderStore.appendOrders(result.records.map(normalizeSummaryIdentifiers), {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
        })
        return
      }
      const previousOrderMap = new Map(clientOrderStore.orders.map((item) => [item.id, item]))
      const normalizedRecords = result.records.map(normalizeSummaryIdentifiers)
      const nextRecords = silent ? resolveSilentRefreshRecords(normalizedRecords) : normalizedRecords
      const logicalPageSize = clientOrderStore.pageSize || DEFAULT_ORDER_PAGE_SIZE
      clientOrderStore.setOrders(nextRecords, {
        // 只跨过已完整保留的页；下一次加载会重读部分页并按订单 ID 去重。
        page: silent ? Math.floor(nextRecords.length / logicalPageSize) : result.page,
        pageSize: silent ? logicalPageSize : result.pageSize,
        total: result.total,
      })
      if (silent) {
        const refreshedOrderIds = nextRecords
          .filter((item) => hasOrderCardChanged(previousOrderMap.get(item.id), item))
          .map((item) => item.id)
        markRefreshedOrders(refreshedOrderIds)
        lastAutoRefreshAt.value = Date.now()
      }
      if (scrollAnchor) {
        await nextTick()
        if (pageRuntimeActive && isCurrent()) {
          restoreOrderRefreshAnchor(scrollAnchor, {
            listRoot: orderListBodyRef.value,
            itemAttributeName: 'data-order-card-id',
          })
        }
      }
    },
    onError: (error) => {
      if (!isCurrent()) return
      const normalizedError = normalizeRequestError(error, '订单加载失败')
      if (silent) {
        return
      }
      if (append) {
        showAppWarning(`加载更多失败：${normalizedError.message}`)
        return
      }
      if (hasCachedOrders) {
        // 已有列表时不切到整页错误态，避免“刷新失败导致内容闪退”。
        showAppWarning(`订单刷新失败：${normalizedError.message}`)
        return
      }
      requestError.value = {
        type: globalThis.navigator.onLine === false ? 'offline' : 'error',
        message: normalizedError.message,
      }
    },
    onFinally: () => {
      resetOrderLoading()
      if (pendingSearchRefresh) void triggerSilentOrderRefresh()
    },
  })
}

const clearKeyword = () => {
  keywordInput.value = ''
  applySearch('', searchMode.value)
}

// 详细注释：执行撤回订单，二次确认后请求撤回，并更新 Store 中的订单状态。
const handleRecallOrder = async (order: PersistedO2oPreorderSummary) => {
  if (order.status !== 'pending') {
    showAppWarning('当前订单状态不可撤回')
    return
  }
  const owner = clientAuthStore.currentUser?.id
  const session = clientAuthStore.sessionGeneration
  const isCurrentSession = () => owner === clientAuthStore.currentUser?.id && session === clientAuthStore.sessionGeneration

  try {
    await ElMessageBox.confirm(
      `确认撤回预订单“${order.preorderNo}”吗？撤回后将释放预订库存，二维码会立即失效。`,
      '撤回订单',
      {
        type: 'warning',
        confirmButtonText: '确认撤回',
        cancelButtonText: '再想想',
        closeOnClickModal: false,
      },
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    showAppError('撤回确认失败，请稍后重试')
    return
  }

  if (!isCurrentSession()) return
  recallingOrderId.value = order.id
  try {
    const detail = await cancelMyO2oPreorder(order.id)
    if (!isCurrentSession()) return
    clientOrderStore.syncOrderSummary(buildClientOrderSummaryFromDetail(detail), { preserveFresh: true })
    if (effectiveKeyword.value) pendingSearchRefresh = true
    notifyClientOrderRefresh({
      orderId: detail.order.id,
      reason: 'cancelled',
      sourceId: clientOrderRefreshSourceId,
    })
    showAppSuccess('订单已撤回')
  } catch (error) {
    if (!isCurrentSession()) return
    const normalizedError = normalizeRequestError(error, '撤回订单失败')
    showAppError(normalizedError.message)
  } finally {
    if (isCurrentSession()) {
      recallingOrderId.value = ''
      if (pendingSearchRefresh) void triggerSilentOrderRefresh()
    }
  }
}

watch(
  [() => clientAuthStore.currentUser?.id, () => clientAuthStore.sessionGeneration],
  ([nextUserId]) => {
    pendingSearchRefresh = false
    recallingOrderId.value = ''
    syncStoreWithCurrentUser()
    if (nextUserId && pageRuntimeActive) {
      void loadOrders(true)
    }
  },
)

onMounted(async () => {
  syncStoreWithCurrentUser()
  const hadCachedOrders = clientOrderStore.orders.length > 0
  const hadFreshCache = hadCachedOrders && clientOrderStore.isFresh
  if (hadCachedOrders && getOrderListReturnScroll()) {
    await nextTick()
    restoreOrderListReturnScroll()
    if (pageRuntimeActive && router.currentRoute.value.name === 'client-orders') {
      void loadOrders(true, { silent: true, preserveScroll: true })
    }
    return
  }
  await loadOrders()
  if (hadFreshCache && pageRuntimeActive && router.currentRoute.value.name === 'client-orders') {
    void loadOrders(true, { silent: true, preserveScroll: true })
  }
})

onActivated(() => {
  activatePageRuntime()
})

onDeactivated(() => {
  deactivatePageRuntime()
})

onBeforeUnmount(() => {
  stopKeywordDebounce()
  if (refreshMarkCleanupTimer !== null) {
    globalThis.clearTimeout(refreshMarkCleanupTimer)
    refreshMarkCleanupTimer = null
  }
  deactivatePageRuntime()
})
</script>

<template>
  <section ref="orderListPageRef" class="order-list-page space-y-4" @client-page-entered="handlePageEntered">
    <div class="rounded-[1.4rem] bg-white p-3.5 shadow-[var(--ylink-shadow-soft)] sm:p-4 dark:bg-[#141415]">
      <div class="order-list-page__hero">
        <div class="min-w-0 flex-1">
          <p class="text-xl font-semibold text-slate-900 dark:text-slate-100">我的订单</p>
          <p class="text-sm text-slate-500 dark:text-slate-400">查看待提货、已核销与已取消订单，并区分部门订与散客</p>
        </div>
        <button
          class="order-list-page__refresh-btn disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="refreshing"
          @click="loadOrders(true)"
        >
          <el-icon class="text-sm"><RefreshRight /></el-icon>
          <span class="sm:hidden">{{ refreshing ? '刷新中' : '刷新' }}</span>
          <span class="hidden sm:inline">{{ refreshing ? '刷新中...' : '刷新订单' }}</span>
        </button>
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button
          v-for="tab in O2O_ORDER_STATUS_TABS"
          :key="tab.key"
          type="button"
          class="rounded-full px-3 py-1.5 text-xs"
          :class="activeStatus === tab.key ? 'bg-slate-900 text-white dark:bg-brand' : 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'"
          @click="handleStatusChange(tab.key as 'all' | O2oPreorderSummary['status'])"
        >
          {{ tab.label }}
        </button>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <el-segmented
          :model-value="searchMode"
          :options="ORDER_SEARCH_MODES"
          size="small"
          aria-label="订单搜索模式"
          @change="handleSearchModeChange"
        />
        <span class="text-xs text-slate-500 dark:text-slate-400">{{ ORDER_SEARCH_HINTS[searchMode] }}</span>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <input
          v-model="keywordInput"
          class="h-10 min-w-0 flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-slate-300 dark:border-white/10 dark:bg-white/5"
          maxlength="64"
          placeholder="订单号、商品名或规格"
          aria-label="搜索订单号、核销码、部门工号、归属、商品名或规格"
        />
        <button type="button" class="h-10 shrink-0 rounded-full border border-slate-200 px-4 text-sm text-slate-600 dark:border-white/10 dark:text-slate-300" @click="clearKeyword">清空</button>
      </div>
      <p v-if="keywordDebouncing || refreshing || loadingMore" class="mt-2 text-xs text-slate-400">
        {{
          keywordDebouncing
            ? '正在更新关键词结果...'
            : loadingMore
              ? '正在加载更多订单...'
              : '正在刷新订单，当前列表可继续浏览'
        }}
      </p>
      <p v-if="orders.length && clientOrderStore.hasCurrentResults" class="mt-2 text-xs text-slate-400">
        已加载 {{ orders.length }} 条，服务端共命中 {{ total }} 条订单
      </p>
      <p
        v-if="orders.length && clientOrderStore.hasCurrentResults"
        class="mt-1 truncate text-xs leading-4"
        :class="showSilentSyncStatus ? 'text-teal-600 dark:text-teal-300' : 'text-slate-400'"
        role="status"
      >
        {{ autoRefreshStatusText }}
      </p>
    </div>

    <div v-if="firstScreenLoading" class="grid gap-3 rounded-[1.4rem] bg-white p-3.5 shadow-[var(--ylink-shadow-soft)] sm:p-4 dark:bg-[#141415]">
      <div v-for="index in 4" :key="index" class="h-[4rem] animate-pulse rounded-2xl bg-slate-100 dark:bg-white/10" />
    </div>
    <BaseRequestState
      v-else-if="requestError"
      :type="requestError.type"
      :title="requestError.type === 'offline' ? '网络异常' : '订单加载失败'"
      :description="requestError.message"
      action-text="重新加载"
      @retry="loadOrders(true)"
    />
    <BaseRequestState
      v-else-if="clientOrderStore.hasCurrentResults && !orders.length"
      type="empty"
      title="暂无订单"
      :description="effectiveKeyword ? '未匹配到符合关键词的订单，请调整关键词后重试' : '当前筛选下没有订单记录'"
      action-text="刷新订单"
      @retry="loadOrders(true)"
    />

    <div v-else-if="clientOrderStore.hasCurrentResults">
      <div ref="orderListBodyRef">
        <TransitionGroup name="order-list-refresh" tag="div" class="space-y-3" @before-leave="prepareOrderCardLeave">
          <div
            v-for="card in orderCardList"
            :key="card.order.id"
            :data-order-card-id="card.order.id"
          >
            <div class="order-card-viewport">
              <article
                class="rounded-[1.2rem] bg-white p-3.5 shadow-[var(--ylink-shadow-soft)] sm:p-4 dark:bg-[#141415]"
                :class="{ 'order-list-card--refreshed': isOrderRecentlyRefreshed(card.order.id) }"
              >
                <div class="order-list-card__header">
                  <div class="order-list-card__topline">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <p class="min-w-0 flex-1 truncate text-[0.98rem] font-semibold text-slate-900 sm:flex-none sm:text-base dark:text-slate-100">
                          {{ card.order.preorderNo }}
                        </p>
                        <span class="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 sm:text-xs dark:bg-white/10 dark:text-slate-300">
                          {{ getClientOrderTypeLabel(card.order) }}
                        </span>
                        <Transition name="order-refresh-badge">
                          <span
                            v-if="isOrderRecentlyRefreshed(card.order.id)"
                            class="rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-700 dark:bg-teal-500/10 dark:text-teal-300"
                          >
                            已更新
                          </span>
                        </Transition>
                      </div>
                      <p v-if="card.order.customerOrderBusinessNo" class="mt-1 text-xs text-teal-700 dark:text-teal-300">
                        关联出库业务单号：{{ card.order.customerOrderBusinessNo }}
                      </p>
                      <p v-if="isMergedCustomerOrder(card.order)" class="mt-1 text-xs text-teal-700 dark:text-teal-300">
                        关联正式出库单已合并（原始出库业务单号：{{ getOriginalCustomerOrderBusinessNo(card.order) }}）
                      </p>
                    </div>
                    <div class="flex items-center gap-2 self-start">
                      <button
                        v-if="card.order.status === 'pending'"
                        type="button"
                        class="rounded-full border border-rose-200 px-3 py-1.5 text-xs text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400 dark:border-rose-900/60 dark:text-rose-400"
                        :disabled="recallingOrderId === card.order.id"
                        @click="handleRecallOrder(card.order)"
                      >
                        {{ recallingOrderId === card.order.id ? '撤回中...' : '撤回订单' }}
                      </button>
                      <router-link :to="`/client/orders/${card.order.id}`" class="rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white">
                        详情
                      </router-link>
                    </div>
                  </div>
                  <div class="order-list-card__meta">
                    <span
                      v-for="metaFact in card.metaFacts"
                      :key="metaFact.key"
                      class="order-list-card__meta-pill"
                      :class="`order-list-card__meta-pill--${metaFact.key}`"
                    >
                      {{ metaFact.label }}
                    </span>
                  </div>
                </div>

                <div class="order-list-card__status-row">
                  <span
                    v-for="statusChip in card.statusChips"
                    :key="statusChip.key"
                    class="rounded-full px-2.5 py-1 text-[11px] font-semibold sm:text-xs"
                    :class="statusChip.className"
                  >
                    {{ statusChip.label }}
                  </span>
                </div>

                <div v-if="needsKingdeeRegistration(card.order)" class="kingdee-registration-missing mt-3 flex items-center justify-between gap-3 rounded-xl border bg-red-50 px-3 py-2 text-sm dark:bg-red-500/10">
                  <span>金蝶单据编号未填写</span>
                  <router-link v-slot="{ navigate }" :to="`/client/orders/${card.order.id}`" custom>
                    <el-button size="small" type="danger" plain @click="navigate">去填写</el-button>
                  </router-link>
                </div>

                <div class="mt-3 rounded-2xl px-3 py-2.5" :class="card.report.cardClassName">
                  <div class="order-list-card__summary">
                    <p class="order-list-card__summary-title text-sm font-semibold">{{ card.report.cardTitle }}</p>
                    <p class="order-list-card__summary-text text-xs">{{ card.report.cardDescription }}</p>
                  </div>
                  <p v-if="card.assistSummary" class="mt-1.5 text-[11px] leading-5 opacity-80">
                    {{ card.assistSummary }}
                  </p>
                </div>
              </article>
            </div>
          </div>
        </TransitionGroup>
      </div>
      <div class="flex justify-center pt-1">
        <button
          v-if="hasMoreOrders"
          type="button"
          class="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm text-slate-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-[#141415] dark:text-slate-300"
          :disabled="loadingMore"
          @click="loadOrders(true, { append: true })"
        >
          {{ loadingMore ? '加载中...' : '加载更多' }}
        </button>
        <p v-else-if="clientOrderStore.hasCurrentResults" class="text-xs text-slate-400">已加载全部符合条件的订单</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.kingdee-registration-missing {
  border-color: #fecaca;
  color: #991b1b;
}

.dark .kingdee-registration-missing {
  border-color: #ef44444d;
  color: #fca5a5;
}

/* 订单列表页根容器：为底部悬浮导航与安全区预留稳定空间，避免最后一张卡片被导航覆盖。 */
.order-list-page {
  padding-bottom: calc(7.25rem + env(safe-area-inset-bottom, 0px));
}

/*
 * 局部覆盖全局 client-page-absolute：
 * - 订单列表属于长内容页面，需要让自身参与文档流计算高度；
 * - 否则容器只按视口高度计算，滚动到底部时最后一张卡片容易被裁掉。
 */
:global(.client-page-absolute.order-list-page) {
  position: relative;
}

.order-list-page__hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.order-list-page__refresh-btn {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.35rem;
  width: max-content;
  max-width: 100%;
  border: 1px solid rgb(226 232 240);
  border-radius: 9999px;
  background: rgb(248 250 252);
  color: rgb(71 85 105);
  font-size: 0.875rem;
  line-height: 1;
  padding: 0.625rem 0.9rem;
  white-space: nowrap;
}

/* 订单摘要标签：把时间、归属、件数、金额压缩为可换行的小胶囊，提升同屏信息密度。 */
.order-list-card__header {
  display: grid;
  gap: 0.75rem;
}

.order-list-card__topline {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.order-list-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.order-list-card__meta-pill {
  display: inline-flex;
  min-width: fit-content;
  max-width: 100%;
  align-items: center;
  border-radius: 9999px;
  background: rgb(248 250 252);
  padding: 0.35rem 0.75rem;
  font-size: 0.75rem;
  line-height: 1.25rem;
  color: rgb(100 116 139);
  white-space: nowrap;
}

/* 状态横向信息带：主状态、业务状态与退货状态统一采用横向胶囊表达，减少额外说明卡数量。 */
.order-list-card__status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

/* 核心说明卡改为“标题 + 描述”同层排布，减少原先上下两行强制堆叠造成的高度浪费。 */
.order-list-card__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem 0.75rem;
}

.order-list-card__summary-title {
  flex: 0 0 auto;
}

.order-list-card__summary-text {
  flex: 1 1 14rem;
  min-width: 0;
  line-height: 1.45;
}

@media (prefers-reduced-motion: no-preference) {
  .order-card-viewport {
    transition:
      opacity var(--ylink-motion-normal) var(--ylink-motion-ease) var(--order-card-enter-delay, 0ms),
      transform var(--ylink-motion-normal) var(--ylink-motion-ease) var(--order-card-enter-delay, 0ms);
  }

  .order-card-viewport--seen > .order-card-viewport {
    transition-duration: 180ms;
    transition-delay: 0ms;
  }

  .order-list-page[data-client-page-entering] .order-card-viewport,
  .order-card-viewport--hidden > .order-card-viewport {
    opacity: 0;
    transform: translateY(10px);
    transition: none;
    pointer-events: none;
  }

  .order-card-viewport--hidden.order-card-viewport--seen > .order-card-viewport {
    transform: translateY(6px);
  }

  .order-list-page[data-client-page-entering] .order-card-viewport:focus-within,
  .order-card-viewport--hidden:focus-within > .order-card-viewport {
    opacity: 1;
    transform: none;
    transition: none;
    pointer-events: auto;
  }
}

.order-list-card--refreshed {
  box-shadow:
    0 0 0 1px rgba(13, 148, 136, 0.14),
    0 10px 26px rgba(13, 148, 136, 0.12);
  animation: order-list-card-refresh 0.9s var(--ylink-motion-ease);
}

.order-list-refresh-enter-active,
.order-list-refresh-leave-active,
.order-list-refresh-move,
.order-refresh-badge-enter-active,
.order-refresh-badge-leave-active {
  transition:
    opacity var(--ylink-motion-normal) var(--ylink-motion-ease),
    transform var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.order-list-refresh-enter-from,
.order-list-refresh-leave-to,
.order-refresh-badge-enter-from,
.order-refresh-badge-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}

.order-list-refresh-leave-active {
  position: absolute;
  width: calc(100% - 1.75rem);
}

@keyframes order-list-card-refresh {
  0% {
    transform: translateY(6px) scale(0.992);
    box-shadow:
      0 0 0 0 rgba(45, 212, 191, 0.26),
      0 10px 26px rgba(13, 148, 136, 0.16);
  }
  100% {
    transform: translateY(0) scale(1);
    box-shadow:
      0 0 0 1px rgba(13, 148, 136, 0.14),
      0 10px 26px rgba(13, 148, 136, 0.12);
  }
}

@media (max-width: 767px) {
  .order-list-page {
    padding-bottom: calc(7.75rem + env(safe-area-inset-bottom, 0px));
  }

  .order-list-page__hero {
    gap: 0.5rem;
  }

  .order-list-page__refresh-btn {
    margin-top: 0.1rem;
    padding: 0.55rem 0.72rem;
    font-size: 0.78rem;
  }

  .order-list-card__meta {
    gap: 0.45rem;
  }

  .order-list-card__meta-pill:not(.order-list-card__meta-pill--createdAt, .order-list-card__meta-pill--amount) {
    display: none;
  }

  .order-list-card__meta-pill {
    padding: 0.32rem 0.66rem;
    font-size: 0.72rem;
    line-height: 1.1rem;
  }

  .order-list-card__header {
    gap: 0.65rem;
  }

  .order-list-card__topline {
    gap: 0.6rem;
  }

  .order-list-card__status-row {
    display: none;
  }

  .order-list-card__summary {
    gap: 0.25rem 0.65rem;
  }
}

/* 暗色：刷新按钮与元信息胶囊。 */
.dark .order-list-page__refresh-btn {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: rgb(203 213 225);
}

.dark .order-list-card__meta-pill {
  background: rgba(255, 255, 255, 0.06);
}
</style>
