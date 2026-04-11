<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientOrdersView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, onMounted, ref } from 'vue'
import { getMyO2oPreorders, type O2oPreorderSummary } from '@/api/modules/o2o'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import {
  CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG,
  CLIENT_O2O_ORDER_STATUS_CLASS_MAP,
  getClientOrderReportScenario,
  O2O_ORDER_STATUS_TABS,
} from '@/constants/o2o-order-status'
import { useClientOrderStore } from '@/store'
import { normalizeRequestError } from '@/utils/error'

const loading = ref(false)
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const clientOrderStore = useClientOrderStore()
const { runLatest } = useStableRequest()
clientOrderStore.initialize()

const orders = computed(() => clientOrderStore.orders)
const keyword = ref('')
const activeStatus = computed({
  get: () => clientOrderStore.activeStatus,
  set: (value: 'all' | O2oPreorderSummary['status']) => clientOrderStore.setActiveStatus(value),
})

const filteredOrders = computed(() => {
  const normalizedKeyword = keyword.value.trim().toLowerCase()
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
  const scenario = order.statusReport?.scenario ?? getClientOrderReportScenario(order.status, order.timeoutAt)
  return CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[scenario]
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

const loadOrders = async (force = false) => {
  if (!force && clientOrderStore.orders.length > 0 && clientOrderStore.isFresh) {
    requestError.value = null
    return
  }
  loading.value = clientOrderStore.orders.length === 0
  requestError.value = null
  await runLatest({
    executor: (signal) => getMyO2oPreorders({ signal }),
    onSuccess: (result) => {
      clientOrderStore.setOrders(result)
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '订单加载失败')
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
        <button class="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600" @click="loadOrders(true)">
          刷新订单
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
          v-model.trim="keyword"
          class="h-10 flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-slate-300"
          placeholder="搜索订单号或核销码"
        />
        <button type="button" class="h-10 rounded-full border border-slate-200 px-4 text-sm text-slate-600" @click="keyword = ''">清空</button>
      </div>
    </div>

    <div v-if="loading" class="grid gap-3 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
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
      :description="keyword ? '未匹配到符合关键词的订单，请调整关键词后重试' : '当前筛选下没有订单记录'"
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
            <router-link :to="`/client/orders/${order.id}`" class="rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white">详情</router-link>
          </div>
        </div>
        <div class="mt-3 rounded-2xl px-3 py-2" :class="getOrderStatusReport(order).cardClassName">
          <p class="text-sm font-semibold">{{ getOrderStatusReport(order).cardTitle }}</p>
          <p class="mt-1 text-xs">{{ getOrderStatusReport(order).cardDescription }}</p>
        </div>
      </article>
    </div>
  </section>
</template>
