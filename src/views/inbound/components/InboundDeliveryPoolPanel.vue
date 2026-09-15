<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/components/InboundDeliveryPoolPanel.vue
 * 文件职责：为库管提供送货单池，实时查看供货方已提交的待入库与已入库单据，并跳转到扫码页完成入库。
 * 实现逻辑：
 * - 分栏（全部/待入库/已入库）、关键词与分页全部由服务端计算，标签上的数量取服务端 poolCounts，不在前端重算；
 * - 列表与详情请求都走稳定请求工具，快速切换分栏或连点单据时旧响应不会覆盖新状态；
 * - 默认 15 秒轮询：页面不可见、列表或详情加载中时跳过本轮，避免后台请求抢占前台交互；
 * - 服务端返回的 latestOrderId 作为下一次轮询基准，newOrderCount 用于提示供货方新提交的送货单。
 * 维护说明：
 * - 分栏计数、分页与排序口径必须继续以服务端为准，不要改成前端按当前页统计；
 * - “去入库”只负责把单号交回扫码页，入库动作仍由扫码页的既有核销链路执行，不在本面板直接调用核销接口。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import dayjs from 'dayjs'

import { BizResponsiveDrawerShell, PagePaginationBar, PassiveSegmentedTabs } from '@/components/common'
import {
  getInboundAdminPool,
  getInboundDetail,
  type InboundOrder,
  type InboundOrderDetail,
  type InboundOrderPoolKey,
} from '@/api/modules/inbound'
import { useDevice } from '@/composables/useDevice'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'
import { showAppError, showAppInfo } from '@/utils/app-alert'

const emit = defineEmits<{
  (event: 'verify', showNo: string): void
}>()

const POOL_REFRESH_INTERVAL_MS = 15 * 1000

const { isPhone } = useDevice()
const listRequest = useStableRequest()
const detailRequest = useStableRequest()

const activePool = ref<InboundOrderPoolKey>('pending')
const keyword = ref('')
const page = ref(1)
const pageSize = ref(10)
const total = ref(0)
const records = ref<InboundOrder[]>([])
const poolCounts = ref<Record<InboundOrderPoolKey, number>>({ all: 0, pending: 0, verified: 0 })
const latestOrderId = ref<string | null>(null)
const listLoading = ref(false)
const detailLoading = ref(false)
const activeOrderId = ref('')
const activeDetail = ref<InboundOrderDetail | null>(null)
const detailDrawerVisible = ref(false)
const lastLoadedAt = ref<Date | null>(null)

let refreshTimer: ReturnType<typeof globalThis.setInterval> | null = null

const poolTabs = computed(() => [
  { label: `全部 ${poolCounts.value.all}`, name: 'all' as const },
  { label: `待入库 ${poolCounts.value.pending}`, name: 'pending' as const },
  { label: `已入库 ${poolCounts.value.verified}`, name: 'verified' as const },
])

const statusMeta: Record<InboundOrder['status'], { label: string; type: 'warning' | 'success' | 'info' }> = {
  pending: { label: '待入库', type: 'warning' },
  verified: { label: '已入库', type: 'success' },
  cancelled: { label: '已撤销', type: 'info' },
}

const formatDateTime = (value: string | null | undefined, fallback = '未填写') => (
  value ? dayjs(value).format('YYYY-MM-DD HH:mm') : fallback
)

const loadPool = async (options: { silent?: boolean } = {}) => {
  if (!options.silent) {
    listLoading.value = true
  }
  await listRequest.runLatest({
    executor: (signal) => getInboundAdminPool({
      pool: activePool.value,
      keyword: keyword.value.trim() || undefined,
      page: page.value,
      pageSize: pageSize.value,
      sinceOrderId: options.silent && latestOrderId.value ? latestOrderId.value : undefined,
    }, { signal }),
    onSuccess: (result) => {
      records.value = result.records
      total.value = result.total
      page.value = result.page
      poolCounts.value = result.poolCounts
      lastLoadedAt.value = new Date()
      if (options.silent && result.newOrderCount > 0) {
        showAppInfo(`供货方新提交了 ${result.newOrderCount} 张送货单`)
      }
      latestOrderId.value = result.latestOrderId
    },
    onError: (error) => {
      if (!options.silent) {
        showAppError(extractErrorMessage(error, '获取送货单池失败'))
      }
    },
    onFinally: () => {
      listLoading.value = false
    },
  })
}

const loadDetail = async (order: InboundOrder) => {
  activeOrderId.value = order.id
  if (isPhone.value) {
    detailDrawerVisible.value = true
  }
  detailLoading.value = true
  await detailRequest.runLatest({
    executor: (signal) => getInboundDetail(order.showNo, { signal }),
    onSuccess: (result) => {
      activeDetail.value = result
    },
    onError: (error) => {
      activeDetail.value = null
      showAppError(extractErrorMessage(error, '获取送货单详情失败'))
    },
    onFinally: () => {
      detailLoading.value = false
    },
  })
}

const handlePoolChange = () => {
  page.value = 1
  void loadPool()
}

const handleSearch = () => {
  page.value = 1
  void loadPool()
}

const handlePageChange = () => {
  void loadPool()
}

const handleVerify = (order: InboundOrder) => {
  emit('verify', order.showNo)
}

const stopAutoRefresh = () => {
  if (refreshTimer === null) {
    return
  }
  globalThis.clearInterval(refreshTimer)
  refreshTimer = null
}

const startAutoRefresh = () => {
  stopAutoRefresh()
  refreshTimer = globalThis.setInterval(() => {
    if (globalThis.document?.visibilityState === 'hidden' || listLoading.value || detailLoading.value) {
      return
    }
    void loadPool({ silent: true })
  }, POOL_REFRESH_INTERVAL_MS)
}

const handleVisibilityChange = () => {
  if (globalThis.document?.visibilityState === 'hidden') {
    return
  }
  if (!listLoading.value && !detailLoading.value) {
    void loadPool({ silent: true })
  }
}

onMounted(() => {
  void loadPool()
  startAutoRefresh()
  globalThis.document?.addEventListener('visibilitychange', handleVisibilityChange)
})

onBeforeUnmount(() => {
  stopAutoRefresh()
  globalThis.document?.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<template>
  <div class="inbound-pool grid gap-4 xl:grid-cols-[26rem_minmax(0,1fr)]">
    <section class="min-w-0 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <PassiveSegmentedTabs v-model="activePool" :tabs="poolTabs" aria-label="送货单池分栏" @tab-change="handlePoolChange" />

      <div class="mt-3 flex items-center gap-2">
        <el-input v-model="keyword" placeholder="按送货单号或供货方搜索" clearable @keyup.enter="handleSearch" @clear="handleSearch" />
        <el-button type="primary" :loading="listLoading" @click="handleSearch">查询</el-button>
      </div>
      <p class="mt-2 text-xs text-slate-400 dark:text-slate-500">
        每 15 秒自动刷新{{ lastLoadedAt ? `，最近同步 ${dayjs(lastLoadedAt).format('HH:mm:ss')}` : '' }}
      </p>

      <div v-loading="listLoading" class="mt-3 space-y-2">
        <button
          v-for="order in records"
          :key="order.id"
          type="button"
          class="inbound-pool__item w-full rounded-xl border px-3 py-2.5 text-left transition"
          :class="
            activeOrderId === order.id
              ? 'border-teal-300 bg-teal-50/70 dark:border-teal-700 dark:bg-teal-950/30'
              : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800'
          "
          @click="loadDetail(order)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="truncate font-semibold text-slate-800 dark:text-slate-100">{{ order.showNo }}</span>
            <el-tag :type="statusMeta[order.status].type" size="small" effect="light" round>
              {{ statusMeta[order.status].label }}
            </el-tag>
          </div>
          <p class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">供货方：{{ order.supplierName || '-' }}</p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            预计送达：{{ formatDateTime(order.expectedArrivalAt) }} · 共 {{ Number(order.totalQty) }} 件
          </p>
        </button>
        <div v-if="!listLoading && !records.length" class="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400 dark:border-slate-700">
          当前分栏暂无送货单
        </div>
      </div>

      <PagePaginationBar
        v-if="total > 0"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        layout="total, prev, next"
        :page-sizes="[10, 20, 50]"
        :total="total"
        @current-change="handlePageChange"
        @size-change="handlePageChange"
      />
    </section>

    <section v-if="!isPhone" class="min-w-0 rounded-2xl border border-slate-100 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div v-loading="detailLoading" class="min-h-[240px]">
        <template v-if="activeDetail">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-lg font-semibold text-slate-900 dark:text-slate-100">{{ activeDetail.order.showNo }}</p>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                创建于 {{ formatDateTime(activeDetail.order.createdAt, '-') }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <el-tag :type="statusMeta[activeDetail.order.status].type" effect="light" round>
                {{ statusMeta[activeDetail.order.status].label }}
              </el-tag>
              <el-button
                v-if="activeDetail.order.status === 'pending'"
                type="primary"
                @click="handleVerify(activeDetail.order)"
              >
                去入库
              </el-button>
            </div>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
              <p class="text-xs text-slate-500 dark:text-slate-400">预计送达时间</p>
              <p class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ formatDateTime(activeDetail.order.expectedArrivalAt) }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
              <p class="text-xs text-slate-500 dark:text-slate-400">总件数</p>
              <p class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ Number(activeDetail.order.totalQty) }} 件</p>
            </div>
            <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
              <p class="text-xs text-slate-500 dark:text-slate-400">供货方</p>
              <p class="mt-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{{ activeDetail.order.supplierName || '-' }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
              <p class="text-xs text-slate-500 dark:text-slate-400">入库时间</p>
              <p class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ formatDateTime(activeDetail.order.verifiedAt, '尚未入库') }}</p>
            </div>
          </div>

          <div class="mt-4 rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <p class="text-xs text-slate-500 dark:text-slate-400">备注</p>
            <p class="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">{{ activeDetail.order.remark || '未填写备注' }}</p>
          </div>

          <el-table native-scrollbar :data="activeDetail.items" stripe class="mt-4 w-full" table-layout="auto">
            <el-table-column prop="productNameSnapshot" label="商品" min-width="180" show-overflow-tooltip />
            <el-table-column label="规格" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">{{ row.sku?.specText || '默认规格' }}</template>
            </el-table-column>
            <el-table-column label="数量" width="100" align="right">
              <template #default="{ row }">{{ Number(row.qty) }}</template>
            </el-table-column>
          </el-table>
        </template>
        <div v-else-if="!detailLoading" class="flex min-h-[240px] items-center justify-center">
          <el-empty :image-size="120" description="请选择左侧送货单查看明细" />
        </div>
      </div>
    </section>

    <BizResponsiveDrawerShell
      v-if="isPhone"
      v-model="detailDrawerVisible"
      title="送货单详情"
      height-mode="scroll"
      phone-size="92%"
      :loading="detailLoading"
    >
      <div v-if="activeDetail" class="space-y-3">
        <div class="flex items-center justify-between gap-2">
          <p class="text-base font-semibold text-slate-900 dark:text-slate-100">{{ activeDetail.order.showNo }}</p>
          <el-tag :type="statusMeta[activeDetail.order.status].type" size="small" effect="light" round>
            {{ statusMeta[activeDetail.order.status].label }}
          </el-tag>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <p class="text-xs text-slate-500 dark:text-slate-400">预计送达</p>
            <p class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ formatDateTime(activeDetail.order.expectedArrivalAt) }}</p>
          </div>
          <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <p class="text-xs text-slate-500 dark:text-slate-400">总件数</p>
            <p class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ Number(activeDetail.order.totalQty) }} 件</p>
          </div>
          <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <p class="text-xs text-slate-500 dark:text-slate-400">供货方</p>
            <p class="mt-1 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{{ activeDetail.order.supplierName || '-' }}</p>
          </div>
          <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
            <p class="text-xs text-slate-500 dark:text-slate-400">入库时间</p>
            <p class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ formatDateTime(activeDetail.order.verifiedAt, '尚未入库') }}</p>
          </div>
        </div>
        <div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/40">
          <p class="text-xs text-slate-500 dark:text-slate-400">备注</p>
          <p class="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">{{ activeDetail.order.remark || '未填写备注' }}</p>
        </div>
        <div v-for="item in activeDetail.items" :key="item.id" class="rounded-xl border border-slate-100 px-3 py-2 dark:border-slate-700">
          <p class="text-sm font-medium text-slate-800 dark:text-slate-100">{{ item.productNameSnapshot }}</p>
          <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{{ item.sku?.specText || '默认规格' }} · {{ Number(item.qty) }} 件</p>
        </div>
        <el-button
          v-if="activeDetail.order.status === 'pending'"
          type="primary"
          class="w-full"
          @click="handleVerify(activeDetail.order)"
        >
          去入库
        </el-button>
      </div>
    </BizResponsiveDrawerShell>
  </div>
</template>

<style scoped>
.inbound-pool__item {
  min-width: 0;
}
</style>
