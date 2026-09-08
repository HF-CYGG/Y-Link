<script setup lang="ts">
/**
 * 模块说明：src/views/dashboard/components/TopCustomerRankCard.vue
 * 文件职责：负责仪表盘客户排行卡片展示，并提供进入客户钻取抽屉的入口。
 * 实现逻辑：
 * - 卡片层只负责展示排行结果和处理选中交互，详情数据延后到抽屉阶段再获取；
 * - 通过轻量交互把首页信息密度控制在可浏览范围内，避免把客户明细全部堆到首屏。
 * 维护说明：
 * - 若后续新增客户排行指标，优先在当前卡片能力上扩展，保持和商品排行卡片一致的使用方式；
 * - 统计区间由首页筛选栏统一下发，卡片不得写死“本月”之类的口径；
 * - 客户排行的名称、金额和数量口径必须与后端统计定义保持一致，不能在组件内二次解释。
 */


import { computed, ref } from 'vue'

import type { DashboardTopCustomer } from '@/api/modules/dashboard'
import TopCustomerDrilldownDrawer from './TopCustomerDrilldownDrawer.vue'
import type { DashboardAppliedFilter, DashboardRankOptions } from '../composables/useDashboardAnalytics'

import { showAppWarning } from '@/utils/app-alert'

const props = defineProps<{
  topCustomers: DashboardTopCustomer[]
  options: DashboardRankOptions
  filter: DashboardAppliedFilter
  rangeLabel: string
  loading: boolean
}>()

const rankSubtitle = computed(() => `按出库金额 Top ${props.options.topN}`)

const drawerVisible = ref(false)
const activeCustomerName = ref('')

const formatAmount = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const openDrilldown = (customerName: string) => {
  if (!customerName.trim()) {
    showAppWarning('当前榜单项缺少客户标识')
    return
  }

  activeCustomerName.value = customerName
  drawerVisible.value = true
}
</script>

<template>
  <div class="apple-card p-5 sm:p-6 xl:p-7">
    <div class="mb-5 flex items-center justify-between">
      <div class="min-w-0">
        <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-200">经常购买部门榜</h2>
        <p class="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{{ props.rangeLabel }}</p>
      </div>
      <span class="shrink-0 text-xs text-slate-500 dark:text-slate-400">{{ rankSubtitle }}</span>
    </div>
    <div v-if="props.loading" class="min-h-[180px]">
      <el-skeleton animated :rows="5" class="w-full" />
    </div>
    <div v-else-if="topCustomers.length" class="space-y-3">
      <button
        v-for="(item, index) in topCustomers"
        :key="`${item.customerName}-${index}`"
        type="button"
        class="flex w-full items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-left transition hover:bg-slate-100 dark:bg-slate-900/40 dark:hover:bg-slate-900/60"
        @click="openDrilldown(item.customerName)"
      >
        <div class="flex min-w-0 items-center gap-3">
          <div class="flex h-7 w-7 items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand dark:bg-brand/20 dark:text-teal-400">
            {{ index + 1 }}
          </div>
          <div class="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{{ item.customerName }}</div>
        </div>
        <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">¥{{ formatAmount(item.totalAmount) }}</div>
      </button>
    </div>
    <div v-else class="flex min-h-[180px] items-center justify-center rounded-xl bg-slate-50 text-slate-400 dark:bg-slate-900/40">
      <el-empty :image-size="64" description="所选区间暂无榜单数据" />
    </div>
  </div>
  <TopCustomerDrilldownDrawer v-model="drawerVisible" :customer-name="activeCustomerName" :filter="props.filter" />
</template>
