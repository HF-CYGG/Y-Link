<script setup lang="ts">
/**
 * 模块说明：src/views/dashboard/components/DashboardPieSection.vue
 * 文件职责：负责仪表盘饼图分区的统计展示，统一输出订单结构、金额结构等占比信息及对应状态反馈。
 * 实现逻辑：
 * - 统计区间由上层统一下发，本组件只在区间变化时重新拉取饼图数据，保证与趋势图、榜单同口径；
 * - 图表区与摘要区保持同一口径，避免卡片数字和饼图分片含义不一致；
 * - 商品占比按商品合并统计，同一商品的不同颜色/规格不再裂成多片；被 Top N 截断的部分由后端汇总为“其他”，
 *   因此卡片总额等于区间真实总额、各分片占比之和为 100%。
 * 维护说明：
 * - 若后续新增统计口径，需要同步补充分片标签、图例文案和空态提示；
 * - 仪表盘图表展示必须优先保证清晰可读，不要因为装饰性动画影响首屏性能；
 * - 请求竞态交给 useStableRequest，不要再加 `if (loading) return` 早退守卫，否则快速切区间会吞掉新请求。
 */


import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import type { EChartsOption } from 'echarts'

import { Document, Money } from '@element-plus/icons-vue'
import BaseEChart from '@/components/charts/BaseEChart.vue'
import { getDashboardPieData, type DashboardPieDataResult, type DashboardPieSlice } from '@/api/modules/dashboard'
import { useStableRequest } from '@/composables/useStableRequest'
import { useThemeStore } from '@/store'
import pinia from '@/store/pinia'
import { extractErrorMessage } from '@/utils/error'
import { escapeTooltipHtml } from '@/utils/html-escape'
import type { DashboardAppliedFilter } from '../composables/useDashboardAnalytics'

import { showAppError } from '@/utils/app-alert'

const props = defineProps<{
  filter: DashboardAppliedFilter
  rangeLabel: string
}>()

const themeStore = useThemeStore(pinia)
const pieRequest = useStableRequest()
const pieLoading = ref(false)
const pieData = ref<DashboardPieDataResult | null>(null)
/** 最近一次饼图查询的错误文案：非空时不得继续展示上一次的成功结果。 */
const pieError = ref('')
const piePalette = ['#14b8a6', '#0ea5e9', '#8b5cf6', '#f97316', '#eab308', '#ef4444', '#84cc16', '#06b6d4']
type PieValueType = 'amount' | 'count'
type NumericLike = string | number | null | undefined

/** 饼图区间文案优先使用饼图接口自己的回执，避免与榜单区间不一致时误导用户。 */
const pieRangeLabel = computed(() => {
  const range = pieData.value?.range
  if (range?.startDate && range?.endDate) {
    return `${range.startDate} 至 ${range.endDate}`
  }
  return props.rangeLabel
})

const pieCards = computed(() => {
  return [
    {
      key: 'productPie',
      title: '商品金额占比',
      description: `按商品维度统计出库金额占比（${pieRangeLabel.value}）`,
      slices: pieData.value?.productPie ?? [],
      emptyText: '所选区间暂无商品占比数据',
      valueType: 'amount' as PieValueType,
    },
    {
      key: 'customerPie',
      title: '客户金额占比',
      description: `按部门/散客维度统计出库金额占比（${pieRangeLabel.value}）`,
      slices: pieData.value?.customerPie ?? [],
      emptyText: '所选区间暂无客户占比数据',
      valueType: 'amount' as PieValueType,
    },
    {
      key: 'orderTypePie',
      title: '散客/部门单数占比',
      description: `按订单类型统计出库单数占比（${pieRangeLabel.value}）`,
      slices: pieData.value?.orderTypePie ?? [],
      emptyText: '所选区间暂无订单类型占比数据',
      valueType: 'count' as PieValueType,
    },
  ] as const
})

const formatAmount = (value: NumericLike): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

const formatCount = (value: NumericLike): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? String(Math.max(0, Math.round(normalizedNumber))) : '0'
}

const formatSliceValue = (value: NumericLike, valueType: PieValueType): string => {
  if (valueType === 'count') {
    return `${formatCount(value)} 单`
  }
  return `¥${formatAmount(value)}`
}

const resolvePieLegendColor = (index: number): string => {
  return piePalette[index % piePalette.length]
}

const getCardTotalValue = (slices: readonly DashboardPieSlice[]) => {
  return slices.reduce((sum, item) => sum + Number(item.value ?? 0), 0)
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const buildPieOption = (slices: readonly DashboardPieSlice[], valueType: PieValueType): EChartsOption => {
  return {
    color: piePalette,
    animationDuration: themeStore.prefersReducedMotion ? 0 : 400,
    animationDurationUpdate: themeStore.prefersReducedMotion ? 0 : 260,
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(15, 23, 42, 0.92)',
      borderWidth: 0,
      textStyle: {
        color: '#f8fafc',
        fontSize: 12,
      },
      formatter: (params) => {
        const normalizedParams = Array.isArray(params) ? params[0] : params
        if (!normalizedParams) {
          return ''
        }
        const percent = Number(normalizedParams.percent ?? 0).toFixed(2)
        const rawValue = normalizedParams.value
        const normalizedValue = typeof rawValue === 'number' || typeof rawValue === 'string' ? rawValue : 0
        return [
          `<div style="font-weight:600;margin-bottom:4px;">${escapeTooltipHtml(normalizedParams.name)}</div>`,
          `<div>占比：${percent}%</div>`,
          `<div>${valueType === 'count' ? '单数' : '金额'}：${formatSliceValue(normalizedValue, valueType)}</div>`,
        ].join('')
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['52%', '72%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        selectedMode: false,
        stillShowZeroSum: true,
        label: {
          show: false,
        },
        labelLine: {
          show: false,
        },
        emphasis: {
          scale: !themeStore.prefersReducedMotion,
          scaleSize: themeStore.prefersReducedMotion ? 0 : 6,
        },
        itemStyle: {
          borderColor: '#ffffff',
          borderWidth: 3,
          borderRadius: 6,
        },
        data: slices.map((slice) => ({
          name: slice.label,
          value: Number(slice.value ?? 0),
        })),
      },
    ],
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const loadPieData = async () => {
  pieLoading.value = true
  pieError.value = ''
  await pieRequest.runLatest({
    executor: (signal) =>
      getDashboardPieData(
        {
          dateRange: props.filter.dateRange,
          orderType: props.filter.orderType || undefined,
        },
        { signal },
      ),
    onSuccess: (result) => {
      pieError.value = ''
      pieData.value = result
    },
    onError: (error) => {
      // 区间已经切到新条件，若留着上一次的成功结果，用户会把旧占比当成新筛选的结果读。
      const message = extractErrorMessage(error, '获取饼图统计失败')
      pieError.value = message
      pieData.value = null
      showAppError(message)
    },
    onFinally: () => {
      pieLoading.value = false
    },
  })
}

/**
 * 失活与卸载时复位加载态：
 * - useStableRequest 的 cancel() 会把 activeController 置空，runLatest 随后判定当前请求已过期
 *   而直接返回，onFinally 不会被调用；
 * - 不复位的话，keep-alive 页面在请求未完成时离开，pieLoading 会永久为 true，三张饼图卡片
 *   会一直停在骨架屏，直到用户再次改动筛选条件。
 */
const resetLoadingOnLeave = () => {
  pieLoading.value = false
}

onDeactivated(resetLoadingOnLeave)
onBeforeUnmount(resetLoadingOnLeave)

/**
 * 重新进入 keep-alive 页面时兜底：
 * - 上次请求若在离页时被取消，这里没有数据也不会再自动触发（watch 只在筛选条件变化时响应），
 *   因此需要补一次拉取，避免卡在空态。
 */
onActivated(() => {
  if (!pieData.value && !pieLoading.value) {
    void loadPieData()
  }
})

watch(
  () => props.filter,
  () => {
    void loadPieData()
  },
  { deep: true, immediate: true },
)
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-3">
    <div v-for="card in pieCards" :key="card.key" class="apple-card p-5 sm:p-6">
      <div class="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 class="text-base font-semibold text-slate-800 dark:text-slate-200">{{ card.title }}</h3>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">{{ card.description }}</p>
        </div>
        <div class="shrink-0 text-right">
          <div class="text-[11px] text-slate-400 dark:text-slate-500">
            {{ card.valueType === 'count' ? '总单数' : '总金额' }}
          </div>
          <div class="text-xs font-semibold text-slate-600 dark:text-slate-300">
            {{
              card.valueType === 'count'
                ? `${formatCount(getCardTotalValue(card.slices))} 单`
                : `¥${formatAmount(getCardTotalValue(card.slices))}`
            }}
          </div>
        </div>
      </div>
      <div v-if="pieLoading" class="flex min-h-[220px] items-center justify-center">
        <el-skeleton animated :rows="6" class="w-full" />
      </div>
      <div v-else-if="card.slices.length" class="space-y-4">
        <div class="mx-auto flex w-full max-w-[240px] items-center justify-center">
          <div class="relative h-44 w-full max-w-[240px]">
            <BaseEChart :option="buildPieOption(card.slices, card.valueType)" :min-height="176" />
            <div class="pointer-events-none absolute inset-0 flex items-center justify-center text-center">
              <el-icon :size="32" class="text-slate-300/80 dark:text-slate-600/80">
                <component :is="card.valueType === 'count' ? Document : Money" />
              </el-icon>
            </div>
          </div>
        </div>
        <div class="space-y-2">
          <div v-for="(slice, index) in card.slices" :key="`${card.key}-${slice.key}-${index}`" class="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/40">
            <div class="flex min-w-0 items-center gap-2">
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: resolvePieLegendColor(index) }" />
              <span class="truncate text-slate-700 dark:text-slate-200">{{ slice.label }}</span>
            </div>
            <div class="shrink-0 text-slate-600 dark:text-slate-300">
              {{ Number(slice.ratio ?? 0).toFixed(2) }}% ｜ {{ formatSliceValue(slice.value, card.valueType) }}
            </div>
          </div>
        </div>
      </div>
      <div v-else class="flex min-h-[220px] items-center justify-center rounded-xl bg-slate-50 dark:bg-slate-900/40">
        <el-empty :image-size="64" :description="pieError || card.emptyText" />
      </div>
    </div>
  </div>
</template>
