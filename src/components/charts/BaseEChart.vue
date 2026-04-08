<script setup lang="ts">
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
