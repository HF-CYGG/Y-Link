<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import QRCode from 'qrcode'
import ClientShell from '@/views/client/components/ClientShell.vue'
import { getO2oPreorderDetail, type O2oPreorderDetail } from '@/api/modules/o2o'

const route = useRoute()

const loading = ref(false)
const detail = ref<O2oPreorderDetail | null>(null)
const qrDataUrl = ref('')

const statusLabel = computed(() => {
  const status = detail.value?.order.status
  if (status === 'verified') {
    return '已核销'
  }
  if (status === 'cancelled') {
    return '已取消'
  }
  return '待取货'
})

/**
 * 生成订单二维码：
 * - 二维码载荷由后端统一生成，前端只负责渲染；
 * - 这样未来扫码枪、手机扫码或小程序接入时都能共用同一协议。
 */
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
  try {
    detail.value = await getO2oPreorderDetail(orderId)
    await renderQrCode()
  } finally {
    loading.value = false
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
  <ClientShell title="订单详情" subtitle="请在线下取货时向工作人员出示下方二维码">
    <div v-if="loading" class="rounded-3xl bg-white p-8 text-center text-slate-400 shadow-sm">订单详情加载中...</div>

    <section v-else-if="detail" class="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <aside class="rounded-3xl bg-white p-5 shadow-sm">
        <p class="text-lg font-semibold text-slate-900">{{ detail.order.showNo }}</p>
        <p class="mt-1 text-sm text-slate-400">状态：{{ statusLabel }}</p>

        <div class="mt-5 rounded-3xl bg-slate-50 p-4 text-center">
          <img v-if="qrDataUrl" :src="qrDataUrl" alt="预订单二维码" class="mx-auto h-64 w-64 rounded-2xl bg-white p-3" />
          <p class="mt-3 text-sm text-slate-500">核销码：{{ detail.order.verifyCode }}</p>
        </div>

        <div class="mt-4 space-y-2 rounded-2xl bg-amber-50 px-4 py-4 text-sm text-amber-700">
          <p>1. 领取时请出示此二维码或核销码。</p>
          <p>2. 工作人员核销后，订单状态会变为“已核销”。</p>
          <p>3. 若超过保留时长未领取，系统可能自动取消并释放库存。</p>
        </div>
      </aside>

      <div class="space-y-4">
        <div class="rounded-3xl bg-white p-5 shadow-sm">
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

        <div class="rounded-3xl bg-white p-5 shadow-sm">
          <p class="text-lg font-semibold text-slate-900">预订明细</p>
          <div class="mt-4 overflow-hidden rounded-2xl border border-slate-100">
            <table class="min-w-full divide-y divide-slate-100 text-sm">
              <thead class="bg-slate-50 text-slate-500">
                <tr>
                  <th class="px-4 py-3 text-left font-medium">商品</th>
                  <th class="px-4 py-3 text-left font-medium">编码</th>
                  <th class="px-4 py-3 text-right font-medium">数量</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 bg-white text-slate-700">
                <tr v-for="item in detail.items" :key="item.id">
                  <td class="px-4 py-3">{{ item.productName }}</td>
                  <td class="px-4 py-3">{{ item.productCode }}</td>
                  <td class="px-4 py-3 text-right font-medium">{{ item.qty }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  </ClientShell>
</template>
