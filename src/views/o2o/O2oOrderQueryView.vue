<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/O2oOrderQueryView.vue
 * 文件职责：管理端集中查看 O2O 订单池、详情进度、超时状态与业务状态流转。
 * 维护说明：
 * - 左侧订单池分组依赖统一状态推导，修改分组规则时要同步校验高亮、新订单提醒与详情联动；
 * - 详情区的状态文案必须复用共享状态配置，避免“主动撤回”被错误展示成普通取消。
 */

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { PageContainer } from '@/components/common'
import {
  getClientOrderStatusReportConfig,
  getO2oOrderBusinessStatusMeta,
  getClientOrderReportScenario,
  isO2oOrderPending,
  O2O_ORDER_BUSINESS_STATUS_META,
  type O2oOrderBusinessStatus,
  type O2oOrderStatus,
} from '@/constants/o2o-order-status'
import {
  getO2oConsoleOrderDetail,
  getO2oConsoleOrders,
  updateO2oOrderBusinessStatus,
  updateO2oOrderMerchantMessage,
  type O2oPreorderDetail,
  type O2oPreorderSummary,
  type O2oOrderStatusReport,
} from '@/api/modules/o2o'

type OrderPoolKey = 'all' | 'pending' | 'completed' | 'cancelled'

const ORDER_POOL_TABS: Array<{ key: OrderPoolKey; label: string }> = [
  { key: 'all', label: '全部订单' },
  { key: 'pending', label: '待核销' },
  { key: 'completed', label: '已完成' },
  { key: 'cancelled', label: '已取消' },
]

const NEW_ORDER_WINDOW_MS = 30 * 60 * 1000
const NEW_ORDER_HIGHLIGHT_MS = 6000
const MERCHANT_MESSAGE_MAX_LENGTH = 500
const POLL_INTERVAL_OPTIONS = [10, 15] as const
const listLoading = ref(false)
const detailLoading = ref(false)
const orders = ref<O2oPreorderSummary[]>([])
const activePool = ref<OrderPoolKey>('all')
const activeOrderId = ref('')
const activeOrderDetail = ref<O2oPreorderDetail | null>(null)
const autoRefreshEnabled = ref(true)
const pollIntervalSeconds = ref<(typeof POLL_INTERVAL_OPTIONS)[number]>(15)
const soundNoticeEnabled = ref(false)
const nowMs = ref(Date.now())
const orderHighlightExpiresAtMap = ref<Record<string, number>>({})
const latestNewOrderNotice = ref<{ count: number; expiresAt: number } | null>(null)
const orderSnapshotReady = ref(false)
const router = useRouter()

let autoRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null
let secondTickTimer: ReturnType<typeof globalThis.setInterval> | null = null
let reminderAudioContext: AudioContext | null = null

const query = reactive({
  keyword: '',
})

// “去核销”只允许真正处于 pending 的订单进入核销台。
// 已超时取消、人工取消、已核销都不允许再进入核销流程，避免操作员误判。
const canGoVerify = computed(() => isO2oOrderPending(activeOrderDetail.value?.order.status))
const goVerifyButtonText = computed(() => (canGoVerify.value ? '去核销' : '不可核销'))

const formatCurrency = (value: string | number | null | undefined) => {
  return Number(value ?? 0).toFixed(2)
}

/**
 * 订单时间格式化：
 * - 接口返回的时间字段可能是 ISO 字符串，这里统一转为本地时间展示；
 * - 列表卡片默认展示到“分钟”，详情进度节点展示到“秒”，兼顾紧凑性与可追溯性；
 * - 若时间值为空或解析失败，则返回兜底文案，避免页面直接暴露原始异常字符串。
 */
const formatOrderDateTime = (
  value: string | null | undefined,
  options?: {
    includeSeconds?: boolean
    fallback?: string
  },
) => {
  const fallbackText = options?.fallback ?? '--'
  if (!value) {
    return fallbackText
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return fallbackText
  }
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return options?.includeSeconds === false
    ? `${year}-${month}-${day} ${hours}:${minutes}`
    : `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

const parseTimeMs = (value: string | null | undefined) => {
  if (!value) {
    return 0
  }
  const timestamp = new Date(value).getTime()
  // 处理可能产生的 NaN 时间戳，避免排序时出错
  return Number.isFinite(timestamp) ? timestamp : 0
}

/**
 * 确定订单的排序时间戳：
 * 优先使用创建时间，若缺失则使用超时时间作为兜底。
 */
const resolveOrderSortTimestamp = (order: O2oPreorderSummary) => {
  return parseTimeMs(order.createdAt) || parseTimeMs(order.timeoutAt)
}

const getOrderScenario = (order: { statusReport?: O2oOrderStatusReport; status: O2oOrderStatus; timeoutAt: string | null }) => {
  return order.statusReport?.scenario ?? getClientOrderReportScenario(order.status, order.timeoutAt, nowMs.value)
}

const getOrderReportConfig = (order: { statusReport?: O2oOrderStatusReport; status: O2oOrderStatus; timeoutAt: string | null }) => {
  return getClientOrderStatusReportConfig({
    statusReport: order.statusReport,
    status: order.status,
    timeoutAt: order.timeoutAt,
  }, nowMs.value)
}

/**
 * 判断是否为新订单：
 * 仅 pending 状态且在设定时间窗口（NEW_ORDER_WINDOW_MS）内的订单判定为新订单。
 */
const isNewOrder = (order: O2oPreorderSummary) => {
  if (order.status !== 'pending') {
    return false
  }
  const createdAtMs = new Date(order.createdAt).getTime()
  if (!Number.isFinite(createdAtMs)) {
    return false
  }
  return nowMs.value - createdAtMs <= NEW_ORDER_WINDOW_MS
}

const resolvePoolKey = (order: O2oPreorderSummary): OrderPoolKey => {
  const scenario = getOrderScenario(order)
  if (scenario === 'verified') {
    return 'completed'
  }
  if (scenario === 'cancelled' || scenario === 'timeout_cancelled') {
    return 'cancelled'
  }
  return 'pending'
}

const poolCountMap = computed(() => {
  const map: Record<OrderPoolKey, number> = {
    all: orders.value.length,
    pending: 0,
    completed: 0,
    cancelled: 0,
  }
  for (const order of orders.value) {
    map[resolvePoolKey(order)] += 1
  }
  return map
})

const poolOrderMap = computed(() => {
  const map: Record<OrderPoolKey, O2oPreorderSummary[]> = {
    all: [],
    pending: [],
    completed: [],
    cancelled: [],
  }
  for (const order of orders.value) {
    map.all.push(order)
    map[resolvePoolKey(order)].push(order)
  }
  for (const tab of ORDER_POOL_TABS) {
    map[tab.key] = map[tab.key].slice().sort((prev, next) => {
      const timeDiff = resolveOrderSortTimestamp(next) - resolveOrderSortTimestamp(prev)
      if (timeDiff !== 0) {
        return timeDiff
      }
      return next.showNo.localeCompare(prev.showNo)
    })
  }
  return map
})

const currentPoolOrders = computed(() => poolOrderMap.value[activePool.value])
const detailEmptyText = computed(() => {
  if (listLoading.value) {
    return '订单加载中...'
  }
  if (!currentPoolOrders.value.length) {
    return '当前分类无符合条件的订单'
  }
  return '请选择左侧订单查看状态报告与进度节点'
})
const activeNewOrderNotice = computed(() => {
  if (!latestNewOrderNotice.value) {
    return null
  }
  if (latestNewOrderNotice.value.expiresAt <= nowMs.value) {
    return null
  }
  return latestNewOrderNotice.value
})

const activeScenario = computed(() => {
  if (!activeOrderDetail.value) {
    return 'pending'
  }
  return activeOrderDetail.value.order.statusReport?.scenario
    ?? getClientOrderReportScenario(activeOrderDetail.value.order.status, activeOrderDetail.value.order.timeoutAt, nowMs.value)
})

// 详情状态卡复用共享配置解析，确保“主动撤回”和“超时取消”展示口径一致。
const reportConfig = computed(() => {
  if (!activeOrderDetail.value) {
    return getClientOrderStatusReportConfig({
      status: 'pending',
      timeoutAt: null,
    })
  }

  return getClientOrderStatusReportConfig({
    statusReport: activeOrderDetail.value.order.statusReport,
    status: activeOrderDetail.value.order.status,
    timeoutAt: activeOrderDetail.value.order.timeoutAt,
  }, nowMs.value)
})

const detailAmountSummary = computed(() => {
  if (!activeOrderDetail.value) {
    return {
      totalAmount: '0.00',
      totalQty: 0,
      totalItemCount: 0,
    }
  }
  if (activeOrderDetail.value.amountSummary) {
    return activeOrderDetail.value.amountSummary
  }
  const totalAmount = activeOrderDetail.value.items.reduce((sum, item) => {
    const lineAmount = Number(item.subTotal ?? Number(item.defaultPrice || 0) * Number(item.qty || 0))
    return sum + lineAmount
  }, 0)
  return {
    totalAmount: formatCurrency(totalAmount),
    totalQty: Number(activeOrderDetail.value.order.totalQty ?? 0),
    totalItemCount: activeOrderDetail.value.items.length,
  }
})

// 预定用户信息摘要：
// - 统一收敛详情接口返回的用户名、手机号、邮箱、部门字段；
// - 模板仅消费这里的展示值，避免散落空值判断导致显示口径不一致。
const orderCustomerProfile = computed(() => {
  const profile = activeOrderDetail.value?.customerProfile
  if (!profile) {
    return {
      username: '未查询到预定用户',
      mobile: '未留手机号',
      email: '未留邮箱',
      departmentName: '未填写部门',
    }
  }
  return {
    username: profile.username?.trim() || '未命名用户',
    mobile: profile.mobile?.trim() || '未留手机号',
    email: profile.email?.trim() || '未留邮箱',
    departmentName: profile.departmentName?.trim() || '未填写部门',
  }
})

// 管理端状态选择只保留当前门店对外使用的四个核心业务状态，避免误选运输类历史状态。
const BUSINESS_STATUS_PICKER_ORDER: O2oOrderBusinessStatus[] = ['awaiting_shipment', 'preparing', 'ready', 'after_sale']

const businessStatusOptions = BUSINESS_STATUS_PICKER_ORDER.map((value) => {
  const meta = O2O_ORDER_BUSINESS_STATUS_META[value]
  return {
    value,
    label: meta.label,
    description: meta.consoleDescription,
  }
})

const activeBusinessStatus = computed(() => activeOrderDetail.value?.order.businessStatus ?? null)
const draftBusinessStatus = ref<O2oOrderBusinessStatus | null>(null)
const draftMerchantMessage = ref('')
// 详情辅助面板折叠状态：默认空数组表示“商家特殊状态/商家留言”均收起，不占页面空间。
const detailAssistPanels = ref<string[]>([])

const activeBusinessStatusMeta = computed(() => {
  return getO2oOrderBusinessStatusMeta(activeBusinessStatus.value)
})

watch(
  () => activeOrderDetail.value?.order.businessStatus ?? null,
  (value) => {
    draftBusinessStatus.value = value
  },
  { immediate: true },
)

watch(
  () => activeOrderDetail.value?.order.merchantMessage ?? null,
  (value) => {
    // 订单切换或详情刷新时，保持留言草稿与服务端最新值一致，避免误提交旧内容。
    draftMerchantMessage.value = value ?? ''
  },
  { immediate: true },
)

const activeMerchantMessage = computed(() => {
  const value = activeOrderDetail.value?.order.merchantMessage ?? null
  return value?.trim() ? value.trim() : null
})

const normalizedDraftMerchantMessage = computed(() => {
  const value = draftMerchantMessage.value.trim()
  return value || null
})

const merchantMessageChanged = computed(() => {
  return normalizedDraftMerchantMessage.value !== activeMerchantMessage.value
})

const timelineItems = computed(() => {
  if (!activeOrderDetail.value) {
    return []
  }
  const order = activeOrderDetail.value.order
  if (activeScenario.value === 'verified') {
    return [
      { key: 'created', title: '已下单', time: formatOrderDateTime(order.createdAt), active: true },
      { key: 'prepare', title: '备货完成', time: formatOrderDateTime(order.timeoutAt, { fallback: '门店已备货' }), active: true },
      { key: 'verify', title: '已核销', time: formatOrderDateTime(order.verifiedAt, { fallback: '核销成功' }), active: true },
      { key: 'done', title: '订单完成', time: formatOrderDateTime(order.verifiedAt, { fallback: '已完成' }), active: true },
    ]
  }
  if (activeScenario.value === 'cancelled' || activeScenario.value === 'timeout_cancelled') {
    return [
      { key: 'created', title: '已下单', time: formatOrderDateTime(order.createdAt), active: true },
      { key: 'prepare', title: '备货中', time: formatOrderDateTime(order.timeoutAt, { fallback: '门店处理中' }), active: true },
      { key: 'cancel', title: reportConfig.value.timelineCurrentTitle, time: formatOrderDateTime(order.timeoutAt, { fallback: '已取消' }), active: true },
      { key: 'closed', title: '订单关闭', time: reportConfig.value.timelineCurrentHint, active: true },
    ]
  }
  return [
    { key: 'created', title: '已下单', time: formatOrderDateTime(order.createdAt), active: true },
    { key: 'prepare', title: '备货中', time: formatOrderDateTime(order.timeoutAt, { fallback: '按门店通知准备' }), active: true },
    { key: 'pending', title: reportConfig.value.timelineCurrentTitle, time: formatOrderDateTime(order.timeoutAt, { fallback: '待完成' }), active: true },
    { key: 'future', title: '核销后完成订单', time: '待完成', active: false },
  ]
})

const resolveRemainSeconds = (order: { status: O2oOrderStatus; expireInSeconds?: number; timeoutAt: string | null }) => {
  if (order.status !== 'pending') {
    return null
  }
  if (order.timeoutAt) {
    const remain = Math.floor((new Date(order.timeoutAt).getTime() - nowMs.value) / 1000)
    return Math.max(0, remain)
  }
  if (typeof order.expireInSeconds === 'number') {
    return Math.max(0, Math.floor(order.expireInSeconds))
  }
  return null
}

const formatCountdown = (order: { status: O2oOrderStatus; expireInSeconds?: number; timeoutAt: string | null }) => {
  const remainSeconds = resolveRemainSeconds(order)
  if (remainSeconds === null) {
    return '--'
  }
  if (remainSeconds <= 0) {
    return '已超时'
  }
  const hour = Math.floor(remainSeconds / 3600)
  const minute = Math.floor((remainSeconds % 3600) / 60)
  const second = remainSeconds % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

const isOrderHighlighted = (orderId: string) => {
  return (orderHighlightExpiresAtMap.value[orderId] ?? 0) > nowMs.value
}

const pruneTransientMarks = () => {
  const activeEntries = Object.entries(orderHighlightExpiresAtMap.value).filter(([, expiresAt]) => expiresAt > nowMs.value)
  if (activeEntries.length !== Object.keys(orderHighlightExpiresAtMap.value).length) {
    orderHighlightExpiresAtMap.value = Object.fromEntries(activeEntries)
  }
  if (latestNewOrderNotice.value && latestNewOrderNotice.value.expiresAt <= nowMs.value) {
    latestNewOrderNotice.value = null
  }
}

const playNewOrderReminderSound = () => {
  if (!soundNoticeEnabled.value) {
    return
  }
  const AudioContextCtor = globalThis.window.AudioContext || (globalThis.window as any).webkitAudioContext
  if (!AudioContextCtor) {
    return
  }
  if (!reminderAudioContext) {
    reminderAudioContext = new AudioContextCtor()
  }
  if (reminderAudioContext.state === 'suspended') {
    reminderAudioContext.resume().catch(() => undefined)
  }
  const oscillator = reminderAudioContext.createOscillator()
  const gainNode = reminderAudioContext.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = 880
  gainNode.gain.value = 0.0001
  oscillator.connect(gainNode)
  gainNode.connect(reminderAudioContext.destination)
  const startAt = reminderAudioContext.currentTime
  gainNode.gain.exponentialRampToValueAtTime(0.08, startAt + 0.02)
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.22)
  oscillator.start(startAt)
  oscillator.stop(startAt + 0.24)
}

const markIncrementalNewOrders = (items: O2oPreorderSummary[]) => {
  if (!items.length) {
    return
  }
  const nextMap = { ...orderHighlightExpiresAtMap.value }
  const expiresAt = nowMs.value + NEW_ORDER_HIGHLIGHT_MS
  for (const item of items) {
    nextMap[item.id] = expiresAt
  }
  orderHighlightExpiresAtMap.value = nextMap
  latestNewOrderNotice.value = {
    count: items.length,
    expiresAt,
  }
  playNewOrderReminderSound()
}

const dismissNewOrderNotice = () => {
  latestNewOrderNotice.value = null
}

const loadOrderDetail = async (id: string) => {
  if (!id) {
    activeOrderDetail.value = null
    return
  }
  detailLoading.value = true
  try {
    activeOrderDetail.value = await getO2oConsoleOrderDetail(id)
  } finally {
    detailLoading.value = false
  }
}

const mergeOrderSummaryFromDetail = (detail: O2oPreorderDetail) => {
  const nextOrder = detail.order
  const nextSummary: O2oPreorderSummary = {
    id: nextOrder.id,
    showNo: nextOrder.showNo,
    verifyCode: nextOrder.verifyCode,
    status: nextOrder.status,
    businessStatus: nextOrder.businessStatus,
    merchantMessage: nextOrder.merchantMessage,
    totalQty: nextOrder.totalQty,
    timeoutAt: nextOrder.timeoutAt,
    createdAt: nextOrder.createdAt,
    expireInSeconds: nextOrder.expireInSeconds,
    totalAmount: nextOrder.totalAmount,
    statusReport: nextOrder.statusReport,
  }
  const index = orders.value.findIndex((item) => item.id === nextOrder.id)
  if (index < 0) {
    orders.value = [nextSummary, ...orders.value]
    return
  }
  const nextOrders = orders.value.slice()
  nextOrders[index] = {
    ...nextOrders[index],
    ...nextSummary,
  }
  orders.value = nextOrders
}

const syncActiveOrder = async () => {
  const currentOrders = currentPoolOrders.value
  if (currentOrders.length === 0) {
    // 用户主动点进空分类时，不自动跳走，右侧保留空态说明即可。
    activeOrderId.value = ''
    activeOrderDetail.value = null
    return
  }
  const latestCurrentOrders = poolOrderMap.value[activePool.value]
  const exists = latestCurrentOrders.find((item) => item.id === activeOrderId.value)
  if (exists) {
    await loadOrderDetail(activeOrderId.value)
    return
  }
  const first = latestCurrentOrders[0]
  activeOrderId.value = first?.id ?? ''
  await loadOrderDetail(activeOrderId.value)
}

const loadOrders = async (silent = false) => {
  if (!silent) {
    listLoading.value = true
  }
  try {
    const previousOrderIds = new Set(orders.value.map((item) => item.id))
    const latestOrders = await getO2oConsoleOrders({
      keyword: query.keyword.trim() || undefined,
      limit: 200,
    })
    if (orderSnapshotReady.value) {
      const incrementalNewOrders = latestOrders.filter((item) => !previousOrderIds.has(item.id) && isNewOrder(item))
      markIncrementalNewOrders(incrementalNewOrders)
    }
    orders.value = latestOrders
    orderSnapshotReady.value = true
    await syncActiveOrder()
  } finally {
    listLoading.value = false
  }
}

const handlePickOrder = async (id: string) => {
  activeOrderId.value = id
  await loadOrderDetail(id)
}

const handlePoolChange = async (poolKey: OrderPoolKey) => {
  activePool.value = poolKey
  await syncActiveOrder()
}

const handleSearch = async () => {
  await loadOrders()
}

const handleRefreshCurrentOrder = async () => {
  if (!activeOrderId.value) {
    return
  }
  detailLoading.value = true
  try {
    const latestDetail = await getO2oConsoleOrderDetail(activeOrderId.value)
    activeOrderDetail.value = latestDetail
    mergeOrderSummaryFromDetail(latestDetail)
    ElMessage.success('当前订单状态已刷新')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '刷新失败，请稍后重试')
  } finally {
    detailLoading.value = false
  }
}

const handleGoVerify = async () => {
  if (!canGoVerify.value) {
    ElMessage.warning('当前订单已取消或已核销，不可继续核销')
    return
  }
  const verifyCode = activeOrderDetail.value?.order.verifyCode?.trim()
  if (!verifyCode) {
    ElMessage.warning('当前订单缺少核销码，无法前往核销台')
    return
  }
  await router.push({
    name: 'o2o-console-verify',
    query: {
      verifyCode,
      autoSearch: '1',
    },
  })
}

const handleCopyVerifyCode = async () => {
  const verifyCode = activeOrderDetail.value?.order.verifyCode?.trim()
  if (!verifyCode) {
    ElMessage.warning('当前订单缺少核销码，无法复制')
    return
  }
  if (!globalThis.navigator?.clipboard?.writeText) {
    ElMessage.error('当前环境不支持复制，请手动复制核销码')
    return
  }
  try {
    await globalThis.navigator.clipboard.writeText(verifyCode)
    ElMessage.success('核销码复制成功')
  } catch {
    ElMessage.error('复制失败，请检查浏览器权限后重试')
  }
}

const handleBusinessStatusChange = async (value: O2oOrderBusinessStatus | null) => {
  if (!activeOrderDetail.value?.order.id) {
    return
  }
  const previousValue = activeBusinessStatus.value
  if (value === previousValue) {
    return
  }

  const nextMeta = getO2oOrderBusinessStatusMeta(value)
  const confirmMessage = value
    ? `确认将订单“${activeOrderDetail.value.order.showNo}”的商家特殊状态更新为“${nextMeta?.label ?? value}”吗？`
    : `确认清除订单“${activeOrderDetail.value.order.showNo}”的商家特殊状态吗？`

  try {
    await ElMessageBox.confirm(confirmMessage, '确认更新特殊状态', {
      type: 'warning',
      confirmButtonText: '确认生效',
      cancelButtonText: '取消',
      closeOnClickModal: false,
    })
  } catch {
    draftBusinessStatus.value = previousValue
    return
  }

  detailLoading.value = true
  try {
    const latestDetail = await updateO2oOrderBusinessStatus(activeOrderDetail.value.order.id, value)
    activeOrderDetail.value = latestDetail
    mergeOrderSummaryFromDetail(latestDetail)
    draftBusinessStatus.value = latestDetail.order.businessStatus
    ElMessage.success(value ? '商家特殊状态已更新' : '商家特殊状态已清除')
  } catch (error) {
    draftBusinessStatus.value = previousValue
    ElMessage.error(error instanceof Error ? error.message : '更新商家状态失败，请稍后重试')
  } finally {
    detailLoading.value = false
  }
}

const handleSaveMerchantMessage = async () => {
  if (!activeOrderDetail.value?.order.id) {
    return
  }
  if (!merchantMessageChanged.value) {
    ElMessage.info('留言内容未变化，无需保存')
    return
  }

  const previousValue = activeMerchantMessage.value
  const nextValue = normalizedDraftMerchantMessage.value
  const nextLength = nextValue?.length ?? 0
  if (nextLength > MERCHANT_MESSAGE_MAX_LENGTH) {
    ElMessage.warning(`商家留言最多 ${MERCHANT_MESSAGE_MAX_LENGTH} 个字符`)
    return
  }

  let confirmMessage = `确认清空订单“${activeOrderDetail.value.order.showNo}”的商家留言吗？`
  if (nextValue) {
    confirmMessage = previousValue
      ? `确认更新订单“${activeOrderDetail.value.order.showNo}”的商家留言吗？`
      : `确认设置订单“${activeOrderDetail.value.order.showNo}”的商家留言吗？`
  }

  try {
    await ElMessageBox.confirm(confirmMessage, '确认提交商家留言', {
      type: 'warning',
      confirmButtonText: '确认提交',
      cancelButtonText: '取消',
      closeOnClickModal: false,
    })
  } catch {
    return
  }

  detailLoading.value = true
  try {
    const latestDetail = await updateO2oOrderMerchantMessage(activeOrderDetail.value.order.id, nextValue)
    activeOrderDetail.value = latestDetail
    mergeOrderSummaryFromDetail(latestDetail)
    draftMerchantMessage.value = latestDetail.order.merchantMessage ?? ''
    ElMessage.success(nextValue ? '商家留言已保存' : '商家留言已清空')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存商家留言失败，请稍后重试')
  } finally {
    detailLoading.value = false
  }
}

const scheduleAutoRefresh = () => {
  if (autoRefreshTimer !== null) {
    globalThis.clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
  if (!autoRefreshEnabled.value) {
    return
  }
  autoRefreshTimer = globalThis.setInterval(() => {
    void loadOrders(true)
  }, pollIntervalSeconds.value * 1000)
}

const handleAutoRefreshChange = () => {
  scheduleAutoRefresh()
  ElMessage.success(autoRefreshEnabled.value ? `已开启 ${pollIntervalSeconds.value} 秒轮询` : '已关闭轮询')
}

const handlePollIntervalChange = () => {
  if (!autoRefreshEnabled.value) {
    return
  }
  scheduleAutoRefresh()
  ElMessage.success(`轮询间隔已切换为 ${pollIntervalSeconds.value} 秒`)
}

const handleSoundSwitchChange = () => {
  ElMessage.success(soundNoticeEnabled.value ? '已开启新单提示音' : '已关闭新单提示音')
}

onMounted(async () => {
  await loadOrders()
  scheduleAutoRefresh()
  secondTickTimer = globalThis.setInterval(() => {
    nowMs.value = Date.now()
    pruneTransientMarks()
  }, 1000)
})

onBeforeUnmount(() => {
  if (autoRefreshTimer !== null) {
    globalThis.clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
  if (secondTickTimer !== null) {
    globalThis.clearInterval(secondTickTimer)
    secondTickTimer = null
  }
  // 清理音频上下文，避免内存泄漏
  if (reminderAudioContext && reminderAudioContext.state !== 'closed') {
    reminderAudioContext.close().catch(() => undefined)
    reminderAudioContext = null
  }
})
</script>

<template>
  <PageContainer title="订单池工作台" description="左侧订单池实时分栏，右侧工作台查看状态报告、商品明细、金额汇总与进度节点">
    <div class="order-workbench-root grid gap-4 xl:grid-cols-[26rem_minmax(0,1fr)]">
      <section class="min-w-0 overflow-hidden rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <p class="break-words text-lg font-semibold text-slate-900">订单池</p>
          <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <el-switch
              v-model="autoRefreshEnabled"
              size="small"
              inline-prompt
              active-text="轮询开"
              inactive-text="轮询关"
              @change="handleAutoRefreshChange"
            />
            <el-select
              v-model="pollIntervalSeconds"
              size="small"
              class="poll-interval-select w-full sm:w-28"
              :disabled="!autoRefreshEnabled"
              @change="handlePollIntervalChange"
            >
              <el-option v-for="seconds in POLL_INTERVAL_OPTIONS" :key="seconds" :label="`${seconds} 秒`" :value="seconds" />
            </el-select>
            <el-switch
              v-model="soundNoticeEnabled"
              size="small"
              inline-prompt
              active-text="声音开"
              inactive-text="声音关"
              @change="handleSoundSwitchChange"
            />
          </div>
        </div>

        <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-2">
          <button
            v-for="tab in ORDER_POOL_TABS"
            :key="tab.key"
            type="button"
            class="order-pool-tab flex min-w-0 items-center justify-between rounded-2xl px-3 py-2 text-left text-xs transition"
            :class="activePool === tab.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'"
            @click="handlePoolChange(tab.key)"
          >
            <span class="order-pool-tab__label">{{ tab.label }}</span>
            <span class="order-pool-tab__count rounded-full px-2 py-0.5 text-[11px]" :class="activePool === tab.key ? 'bg-white/20 text-white' : 'bg-white text-slate-500'">
              {{ poolCountMap[tab.key] }}
            </span>
          </button>
        </div>

        <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <el-input
            v-model.trim="query.keyword"
            class="min-w-0"
            placeholder="搜索订单号或核销码"
            clearable
            @keyup.enter="handleSearch"
          />
          <el-button class="search-action-button w-full sm:w-auto" type="primary" @click="handleSearch">查询</el-button>
        </div>

        <Transition name="new-order-notice">
          <div v-if="activeNewOrderNotice" class="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p class="break-words">新单提醒：新增 {{ activeNewOrderNotice.count }} 笔，已高亮 6 秒</p>
              <el-button link type="warning" @click="dismissNewOrderNotice">知道了</el-button>
            </div>
          </div>
        </Transition>

        <div class="mt-4 space-y-2">
          <button
            v-for="order in currentPoolOrders"
            :key="order.id"
            type="button"
            class="w-full rounded-2xl border px-3 py-3 text-left transition"
            :class="[
              activeOrderId === order.id ? 'border-teal-200 bg-teal-50' : 'border-slate-100 bg-white hover:bg-slate-50',
              isOrderHighlighted(order.id) ? 'order-card--new' : '',
            ]"
            @click="handlePickOrder(order.id)"
          >
            <div class="flex min-w-0 items-start justify-between gap-2">
              <p class="min-w-0 break-words text-sm font-semibold text-slate-900">{{ order.showNo }}</p>
              <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" :class="getOrderReportConfig(order).cardClassName">
                {{ getOrderReportConfig(order).statusLabel }}
              </span>
            </div>
            <div class="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-500">
              <p class="break-words">时间：{{ formatOrderDateTime(order.createdAt, { includeSeconds: false }) }}</p>
              <p class="text-right">件数：{{ order.totalQty }}</p>
              <p>应付总额：¥{{ formatCurrency(order.totalAmount) }}</p>
              <p class="text-right">倒计时：{{ formatCountdown(order) }}</p>
            </div>
          </button>
          <div v-if="!listLoading && !currentPoolOrders.length" class="rounded-2xl border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">
            当前分栏暂无订单
          </div>
        </div>
      </section>

      <section class="min-w-0 overflow-hidden rounded-3xl bg-white p-5 shadow-sm">
        <template v-if="activeOrderDetail">
          <div class="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-start lg:justify-between">
            <div class="min-w-0">
              <p class="break-words text-lg font-semibold text-slate-900">{{ activeOrderDetail.order.showNo }}</p>
              <p class="mt-1 break-all text-sm text-slate-400">核销码：{{ activeOrderDetail.order.verifyCode }}</p>
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:w-auto">
              <el-button class="w-full" type="primary" plain :disabled="!canGoVerify" @click="handleGoVerify">{{ goVerifyButtonText }}</el-button>
              <el-button class="w-full" :loading="detailLoading" @click="handleRefreshCurrentOrder">刷新状态</el-button>
              <el-button class="w-full" @click="handleCopyVerifyCode">复制核销码</el-button>
            </div>
          </div>

          <div class="mt-4 rounded-2xl px-4 py-3" :class="reportConfig.cardClassName">
            <p class="text-sm font-semibold">状态报告：{{ reportConfig.cardTitle }}</p>
            <p class="mt-1 break-words text-xs">{{ reportConfig.cardDescription }}</p>
          </div>

          <div class="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2">
            <el-collapse v-model="detailAssistPanels" class="order-detail-assist-collapse">
              <el-collapse-item name="business-status">
                <template #title>
                  <div class="flex min-w-0 flex-col py-2">
                    <p class="text-sm font-semibold text-slate-900">商家特殊状态</p>
                    <p class="mt-1 text-xs leading-5 text-slate-500">
                      用于通知用户当前订单所处的特殊进度，不改变待核销、已核销、已取消等核心状态。
                    </p>
                  </div>
                </template>
                <div class="pb-3">
                  <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div class="min-w-0">
                      <p class="text-xs leading-5 text-slate-500">请选择需要展示给用户的特殊状态（可清空）。</p>
                    </div>
                    <el-select
                      v-model="draftBusinessStatus"
                      clearable
                      placeholder="选择特殊状态"
                      class="w-full lg:w-72"
                      :disabled="detailLoading"
                      @change="handleBusinessStatusChange"
                    >
                      <el-option
                        v-for="option in businessStatusOptions"
                        :key="option.value"
                        :label="option.label"
                        :value="option.value"
                      />
                    </el-select>
                  </div>
                  <p v-if="activeBusinessStatusMeta" class="mt-2 text-xs leading-5 text-slate-500">
                    {{ activeBusinessStatusMeta.consoleDescription }}
                  </p>
                  <div v-if="activeBusinessStatusMeta" class="mt-3 rounded-2xl px-3 py-2" :class="activeBusinessStatusMeta.className">
                    <p class="text-sm font-semibold">当前商家状态：{{ activeBusinessStatusMeta.label }}</p>
                    <p class="mt-1 text-xs">{{ activeBusinessStatusMeta.consoleDescription }}</p>
                  </div>
                </div>
              </el-collapse-item>

              <el-collapse-item name="merchant-message">
                <template #title>
                  <div class="flex min-w-0 flex-col py-2">
                    <p class="text-sm font-semibold text-slate-900">商家留言</p>
                    <p class="mt-1 text-xs leading-5 text-slate-500">
                      用于补充特殊订单说明；保存后客户端详情页可见，清空后客户端不再显示该模块。
                    </p>
                  </div>
                </template>
                <div class="pb-3">
                  <div class="flex flex-col gap-3">
                    <el-input
                      v-model="draftMerchantMessage"
                      type="textarea"
                      :rows="3"
                      maxlength="500"
                      show-word-limit
                      resize="none"
                      placeholder="请输入商家留言（最多 500 字）"
                      :disabled="detailLoading"
                    />
                    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p class="text-xs text-slate-500">
                        {{ merchantMessageChanged ? '留言有变更，点击保存后生效' : '留言与当前已保存内容一致' }}
                      </p>
                      <div class="flex gap-2">
                        <el-button :disabled="detailLoading || !merchantMessageChanged" @click="handleSaveMerchantMessage">
                          保存留言
                        </el-button>
                        <el-button
                          :disabled="detailLoading || !normalizedDraftMerchantMessage"
                          @click="draftMerchantMessage = ''"
                        >
                          清空输入
                        </el-button>
                      </div>
                    </div>
                    <div v-if="activeMerchantMessage" class="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      <p class="text-xs text-amber-700">当前已生效留言</p>
                      <p class="mt-1 whitespace-pre-wrap break-words">{{ activeMerchantMessage }}</p>
                    </div>
                    <p v-else class="text-xs text-slate-500">当前未设置商家留言</p>
                  </div>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-4">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">状态</p>
              <p class="mt-1 text-sm font-semibold text-slate-900">{{ reportConfig.statusLabel }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">商家状态</p>
              <p class="mt-1 text-sm font-semibold text-slate-900">{{ activeBusinessStatusMeta?.label ?? '未设置' }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">应付总额</p>
              <p class="mt-1 text-sm font-semibold text-slate-900">¥{{ formatCurrency(detailAmountSummary.totalAmount) }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总件数</p>
              <p class="mt-1 text-sm font-semibold text-slate-900">{{ detailAmountSummary.totalQty }} 件</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">商品条目</p>
              <p class="mt-1 text-sm font-semibold text-slate-900">{{ detailAmountSummary.totalItemCount }} 项</p>
            </div>
          </div>

          <div class="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-4">
            <div>
              <p class="text-base font-semibold text-slate-900">预定用户信息</p>
              <p class="mt-1 text-xs leading-5 text-slate-500">
                便于门店在特殊情况下通过电话、邮件等方式及时联系客户并同步订单变化。
              </p>
            </div>
            <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">用户名</p>
                <p class="mt-1 break-words text-sm font-semibold text-slate-900">{{ orderCustomerProfile.username }}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">手机号</p>
                <p class="mt-1 break-all text-sm font-semibold text-slate-900">{{ orderCustomerProfile.mobile }}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">邮箱</p>
                <p class="mt-1 break-all text-sm font-semibold text-slate-900">{{ orderCustomerProfile.email }}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-4 py-3">
                <p class="text-sm text-slate-400">所属部门</p>
                <p class="mt-1 break-words text-sm font-semibold text-slate-900">{{ orderCustomerProfile.departmentName }}</p>
              </div>
            </div>
          </div>

          <div class="mt-4 space-y-2">
            <p class="text-base font-semibold text-slate-900">进度节点</p>
            <div
              v-for="step in timelineItems"
              :key="step.key"
              class="flex items-start gap-3 rounded-2xl px-3 py-2"
              :class="step.active ? 'bg-teal-50' : 'bg-slate-50'"
            >
              <span class="mt-1 h-2.5 w-2.5 rounded-full" :class="step.active ? 'bg-teal-500' : 'bg-slate-300'" />
              <div>
                <p class="text-sm font-semibold text-slate-900">{{ step.title }}</p>
                <p class="break-words text-xs text-slate-500">{{ step.time }}</p>
              </div>
            </div>
          </div>

          <div class="mt-4">
            <p class="mb-2 text-base font-semibold text-slate-900">商品明细</p>
            <div class="hidden sm:block">
              <div class="table-scroll-wrap">
                <el-table :data="activeOrderDetail.items" row-key="id" :loading="detailLoading">
                  <el-table-column prop="productName" label="商品名称" min-width="180" />
                  <el-table-column prop="defaultPrice" label="单价" width="120">
                    <template #default="{ row }">
                      <span>¥{{ formatCurrency(row.defaultPrice) }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column prop="qty" label="数量" width="90" align="right" />
                  <el-table-column label="小计" width="120" align="right">
                    <template #default="{ row }">
                      <span>¥{{ formatCurrency(row.subTotal ?? Number(row.defaultPrice || 0) * Number(row.qty || 0)) }}</span>
                    </template>
                  </el-table-column>
                </el-table>
              </div>
            </div>
            <div class="space-y-2 sm:hidden">
              <div
                v-for="item in activeOrderDetail.items"
                :key="item.id"
                class="rounded-2xl border border-slate-100 bg-slate-50 px-3 py-3"
              >
                <p class="break-words text-sm font-semibold text-slate-900">{{ item.productName }}</p>
                <div class="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-500">
                  <p>单价：¥{{ formatCurrency(item.defaultPrice) }}</p>
                  <p class="text-right">数量：{{ item.qty }}</p>
                  <p class="col-span-2 text-right font-semibold text-slate-700">
                    小计：¥{{ formatCurrency(item.subTotal ?? Number(item.defaultPrice || 0) * Number(item.qty || 0)) }}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </template>

        <div v-else class="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm text-slate-400">
          {{ detailEmptyText }}
        </div>
      </section>
    </div>
  </PageContainer>
</template>

<style scoped>
.order-workbench-root {
  width: 100%;
  min-width: 0;
  overflow-x: clip;
}

.order-detail-assist-collapse {
  --el-collapse-border-color: transparent;
  border-top: none;
  border-bottom: none;
}

.order-detail-assist-collapse :deep(.el-collapse-item__header) {
  min-height: 56px;
  border-bottom: 1px solid #e2e8f0;
  background: transparent;
}

.order-detail-assist-collapse :deep(.el-collapse-item:last-child .el-collapse-item__header) {
  border-bottom: none;
}

.order-detail-assist-collapse :deep(.el-collapse-item__wrap) {
  border-bottom: none;
  background: transparent;
}

.order-detail-assist-collapse :deep(.el-collapse-item__content) {
  padding-bottom: 0;
}

.table-scroll-wrap {
  overflow-x: auto;
  max-width: 100%;
  -webkit-overflow-scrolling: touch;
}

.order-pool-tab {
  min-width: 0;
}

.order-pool-tab__label {
  min-width: 0;
  white-space: normal;
  word-break: break-word;
  line-height: 1.25;
}

.order-pool-tab__count {
  flex-shrink: 0;
}

.order-workbench-root :deep(.el-button) {
  max-width: 100%;
}

.order-workbench-root :deep(.el-button > span) {
  white-space: nowrap;
  word-break: normal;
  text-align: center;
}

.search-action-button {
  min-width: 88px;
}

.order-workbench-root :deep(.el-input__wrapper),
.order-workbench-root :deep(.el-select__wrapper) {
  max-width: 100%;
}

.order-card--new {
  border-color: rgba(251, 146, 60, 0.48);
  box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.22);
  animation: new-order-pulse 0.9s ease-in-out infinite;
}

.new-order-notice-enter-active,
.new-order-notice-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.new-order-notice-enter-from,
.new-order-notice-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@keyframes new-order-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.28);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(251, 191, 36, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(251, 191, 36, 0);
  }
}

@media (max-width: 767px) {
  .order-workbench-root {
    gap: 12px;
  }

  .order-workbench-root > section {
    min-width: 0;
    border-radius: 20px;
    padding: 16px;
  }

  .order-workbench-root :deep(.el-switch),
  .order-workbench-root :deep(.el-select),
  .poll-interval-select {
    width: 100%;
  }

  .order-workbench-root :deep(.el-button) {
    min-height: 42px;
    padding-left: 12px;
    padding-right: 12px;
  }

  .order-workbench-root :deep(.el-button > span) {
    white-space: normal;
    word-break: break-word;
  }

  .table-scroll-wrap :deep(.el-table) {
    min-width: 520px;
  }
}
</style>
