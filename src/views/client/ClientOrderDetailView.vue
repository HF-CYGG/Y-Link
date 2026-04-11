<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientOrderDetailView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'
import QRCode from 'qrcode'
import { getO2oPreorderDetail, type O2oPreorderDetail } from '@/api/modules/o2o'
import { BaseRequestState } from '@/components/common'
import { useStableRequest } from '@/composables/useStableRequest'
import {
  CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG,
  getClientOrderReportScenario,
  isO2oOrderCancelled,
  isO2oOrderTimeoutCancelled,
  isO2oOrderVerified,
} from '@/constants/o2o-order-status'
import { normalizeRequestError } from '@/utils/error'

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const detail = ref<O2oPreorderDetail | null>(null)
const qrDataUrl = ref('')
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const { runLatest } = useStableRequest()

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
  return CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[currentReportScenario.value].statusLabel
})

const handleBack = () => {
  router.back()
}

const statusBanner = computed(() => {
  const report = CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[currentReportScenario.value]
  return { className: report.cardClassName, title: report.cardTitle, description: report.cardDescription }
})

const timelineItems = computed(() => {
  if (!detail.value) {
    return []
  }
  const order = detail.value.order
  const nowMs = Date.now()
  const report = CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[currentReportScenario.value]
  const cancelledByTimeout = isO2oOrderTimeoutCancelled(order.status, order.timeoutAt, nowMs)

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

const renderQrCode = async () => {
  if (!detail.value?.qrPayload) {
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
  <section class="pb-20">
    <div class="mb-3">
      <button
        type="button"
        class="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-700 shadow-[var(--ylink-shadow-soft)]"
        @click="handleBack"
      >
        <el-icon :size="18"><ArrowLeft /></el-icon>
      </button>
    </div>

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
        <p class="text-lg font-semibold text-slate-900">{{ detail.order.showNo }}</p>
        <p class="mt-1 text-sm text-slate-400">状态：{{ statusLabel }}</p>
        <div class="mt-3 rounded-2xl px-3 py-2" :class="statusBanner.className">
          <p class="text-sm font-semibold">{{ statusBanner.title }}</p>
          <p class="mt-1 text-xs">{{ statusBanner.description }}</p>
        </div>

        <div class="mt-5 rounded-3xl bg-slate-50 p-4 text-center">
          <img v-if="qrDataUrl" :src="qrDataUrl" alt="预订单二维码" class="mx-auto h-64 w-64 rounded-2xl bg-white p-3 shadow-sm" />
          <p class="mt-4 text-xs text-slate-400">取货码</p>
          <p class="mt-1 text-xl font-semibold tracking-[0.18em] text-slate-900">{{ displayVerifyCode }}</p>
        </div>

        <div class="mt-4 space-y-2 rounded-2xl bg-amber-50 px-4 py-4 text-sm text-amber-700">
          <p>取货地址：A 区一层服务台</p>
          <p>取货时段：08:30 - 20:30</p>
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
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  </section>
</template>
