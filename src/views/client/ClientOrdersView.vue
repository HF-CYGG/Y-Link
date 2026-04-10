<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getMyO2oPreorders, type O2oPreorderSummary } from '@/api/modules/o2o'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import { useClientOrderStore } from '@/store'
import { normalizeRequestError } from '@/utils/error'

const loading = ref(false)
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const clientOrderStore = useClientOrderStore()
const { runLatest } = useStableRequest()
clientOrderStore.initialize()

const orders = computed(() => clientOrderStore.orders)
const activeStatus = computed({
  get: () => clientOrderStore.activeStatus,
  set: (value: 'all' | O2oPreorderSummary['status']) => clientOrderStore.setActiveStatus(value),
})

const statusLabelMap: Record<O2oPreorderSummary['status'], string> = {
  pending: '待取货',
  verified: '已核销',
  cancelled: '已取消',
}

const statusClassMap: Record<O2oPreorderSummary['status'], string> = {
  pending: 'bg-amber-50 text-amber-600',
  verified: 'bg-emerald-50 text-emerald-600',
  cancelled: 'bg-slate-100 text-slate-500',
}

const filteredOrders = computed(() => {
  if (activeStatus.value === 'all') {
    return orders.value
  }
  return orders.value.filter((order) => order.status === activeStatus.value)
})

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
          v-for="tab in [{ key: 'all', label: '全部' }, { key: 'pending', label: '待提货' }, { key: 'verified', label: '已核销' }, { key: 'cancelled', label: '已取消' }]"
          :key="tab.key"
          type="button"
          class="rounded-full px-3 py-1.5 text-xs"
          :class="activeStatus === tab.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'"
          @click="handleStatusChange(tab.key as 'all' | O2oPreorderSummary['status'])"
        >
          {{ tab.label }}
        </button>
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
    <BaseRequestState v-else-if="!filteredOrders.length" type="empty" title="暂无订单" description="当前筛选下没有订单记录" action-text="刷新订单" @retry="loadOrders(true)" />

    <div v-else class="space-y-3">
      <article v-for="order in filteredOrders" :key="order.id" class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="text-base font-semibold text-slate-900">{{ order.showNo }}</p>
            <p class="mt-1 text-xs text-slate-400">下单时间：{{ order.createdAt }}</p>
            <p v-if="order.timeoutAt" class="mt-1 text-xs text-slate-400">超时释放：{{ order.timeoutAt }}</p>
          </div>
          <div class="flex items-center gap-2">
            <span class="rounded-full px-2.5 py-1 text-xs font-semibold" :class="statusClassMap[order.status]">
              {{ statusLabelMap[order.status] }}
            </span>
            <router-link :to="`/client/orders/${order.id}`" class="rounded-full bg-slate-900 px-3 py-1.5 text-xs text-white">详情</router-link>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
