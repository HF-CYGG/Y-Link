<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/store'

/**
 * 分页条参数：
 * - 统一分页对齐方式与多端留白；
 * - 页面继续通过 v-model 维护页码与页容量状态。
 */
interface Props {
  currentPage: number
  pageSize: number
  total: number
  layout?: string
  pageSizes?: number[]
}

const props = withDefaults(defineProps<Props>(), {
  layout: 'total, prev, pager, next, jumper',
  pageSizes: () => [10, 20, 30, 50, 100],
})

const emit = defineEmits<{
  'update:currentPage': [value: number]
  'update:pageSize': [value: number]
  'current-change': [value: number]
  'size-change': [value: number]
}>()

const appStore = useAppStore()

/**
 * 分页栏对齐策略：
 * - 手机端居中，避免控件挤在右侧难以点击；
 * - 平板/桌面靠右，与常见后台列表交互保持一致。
 */
const containerClass = computed(() => {
  return [
    'mt-4 flex w-full min-w-0',
    appStore.isPhone ? 'justify-center' : 'justify-end',
  ]
})
</script>

<template>
  <div :class="containerClass">
    <el-pagination
      :current-page="props.currentPage"
      :page-size="props.pageSize"
      :layout="props.layout"
      :page-sizes="props.pageSizes"
      :total="props.total"
      @update:current-page="emit('update:currentPage', $event)"
      @update:page-size="emit('update:pageSize', $event)"
      @current-change="emit('current-change', $event)"
      @size-change="emit('size-change', $event)"
    />
  </div>
</template>
