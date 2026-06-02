<script setup lang="ts">
/**
 * 模块说明：src/components/charts/BaseEChart.vue
 * 文件职责：提供基于 `vue-echarts` 的基础图表容器，统一承接图表配置、加载态和最小展示高度。
 * 实现逻辑：
 * - 组件接收标准 ECharts 配置对象，屏蔽页面层对底层图表实例组件的重复接入；
 * - 统一处理加载态、自动尺寸调整和最小高度，保证图表卡片在不同页面中的呈现稳定；
 * - 通过单独引入共享注册文件，确保所需图表类型与组件在渲染前已完成注册。
 */


import { computed } from 'vue'
import VChart from 'vue-echarts'
import type { EChartsOption } from 'echarts'
import './echarts'

const props = withDefaults(
  defineProps<{
    option: EChartsOption
    loading?: boolean
    minHeight?: number
    autoresize?: boolean
  }>(),
  {
    loading: false,
    minHeight: 280,
    autoresize: true,
  },
)

const chartStyle = computed(() => ({
  height: `${props.minHeight}px`,
  minHeight: `${props.minHeight}px`,
}))
</script>

<template>
  <div class="relative w-full" :style="chartStyle">
    <VChart :option="props.option" :autoresize="props.autoresize" class="h-full w-full" />
    <div
      v-if="props.loading"
      class="absolute inset-0 flex items-center justify-center rounded-xl bg-white/70 backdrop-blur-sm dark:bg-slate-950/40"
    >
      <el-skeleton animated :rows="4" class="w-full px-6" />
    </div>
  </div>
</template>
