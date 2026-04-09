<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { EChartsOption } from 'echarts'
import { ElMessage } from 'element-plus'
import BaseEChart from '@/components/charts/BaseEChart.vue'
import { getDashboardPieData, type DashboardPieDataResult, type DashboardPieSlice } from '@/api/modules/dashboard'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAppStore, useThemeStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

const appStore = useAppStore()
const themeStore = useThemeStore()
const pieRequest = useStableRequest()
const pieLoading = ref(false)
const pieData = ref<DashboardPieDataResult>({
  productPie: [],
  customerPie: [],
  orderTypePie: [],
})
const filterForm = reactive({
  dateRange: [] as [string, string] | [],
  orderType: '' as '' | 'department' | 'walkin',
})
const piePalette = ['#14b8a6', '#0ea5e9', '#8b5cf6', '#f97316', '#eab308', '#ef4444', '#84cc16', '#06b6d4']
type PieValueType = 'amount' | 'count'
type NumericLike = string | number | null | undefined

const pieCards = computed(() => {
  return [
    {
      key: 'productPie',
      title: '商品金额占比',
      description: '按商品维度统计出库金额占比',
      slices: pieData.value.productPie,
      emptyText: '暂无商品占比数据',
      valueType: 'amount' as PieValueType,
    },
    {
      key: 'customerPie',
      title: '客户金额占比',
      description: '按部门/散客维度统计出库金额占比',
      slices: pieData.value.customerPie,
      emptyText: '暂无客户占比数据',
      valueType: 'amount' as PieValueType,
    },
    {
      key: 'orderTypePie',
      title: '散客/部门单数占比',
      description: '按订单类型统计出库单数占比',
      slices: pieData.value.orderTypePie,
      emptyText: '暂无订单类型占比数据',
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

const getCardTotalValue = (slices: DashboardPieSlice[]) => {
  return slices.reduce((sum, item) => sum + Number(item.value ?? 0), 0)
}

const buildPieOption = (slices: DashboardPieSlice[], valueType: PieValueType): EChartsOption => {
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
          `<div style="font-weight:600;margin-bottom:4px;">${normalizedParams.name}</div>`,
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

const buildQuery = () => {
  const query: {
    dateRange?: [string, string]
    orderType?: 'department' | 'walkin'
  } = {}

  if (filterForm.dateRange.length === 2) {
    query.dateRange = [filterForm.dateRange[0], filterForm.dateRange[1]]
  }
  if (filterForm.orderType) {
    query.orderType = filterForm.orderType
  }

  return query
}

const loadPieData = async () => {
  if (pieLoading.value) {
    return
  }

  pieLoading.value = true
  await pieRequest.runLatest({
    executor: (signal) => getDashboardPieData(buildQuery(), { signal }),
    onSuccess: (result) => {
      pieData.value = {
        productPie: result.productPie ?? [],
        customerPie: result.customerPie ?? [],
        orderTypePie: result.orderTypePie ?? [],
      }
    },
    onError: (error) => {
      ElMessage.error(extractErrorMessage(error, '获取饼图统计失败'))
    },
    onFinally: () => {
      pieLoading.value = false
    },
  })
}

const handleFilterSearch = () => {
  void loadPieData()
}

const handleFilterReset = () => {
  filterForm.dateRange = []
  filterForm.orderType = ''
  void loadPieData()
}

void loadPieData()
</script>

<template>
  <section class="space-y-4">
    <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-200">结构占比</h2>
    <div class="apple-card p-4 sm:p-5 xl:p-6">
      <div class="flex flex-wrap items-center gap-3">
        <el-date-picker
          v-model="filterForm.dateRange"
          type="daterange"
          unlink-panels
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          :class="appStore.isPhone ? '!w-full' : appStore.isTablet ? '!w-[320px]' : '!w-[340px]'"
        />
        <el-select
          v-model="filterForm.orderType"
          clearable
          placeholder="订单类型"
          :class="appStore.isPhone ? '!w-full' : appStore.isTablet ? '!w-[150px]' : '!w-[160px]'"
        >
          <el-option label="部门单" value="department" />
          <el-option label="散客单" value="walkin" />
        </el-select>
        <div :class="['flex gap-2', appStore.isPhone ? 'w-full' : '']">
          <el-button :class="appStore.isPhone ? 'flex-1' : ''" type="primary" :loading="pieLoading" @click="handleFilterSearch">
            查询统计
          </el-button>
          <el-button :class="appStore.isPhone ? 'flex-1' : ''" :disabled="pieLoading" @click="handleFilterReset">
            重置条件
          </el-button>
        </div>
      </div>
    </div>
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
                  <component :is="card.valueType === 'count' ? 'Document' : 'Money'" />
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
          <el-empty :image-size="64" :description="card.emptyText" />
        </div>
      </div>
    </div>
  </section>
</template>
