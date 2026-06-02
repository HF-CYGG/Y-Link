<script setup lang="ts">
/**
 * 模块说明：src/views/dashboard/components/TrendChartCard.vue
 * 文件职责：负责仪表盘趋势图卡片的图表配置组装与主题适配，展示订单、金额等时间序列趋势。
 * 实现逻辑：
 * - 组件接收上层整理后的趋势点数据，只在本地完成 ECharts option 计算与视觉呈现；
 * - 图表颜色和辅助线样式跟随主题状态切换，避免深浅主题下出现可读性下降。
 * 维护说明：
 * - 若后续新增趋势维度，优先扩展数据映射与图例配置，不要把接口请求下沉到图表组件内部；
 * - 图表交互应保持克制，避免悬浮态和动画过重影响首页首屏响应。
 */


import { computed } from 'vue'
import type { EChartsOption } from 'echarts'
import BaseEChart from '@/components/charts/BaseEChart.vue'
import type { DashboardTrendPoint } from '@/api/modules/dashboard'
import { useThemeStore } from '@/store'
import pinia from '@/store/pinia'

const props = defineProps<{
  trend: DashboardTrendPoint[]
}>()
const themeStore = useThemeStore(pinia)

const formatAmount = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

const formatQty = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

const peakAmount = computed(() => {
  const maxValue = Math.max(...props.trend.map((point) => Number(point.amount ?? 0)), 0)
  return formatAmount(maxValue)
})

const trendOption = computed<EChartsOption>(() => ({
  animationDuration: themeStore.prefersReducedMotion ? 0 : 400,
  animationDurationUpdate: themeStore.prefersReducedMotion ? 0 : 260,
  color: ['#14b8a6'],
  grid: {
    left: 16,
    right: 16,
    top: 16,
    bottom: 12,
    containLabel: true,
  },
  tooltip: {
    trigger: 'axis',
    axisPointer: {
      type: 'line',
      lineStyle: {
        color: 'rgba(20, 184, 166, 0.45)',
        width: 1,
      },
    },
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderWidth: 0,
    textStyle: {
      color: '#f8fafc',
      fontSize: 12,
    },
    formatter: (params) => {
      const normalizedParams = Array.isArray(params) ? params[0] : params
      const pointIndex = Number(normalizedParams?.dataIndex ?? -1)
      const point = pointIndex >= 0 ? props.trend[pointIndex] : undefined
      if (!point) {
        return ''
      }

      return [
        `<div style="font-weight:600;margin-bottom:4px;">${point.label}</div>`,
        `<div>出库单数：${point.orderCount} 单</div>`,
        `<div>出库总额：¥${formatAmount(point.amount)}</div>`,
        `<div>出库数量：${formatQty(point.totalQty)}</div>`,
      ].join('')
    },
  },
  xAxis: {
    type: 'category',
    boundaryGap: false,
    data: props.trend.map((item) => item.label),
    axisTick: { show: false },
    axisLine: {
      lineStyle: {
        color: 'rgba(148, 163, 184, 0.28)',
      },
    },
    axisLabel: {
      color: '#94a3b8',
      fontSize: 12,
      margin: 12,
    },
  },
  yAxis: {
    type: 'value',
    splitNumber: 4,
    axisLabel: {
      color: '#94a3b8',
      formatter: (value: number) => `¥${formatAmount(value)}`,
    },
    splitLine: {
      lineStyle: {
        color: 'rgba(148, 163, 184, 0.16)',
      },
    },
  },
  series: [
    {
      type: 'line',
      smooth: true,
      showSymbol: true,
      symbol: 'circle',
      symbolSize: 8,
      lineStyle: {
        width: 3,
        color: '#0d9488',
      },
      itemStyle: {
        color: '#ffffff',
        borderColor: '#0d9488',
        borderWidth: 2,
      },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(20, 184, 166, 0.35)' },
            { offset: 1, color: 'rgba(20, 184, 166, 0.03)' },
          ],
        },
      },
      data: props.trend.map((item) => Number(item.amount ?? 0)),
    },
  ],
}))
</script>

<template>
  <div class="apple-card p-5 sm:p-6 xl:p-7">
    <div class="mb-5 flex items-center justify-between">
      <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-200">近 7 日出库趋势</h2>
      <div class="text-xs text-slate-500 dark:text-slate-400">
        峰值：<span class="font-semibold text-slate-700 dark:text-slate-200">¥{{ peakAmount }}</span>
      </div>
    </div>

    <div v-if="props.trend.length > 1">
      <BaseEChart :option="trendOption" :min-height="260" />
    </div>

    <div v-else class="flex min-h-[260px] items-center justify-center rounded-xl bg-slate-50 text-slate-400 dark:bg-slate-900/40">
      <el-empty :image-size="72" description="暂无趋势数据" />
    </div>
  </div>
</template>
