<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ClientShell from '@/views/client/components/ClientShell.vue'
import { getMyO2oPreorders, type O2oPreorderSummary } from '@/api/modules/o2o'

const loading = ref(false)
const orders = ref<O2oPreorderSummary[]>([])

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

const loadOrders = async () => {
  loading.value = true
  try {
    orders.value = await getMyO2oPreorders()
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadOrders()
})
</script>

<template>
  <ClientShell title="我的订单" subtitle="可查看预订记录、状态与核销凭证">
    <div class="mb-4 flex justify-end">
      <button class="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 shadow-sm" @click="loadOrders">
        刷新订单
      </button>
    </div>

    <div v-if="loading" class="rounded-3xl bg-white p-8 text-center text-slate-400 shadow-sm">订单加载中...</div>
    <div v-else-if="!orders.length" class="rounded-3xl bg-white p-8 text-center text-slate-400 shadow-sm">
      暂无预订记录，先去商品大厅挑选商品吧
    </div>

    <div v-else class="space-y-4">
      <article
        v-for="order in orders"
        :key="order.id"
        class="rounded-3xl bg-white p-5 shadow-sm transition hover:shadow-md"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p class="text-lg font-semibold text-slate-900">{{ order.showNo }}</p>
            <p class="mt-1 text-sm text-slate-400">创建时间：{{ order.createdAt }}</p>
            <p v-if="order.timeoutAt" class="mt-1 text-sm text-slate-400">超时取消时间：{{ order.timeoutAt }}</p>
          </div>

          <div class="flex items-center gap-3">
            <span class="rounded-full px-3 py-1 text-sm font-medium" :class="statusClassMap[order.status]">
              {{ statusLabelMap[order.status] }}
            </span>
            <router-link
              :to="`/client/orders/${order.id}`"
              class="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white"
            >
              查看详情
            </router-link>
          </div>
        </div>

        <div class="mt-4 grid gap-3 sm:grid-cols-3">
          <div class="rounded-2xl bg-slate-50 px-4 py-3">
            <p class="text-sm text-slate-400">总件数</p>
            <p class="mt-1 text-lg font-semibold text-slate-900">{{ order.totalQty }} 件</p>
          </div>
          <div class="rounded-2xl bg-slate-50 px-4 py-3">
            <p class="text-sm text-slate-400">核销码</p>
            <p class="mt-1 break-all text-sm font-medium text-slate-700">{{ order.verifyCode }}</p>
          </div>
          <div class="rounded-2xl bg-slate-50 px-4 py-3">
            <p class="text-sm text-slate-400">状态说明</p>
            <p class="mt-1 text-sm text-slate-700">
              {{ order.status === 'pending' ? '线下出示二维码后由工作人员核销' : order.status === 'verified' ? '已完成领取' : '已自动释放预订库存' }}
            </p>
          </div>
        </div>
      </article>
    </div>
  </ClientShell>
</template>
