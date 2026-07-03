<script setup lang="ts">
/**
 * 模块说明：src/components/common/page-shared/PassiveSegmentedTabs.vue
 * 文件职责：提供不依赖 Element Plus Tabs 的轻量标签切换组件，避免 tab-nav 注册非被动 wheel 监听。
 * 实现逻辑：
 * - 通过 Element Plus Segmented 承载单选切换，复用既有表单控件的键盘与焦点能力；
 * - 对外保持 modelValue、update:modelValue 与 tab-change 事件，方便替换工作台和详情区标签；
 * - 视觉层默认收敛为下划线标签风格，延续现有工作台标签的低干扰体验。
 * 维护说明：
 * - 新增页面级标签优先复用本组件，不要回退到 el-tabs；
 * - 若后续要扩展更多标签状态，先补充 tabs 选项字段，再保持事件契约稳定。
 */
import { computed } from 'vue'

export interface PassiveSegmentedTabOption {
  label: string
  name: string | number
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  modelValue: string | number
  tabs: ReadonlyArray<PassiveSegmentedTabOption>
  ariaLabel?: string
  block?: boolean
  size?: '' | 'large' | 'default' | 'small'
}>(), {
  ariaLabel: '页面标签',
  block: false,
  size: '',
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string | number): void
  (event: 'tab-change', value: string | number): void
}>()

const segmentedOptions = computed(() => props.tabs.map((tab) => ({
  label: tab.label,
  value: tab.name,
  disabled: tab.disabled === true,
})))

const handleValueUpdate = (value: string | number | boolean) => {
  if (typeof value === 'boolean') {
    return
  }

  emit('update:modelValue', value)
  emit('tab-change', value)
}
</script>

<template>
  <nav class="passive-segmented-tabs" :aria-label="props.ariaLabel">
    <el-segmented
      :model-value="props.modelValue"
      :options="segmentedOptions"
      :block="props.block"
      :size="props.size || undefined"
      :aria-label="props.ariaLabel"
      @update:model-value="handleValueUpdate"
    />
  </nav>
</template>

<style scoped>
.passive-segmented-tabs {
  width: 100%;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.passive-segmented-tabs :deep(.el-segmented) {
  --el-segmented-bg-color: transparent;
  --el-segmented-item-selected-bg-color: transparent;
  --el-segmented-item-selected-color: rgb(13 148 136);
  --el-segmented-item-hover-bg-color: transparent;
  --el-segmented-item-hover-color: rgb(15 23 42);
  display: inline-flex;
  width: max-content;
  max-width: 100%;
  min-width: 0;
  padding: 0;
  background: transparent;
  border-radius: 0;
}

.passive-segmented-tabs :deep(.el-segmented.is-block) {
  width: 100%;
}

.passive-segmented-tabs :deep(.el-segmented__group) {
  min-width: 0;
  gap: 0;
}

.passive-segmented-tabs :deep(.el-segmented__item) {
  min-width: max-content;
  border-radius: 0;
  color: rgb(51 65 85);
  font-weight: 600;
  line-height: 1.2;
  transition:
    color 0.16s ease,
    opacity 0.16s ease;
}

.passive-segmented-tabs :deep(.el-segmented__item-label) {
  padding: 0.85rem 1.15rem;
}

.passive-segmented-tabs :deep(.el-segmented__item-selected) {
  border-radius: 0;
  background: transparent;
  box-shadow: inset 0 -2px 0 rgb(13 148 136);
}

.passive-segmented-tabs :deep(.el-segmented__item.is-selected) {
  color: rgb(13 148 136);
}

.passive-segmented-tabs :deep(.el-segmented__item:not(.is-disabled):hover) {
  color: rgb(15 23 42);
}

@media (max-width: 767px) {
  .passive-segmented-tabs :deep(.el-segmented__item-label) {
    padding: 0.78rem 0.82rem;
    font-size: 0.92rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .passive-segmented-tabs :deep(.el-segmented__item) {
    transition: none;
  }
}
</style>
