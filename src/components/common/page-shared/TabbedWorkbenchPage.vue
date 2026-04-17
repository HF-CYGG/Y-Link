<script setup lang="ts">
/**
 * 模块说明：src/components/common/page-shared/TabbedWorkbenchPage.vue
 * 文件职责：提供基于 Tab 切换的页面容器壳，支持页面级组件的 Keep-Alive 缓存。
 * 维护说明：用于将多个功能页面聚合在一个标签页工作台中，同时避免嵌套页面的双标题。
 */
import type { Component } from 'vue'
import { PageContainer } from '@/components/common'

interface WorkbenchTabOption {
  label: string
  name: string
}

interface Props {
  title: string
  description?: string
  tabs: ReadonlyArray<WorkbenchTabOption>
  activeTab: string
  activeComponent: Component
  keepAlive?: boolean
  cardClass?: string
  contentClass?: string
}

const props = withDefaults(defineProps<Props>(), {
  description: '',
  keepAlive: true,
  cardClass: '',
  contentClass: '',
})

const emit = defineEmits<{
  (event: 'tab-change', value: string | number): void
}>()

// 统一转发标签切换事件，让页面层只关心“Tab 对应哪条路由”，
// 不再重复维护相同的容器结构与事件透传模板。
const handleTabChange = (value: string | number) => {
  emit('tab-change', value)
}
</script>

<template>
  <PageContainer :title="props.title" :description="props.description">
    <div :class="['rounded-2xl bg-white p-4 shadow-sm dark:bg-slate-800', props.cardClass]">
      <el-tabs :model-value="props.activeTab" @tab-change="handleTabChange">
        <el-tab-pane
          v-for="tab in props.tabs"
          :key="tab.name"
          :label="tab.label"
          :name="tab.name"
        />
      </el-tabs>

      <div :class="['embedded-page', props.contentClass]">
        <transition name="workbench-horizontal-slide">
          <keep-alive v-if="props.keepAlive">
            <component :is="props.activeComponent" :key="props.activeTab" class="workbench-horizontal-slide__panel" />
          </keep-alive>
          <component
            :is="props.activeComponent"
            v-else
            :key="props.activeTab"
            class="workbench-horizontal-slide__panel"
          />
        </transition>
      </div>
    </div>
  </PageContainer>
</template>

<style scoped>
.embedded-page {
  position: relative;
  overflow: hidden;
}

.workbench-horizontal-slide__panel {
  width: 100%;
  backface-visibility: hidden;
  transform: translateZ(0);
}

.workbench-horizontal-slide-enter-active {
  transition:
    transform 0.32s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform, opacity;
  position: relative;
  z-index: 2;
}

.workbench-horizontal-slide-leave-active {
  transition:
    transform 0.24s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform, opacity;
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}

.workbench-horizontal-slide-enter-from {
  transform: translate3d(28px, 0, 0);
  opacity: 0;
}

.workbench-horizontal-slide-leave-to {
  transform: translate3d(-20px, 0, 0);
  opacity: 0;
}

/* 工作台内部承载的是“已存在的完整页面”，
   这里统一隐藏子页面原本自带的标题头，避免页面套页面后双标题重复。 */
.embedded-page :deep(section > header) {
  display: none;
}
</style>
