<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { useAppStore } from '@/store'

/**
 * 通用工具栏卡片参数：
 * - contentClass 用于页面在少量场景下补充布局约束；
 * - actionsClass 用于操作区增加个性化宽度或对齐方式；
 * - actionStretchOnPhone 控制手机端操作区是否自动撑满整行。
 */
interface Props {
  contentClass?: string
  actionsClass?: string
  actionStretchOnPhone?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  contentClass: '',
  actionsClass: '',
  actionStretchOnPhone: true,
})

const slots = useSlots()
const appStore = useAppStore()

/**
 * 当前是否存在操作区：
 * - 只有存在 actions 插槽时才渲染右侧区域；
 * - 这样可兼容“只有筛选项”与“筛选 + 操作”两类页面。
 */
const hasActions = computed(() => Boolean(slots.actions))

/**
 * 主内容区布局：
 * - 手机端永远纵向排列，避免输入框与按钮挤压；
 * - 桌面端允许左右分区，兼顾筛选区与快捷操作的并列展示。
 */
const wrapperClass = computed(() => {
  if (!hasActions.value) {
    return ['flex flex-col gap-3', props.contentClass]
  }

  return [
    'flex flex-col gap-3',
    'sm:flex-row sm:items-center sm:justify-between',
    props.contentClass,
  ]
})

/**
 * 操作区布局：
 * - 手机上默认撑满整行，便于按钮换行与单手点击；
 * - 平板/桌面维持紧凑横排，减少工具栏高度。
 */
const actionContainerClass = computed(() => {
  return [
    'flex items-center gap-2',
    appStore.isPhone && props.actionStretchOnPhone ? 'w-full flex-wrap' : 'shrink-0 flex-wrap justify-end',
    props.actionsClass,
  ]
})
</script>

<template>
  <div class="apple-card flex min-w-0 flex-col gap-3 p-4">
    <div :class="wrapperClass">
      <div class="min-w-0 flex-1">
        <slot :is-phone="appStore.isPhone" :is-tablet="appStore.isTablet" :is-desktop="appStore.isDesktop" />
      </div>

      <div v-if="hasActions" :class="actionContainerClass">
        <slot
          name="actions"
          :is-phone="appStore.isPhone"
          :is-tablet="appStore.isTablet"
          :is-desktop="appStore.isDesktop"
        />
      </div>
    </div>
  </div>
</template>
