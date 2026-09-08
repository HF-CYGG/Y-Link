<script setup lang="ts">
/**
 * 模块说明：src/views/dashboard/components/DashboardFilterBar.vue
 * 文件职责：提供工作台首页统一的统计区间筛选栏，同时驱动结构占比饼图、出库趋势与两个排行榜。
 * 实现逻辑：
 * - 支持“按日 / 按月”两种粒度：按月模式使用 monthrange，由上层展开为首月 1 日至末月最后一日，保证跨月跨年区间完整覆盖；
 * - 区间与订单类型属于草稿态，点击“查询统计”后才提交，避免用户还在拖日期时反复触发接口；
 * - 筛选栏内展示后端回执的真实生效区间，杜绝“选了自定义区间，标题仍写本月”的口径错位。
 * 维护说明：
 * - 新增筛选维度时同步扩展 useDashboardAnalytics 的草稿态，不要在本组件里私自发起请求；
 * - 区间文案必须以后端返回的 range 为准，前端不得自行推断默认区间后展示。
 */

import { WarningFilled } from '@element-plus/icons-vue'

import type { DashboardTrendGranularity } from '@/api/modules/dashboard'
import type { DashboardOrderTypeFilter } from '../composables/useDashboardAnalytics'
import { useAppStore } from '@/store'
import pinia from '@/store/pinia'

const appStore = useAppStore(pinia)

const props = defineProps<{
  granularity: DashboardTrendGranularity
  rangeValue: [string, string] | []
  orderType: DashboardOrderTypeFilter
  loading: boolean
  /** 区间查询失败时的错误文案，非空时替代“当前统计区间”提示，避免旧口径继续被当成有效结果。 */
  errorMessage: string
  rangeLabel: string
  granularityLabel: string
  orderTypeLabel: string
}>()

const emit = defineEmits<{
  (event: 'update:granularity', value: DashboardTrendGranularity): void
  (event: 'update:rangeValue', value: [string, string] | []): void
  (event: 'update:orderType', value: DashboardOrderTypeFilter): void
  (event: 'granularity-change'): void
  (event: 'search'): void
  (event: 'reset'): void
}>()

const rangeControlClass = appStore.isPhone ? '!w-full' : appStore.isTablet ? '!w-[320px]' : '!w-[340px]'
const selectControlClass = appStore.isPhone ? '!w-full' : appStore.isTablet ? '!w-[150px]' : '!w-[160px]'

// 详细注释：切换粒度后已选值不再适用，交由上层清空，避免把月份值当作日期提交。
const handleGranularityChange = (value: DashboardTrendGranularity) => {
  emit('update:granularity', value)
  emit('granularity-change')
}
</script>

<template>
  <div class="apple-card p-4 sm:p-5 xl:p-6">
    <div class="flex flex-wrap items-center gap-3">
      <el-radio-group
        :model-value="props.granularity"
        :class="appStore.isPhone ? 'w-full' : ''"
        @update:model-value="handleGranularityChange($event as DashboardTrendGranularity)"
      >
        <el-radio-button value="day">按日</el-radio-button>
        <el-radio-button value="month">按月</el-radio-button>
      </el-radio-group>

      <el-date-picker
        v-if="props.granularity === 'month'"
        :model-value="props.rangeValue"
        type="monthrange"
        unlink-panels
        value-format="YYYY-MM"
        range-separator="至"
        start-placeholder="开始月份"
        end-placeholder="结束月份"
        :class="rangeControlClass"
        @update:model-value="emit('update:rangeValue', ($event as [string, string] | null) ?? [])"
      />
      <el-date-picker
        v-else
        :model-value="props.rangeValue"
        type="daterange"
        unlink-panels
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        :class="rangeControlClass"
        @update:model-value="emit('update:rangeValue', ($event as [string, string] | null) ?? [])"
      />

      <el-select
        :model-value="props.orderType"
        clearable
        placeholder="订单类型"
        :class="selectControlClass"
        @update:model-value="emit('update:orderType', ($event as DashboardOrderTypeFilter) ?? '')"
      >
        <el-option label="部门单" value="department" />
        <el-option label="散客单" value="walkin" />
      </el-select>

      <div :class="['flex gap-2', appStore.isPhone ? 'w-full' : '']">
        <el-button :class="appStore.isPhone ? 'flex-1' : ''" type="primary" :loading="props.loading" @click="emit('search')">
          查询统计
        </el-button>
        <el-button :class="appStore.isPhone ? 'flex-1' : ''" :disabled="props.loading" @click="emit('reset')">
          重置条件
        </el-button>
      </div>
    </div>

    <div v-if="props.errorMessage" class="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400">
      <el-icon :size="14" class="mt-0.5 shrink-0"><WarningFilled /></el-icon>
      <span>{{ props.errorMessage }}（请调整起止时间后重试，下方图表与榜单已清空）</span>
    </div>
    <div v-else class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
      <span>
        当前统计区间：
        <span class="font-semibold text-slate-700 dark:text-slate-200">{{ props.rangeLabel }}</span>
      </span>
      <span class="hidden sm:inline">·</span>
      <span>趋势粒度：{{ props.granularityLabel }}</span>
      <span class="hidden sm:inline">·</span>
      <span>{{ props.orderTypeLabel }}</span>
      <span class="w-full text-[11px] text-slate-400 dark:text-slate-500">
        未选择区间时默认统计本月；饼图、趋势与榜单均以此区间为准。
      </span>
    </div>
  </div>
</template>
