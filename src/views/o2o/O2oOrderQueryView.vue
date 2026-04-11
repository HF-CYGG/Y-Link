<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { PageContainer } from '@/components/common'
import {
  CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG,
  getClientOrderReportScenario,
  O2O_ORDER_STATUS_TABS,
  type O2oOrderStatus,
} from '@/constants/o2o-order-status'
import {
  getO2oConsoleOrderDetail,
  getO2oConsoleOrders,
  type O2oPreorderDetail,
  type O2oPreorderSummary,
} from '@/api/modules/o2o'

const listLoading = ref(false)
const detailLoading = ref(false)
const orders = ref<O2oPreorderSummary[]>([])
const activeOrderId = ref('')
const activeOrderDetail = ref<O2oPreorderDetail | null>(null)
const autoRefreshEnabled = ref(true)
let autoRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null

const query = reactive({
  status: 'all' as 'all' | O2oOrderStatus,
  keyword: '',
})

const filteredOrders = computed(() => {
  const keyword = query.keyword.trim().toLowerCase()
  return orders.value.filter((item) => {
    if (query.status !== 'all' && item.status !== query.status) {
      return false
    }
    if (!keyword) {
      return true
    }
    return `${item.showNo} ${item.verifyCode}`.toLowerCase().includes(keyword)
  })
})

const activeScenario = computed(() => {
  if (!activeOrderDetail.value) {
    return 'pending'
  }
  return activeOrderDetail.value.order.statusReport?.scenario
    ?? getClientOrderReportScenario(activeOrderDetail.value.order.status, activeOrderDetail.value.order.timeoutAt)
})

const reportConfig = computed(() => CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[activeScenario.value])

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

const syncActiveOrder = async () => {
  const exists = filteredOrders.value.find((item) => item.id === activeOrderId.value)
  if (exists) {
    await loadOrderDetail(activeOrderId.value)
    return
  }
  const first = filteredOrders.value[0]
  activeOrderId.value = first?.id ?? ''
  await loadOrderDetail(activeOrderId.value)
}

const loadOrders = async (silent = false) => {
  if (!silent) {
    listLoading.value = true
  }
  try {
    orders.value = await getO2oConsoleOrders({
      status: query.status === 'all' ? undefined : query.status,
      keyword: query.keyword.trim() || undefined,
      limit: 100,
    })
    await syncActiveOrder()
  } finally {
    listLoading.value = false
  }
}

const handlePickOrder = async (id: string) => {
  activeOrderId.value = id
  await loadOrderDetail(id)
}

const handleStatusChange = async (status: 'all' | O2oOrderStatus) => {
  query.status = status
  await loadOrders()
}

const handleSearch = async () => {
  await loadOrders()
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
  }, 15000)
}

const toggleAutoRefresh = () => {
  autoRefreshEnabled.value = !autoRefreshEnabled.value
  scheduleAutoRefresh()
  ElMessage.success(autoRefreshEnabled.value ? '已开启实时刷新' : '已关闭实时刷新')
}

onMounted(async () => {
  await loadOrders()
  scheduleAutoRefresh()
})

onBeforeUnmount(() => {
  if (autoRefreshTimer !== null) {
    globalThis.clearInterval(autoRefreshTimer)
    autoRefreshTimer = null
  }
})
</script>

<template>
  <PageContainer title="订单查询" description="可分类查询已预订订单，并实时查看订单状态与进度报告">
    <div class="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-2">
          <p class="text-lg font-semibold text-slate-900">订单筛选</p>
          <el-button size="small" @click="toggleAutoRefresh">
            {{ autoRefreshEnabled ? '实时刷新中' : '开启实时刷新' }}
          </el-button>
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
          <button
            v-for="tab in O2O_ORDER_STATUS_TABS"
            :key="tab.key"
            type="button"
            class="rounded-full px-3 py-1.5 text-xs"
            :class="query.status === tab.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'"
            @click="handleStatusChange(tab.key as 'all' | O2oOrderStatus)"
          >
            {{ tab.label }}
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

        <div class="mt-4 space-y-2">
          <button
            v-for="order in filteredOrders"
            :key="order.id"
            type="button"
            class="w-full rounded-2xl border px-3 py-2 text-left transition"
            :class="activeOrderId === order.id ? 'border-teal-200 bg-teal-50' : 'border-slate-100 bg-white hover:bg-slate-50'"
            @click="handlePickOrder(order.id)"
          >
            <p class="text-sm font-semibold text-slate-900">{{ order.showNo }}</p>
            <p class="mt-1 text-xs text-slate-500">{{ CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[order.statusReport?.scenario ?? 'pending'].statusLabel }}</p>
            <p class="mt-1 text-xs text-slate-400">下单：{{ order.createdAt }}</p>
          </button>
          <div v-if="!listLoading && !filteredOrders.length" class="rounded-2xl border border-dashed border-slate-200 px-3 py-8 text-center text-sm text-slate-400">
            当前筛选条件下暂无订单
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
            <el-button @click="loadOrders(true)">刷新状态</el-button>
          </div>

          <div class="mt-4 rounded-2xl px-4 py-3" :class="reportConfig.cardClassName">
            <p class="text-sm font-semibold">{{ reportConfig.cardTitle }}</p>
            <p class="mt-1 text-xs">{{ reportConfig.cardDescription }}</p>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-3">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">状态</p>
              <p class="mt-1 text-sm font-semibold text-slate-900">{{ reportConfig.statusLabel }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总件数</p>
              <p class="mt-1 text-sm font-semibold text-slate-900">{{ activeOrderDetail.order.totalQty }} 件</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">创建时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ activeOrderDetail.order.createdAt }}</p>
            </div>
          </div>

          <div class="mt-4 space-y-2">
            <p class="text-base font-semibold text-slate-900">订单进度</p>
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

          <el-table class="mt-4" :data="activeOrderDetail.items" row-key="id" :loading="detailLoading">
            <el-table-column prop="productName" label="商品名称" min-width="180" />
            <el-table-column prop="defaultPrice" label="单价" width="110">
              <template #default="{ row }">
                <span>¥{{ Number(row.defaultPrice || 0).toFixed(2) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="qty" label="数量" width="90" align="right" />
          </el-table>
        </template>

        <div v-else class="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm text-slate-400">
          {{ listLoading ? '订单加载中...' : '请选择左侧订单查看状态与进度' }}
        </div>
      </section>
    </div>
  </PageContainer>
</template>
