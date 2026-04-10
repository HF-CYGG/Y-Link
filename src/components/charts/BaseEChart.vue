<script setup lang="ts">
/**
 * 模块说明：src/components/charts/BaseEChart.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
