<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientOrdersView.vue
 * 文件职责：承载客户端“我的订单”列表展示、服务端筛选查询、分页加载与刷新反馈能力。
 * 实现逻辑：
 * - 状态筛选与关键词查询统一走服务端接口，不再只对第一页缓存做本地过滤，避免遗漏更多历史订单；
 * - 订单列表支持“加载更多”，并把当前筛选条件、关键词、页码和已加载结果缓存到按账号隔离的 Store 中；
 * - 页面层继续使用 `useStableRequest` 保证只有最新一次查询结果生效，减少频繁切换筛选时的闪烁与覆盖。
 * 维护说明：
 * - 若后续新增列表查询条件，需要同步修改 `buildListQuery()`、Store 快照字段与空态文案；
 * - 订单撤回等会改变服务端筛选结果的操作，要优先考虑当前列表是否需要局部剔除或整页刷新。
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
import { useClientAuthStore, useClientOrderStore } from '@/store'
import { normalizeRequestError } from '@/utils/error'

const ORDER_TYPE_LABEL_MAP = {
  department: '部门订',
  walkin: '散客',
} as const
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
const firstScreenLoading = ref(false)
const refreshing = ref(false)
const loadingMore = ref(false)
const recallingOrderId = ref('')
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const clientAuthStore = useClientAuthStore()
const clientOrderStore = useClientOrderStore()
const { runLatest } = useStableRequest()
clientOrderStore.initialize(clientAuthStore.currentUser?.id)

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

const buildOrderSummaryFromDetail = (detail: O2oPreorderDetail): O2oPreorderSummary => {
  const { order } = detail
  const latestReturnRequest = detail.returnRequests
    .slice()
    .sort((prev, next) => new Date(next.createdAt).getTime() - new Date(prev.createdAt).getTime())[0] ?? null
  return {
    id: order.id,
    showNo: order.showNo,
    verifyCode: order.verifyCode,
    status: order.status,
    businessStatus: order.businessStatus,
    hasCustomerOrder: Boolean(order.hasCustomerOrder),
    isSystemApplied: order.isSystemApplied,
    merchantMessage: order.merchantMessage,
    clientOrderType: order.clientOrderType,
    departmentNameSnapshot: order.departmentNameSnapshot,
    returnRequestCount: detail.returnRequests.length,
    pendingReturnRequestCount: detail.returnRequests.filter((item) => item.status === 'pending').length,
    latestReturnRequest: latestReturnRequest
      ? {
          id: latestReturnRequest.id,
          returnNo: latestReturnRequest.returnNo,
          status: latestReturnRequest.status,
          createdAt: latestReturnRequest.createdAt,
          handledAt: latestReturnRequest.handledAt,
          rejectedReason: latestReturnRequest.rejectedReason,
        }
      : null,
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

const getLatestReturnRequestMeta = (order: O2oPreorderSummary) => {
  if (!order.latestReturnRequest) {
    return null
  }
  return RETURN_REQUEST_STATUS_META[order.latestReturnRequest.status]
}

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

const loadOrders = async (force = false, options?: { append?: boolean }) => {
  const append = options?.append === true
  if (!append && !force && clientOrderStore.orders.length > 0 && clientOrderStore.isFresh) {
    requestError.value = null
    return
  }
  const hasCachedOrders = clientOrderStore.orders.length > 0
  const targetPage = append ? clientOrderStore.page + 1 : 1
  firstScreenLoading.value = !hasCachedOrders && !append
  refreshing.value = hasCachedOrders && !append
  loadingMore.value = append
  if (!append) {
    requestError.value = null
  }
  await runLatest({
    executor: (signal) =>
      getMyO2oPreorders(
        buildListQuery(targetPage),
        { signal },
      ),
    onSuccess: (result) => {
      if (append) {
        clientOrderStore.appendOrders(result.records, {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
        })
        return
      }
      clientOrderStore.setOrders(result.records, {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
      })
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '订单加载失败')
      if (append) {
        ElMessage.warning(`加载更多失败：${normalizedError.message}`)
        return
      }
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
    // 撤回后订单可能不再属于当前筛选结果，这里主动以当前服务端查询条件刷新列表。
    await loadOrders(true)
    ElMessage.success('订单已撤回')
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '撤回订单失败')
    ElMessage.error(normalizedError.message)
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
  syncStoreWithCurrentUser()
  await loadOrders()
})
</script>

<template>
  <section class="space-y-4 pb-20">
    <div class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-xl font-semibold text-slate-900">我的订单</p>
          <p class="text-sm text-slate-500">查看待提货、已核销与已取消订单，并区分部门订与散客</p>
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
          placeholder="搜索订单号、核销码、部门或归属"
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
      <p v-if="orders.length" class="mt-2 text-xs text-slate-400">
        已加载 {{ orders.length }} 条，服务端共命中 {{ total }} 条订单
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
      v-else-if="!orders.length"
      type="empty"
      title="暂无订单"
      :description="effectiveKeyword ? '未匹配到符合关键词的订单，请调整关键词后重试' : '当前筛选下没有订单记录'"
      action-text="刷新订单"
      @retry="loadOrders(true)"
    />

    <div v-else class="space-y-3">
      <article v-for="order in orders" :key="order.id" class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-base font-semibold text-slate-900">{{ order.showNo }}</p>
              <span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                {{ getClientOrderTypeLabel(order) }}
              </span>
            </div>
            <p class="mt-1 text-xs text-slate-400">下单时间：{{ order.createdAt }}</p>
            <p class="mt-1 text-xs text-slate-400">
              归属：{{ getClientOrderTypeLabel(order) }}{{ order.departmentNameSnapshot ? ` / ${order.departmentNameSnapshot}` : '' }}
            </p>
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
          v-if="getLatestReturnRequestMeta(order)"
          class="mt-3 rounded-2xl px-3 py-2"
          :class="getLatestReturnRequestMeta(order)?.className"
        >
          <p class="text-sm font-semibold">
            退货状态：{{ getLatestReturnRequestMeta(order)?.label }}
          </p>
          <p class="mt-1 text-xs">
            {{ getLatestReturnRequestMeta(order)?.description }}
          </p>
          <p class="mt-1 text-[11px] opacity-80">
            退货单号：{{ order.latestReturnRequest?.returnNo }}
          </p>
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
