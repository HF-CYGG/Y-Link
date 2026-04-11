<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { PageContainer } from '@/components/common'
import {
  CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG,
  getClientOrderReportScenario,
  type O2oOrderStatus,
} from '@/constants/o2o-order-status'
import {
  getO2oConsoleOrderDetail,
  getO2oConsoleOrders,
  type O2oPreorderDetail,
  type O2oPreorderSummary,
  type O2oOrderStatusReport,
} from '@/api/modules/o2o'

type OrderPoolKey = 'new' | 'pending' | 'timeout_soon' | 'completed' | 'cancelled'

const ORDER_POOL_TABS: Array<{ key: OrderPoolKey; label: string }> = [
  { key: 'new', label: '新订单' },
  { key: 'pending', label: '待核销' },
  { key: 'timeout_soon', label: '临近超时' },
  { key: 'completed', label: '已完成' },
  { key: 'cancelled', label: '已取消' },
]

const NEW_ORDER_WINDOW_MS = 30 * 60 * 1000
const NEW_ORDER_HIGHLIGHT_MS = 6000
const POLL_INTERVAL_OPTIONS = [10, 15] as const
const listLoading = ref(false)
const detailLoading = ref(false)
const orders = ref<O2oPreorderSummary[]>([])
const activePool = ref<OrderPoolKey>('new')
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

const formatCurrency = (value: string | number | null | undefined) => {
  return Number(value ?? 0).toFixed(2)
}

const parseTimeMs = (value: string | null | undefined) => {
  if (!value) {
    return 0
  }
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

const resolveOrderSortTimestamp = (order: O2oPreorderSummary) => {
  return parseTimeMs(order.createdAt) || parseTimeMs(order.timeoutAt)
}

const getOrderScenario = (order: { statusReport?: O2oOrderStatusReport; status: O2oOrderStatus; timeoutAt: string | null }) => {
  return order.statusReport?.scenario ?? getClientOrderReportScenario(order.status, order.timeoutAt, nowMs.value)
}

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
  if (scenario === 'timeout_soon') {
    return 'timeout_soon'
  }
  if (isNewOrder(order)) {
    return 'new'
  }
  return 'pending'
}

const poolCountMap = computed(() => {
  const map: Record<OrderPoolKey, number> = {
    new: 0,
    pending: 0,
    timeout_soon: 0,
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
    new: [],
    pending: [],
    timeout_soon: [],
    completed: [],
    cancelled: [],
  }
  for (const order of orders.value) {
    map[resolvePoolKey(order)].push(order)
  }
  for (const tab of ORDER_POOL_TABS) {
    map[tab.key] = map[tab.key].slice().sort((prev, next) => {
      const highlightDiff = Number(isOrderHighlighted(next.id)) - Number(isOrderHighlighted(prev.id))
      if (highlightDiff !== 0) {
        return highlightDiff
      }
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

const reportConfig = computed(() => CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[activeScenario.value])

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

const timelineItems = computed(() => {
  if (!activeOrderDetail.value) {
    return []
  }
  const order = activeOrderDetail.value.order
  if (activeScenario.value === 'verified') {
    return [
      { key: 'created', title: '已下单', time: order.createdAt, active: true },
      { key: 'prepare', title: '备货完成', time: order.timeoutAt || '门店已备货', active: true },
      { key: 'verify', title: '已核销', time: order.verifiedAt || '核销成功', active: true },
      { key: 'done', title: '订单完成', time: order.verifiedAt || '已完成', active: true },
    ]
  }
  if (activeScenario.value === 'cancelled' || activeScenario.value === 'timeout_cancelled') {
    return [
      { key: 'created', title: '已下单', time: order.createdAt, active: true },
      { key: 'prepare', title: '备货中', time: order.timeoutAt || '门店处理中', active: true },
      { key: 'cancel', title: reportConfig.value.timelineCurrentTitle, time: order.timeoutAt || '已取消', active: true },
      { key: 'closed', title: '订单关闭', time: reportConfig.value.timelineCurrentHint, active: true },
    ]
  }
  return [
    { key: 'created', title: '已下单', time: order.createdAt, active: true },
    { key: 'prepare', title: '备货中', time: order.timeoutAt || '按门店通知准备', active: true },
    { key: 'pending', title: reportConfig.value.timelineCurrentTitle, time: order.timeoutAt || '待完成', active: true },
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
    void reminderAudioContext.resume()
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
    const firstNonEmptyPool = ORDER_POOL_TABS.find((tab) => poolOrderMap.value[tab.key].length > 0)
    if (firstNonEmptyPool) {
      activePool.value = firstNonEmptyPool.key
    }
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
      const incrementalNewOrders = latestOrders.filter((item) => !previousOrderIds.has(item.id) && resolvePoolKey(item) === 'new')
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
  if (reminderAudioContext) {
    void reminderAudioContext.close()
    reminderAudioContext = null
  }
})
</script>

<template>
  <PageContainer title="订单池工作台" description="左侧订单池实时分栏，右侧工作台查看状态报告、商品明细、金额汇总与进度节点">
    <div class="grid gap-4 xl:grid-cols-[26rem_minmax(0,1fr)]">
      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-lg font-semibold text-slate-900">订单池</p>
          <div class="flex flex-wrap items-center gap-2">
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
              class="w-28"
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

        <div class="mt-3 grid grid-cols-2 gap-2">
          <button
            v-for="tab in ORDER_POOL_TABS"
            :key="tab.key"
            type="button"
            class="flex items-center justify-between rounded-2xl px-3 py-2 text-left text-xs transition"
            :class="activePool === tab.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'"
            @click="handlePoolChange(tab.key)"
          >
            <span>{{ tab.label }}</span>
            <span class="rounded-full px-2 py-0.5 text-[11px]" :class="activePool === tab.key ? 'bg-white/20 text-white' : 'bg-white text-slate-500'">
              {{ poolCountMap[tab.key] }}
            </span>
          </button>
        </div>

        <div class="mt-3 flex items-center gap-2">
          <el-input
            v-model.trim="query.keyword"
            placeholder="搜索订单号或核销码"
            clearable
            @keyup.enter="handleSearch"
          />
          <el-button type="primary" @click="handleSearch">查询</el-button>
        </div>

        <Transition name="new-order-notice">
          <div v-if="activeNewOrderNotice" class="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            <div class="flex items-center justify-between gap-2">
              <p>新单提醒：新增 {{ activeNewOrderNotice.count }} 笔，已自动置顶并高亮 6 秒</p>
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
            <div class="flex items-start justify-between gap-2">
              <p class="text-sm font-semibold text-slate-900">{{ order.showNo }}</p>
              <span class="rounded-full px-2 py-0.5 text-[11px] font-medium" :class="CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[getOrderScenario(order)].cardClassName">
                {{ CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[getOrderScenario(order)].statusLabel }}
              </span>
            </div>
            <div class="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-500">
              <p>时间：{{ order.createdAt }}</p>
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

      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <template v-if="activeOrderDetail">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-lg font-semibold text-slate-900">{{ activeOrderDetail.order.showNo }}</p>
              <p class="mt-1 text-sm text-slate-400">核销码：{{ activeOrderDetail.order.verifyCode }}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <el-button type="primary" plain @click="handleGoVerify">去核销</el-button>
              <el-button :loading="detailLoading" @click="handleRefreshCurrentOrder">刷新状态</el-button>
              <el-button @click="handleCopyVerifyCode">复制核销码</el-button>
            </div>
          </div>

          <div class="mt-4 rounded-2xl px-4 py-3" :class="reportConfig.cardClassName">
            <p class="text-sm font-semibold">状态报告：{{ reportConfig.cardTitle }}</p>
            <p class="mt-1 text-xs">{{ reportConfig.cardDescription }}</p>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-4">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">状态</p>
              <p class="mt-1 text-sm font-semibold text-slate-900">{{ reportConfig.statusLabel }}</p>
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
                <p class="text-xs text-slate-500">{{ step.time }}</p>
              </div>
            </div>
          </div>

          <div class="mt-4">
            <p class="mb-2 text-base font-semibold text-slate-900">商品明细</p>
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
        </template>

        <div v-else class="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm text-slate-400">
          {{ listLoading ? '订单加载中...' : '请选择左侧订单查看状态报告与进度节点' }}
        </div>
      </section>
    </div>
  </PageContainer>
</template>

<style scoped>
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
</style>
