<script setup lang="ts">
/**
 * 模块说明：src/components/common/page-shared/TabbedWorkbenchPage.vue
 * 文件职责：提供基于 Tab 切换的页面容器壳，统一页头、标签区与内容舞台的视觉层级，并支持页面级组件缓存。
 * 实现逻辑：
 * - 通过统一的工作台卡片壳层承接标题说明、标签切换和业务内容区域；
 * - 通过 KeepAlive 保持子页面状态，避免在工作台标签间切换时丢失录入与筛选上下文；
 * - 通过局部过渡与深度样式覆盖，为聚合后的业务页面提供一致且克制的切换反馈。
 * 维护说明：
 * - 若后续新增工作台页签，优先复用本组件的视觉与动效约束，不要在业务页重复搭建一套 Tab 容器；
 * - 当前组件默认会隐藏嵌套页面的二级页头，避免出现双标题与重复说明。
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
  <PageContainer>
    <div
      :class="[
        'supplier-workbench-shell overflow-hidden rounded-[30px] border border-slate-200/70 bg-white/95 shadow-[0_18px_48px_-40px_rgba(15,23,42,0.22)] dark:border-slate-700/80 dark:bg-slate-800/95',
        props.cardClass,
      ]"
    >
      <div class="supplier-workbench-shell__hero border-b border-slate-200/70 px-5 py-4 sm:px-6 sm:py-5 dark:border-slate-700/80">
        <div class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div v-if="props.title || props.description" class="min-w-0 space-y-1 xl:flex-none xl:pr-4">
            <div class="space-y-1">
              <h2 class="text-lg font-semibold leading-tight tracking-tight text-slate-900 dark:text-slate-100 sm:text-xl xl:whitespace-nowrap">
                {{ props.title }}
              </h2>
              <p v-if="props.description" class="max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">
                {{ props.description }}
              </p>
            </div>
          </div>

          <div class="supplier-workbench-shell__tab-wrap">
            <el-tabs :model-value="props.activeTab" @tab-change="handleTabChange">
              <el-tab-pane
                v-for="tab in props.tabs"
                :key="tab.name"
                :label="tab.label"
                :name="tab.name"
              />
            </el-tabs>
          </div>
        </div>
      </div>

      <div :class="['embedded-page px-3 pb-3 pt-3 sm:px-4 sm:pb-4 sm:pt-4', props.contentClass]">
        <transition name="workbench-horizontal-slide" mode="out-in" appear>
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
/* 工作台主壳层：
 * - 仅保留轻量背景与留白，避免壳层的存在感盖过内部业务页面；
 * - 工作台统一负责标签切换和单层页头，不再叠加装饰性徽标。
 */
.supplier-workbench-shell__hero {
  background:
    linear-gradient(180deg, rgba(248, 250, 252, 0.88), rgba(255, 255, 255, 0.96));
}

.supplier-workbench-shell__tab-wrap {
  width: 100%;
  min-width: 0;
}

.embedded-page {
  position: relative;
  overflow: hidden;
  min-height: 240px;
}

.workbench-horizontal-slide__panel {
  width: 100%;
  backface-visibility: hidden;
  transform: translateZ(0);
}

.workbench-horizontal-slide-enter-active {
  transition:
    transform 0.18s ease,
    opacity 0.16s ease;
  will-change: transform, opacity;
  position: relative;
  z-index: 2;
}

.workbench-horizontal-slide-leave-active {
  transition:
    transform 0.14s ease,
    opacity 0.12s ease;
  will-change: transform, opacity;
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}

.workbench-horizontal-slide-enter-from {
  transform: translate3d(8px, 0, 0);
  opacity: 0;
}

.workbench-horizontal-slide-leave-to {
  transform: translate3d(-6px, 0, 0);
  opacity: 0;
}

/* 工作台内部承载的是“已存在的完整页面”，
   这里统一隐藏子页面原本自带的标题头，避免页面套页面后双标题重复。 */
.embedded-page :deep(section > header) {
  display: none;
}

/* 统一工作台标签视觉：
 * - 让标签像工作台模式切换按钮，而不是默认的细线标签；
 * - 同时保留 Element Plus 原有交互与键盘可访问性。
 */
.supplier-workbench-shell :deep(.el-tabs__header) {
  margin: 0;
}

.supplier-workbench-shell :deep(.el-tabs__nav-wrap::after) {
  display: none;
}

.supplier-workbench-shell :deep(.el-tabs__nav-scroll) {
  overflow: auto;
  padding-bottom: 2px;
}

.supplier-workbench-shell :deep(.el-tabs__nav) {
  display: inline-flex;
  gap: 0.5rem;
  border-radius: 999px;
  border: 1px solid rgba(203, 213, 225, 0.9);
  background: rgba(248, 250, 252, 0.96);
  padding: 0.35rem;
}

.supplier-workbench-shell :deep(.el-tabs__active-bar) {
  display: none;
}

.supplier-workbench-shell :deep(.el-tabs__item) {
  height: auto;
  border-radius: 999px;
  padding: 0.68rem 1.05rem;
  color: rgb(51 65 85);
  font-weight: 600;
  line-height: 1.2;
  transition:
    color 0.16s ease,
    background-color 0.16s ease,
    box-shadow 0.16s ease;
}

.supplier-workbench-shell :deep(.el-tabs__item:hover) {
  color: rgb(15 23 42);
  background: rgba(241, 245, 249, 0.88);
}

.supplier-workbench-shell :deep(.el-tabs__item.is-active) {
  color: rgb(15 118 110);
  background: rgba(204, 251, 241, 0.72);
  box-shadow: inset 0 0 0 1px rgba(94, 234, 212, 0.4);
}

.supplier-workbench-shell :deep(.el-tabs__content) {
  display: none;
}

@media (max-width: 767px) {
  .supplier-workbench-shell__hero {
    background: linear-gradient(180deg, rgba(248, 250, 252, 0.92), rgba(255, 255, 255, 0.98));
  }

  .supplier-workbench-shell :deep(.el-tabs__item) {
    padding: 0.62rem 0.9rem;
    font-size: 0.92rem;
  }
}

@media (min-width: 1280px) {
  /* 横向布局下让标签区按内容宽度占位，避免挤压标题导致中文断行。 */
  .supplier-workbench-shell__tab-wrap {
    width: auto;
    flex-shrink: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workbench-horizontal-slide-enter-active,
  .workbench-horizontal-slide-leave-active,
  .supplier-workbench-shell :deep(.el-tabs__item) {
    transition: none;
  }
}
</style>
