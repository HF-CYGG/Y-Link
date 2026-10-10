<script setup lang="ts">
/**
 * 模块说明：src/layout/components/ThemeToggle.vue
 * 文件职责：提供全站统一的亮暗主题切换开关，被管理端顶栏、管理端登录页、客户端主壳层与客户端登录/找回密码页共用。
 * 实现逻辑：
 * - 采用 Element Plus `el-switch`，通过 active/inactive-action-icon 在滑块内显示月亮/太阳，外观对齐 Element Plus 官网开关；
 * - 开关只做展示与触发：before-change 一律返回 false，由 Theme Store 执行切换，开关状态再从 Store 回流，保证单一真源；
 * - 记录最近一次指针按下位置，传给 Store 作为圆形揭幕动画的起点；键盘触发时退回到开关中心点。
 * 维护说明：
 * - 主题持久化、跟随系统与 DOM 类名同步都在 Theme Store 中，组件内不要直接写 localStorage 或 html 类名；
 * - 新增放置位置时直接复用本组件，不要复制一份样式，避免各端开关外观分叉。
 */

import { Moon, Sunny } from '@element-plus/icons-vue'
import { computed, ref } from 'vue'
import { useThemeStore } from '@/store'
import pinia from '@/store/pinia'

const themeStore = useThemeStore(pinia)
const switchRootRef = ref<HTMLElement | null>(null)

/**
 * 最近一次指针按下的位置：
 * - el-switch 的 before-change 拿不到原始点击事件，因此在捕获阶段先记下坐标；
 * - 超过 1 秒的旧坐标视为失效，避免键盘切换误用很久之前的点击点。
 */
let lastPointer: { x: number; y: number; at: number } | null = null

const toggleLabel = computed(() => (themeStore.isDark ? '切换为亮色模式' : '切换为深色模式'))

const handlePointerDown = (event: PointerEvent) => {
  lastPointer = { x: event.clientX, y: event.clientY, at: Date.now() }
}

/**
 * 构造动画起点事件：
 * - Store 依据 MouseEvent 的 clientX/clientY 与 detail 判断是否为真实点击；
 * - 没有有效指针坐标时取开关中心，保证键盘切换的揭幕动画也从开关处展开。
 */
const buildTriggerEvent = () => {
  if (lastPointer && Date.now() - lastPointer.at < 1000) {
    return new MouseEvent('click', { clientX: lastPointer.x, clientY: lastPointer.y, detail: 1 })
  }
  const rect = switchRootRef.value?.getBoundingClientRect()
  if (!rect) {
    return undefined
  }
  return new MouseEvent('click', {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    detail: 1,
  })
}

const handleBeforeChange = () => {
  const triggerEvent = buildTriggerEvent()
  lastPointer = null
  void themeStore.toggleTheme(triggerEvent)
  return false
}
</script>

<template>
  <span ref="switchRootRef" class="theme-toggle" @pointerdown.capture="handlePointerDown">
    <el-switch
      class="theme-toggle__switch"
      :model-value="themeStore.isDark"
      :active-action-icon="Moon"
      :inactive-action-icon="Sunny"
      :before-change="handleBeforeChange"
      :disabled="themeStore.isTransitioning"
      :aria-label="toggleLabel"
      :title="toggleLabel"
    />
  </span>
</template>

<style scoped>
/*
 * 开关外观对齐 Element Plus 官网：
 * - 亮色：浅灰轨道 + 白色滑块 + 深灰太阳；暗色：深灰轨道 + 深色滑块 + 浅色月亮；
 * - 切换中禁用态不降低透明度，避免动画期间开关闪灰。
 */
.theme-toggle {
  display: inline-flex;
  align-items: center;
  line-height: 0;
}

.theme-toggle__switch {
  --el-switch-on-color: #2c2c2c;
  --el-switch-off-color: #f2f2f2;
  height: 24px;
}

.theme-toggle__switch :deep(.el-switch__core) {
  border: 1px solid var(--el-border-color);
}

.theme-toggle__switch :deep(.el-switch__action) {
  background-color: #ffffff;
  color: #303133;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
}

.theme-toggle__switch.is-checked :deep(.el-switch__action) {
  background-color: #141414;
  color: #cfd3dc;
}

.theme-toggle__switch.is-disabled {
  opacity: 1;
}

.theme-toggle__switch.is-disabled :deep(.el-switch__core),
.theme-toggle__switch.is-disabled :deep(.el-switch__label) {
  cursor: wait;
}

:global(.dark .theme-toggle .el-switch__core) {
  border-color: #4c4d4f;
}
</style>
