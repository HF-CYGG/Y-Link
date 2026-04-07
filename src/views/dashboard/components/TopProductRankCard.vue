<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { DashboardTopProduct } from '@/api/modules/dashboard'
import TopProductDrilldownDrawer from './TopProductDrilldownDrawer.vue'

defineProps<{
  topProducts: DashboardTopProduct[]
}>()

const drawerVisible = ref(false)
const activeProductId = ref('')

const formatQty = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

const openDrilldown = (productId: string) => {
  if (!productId.trim()) {
    ElMessage.warning('当前榜单项缺少产品标识')
    return
  }

  activeProductId.value = productId
  drawerVisible.value = true
}
</script>

<template>
  <div class="apple-card p-5 sm:p-6 xl:p-7">
    <div class="mb-5 flex items-center justify-between">
      <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-200">热门出库文创榜</h2>
      <span class="text-xs text-slate-500 dark:text-slate-400">按本月出库数量 Top 5</span>
    </div>
    <div v-if="topProducts.length" class="space-y-3">
      <button
        v-for="(item, index) in topProducts"
        :key="`${item.productId}-${index}`"
        type="button"
        class="flex w-full items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-left transition hover:bg-slate-100 dark:bg-slate-900/40 dark:hover:bg-slate-900/60"
        @click="openDrilldown(item.productId)"
      >
        <div class="flex min-w-0 items-center gap-3">
          <div class="flex h-7 w-7 items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand dark:bg-brand/20 dark:text-teal-400">
            {{ index + 1 }}
          </div>
          <div class="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{{ item.productName }}</div>
        </div>
        <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">{{ formatQty(item.totalQty) }} 件</div>
      </button>
    </div>
    <div v-else class="flex min-h-[180px] items-center justify-center rounded-xl bg-slate-50 text-slate-400 dark:bg-slate-900/40">
      <el-empty :image-size="64" description="暂无榜单数据" />
    </div>
  </div>
  <TopProductDrilldownDrawer v-model="drawerVisible" :product-id="activeProductId" />
</template>
