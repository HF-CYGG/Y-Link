<script setup lang="ts">
/**
 * 模块说明：src/layout/components/ThemeToggle.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { Moon, Sunny } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useThemeStore } from '@/store'

/**
 * 主题切换状态：
 * - 统一改由 Theme Store 托管，组件只负责触发交互；
 * - 点击事件会把触发点传给 Store，用于全局圆形扩散/收缩动画。
 */
const themeStore = useThemeStore()

/**
 * 可访问性文案：
 * - 根据当前主题输出下一步动作，方便读屏用户理解按钮作用；
 * - 同时复用在标题提示中，保证桌面端 hover 与无障碍语义一致。
 */
const toggleLabel = computed(() => (themeStore.isDark ? '切换为亮色模式' : '切换为深色模式'))

/**
 * 执行主题切换：
 * - 鼠标点击时传入真实坐标，触发点击点动画；
 * - 键盘触发时 Store 会自动退回到按钮中心点。
 */
const handleToggleTheme = async (event: MouseEvent) => {
  await themeStore.toggleTheme(event)
}
</script>

<template>
  <button
    type="button"
    class="theme-toggle"
    :class="{
      'is-dark': themeStore.isDark,
      'is-transitioning': themeStore.isTransitioning,
    }"
    :aria-label="toggleLabel"
    :title="toggleLabel"
    :aria-pressed="themeStore.isDark"
    :disabled="themeStore.isTransitioning"
    @click="handleToggleTheme"
  >
    <span class="theme-toggle__track">
      <span class="theme-toggle__backdrop theme-toggle__backdrop--sun" aria-hidden="true">
        <span class="theme-toggle__halo"></span>
      </span>

      <span class="theme-toggle__backdrop theme-toggle__backdrop--moon" aria-hidden="true">
        <span class="theme-toggle__star theme-toggle__star--lg"></span>
        <span class="theme-toggle__star theme-toggle__star--md"></span>
        <span class="theme-toggle__star theme-toggle__star--sm"></span>
      </span>

      <span class="theme-toggle__thumb" aria-hidden="true">
        <span class="theme-toggle__thumb-gloss"></span>
        <el-icon class="theme-toggle__icon theme-toggle__icon--sun" size="14">
          <Sunny />
        </el-icon>
        <el-icon class="theme-toggle__icon theme-toggle__icon--moon" size="14">
          <Moon />
        </el-icon>
      </span>
    </span>
  </button>
</template>

<style scoped>
/**
 * 主题切换器：
 * - 使用共享组件承接登录页与主系统页的同一套交互语言；
 * - 轨道、滑块、图标、按压反馈都在组件内部闭环，避免页面侧出现体验分叉。
 */
.theme-toggle {
  --toggle-width: 56px;
  --toggle-height: 32px;
  --toggle-padding: 3px;
  --toggle-thumb-size: 26px;
  --toggle-thumb-shift: calc(var(--toggle-width) - var(--toggle-thumb-size) - var(--toggle-padding) * 2);
  --toggle-duration: 420ms;
  --toggle-easing: cubic-bezier(0.22, 1, 0.36, 1);
  --toggle-press-scale: 0.97;
  --toggle-track-bg:
    linear-gradient(135deg, rgba(255, 255, 255, 0.95), rgba(226, 232, 240, 0.96)),
    linear-gradient(180deg, #eff6ff, #e2e8f0);
  --toggle-track-border: rgba(148, 163, 184, 0.35);
  --toggle-track-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.85),
    inset 0 -10px 16px rgba(148, 163, 184, 0.18),
    0 8px 18px rgba(15, 23, 42, 0.08);
  --toggle-thumb-bg:
    radial-gradient(circle at 35% 30%, #ffffff 0, #fff9d8 32%, #ffd978 72%, #f59e0b 100%);
  --toggle-thumb-shadow:
    0 10px 20px rgba(245, 158, 11, 0.28),
    inset 0 1px 1px rgba(255, 255, 255, 0.9);
  --toggle-thumb-border: rgba(255, 255, 255, 0.9);
  --toggle-icon-sun-color: #c2410c;
  --toggle-icon-moon-color: #dbeafe;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--toggle-width);
  height: var(--toggle-height);
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition:
    transform 180ms ease,
    filter 220ms ease,
    opacity 220ms ease;
}

.theme-toggle.is-dark {
  --toggle-track-bg:
    radial-gradient(circle at 22% 50%, rgba(34, 197, 94, 0.08), transparent 36%),
    linear-gradient(135deg, rgba(30, 41, 59, 0.98), rgba(15, 23, 42, 0.98)),
    linear-gradient(180deg, #111827, #020617);
  --toggle-track-border: rgba(148, 163, 184, 0.16);
  --toggle-track-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    inset 0 -10px 16px rgba(2, 6, 23, 0.42),
    0 10px 24px rgba(2, 6, 23, 0.34);
  --toggle-thumb-bg:
    radial-gradient(circle at 35% 30%, #ffffff 0, #dbeafe 26%, #cbd5f5 46%, #8b5cf6 100%);
  --toggle-thumb-shadow:
    0 12px 24px rgba(79, 70, 229, 0.34),
    inset 0 1px 1px rgba(255, 255, 255, 0.8);
  --toggle-thumb-border: rgba(191, 219, 254, 0.7);
}

.theme-toggle:hover {
  filter: saturate(1.04);
}

.theme-toggle:active {
  transform: scale(var(--toggle-press-scale));
}

.theme-toggle:focus-visible {
  outline: none;
}

.theme-toggle:focus-visible .theme-toggle__track {
  box-shadow:
    var(--toggle-track-shadow),
    0 0 0 3px rgba(13, 148, 136, 0.16);
}

.theme-toggle.is-dark:focus-visible .theme-toggle__track {
  box-shadow:
    var(--toggle-track-shadow),
    0 0 0 3px rgba(94, 234, 212, 0.18);
}

.theme-toggle:disabled {
  cursor: wait;
  opacity: 0.92;
}

.theme-toggle__track {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--toggle-track-border);
  border-radius: 999px;
  background: var(--toggle-track-bg);
  box-shadow: var(--toggle-track-shadow);
  transition:
    background var(--toggle-duration) var(--toggle-easing),
    border-color var(--toggle-duration) var(--toggle-easing),
    box-shadow var(--toggle-duration) var(--toggle-easing);
}

.theme-toggle__track::before {
  content: '';
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0) 42%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 70%);
  opacity: 0.95;
  transition: opacity var(--toggle-duration) var(--toggle-easing);
}

.theme-toggle.is-dark .theme-toggle__track::before {
  opacity: 0.38;
}

.theme-toggle__backdrop {
  position: absolute;
  inset: 0;
  transition:
    opacity var(--toggle-duration) var(--toggle-easing),
    transform var(--toggle-duration) var(--toggle-easing),
    filter var(--toggle-duration) var(--toggle-easing);
}

.theme-toggle__backdrop--sun {
  opacity: 1;
  transform: translateX(0);
}

.theme-toggle.is-dark .theme-toggle__backdrop--sun {
  opacity: 0;
  transform: translateX(-8px) scale(0.96);
}

.theme-toggle__backdrop--moon {
  opacity: 0;
  transform: translateX(8px) scale(0.96);
}

.theme-toggle.is-dark .theme-toggle__backdrop--moon {
  opacity: 1;
  transform: translateX(0) scale(1);
}

.theme-toggle__halo {
  position: absolute;
  left: 8px;
  top: 7px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background:
    radial-gradient(circle, rgba(253, 224, 71, 0.95) 0, rgba(252, 211, 77, 0.82) 38%, rgba(251, 191, 36, 0) 74%);
  filter: blur(0.2px);
  transition:
    transform var(--toggle-duration) var(--toggle-easing),
    opacity var(--toggle-duration) var(--toggle-easing);
}

.theme-toggle:hover .theme-toggle__halo {
  transform: scale(1.08);
}

.theme-toggle__star {
  position: absolute;
  display: block;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 0 10px rgba(191, 219, 254, 0.45);
  transition:
    transform var(--toggle-duration) var(--toggle-easing),
    opacity var(--toggle-duration) var(--toggle-easing);
}

.theme-toggle__star::after {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  background: rgba(219, 234, 254, 0.26);
  filter: blur(3px);
}

.theme-toggle__star--lg {
  top: 7px;
  right: 12px;
  width: 4px;
  height: 4px;
}

.theme-toggle__star--md {
  top: 15px;
  right: 22px;
  width: 3px;
  height: 3px;
}

.theme-toggle__star--sm {
  top: 9px;
  right: 28px;
  width: 2px;
  height: 2px;
}

.theme-toggle.is-dark .theme-toggle__star--lg {
  transform: translateY(-1px) scale(1.1);
}

.theme-toggle.is-dark .theme-toggle__star--md {
  transform: translateY(1px);
}

.theme-toggle.is-dark .theme-toggle__star--sm {
  transform: translateY(-1px) scale(1.15);
}

.theme-toggle__thumb {
  position: absolute;
  left: var(--toggle-padding);
  top: var(--toggle-padding);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--toggle-thumb-size);
  height: var(--toggle-thumb-size);
  border: 1px solid var(--toggle-thumb-border);
  border-radius: 50%;
  background: var(--toggle-thumb-bg);
  box-shadow: var(--toggle-thumb-shadow);
  transform: translateX(0);
  transition:
    transform var(--toggle-duration) var(--toggle-easing),
    background var(--toggle-duration) var(--toggle-easing),
    box-shadow var(--toggle-duration) var(--toggle-easing),
    border-color var(--toggle-duration) var(--toggle-easing),
    width 220ms ease;
}

.theme-toggle.is-dark .theme-toggle__thumb {
  transform: translateX(var(--toggle-thumb-shift));
}

.theme-toggle:hover .theme-toggle__thumb {
  width: calc(var(--toggle-thumb-size) + 1px);
}

.theme-toggle:active .theme-toggle__thumb {
  width: calc(var(--toggle-thumb-size) + 3px);
}

.theme-toggle.is-dark:active .theme-toggle__thumb {
  transform: translateX(calc(var(--toggle-thumb-shift) - 3px));
}

.theme-toggle:not(.is-dark):active .theme-toggle__thumb {
  transform: translateX(3px);
}

.theme-toggle__thumb-gloss {
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0) 54%);
  opacity: 0.9;
}

.theme-toggle__icon {
  position: absolute;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    opacity 260ms ease,
    transform var(--toggle-duration) var(--toggle-easing),
    color var(--toggle-duration) var(--toggle-easing);
}

.theme-toggle__icon--sun {
  color: var(--toggle-icon-sun-color);
  opacity: 1;
  transform: rotate(0deg) scale(1);
}

.theme-toggle.is-dark .theme-toggle__icon--sun {
  opacity: 0;
  transform: rotate(-90deg) scale(0.45);
}

.theme-toggle__icon--moon {
  color: var(--toggle-icon-moon-color);
  opacity: 0;
  transform: rotate(90deg) scale(0.45);
}

.theme-toggle.is-dark .theme-toggle__icon--moon {
  opacity: 1;
  transform: rotate(0deg) scale(1);
}

.theme-toggle.is-transitioning .theme-toggle__thumb {
  animation: theme-toggle-float 520ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.theme-toggle.is-transitioning .theme-toggle__icon--sun,
.theme-toggle.is-transitioning .theme-toggle__icon--moon {
  animation: theme-toggle-icon-breathe 460ms ease;
}

@keyframes theme-toggle-float {
  0%,
  100% {
    filter: brightness(1);
  }

  50% {
    filter: brightness(1.06);
  }
}

@keyframes theme-toggle-icon-breathe {
  0%,
  100% {
    filter: brightness(1);
  }

  50% {
    filter: brightness(1.08);
  }
}

@media (prefers-reduced-motion: reduce) {
  .theme-toggle,
  .theme-toggle__track,
  .theme-toggle__backdrop,
  .theme-toggle__halo,
  .theme-toggle__star,
  .theme-toggle__thumb,
  .theme-toggle__icon {
    transition-duration: 0.01ms !important;
    animation: none !important;
  }

  .theme-toggle:active,
  .theme-toggle:active .theme-toggle__thumb,
  .theme-toggle.is-dark:active .theme-toggle__thumb,
  .theme-toggle:not(.is-dark):active .theme-toggle__thumb {
    transform: none !important;
  }
}
</style>
