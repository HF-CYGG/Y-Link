<script setup lang="ts">
/**
 * 模块说明：src/components/common/page-shared/PagePaginationBar.vue
 * 文件职责：提供页面底部分页条共享壳，统一分页信息展示、翻页交互和多端对齐方式。
 * 实现逻辑：
 * - 对 `currentPage`、`pageSize`、`total` 等分页状态做统一承载，减少列表页重复拼装 Element Plus 分页条；
 * - 根据设备态自动切换布局对齐和间距，让分页区在手机端与桌面端都保持稳定可读；
 * - 把页码变更事件继续向外透传，业务页面仍然掌握真实查询参数与数据刷新节奏。
 */


import { computed } from 'vue'
import { useAppStore } from '@/store'
import pinia from '@/store/pinia'

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

const appStore = useAppStore(pinia)

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
