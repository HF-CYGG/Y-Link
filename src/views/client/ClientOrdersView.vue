<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientOrdersView.vue
 * 文件职责：承载客户端“我的订单”列表展示、筛选、查询防抖与刷新反馈能力。
 * 维护说明：本文件重点治理“输入触发策略 + 请求最新生效 + 加载反馈节奏”，减少移动端抖动。
 */


import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { cancelMyO2oPreorder, getMyO2oPreorders, type O2oPreorderDetail, type O2oPreorderSummary } from '@/api/modules/o2o'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import {
  CLIENT_O2O_ORDER_STATUS_CLASS_MAP,
  getO2oOrderBusinessStatusMeta,
  getClientOrderStatusReportConfig,
  getClientOrderReportScenario,
  O2O_ORDER_STATUS_TABS,
} from '@/constants/o2o-order-status'
import { useClientOrderStore } from '@/store'
import { normalizeRequestError } from '@/utils/error'

// 关键词防抖窗口：连续输入时只在停顿后更新筛选词，避免每次按键都触发大列表过滤。
const KEYWORD_DEBOUNCE_MS = 260
const firstScreenLoading = ref(false)
const refreshing = ref(false)
const recallingOrderId = ref('')
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const clientOrderStore = useClientOrderStore()
const { runLatest } = useStableRequest()
clientOrderStore.initialize()

const orders = computed(() => clientOrderStore.orders)
const keywordInput = ref('')
const effectiveKeyword = ref('')
const keywordDebounceTimer = ref<ReturnType<typeof globalThis.setTimeout> | null>(null)
const keywordDebouncing = ref(false)
const activeStatus = computed({
  get: () => clientOrderStore.activeStatus,
  set: (value: 'all' | O2oPreorderSummary['status']) => clientOrderStore.setActiveStatus(value),
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

const filteredOrders = computed(() => {
  const normalizedKeyword = effectiveKeyword.value.toLowerCase()
  return orders.value.filter((order) => {
    if (activeStatus.value !== 'all' && order.status !== activeStatus.value) {
      return false
    }
    if (!normalizedKeyword) {
      return true
    }
    const searchText = `${order.showNo} ${order.verifyCode}`.toLowerCase()
    return searchText.includes(normalizedKeyword)
  })
})

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
  activeStatus.value = value
}

const buildOrderSummaryFromDetail = (detail: O2oPreorderDetail): O2oPreorderSummary => {
  const { order } = detail
  return {
    id: order.id,
    showNo: order.showNo,
    verifyCode: order.verifyCode,
    status: order.status,
    businessStatus: order.businessStatus,
    merchantMessage: order.merchantMessage,
    statusReport: order.statusReport,
    totalAmount: order.totalAmount,
    expireInSeconds: order.expireInSeconds,
    totalQty: order.totalQty,
    timeoutAt: order.timeoutAt,
    createdAt: order.createdAt,
  }
}

const getBusinessStatusMeta = (order: O2oPreorderSummary) => {
  return getO2oOrderBusinessStatusMeta(order.businessStatus)
}

const loadOrders = async (force = false) => {
  if (!force && clientOrderStore.orders.length > 0 && clientOrderStore.isFresh) {
    requestError.value = null
    return
  }
  const hasCachedOrders = clientOrderStore.orders.length > 0
  firstScreenLoading.value = !hasCachedOrders
  refreshing.value = hasCachedOrders
  requestError.value = null
  await runLatest({
    executor: (signal) =>
      getMyO2oPreorders(
        {
          page: 1,
          pageSize: 50,
        },
        { signal },
      ),
    onSuccess: (result) => {
      clientOrderStore.setOrders(result.records)
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '订单加载失败')
      if (hasCachedOrders) {
        // 已有列表时不切到整页错误态，避免“刷新失败导致内容闪退”。
        ElMessage.warning(`订单刷新失败：${normalizedError.message}`)
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
    },
  })
}

const clearKeyword = () => {
  if (keywordDebounceTimer.value !== null) {
    globalThis.clearTimeout(keywordDebounceTimer.value)
    keywordDebounceTimer.value = null
  }
  keywordInput.value = ''
  effectiveKeyword.value = ''
  keywordDebouncing.value = false
}

// 详细注释：执行撤回订单，二次确认后请求撤回，并更新 Store 中的订单状态。
const handleRecallOrder = async (order: O2oPreorderSummary) => {
  if (order.status !== 'pending') {
    ElMessage.warning('当前订单状态不可撤回')
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
    ElMessage.error('撤回确认失败，请稍后重试')
    return
  }

  recallingOrderId.value = order.id
  try {
    const detail = await cancelMyO2oPreorder(order.id)
    clientOrderStore.upsertOrder(buildOrderSummaryFromDetail(detail))
    ElMessage.success('订单已撤回')
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '撤回订单失败')
    ElMessage.error(normalizedError.message)
  } finally {
    recallingOrderId.value = ''
  }
}

onMounted(async () => {
  await loadOrders()
})
</script>

<template>
  <section class="space-y-4 pb-20">
    <div class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-xl font-semibold text-slate-900">我的订单</p>
          <p class="text-sm text-slate-500">查看待提货、已核销与已取消订单</p>
        </div>
        <button
          class="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="refreshing"
          @click="loadOrders(true)"
        >
          {{ refreshing ? '刷新中...' : '刷新订单' }}
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
          placeholder="搜索订单号或核销码"
        />
        <button type="button" class="h-10 rounded-full border border-slate-200 px-4 text-sm text-slate-600" @click="clearKeyword">清空</button>
      </div>
      <p v-if="keywordDebouncing || refreshing" class="mt-2 text-xs text-slate-400">
        {{ keywordDebouncing ? '正在更新关键词结果...' : '正在刷新订单，当前列表可继续浏览' }}
      </p>
    </div>

    <div v-if="firstScreenLoading" class="grid gap-3 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div v-for="index in 4" :key="index" class="h-[4.6rem] animate-pulse rounded-2xl bg-slate-100" />
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
      v-else-if="!filteredOrders.length"
      type="empty"
      title="暂无订单"
      :description="effectiveKeyword ? '未匹配到符合关键词的订单，请调整关键词后重试' : '当前筛选下没有订单记录'"
      action-text="刷新订单"
      @retry="loadOrders(true)"
    />

    <div v-else class="space-y-3">
      <article v-for="order in filteredOrders" :key="order.id" class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="text-base font-semibold text-slate-900">{{ order.showNo }}</p>
            <p class="mt-1 text-xs text-slate-400">下单时间：{{ order.createdAt }}</p>
            <p v-if="order.timeoutAt" class="mt-1 text-xs text-slate-400">超时释放：{{ order.timeoutAt }}</p>
          </div>
          <div class="flex items-center gap-2">
            <span class="rounded-full px-2.5 py-1 text-xs font-semibold" :class="getOrderStatusClassName(order)">
              {{ getOrderStatusReport(order).statusLabel }}
            </span>
            <button
              v-if="order.status === 'pending'"
              type="button"
              class="rounded-full border border-rose-200 px-3 py-1.5 text-xs text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              :disabled="recallingOrderId === order.id"
              @click="handleRecallOrder(order)"
            >
              {{ recallingOrderId === order.id ? '撤回中...' : '撤回订单' }}
            </button>
            <router-link :to="`/client/orders/${order.id}`" class="rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white">详情</router-link>
          </div>
        </div>
        <div class="mt-3 rounded-2xl px-3 py-2" :class="getOrderStatusReport(order).cardClassName">
          <p class="text-sm font-semibold">{{ getOrderStatusReport(order).cardTitle }}</p>
          <p class="mt-1 text-xs">{{ getOrderStatusReport(order).cardDescription }}</p>
        </div>
        <div
          v-if="getBusinessStatusMeta(order)"
          class="mt-3 rounded-2xl px-3 py-2"
          :class="getBusinessStatusMeta(order)?.className"
        >
          <p class="text-sm font-semibold">商家状态：{{ getBusinessStatusMeta(order)?.label }}</p>
          <p class="mt-1 text-xs">{{ getBusinessStatusMeta(order)?.clientDescription }}</p>
        </div>
      </article>
    </div>
  </section>
</template>
