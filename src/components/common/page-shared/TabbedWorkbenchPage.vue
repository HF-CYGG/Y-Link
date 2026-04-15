<script setup lang="ts">
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
        <keep-alive v-if="props.keepAlive">
          <component :is="props.activeComponent" />
        </keep-alive>
        <component :is="props.activeComponent" v-else />
      </div>
    </div>
  </PageContainer>
</template>

<style scoped>
/* 工作台内部承载的是“已存在的完整页面”，
   这里统一隐藏子页面原本自带的标题头，避免页面套页面后双标题重复。 */
.embedded-page :deep(section > header) {
  display: none;
}
</style>
