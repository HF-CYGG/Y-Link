<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientOrdersView.vue
 * 文件职责：承载客户端“我的订单”列表展示、服务端筛选查询、分页加载、局部自动刷新与刷新动画反馈能力。
 * 实现逻辑：
 * - 状态筛选与关键词查询统一走服务端接口，不再只对第一页缓存做本地过滤，避免遗漏更多历史订单；
 * - 订单列表支持“加载更多”，并把当前筛选条件、关键词、页码和已加载结果缓存到按账号隔离的 Store 中；
 * - 页面层继续使用 `useStableRequest` 保证只有最新一次查询结果生效，减少频繁切换筛选时的闪烁与覆盖。
 * 维护说明：
 * - 若后续新增列表查询条件，需要同步修改 `buildListQuery()`、Store 快照字段与空态文案；
 * - 订单撤回等会改变服务端筛选结果的操作，要优先考虑当前列表是否需要局部剔除或整页刷新；
 * - 若调整自动刷新节奏，需要同时评估移动端流量、页面可见性监听与高亮动画时长是否仍匹配。
 */


import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { RefreshRight } from '@element-plus/icons-vue'
import {
  cancelMyO2oPreorder,
  getMyO2oPreorderSummary,
  getMyO2oPreorders,
  resolveO2oDisplayShowNo,
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
import { notifyClientOrderRefresh, subscribeClientOrderRefresh } from '@/utils/client-order-refresh'
import { buildClientOrderSummaryFromDetail } from '@/utils/client-order-summary'
import { formatDateTime } from '@/utils/date-time'
import { normalizeRequestError } from '@/utils/error'
import { captureOrderRefreshAnchor, restoreOrderRefreshAnchor } from '@/utils/order-refresh-visual'

import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const ORDER_TYPE_LABEL_MAP = {
  department: '部门订',
  walkin: '散客',
} as const
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
  order: O2oPreorderSummary
  report: ClientOrderStatusReportConfig
  metaFacts: OrderMetaFact[]
  statusChips: OrderStatusChip[]
  assistSummary: string
}

const RETURN_REQUEST_STATUS_META = {
  pending: {
    label: '待门店核销',
    className: 'bg-amber-50 text-amber-700',
    description: '退货申请已提交，请携带商品与退货码到店处理。',
  },
  verified: {
    label: '退货已完成',
    className: 'bg-emerald-50 text-emerald-700',
    description: '门店已完成退货核销，可在订单详情中查看本次退货记录。',
  },
  rejected: {
    label: '退货已拒绝',
    className: 'bg-rose-50 text-rose-700',
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
const recallingOrderId = ref('')
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const orderListBodyRef = ref<HTMLElement | null>(null)
const lastAutoRefreshAt = ref(0)
const orderRefreshMarkExpiresAtMap = ref<Record<string, number>>({})
const clientAuthStore = useClientAuthStore(pinia)
const clientOrderStore = useClientOrderStore(pinia)
const { runLatest } = useStableRequest()
clientOrderStore.initialize(clientAuthStore.currentUser?.id)
let disposeClientOrderRefresh: () => void = () => {}
let refreshMarkCleanupTimer: ReturnType<typeof globalThis.setTimeout> | null = null
let autoRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null
const clientOrderRefreshSourceId = `client-orders-${Math.random().toString(36).slice(2)}`
const runLatestListRequest = runLatest

const orders = computed(() => clientOrderStore.orders)
const total = computed(() => clientOrderStore.total)
const hasMoreOrders = computed(() => orders.value.length < total.value)
const keywordInput = ref(clientOrderStore.keyword)
const effectiveKeyword = ref(clientOrderStore.keyword)
const keywordDebounceTimer = ref<ReturnType<typeof globalThis.setTimeout> | null>(null)
const keywordDebouncing = ref(false)
const activeStatus = computed({
  get: () => clientOrderStore.activeStatus,
  set: (value: 'all' | O2oPreorderSummary['status']) => clientOrderStore.setActiveStatus(value),
})
const autoRefreshStatusText = computed(() => {
  if (!lastAutoRefreshAt.value) {
    return '自动刷新已开启'
  }
  return `最近同步 ${formatOrderDateTime(new Date(lastAutoRefreshAt.value).toISOString())}`
})

// 关键词采用“输入词 + 生效词”双状态：
// - 输入词实时绑定输入框，保证打字流畅；
// - 生效词由防抖定时器更新，避免短时间重复计算导致列表抖动。
watch(
  () => keywordInput.value,
  (nextKeyword) => {
    if (keywordDebounceTimer.value !== null) {
      globalThis.clearTimeout(keywordDebounceTimer.value)
      keywordDebounceTimer.value = null
    }
    if (nextKeyword.trim() === effectiveKeyword.value.trim()) {
      keywordDebouncing.value = false
      return
    }
    keywordDebouncing.value = true
    keywordDebounceTimer.value = globalThis.setTimeout(() => {
      effectiveKeyword.value = nextKeyword.trim()
      keywordDebouncing.value = false
      keywordDebounceTimer.value = null
    }, KEYWORD_DEBOUNCE_MS)
  },
)

onBeforeUnmount(() => {
  if (keywordDebounceTimer.value !== null) {
    globalThis.clearTimeout(keywordDebounceTimer.value)
    keywordDebounceTimer.value = null
  }
})

const getClientOrderTypeLabel = (order: Pick<O2oPreorderSummary, 'clientOrderType'>) => {
  return ORDER_TYPE_LABEL_MAP[order.clientOrderType]
}

const getOrderStatusReport = (order: O2oPreorderSummary) => {
  return getClientOrderStatusReportConfig({
    statusReport: order.statusReport,
    status: order.status,
    timeoutAt: order.timeoutAt,
  })
}

const getOrderStatusClassName = (order: O2oPreorderSummary) => {
  const scenario = order.statusReport?.scenario ?? getClientOrderReportScenario(order.status, order.timeoutAt)
  if (scenario === 'timeout_soon') {
    return 'bg-orange-50 text-orange-700'
  }
  if (scenario === 'timeout_cancelled') {
    return 'bg-rose-50 text-rose-700'
  }
  return CLIENT_O2O_ORDER_STATUS_CLASS_MAP[order.status]
}

const handleStatusChange = (value: 'all' | O2oPreorderSummary['status']) => {
  if (activeStatus.value === value) {
    return
  }
  activeStatus.value = value
  void loadOrders(true)
}

const normalizeSummaryDisplayShowNo = (order: O2oPreorderSummary): O2oPreorderSummary => {
  return {
    ...order,
    showNo: resolveO2oDisplayShowNo(order),
    customerOrderShowNo: order.customerOrderShowNo ?? null,
  }
}

const getBusinessStatusMeta = (order: O2oPreorderSummary) => {
  return getO2oOrderBusinessStatusMeta(order.businessStatus)
}

const getLatestReturnRequestMeta = (order: O2oPreorderSummary) => {
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
const hasOrderCardChanged = (previous: O2oPreorderSummary | undefined, next: O2oPreorderSummary) => {
  if (!previous) {
    return true
  }
  return (
    previous.showNo !== next.showNo
    || previous.verifyCode !== next.verifyCode
    || previous.status !== next.status
    || previous.businessStatus !== next.businessStatus
    || previous.hasCustomerOrder !== next.hasCustomerOrder
    || previous.isSystemApplied !== next.isSystemApplied
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
const buildOrderMetaFacts = (order: O2oPreorderSummary): OrderMetaFact[] => {
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
  order: O2oPreorderSummary,
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
      className: 'bg-slate-100 text-slate-500',
    })
  }

  return chips
}

// 详细注释：辅助说明收口成一段紧凑摘要，把原来分散在多块卡片中的补充状态压缩为可阅读的一段文本。
const buildOrderAssistSummary = (
  order: O2oPreorderSummary,
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
const buildListQuery = (targetPage: number) => {
  return {
    page: targetPage,
    pageSize: clientOrderStore.pageSize || DEFAULT_ORDER_PAGE_SIZE,
    status: activeStatus.value === 'all' ? undefined : activeStatus.value,
    keyword: effectiveKeyword.value || undefined,
  }
}

const syncStoreWithCurrentUser = () => {
  clientOrderStore.initialize(clientAuthStore.currentUser?.id)
  keywordInput.value = clientOrderStore.keyword
  effectiveKeyword.value = clientOrderStore.keyword
}

// 详细注释：静默轮询会临时扩大本次请求的 pageSize，
// 这样列表顶部即使插入了几条新订单，也尽量不把用户当前视野附近的旧卡片挤出结果窗口。
const buildSilentRefreshQuery = () => {
  const logicalPageSize = clientOrderStore.pageSize || DEFAULT_ORDER_PAGE_SIZE
  const loadedCount = Math.max(clientOrderStore.orders.length, logicalPageSize)
  return {
    ...buildListQuery(1),
    pageSize: loadedCount + logicalPageSize,
  }
}

const resolveSilentRefreshRecords = (latestRecords: O2oPreorderSummary[]) => {
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
  if (!clientAuthStore.currentUser?.id) {
    return false
  }
  if (globalThis.document?.visibilityState === 'hidden') {
    return false
  }
  return !firstScreenLoading.value && !refreshing.value && !loadingMore.value && !recallingOrderId.value
}

const triggerSilentOrderRefresh = async () => {
  if (!canRunAutoRefresh()) {
    return
  }
  await loadOrders(true, { silent: true, preserveScroll: true })
}

const refreshSingleOrderSummary = async (orderId: string, options?: { silent?: boolean }) => {
  try {
    const result = normalizeSummaryDisplayShowNo(await getMyO2oPreorderSummary(orderId))
    clientOrderStore.syncOrderSummary(result, { preserveFresh: true })
    markRefreshedOrders([result.id])
  } catch (error) {
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
  disposeClientOrderRefresh = subscribeClientOrderRefresh(async (event) => {
    if (event.sourceId === clientOrderRefreshSourceId || !event.orderId) {
      return
    }
    await refreshSingleOrderSummary(event.orderId, { silent: true })
  })
}

const handleVisibilityChange = () => {
  if (globalThis.document?.visibilityState === 'visible') {
    void triggerSilentOrderRefresh()
  }
}

const scheduleAutoRefresh = () => {
  if (autoRefreshTimer !== null) {
    globalThis.clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
  autoRefreshTimer = globalThis.setInterval(() => {
    void triggerSilentOrderRefresh()
  }, ORDER_AUTO_REFRESH_INTERVAL_MS)
}

const loadOrders = async (force = false, options?: { append?: boolean; silent?: boolean; preserveScroll?: boolean }) => {
  const append = options?.append === true
  const silent = options?.silent === true
  if (!append && !force && clientOrderStore.orders.length > 0 && clientOrderStore.isFresh) {
    requestError.value = null
    return
  }
  const hasCachedOrders = clientOrderStore.orders.length > 0
  const targetPage = append ? clientOrderStore.page + 1 : 1
  const preserveScroll = options?.preserveScroll === true && !append && hasCachedOrders
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
      getMyO2oPreorders(
        silent && !append ? buildSilentRefreshQuery() : buildListQuery(targetPage),
        { signal },
      ),
    onSuccess: async (result) => {
      if (append) {
        clientOrderStore.appendOrders(result.records.map(normalizeSummaryDisplayShowNo), {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
        })
        return
      }
      const previousOrderMap = new Map(clientOrderStore.orders.map((item) => [item.id, item]))
      const normalizedRecords = result.records.map(normalizeSummaryDisplayShowNo)
      const nextRecords = silent ? resolveSilentRefreshRecords(normalizedRecords) : normalizedRecords
      const logicalPageSize = clientOrderStore.pageSize || DEFAULT_ORDER_PAGE_SIZE
      clientOrderStore.setOrders(nextRecords, {
        page: silent ? Math.max(1, Math.ceil(nextRecords.length / logicalPageSize)) : result.page,
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
        restoreOrderRefreshAnchor(scrollAnchor, {
          listRoot: orderListBodyRef.value,
          itemAttributeName: 'data-order-card-id',
        })
      }
    },
    onError: (error) => {
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
      firstScreenLoading.value = false
      refreshing.value = false
      silentRefreshing.value = false
      loadingMore.value = false
    },
  })
}

const clearKeyword = () => {
  const hadKeyword = Boolean(keywordInput.value.trim() || effectiveKeyword.value.trim())
  if (keywordDebounceTimer.value !== null) {
    globalThis.clearTimeout(keywordDebounceTimer.value)
    keywordDebounceTimer.value = null
  }
  keywordInput.value = ''
  effectiveKeyword.value = ''
  keywordDebouncing.value = false
  clientOrderStore.setKeyword('')
  if (hadKeyword) {
    void loadOrders(true)
  }
}

// 详细注释：执行撤回订单，二次确认后请求撤回，并更新 Store 中的订单状态。
const handleRecallOrder = async (order: O2oPreorderSummary) => {
  if (order.status !== 'pending') {
    showAppWarning('当前订单状态不可撤回')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认撤回订单“${order.showNo}”吗？撤回后将释放预订库存，二维码会立即失效。`,
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

  recallingOrderId.value = order.id
  try {
    const detail = await cancelMyO2oPreorder(order.id)
    clientOrderStore.syncOrderSummary(buildClientOrderSummaryFromDetail(detail), { preserveFresh: true })
    notifyClientOrderRefresh({
      orderId: detail.order.id,
      reason: 'cancelled',
      sourceId: clientOrderRefreshSourceId,
    })
    showAppSuccess('订单已撤回')
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '撤回订单失败')
    showAppError(normalizedError.message)
  } finally {
    recallingOrderId.value = ''
  }
}

watch(
  () => effectiveKeyword.value,
  (nextKeyword, previousKeyword) => {
    if (nextKeyword === previousKeyword) {
      return
    }
    clientOrderStore.setKeyword(nextKeyword)
    void loadOrders(true)
  },
)

watch(
  () => clientAuthStore.currentUser?.id ?? '',
  (nextUserId, previousUserId) => {
    if (nextUserId === previousUserId) {
      return
    }
    syncStoreWithCurrentUser()
    if (nextUserId) {
      void loadOrders(true)
    }
  },
)

onMounted(async () => {
  startClientOrderRefreshSubscription()
  syncStoreWithCurrentUser()
  globalThis.document?.addEventListener('visibilitychange', handleVisibilityChange)
  scheduleAutoRefresh()
  const hadCachedOrders = clientOrderStore.orders.length > 0
  await loadOrders()
  if (hadCachedOrders) {
    void loadOrders(true, { silent: true, preserveScroll: true })
  }
})

onBeforeUnmount(() => {
  if (keywordDebounceTimer.value !== null) {
    globalThis.clearTimeout(keywordDebounceTimer.value)
    keywordDebounceTimer.value = null
  }
  if (refreshMarkCleanupTimer !== null) {
    globalThis.clearTimeout(refreshMarkCleanupTimer)
    refreshMarkCleanupTimer = null
  }
  if (autoRefreshTimer !== null) {
    globalThis.clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
  disposeClientOrderRefresh()
  globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<template>
  <section class="order-list-page space-y-4">
    <div class="rounded-[1.4rem] bg-white p-3.5 shadow-[var(--ylink-shadow-soft)] sm:p-4">
      <div class="order-list-page__hero">
        <div class="min-w-0 flex-1">
          <p class="text-xl font-semibold text-slate-900">我的订单</p>
          <p class="text-sm text-slate-500">查看待提货、已核销与已取消订单，并区分部门订与散客</p>
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
          :class="activeStatus === tab.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'"
          @click="handleStatusChange(tab.key as 'all' | O2oPreorderSummary['status'])"
        >
          {{ tab.label }}
        </button>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <input
          v-model="keywordInput"
          class="h-10 flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-slate-300"
          placeholder="搜索订单号、核销码、部门、工号或归属"
        />
        <button type="button" class="h-10 rounded-full border border-slate-200 px-4 text-sm text-slate-600" @click="clearKeyword">清空</button>
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
      <Transition name="order-refresh-badge">
        <p v-if="silentRefreshing && !refreshing && !loadingMore && !keywordDebouncing" class="mt-2 text-xs text-teal-600">
          正在静默同步最新订单，当前浏览位置保持不变
        </p>
      </Transition>
      <p v-if="orders.length" class="mt-2 text-xs text-slate-400">
        已加载 {{ orders.length }} 条，服务端共命中 {{ total }} 条订单
      </p>
      <p v-if="orders.length" class="mt-1 text-xs text-slate-400">
        {{ autoRefreshStatusText }}
      </p>
    </div>

    <div v-if="firstScreenLoading" class="grid gap-3 rounded-[1.4rem] bg-white p-3.5 shadow-[var(--ylink-shadow-soft)] sm:p-4">
      <div v-for="index in 4" :key="index" class="h-[4rem] animate-pulse rounded-2xl bg-slate-100" />
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
      v-else-if="!orders.length"
      type="empty"
      title="暂无订单"
      :description="effectiveKeyword ? '未匹配到符合关键词的订单，请调整关键词后重试' : '当前筛选下没有订单记录'"
      action-text="刷新订单"
      @retry="loadOrders(true)"
    />

    <div v-else>
      <div ref="orderListBodyRef">
        <TransitionGroup name="order-list-refresh" tag="div" class="space-y-3">
          <article
            v-for="card in orderCardList"
            :key="card.order.id"
            class="rounded-[1.2rem] bg-white p-3.5 shadow-[var(--ylink-shadow-soft)] sm:p-4"
            :class="{ 'order-list-card--refreshed': isOrderRecentlyRefreshed(card.order.id) }"
            :data-order-card-id="card.order.id"
          >
            <div class="order-list-card__header">
              <div class="order-list-card__topline">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <p class="min-w-0 flex-1 truncate text-[0.98rem] font-semibold text-slate-900 sm:flex-none sm:text-base">
                      {{ card.order.showNo }}
                    </p>
                    <span class="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 sm:text-xs">
                      {{ getClientOrderTypeLabel(card.order) }}
                    </span>
                    <Transition name="order-refresh-badge">
                      <span
                        v-if="isOrderRecentlyRefreshed(card.order.id)"
                        class="rounded-full bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-700"
                      >
                        已更新
                      </span>
                    </Transition>
                  </div>
                </div>
                <div class="flex items-center gap-2 self-start">
                  <button
                    v-if="card.order.status === 'pending'"
                    type="button"
                    class="rounded-full border border-rose-200 px-3 py-1.5 text-xs text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
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
        </TransitionGroup>
      </div>
      <div class="flex justify-center pt-1">
        <button
          v-if="hasMoreOrders"
          type="button"
          class="rounded-full border border-slate-200 bg-white px-5 py-2 text-sm text-slate-600 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="loadingMore"
          @click="loadOrders(true, { append: true })"
        >
          {{ loadingMore ? '加载中...' : '加载更多' }}
        </button>
        <p v-else class="text-xs text-slate-400">已加载全部符合条件的订单</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
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

  .order-list-card__header {
    gap: 0.65rem;
  }

  .order-list-card__topline {
    gap: 0.6rem;
  }

  .order-list-card__status-row {
    gap: 0.45rem;
    margin-top: 0.65rem;
  }

  .order-list-card__summary {
    gap: 0.25rem 0.65rem;
  }
}
</style>
