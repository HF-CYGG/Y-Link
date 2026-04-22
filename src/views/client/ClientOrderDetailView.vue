<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientOrderDetailView.vue
 * 文件职责：承载客户端订单详情展示、进度查看、二维码展示与订单撤回。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import QRCode from 'qrcode'
import { cancelMyO2oPreorder, getO2oPreorderDetail, type O2oPreorderDetail, type O2oPreorderSummary } from '@/api/modules/o2o'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import {
  getO2oOrderBusinessStatusMeta,
  getClientOrderStatusReportConfig,
  getClientOrderReportScenario,
  isO2oOrderCancelled,
  isO2oOrderPending,
  isO2oOrderVerified,
} from '@/constants/o2o-order-status'
import { useClientOrderStore } from '@/store'
import { normalizeRequestError } from '@/utils/error'

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const recalling = ref(false)
const detail = ref<O2oPreorderDetail | null>(null)
const qrDataUrl = ref('')
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const { runLatest } = useStableRequest()
const clientOrderStore = useClientOrderStore()
clientOrderStore.initialize()

const currentReportScenario = computed(() => {
  if (!detail.value) {
    return 'pending'
  }
  if (detail.value.order.statusReport?.scenario) {
    return detail.value.order.statusReport.scenario
  }
  return getClientOrderReportScenario(detail.value.order.status, detail.value.order.timeoutAt)
})

const statusLabel = computed(() => {
  if (!detail.value) {
    return '待取货'
  }
  return getClientOrderStatusReportConfig({
    statusReport: detail.value.order.statusReport,
    status: detail.value.order.status,
    timeoutAt: detail.value.order.timeoutAt,
  }).statusLabel
})

// 详细注释：返回上一页。使用 vue-router 的 back 方法，如果不支持则由浏览器处理回退历史。
const handleBack = () => {
  router.back()
}

const statusBanner = computed(() => {
  const report = detail.value
    ? getClientOrderStatusReportConfig({
        statusReport: detail.value.order.statusReport,
        status: detail.value.order.status,
        timeoutAt: detail.value.order.timeoutAt,
      })
    : getClientOrderStatusReportConfig({
        status: 'pending',
        timeoutAt: null,
      })
  return { className: report.cardClassName, title: report.cardTitle, description: report.cardDescription }
})

const businessStatusMeta = computed(() => {
  return getO2oOrderBusinessStatusMeta(detail.value?.order.businessStatus)
})

const merchantMessageContent = computed(() => {
  const value = detail.value?.order.merchantMessage ?? null
  if (!value) {
    return null
  }
  const normalizedValue = value.trim()
  return normalizedValue || null
})

const timelineItems = computed(() => {
  if (!detail.value) {
    return []
  }
  const order = detail.value.order
  const nowMs = Date.now()
  const report = getClientOrderStatusReportConfig({
    statusReport: order.statusReport,
    status: order.status,
    timeoutAt: order.timeoutAt,
  }, nowMs)
  const cancelledByTimeout = currentReportScenario.value === 'timeout_cancelled'

  if (isO2oOrderVerified(order.status)) {
    return [
      { key: 'created', title: '已下单', time: order.createdAt, active: true },
      { key: 'prepare', title: '备货完成', time: order.timeoutAt || '门店已备货', active: true },
      { key: 'verify', title: '已核销', time: order.verifiedAt || '核销成功', active: true },
      { key: 'done', title: '订单完成', time: order.verifiedAt || '已完成', active: true },
    ]
  }

  if (isO2oOrderCancelled(order.status)) {
    return [
      { key: 'created', title: '已下单', time: order.createdAt, active: true },
      { key: 'prepare', title: '备货中', time: order.timeoutAt || '门店处理中', active: !cancelledByTimeout },
      {
        key: 'cancelled',
        title: report.timelineCurrentTitle,
        time: order.timeoutAt || '已取消',
        active: true,
      },
      {
        key: 'closed',
        title: '订单关闭',
        time: report.timelineCurrentHint,
        active: true,
      },
    ]
  }

  return [
    { key: 'created', title: '已下单', time: order.createdAt, active: true },
    {
      key: 'prepare',
      title: '备货中',
      time: order.timeoutAt || '按门店通知准备',
      active: true,
    },
    {
      key: 'pending',
      title: report.timelineCurrentTitle,
      time: order.timeoutAt || report.timelineCurrentHint,
      active: true,
    },
    {
      key: 'future',
      title: '核销后完成订单',
      time: '待完成',
      active: false,
    },
  ]
})

const totalAmount = computed(() => {
  if (!detail.value) {
    return 0
  }
  return detail.value.items.reduce((sum, item) => {
    return sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty
  }, 0)
})

const displayVerifyCode = computed(() => {
  if (!canUseQrCode.value) {
    return '已停用'
  }
  const rawCode = detail.value?.order.verifyCode ?? ''
  if (!rawCode) {
    return ''
  }
  return rawCode
    .replaceAll('-', '')
    .toUpperCase()
    .replaceAll(/(.{4})/g, '$1 ')
    .trim()
})

const canRecallOrder = computed(() => {
  return isO2oOrderPending(detail.value?.order.status)
})

const canUseQrCode = computed(() => {
  return isO2oOrderPending(detail.value?.order.status)
})

const qrDisabledHint = computed(() => {
  if (!detail.value) {
    return '当前订单二维码暂不可用'
  }
  if (detail.value.order.status === 'verified') {
    return '订单已核销完成，二维码与取货码已停用'
  }
  if (detail.value.order.statusReport?.cancelReason === 'manual') {
    return '订单已撤回，二维码与取货码已停用'
  }
  if (currentReportScenario.value === 'timeout_cancelled') {
    return '订单已超时取消，二维码与取货码已停用'
  }
  return '当前订单二维码暂不可用'
})

const buildOrderSummaryFromDetail = (nextDetail: O2oPreorderDetail): O2oPreorderSummary => {
  const { order } = nextDetail
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

const renderQrCode = async () => {
  // 二维码仅允许待提货订单展示，撤回、超时取消、已核销后立即切换为禁用态。
  if (!detail.value?.qrPayload || !canUseQrCode.value) {
    qrDataUrl.value = ''
    return
  }

  qrDataUrl.value = await QRCode.toDataURL(detail.value.qrPayload, {
    width: 260,
    margin: 1,
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  })
}

const syncOrderStoreFromDetail = (nextDetail: O2oPreorderDetail) => {
  clientOrderStore.upsertOrder(buildOrderSummaryFromDetail(nextDetail))
}

const loadDetail = async () => {
  const orderId = String(route.params.id ?? '').trim()
  if (!orderId) {
    return
  }

  loading.value = true
  requestError.value = null
  await runLatest({
    executor: (signal) => getO2oPreorderDetail(orderId, { signal }),
    onSuccess: async (result) => {
      detail.value = result
      syncOrderStoreFromDetail(result)
      await renderQrCode()
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '订单详情加载失败')
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

// 详细注释：撤回订单操作，弹出二次确认，调用接口后刷新本地状态及二维码。
const handleRecallOrder = async () => {
  if (!detail.value) {
    return
  }
  if (!canRecallOrder.value) {
    ElMessage.warning('当前订单状态不可撤回')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认撤回订单“${detail.value.order.showNo}”吗？撤回后将释放预订库存，二维码会立即失效。`,
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

  recalling.value = true
  try {
    const nextDetail = await cancelMyO2oPreorder(detail.value.order.id)
    detail.value = nextDetail
    syncOrderStoreFromDetail(nextDetail)
    await renderQrCode()
    ElMessage.success('订单已撤回')
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '撤回订单失败')
    ElMessage.error(normalizedError.message)
  } finally {
    recalling.value = false
  }
}

watch(
  () => route.params.id,
  async () => {
    await loadDetail()
  },
)

onMounted(async () => {
  await loadDetail()
})
</script>

<template>
  <section class="order-detail-page">
    <button
      type="button"
      class="order-back-floating inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-700 shadow-[var(--ylink-shadow-soft)]"
      @click="handleBack"
    >
      <el-icon :size="18"><ArrowLeft /></el-icon>
    </button>

    <div v-if="loading" class="grid gap-3 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div v-for="index in 5" :key="index" class="h-[6.2rem] animate-pulse rounded-2xl bg-slate-100" />
    </div>
    <BaseRequestState
      v-else-if="requestError"
      :type="requestError.type"
      :title="requestError.type === 'offline' ? '网络不可用' : '订单详情加载失败'"
      :description="requestError.message"
      action-text="重试"
      @retry="loadDetail"
    />

    <section v-else-if="detail" class="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <aside class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="text-lg font-semibold text-slate-900">{{ detail.order.showNo }}</p>
            <p class="mt-1 text-sm text-slate-400">状态：{{ statusLabel }}</p>
          </div>
          <button
            v-if="canRecallOrder"
            type="button"
            class="rounded-full border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
            :disabled="recalling"
            @click="handleRecallOrder"
          >
            {{ recalling ? '撤回中...' : '撤回订单' }}
          </button>
        </div>
        <div class="mt-3 rounded-2xl px-3 py-2" :class="statusBanner.className">
          <p class="text-sm font-semibold">{{ statusBanner.title }}</p>
          <p class="mt-1 text-xs">{{ statusBanner.description }}</p>
        </div>
        <div v-if="businessStatusMeta" class="mt-3 rounded-2xl px-3 py-2" :class="businessStatusMeta.className">
          <p class="text-sm font-semibold">商家状态：{{ businessStatusMeta.label }}</p>
          <p class="mt-1 text-xs">{{ businessStatusMeta.clientDescription }}</p>
        </div>

        <div class="mt-5 rounded-3xl bg-slate-50 p-4 text-center">
          <img
            v-if="canUseQrCode && qrDataUrl"
            :src="qrDataUrl"
            alt="预订单二维码"
            class="mx-auto h-64 w-64 rounded-2xl bg-white p-3 shadow-sm"
          />
          <div
            v-else
            class="mx-auto flex h-64 w-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white px-6 text-center"
          >
            <p class="text-sm font-semibold text-slate-700">二维码已停用</p>
            <p class="mt-2 text-xs leading-5 text-slate-400">{{ qrDisabledHint }}</p>
          </div>
          <p class="mt-4 text-xs text-slate-400">取货码</p>
          <p class="mt-1 text-xl font-semibold tracking-[0.18em]" :class="canUseQrCode ? 'text-slate-900' : 'text-slate-400'">
            {{ displayVerifyCode }}
          </p>
        </div>

        <div class="mt-4 space-y-2 rounded-2xl bg-amber-50 px-4 py-4 text-sm text-amber-700">
          <p>取货地址：海右书院112房间</p>
          <p>取货时段：10:00 - 22:00</p>
          <p>联系人：门店值班人员</p>
          <p>温馨提示：请在有效时段内到店核销，过期将自动取消。</p>
        </div>
      </aside>

      <div class="space-y-4">
        <div class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <p class="text-lg font-semibold text-slate-900">订单信息</p>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">创建时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.createdAt }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总件数</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.totalQty }} 件</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总金额</p>
              <p class="mt-1 text-sm font-semibold text-teal-600">¥{{ totalAmount.toFixed(2) }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">超时取消时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.timeoutAt || '未开启自动取消' }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">核销时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.verifiedAt || '尚未核销' }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">商家状态</p>
              <p class="mt-1 text-sm text-slate-700">{{ businessStatusMeta?.label ?? '未设置' }}</p>
            </div>
          </div>
        </div>

        <div v-if="merchantMessageContent" class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <p class="text-lg font-semibold text-slate-900">商家留言</p>
          <p class="mt-3 whitespace-pre-wrap break-words rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            {{ merchantMessageContent }}
          </p>
        </div>

        <div class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <p class="text-lg font-semibold text-slate-900">预订明细</p>
          <div class="mt-4 overflow-hidden rounded-2xl border border-slate-100">
            <table class="min-w-full divide-y divide-slate-100 text-sm">
              <thead class="bg-slate-50 text-slate-500">
                <tr>
                  <th class="px-4 py-3 text-left font-medium">商品</th>
                  <th class="px-4 py-3 text-right font-medium">单价</th>
                  <th class="px-4 py-3 text-right font-medium">数量</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 bg-white text-slate-700">
                <tr v-for="item in detail.items" :key="item.id">
                  <td class="px-4 py-3">{{ item.productName }}</td>
                  <td class="px-4 py-3 text-right">¥{{ Number(item.defaultPrice || 0).toFixed(2) }}</td>
                  <td class="px-4 py-3 text-right font-medium">{{ item.qty }}</td>
                </tr>
                <tr v-if="!detail.items.length">
                  <td colspan="3" class="px-4 py-6 text-center text-slate-400">暂无预订商品明细，请稍后刷新重试</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="rounded-[1.3rem] bg-white p-5 shadow-[var(--ylink-shadow-soft)]">
          <p class="text-lg font-semibold text-slate-900">订单进度</p>
          <div class="mt-4 space-y-3">
            <div
              v-for="timeline in timelineItems"
              :key="timeline.key"
              class="flex items-start gap-3 rounded-2xl px-3 py-2"
              :class="timeline.active ? 'bg-teal-50' : 'bg-slate-50'"
            >
              <span class="mt-1 h-2.5 w-2.5 rounded-full" :class="timeline.active ? 'bg-teal-500' : 'bg-slate-300'" />
              <div>
                <p class="text-sm font-semibold text-slate-900">{{ timeline.title }}</p>
                <p class="text-xs text-slate-500">{{ timeline.time }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
/* 订单详情页根容器：为固定底部导航与安全区预留空间，避免末尾卡片被遮挡。 */
.order-detail-page {
  padding-bottom: calc(7.5rem + env(safe-area-inset-bottom));
}

/*
 * 局部覆盖全局 client-page-absolute：
 * 仅订单详情页恢复到常规文档流，让页面高度随内容增长，从而可以滚动到最下方完整显示卡片。
 */
:global(.client-page-absolute.order-detail-page) {
  position: relative;
}

.order-back-floating {
  position: fixed;
  z-index: 30;
  left: max(10px, calc((100vw - 1240px) / 2 - 52px));
  top: calc(env(safe-area-inset-top) + 82px);
}

@media (max-width: 1023px) {
  .order-back-floating {
    left: 12px;
    top: calc(env(safe-area-inset-top) + 74px);
  }
}
</style>
