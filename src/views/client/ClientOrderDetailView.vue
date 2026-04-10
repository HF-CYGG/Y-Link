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
import { normalizeRequestError } from '@/utils/error'

const route = useRoute()
const router = useRouter()

const loading = ref(false)
const detail = ref<O2oPreorderDetail | null>(null)
const qrDataUrl = ref('')
const requestError = ref<{ type: 'offline' | 'error'; message: string } | null>(null)
const { runLatest } = useStableRequest()

const statusLabel = computed(() => {
  if (!detail.value) {
    return '未知'
  }
  const status = detail.value.order.status
  const timeoutReached = Boolean(detail.value.order.timeoutAt && new Date(detail.value.order.timeoutAt).getTime() <= Date.now())
  if (status === 'verified') {
    return '已核销'
  }
  if (status === 'cancelled' && timeoutReached) {
    return '已超时取消'
  }
  if (status === 'cancelled') {
    return '已取消'
  }
  return '待取货'
})

const handleBack = () => {
  router.back()
}

const statusBanner = computed(() => {
  const status = detail.value?.order.status
  const timeoutReached = Boolean(detail.value?.order.timeoutAt && new Date(detail.value.order.timeoutAt).getTime() <= Date.now())
  if (status === 'verified') {
    return { className: 'bg-emerald-50 text-emerald-700', text: '订单已核销完成，可在订单列表查看历史记录。' }
  }
  if (status === 'cancelled' && timeoutReached) {
    return { className: 'bg-orange-50 text-orange-700', text: '订单因超时未领取已自动取消，库存已释放。' }
  }
  if (status === 'cancelled') {
    return { className: 'bg-slate-100 text-slate-600', text: '订单已取消，如需取货请重新下单。' }
  }
  return { className: 'bg-amber-50 text-amber-700', text: '请在有效时段内到店出示核销码完成领取。' }
})

const timelineItems = computed(() => {
  if (!detail.value) {
    return []
  }
  const timeoutReached = Boolean(detail.value.order.timeoutAt && new Date(detail.value.order.timeoutAt).getTime() <= Date.now())
  let verifyStepTitle = '待核销'
  if (detail.value.order.status === 'verified') {
    verifyStepTitle = '已核销'
  } else if (timeoutReached) {
    verifyStepTitle = '已超时'
  }
  return [
    {
      key: 'created',
      title: '已下单',
      time: detail.value.order.createdAt,
      active: true,
    },
    {
      key: 'pending',
      title: '备货中',
      time: detail.value.order.timeoutAt || '按门店通知准备',
      active: detail.value.order.status === 'pending',
    },
    {
      key: 'verified',
      title: verifyStepTitle,
      time: detail.value.order.verifiedAt || detail.value.order.timeoutAt || '待完成',
      active: detail.value.order.status !== 'pending',
    },
  ]
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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
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
        <p class="mt-3 rounded-2xl px-3 py-2 text-sm" :class="statusBanner.className">{{ statusBanner.text }}</p>

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
                  <th class="px-4 py-3 text-right font-medium">数量</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 bg-white text-slate-700">
                <tr v-for="item in detail.items" :key="item.id">
                  <td class="px-4 py-3">{{ item.productName }}</td>
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
