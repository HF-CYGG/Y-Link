<!--
  模块说明：F:/Y-Link/src/components/common/page-container/PageContainer.vue
  文件职责：页面容器组件，封装通用页头、主体间距与响应式布局。
  实现逻辑：通过插槽承载页面内容并统一外层布局基线。
  维护说明：样式改动需回归多页面密度与滚动表现。
-->

<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/store'
import pinia from '@/store/pinia'

/**
 * 通用页面容器参数：
 * - title / description 用于统一页面头部信息；
 * - narrow 用于少数需要更聚焦阅读宽度的页面。
 */
interface Props {
  title?: string
  description?: string
  narrow?: boolean
}

const props = defineProps<Props>()
const appStore = useAppStore(pinia)

/**
 * 页面容器宽度策略：
 * - desktop 下使用更大的最大宽度，兼顾表格与卡片排布；
 * - tablet 下收紧宽度，减少边缘浪费；
 * - phone 下取消多余留白，优先保证内容完整展示。
 */
const containerClass = computed(() => {
  if (props.narrow) {
    return appStore.isPhone ? 'w-full max-w-full' : 'mx-auto w-full max-w-5xl'
  }

  if (appStore.isDesktop) {
    return 'w-full max-w-none'
  }

  if (appStore.isTablet) {
    return 'w-full max-w-none'
  }

  return 'w-full max-w-full'
})

/**
 * 页面内边距策略：
 * - 与 AppLayout 主区域形成层级配合；
 * - 避免 phone / tablet 下内容被双重 padding 挤压。
 */
const sectionPaddingClass = computed(() => {
  if (appStore.isDesktop) {
    return 'px-0 py-1'
  }

  if (appStore.isTablet) {
    return 'px-0 py-0.5'
  }

  return 'px-0 py-0.5'
})
</script>

<template>
  <section :class="['w-full min-w-0', containerClass, sectionPaddingClass]">
    <header v-if="title || description" class="mb-4 flex min-w-0 flex-col gap-1 sm:mb-5">
      <h1 v-if="title" class="break-words text-xl font-semibold text-slate-900 dark:text-slate-100 sm:text-2xl">
        {{ title }}
      </h1>
      <p v-if="description" class="break-words text-sm leading-6 text-slate-500 dark:text-slate-400">
        {{ description }}
      </p>
    </header>

    <main class="w-full min-w-0">
      <slot />
    </main>
  </section>
</template>
