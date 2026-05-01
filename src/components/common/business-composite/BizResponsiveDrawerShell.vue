<script setup lang="ts">
/**
 * 模块说明：src/components/common/business-composite/BizResponsiveDrawerShell.vue
 * 文件职责：提供后台通用响应式抽屉壳，统一三端尺寸、方向，以及“短内容自适应 / 长内容滚动”两套正文高度模式。
 * 实现逻辑：
 * - 根据设备类型自动切换抽屉方向与尺寸；
 * - 通过抽屉根类名与正文模式类名，把滚动职责统一收敛到壳层；
 * - 页面层只表达业务内容，不再默认继承固定的 `h-full + overflow-y-auto` 行为。
 */


import { computed } from 'vue'
import { useAppStore } from '@/store'

/**
 * 响应式抽屉壳参数：
 * - 统一处理三端方向与尺寸差异；
 * - 页面只保留“何时打开、内部展示什么”的业务逻辑。
 */
interface Props {
  modelValue: boolean
  title: string
  heightMode?: 'auto' | 'scroll'
  phoneSize?: string
  tabletSize?: string
  desktopSize?: string
  phoneDirection?: 'ltr' | 'rtl' | 'ttb' | 'btt'
  defaultDirection?: 'ltr' | 'rtl' | 'ttb' | 'btt'
  loading?: boolean
  bodyClass?: string
  drawerClass?: string
  destroyOnClose?: boolean
  modal?: boolean
  closeOnClickModal?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  heightMode: 'scroll',
  phoneSize: '88%',
  tabletSize: '72%',
  desktopSize: '600px',
  phoneDirection: 'btt',
  defaultDirection: 'rtl',
  loading: false,
  bodyClass: '',
  drawerClass: '',
  destroyOnClose: true,
  modal: true,
  closeOnClickModal: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const appStore = useAppStore()

/**
 * 抽屉展开方向：
 * - 手机端更适合底部弹出，降低单手操作距离；
 * - 平板与桌面端保持右侧滑入，保留纵向阅读空间。
 */
const drawerDirection = computed(() => {
  return appStore.isPhone ? props.phoneDirection : props.defaultDirection
})

/**
 * 抽屉尺寸策略：
 * - phone 使用百分比高度贴近移动端交互；
 * - tablet 使用相对宽度；
 * - desktop 维持固定阅读宽度。
 */
const drawerSize = computed(() => {
  if (appStore.isPhone) {
    return props.phoneSize
  }

  if (appStore.isTablet) {
    return props.tabletSize
  }

  return props.desktopSize
})

/**
 * 抽屉根类名：
 * - 固定挂接共享抽屉壳类名，便于在全局样式中统一治理高度与滚动；
 * - 将高度模式映射为显式类名，减少页面继续通过业务类名“猜测式”覆写。
 */
const drawerClassName = computed(() => {
  return ['ylink-responsive-drawer-shell', `ylink-drawer-height-mode--${props.heightMode}`, props.drawerClass].filter(Boolean).join(' ')
})

/**
 * 抽屉正文容器类名：
 * - `scroll` 模式让壳层自身成为唯一主滚动容器；
 * - `auto` 模式保持内容自然生长，供短内容说明抽屉或轻量确认抽屉使用。
 */
const bodyWrapperClassName = computed(() => {
  return [
    'ylink-responsive-drawer-shell__body',
    `ylink-responsive-drawer-shell__body--${props.heightMode}`,
    'min-w-0',
    props.bodyClass,
  ].filter(Boolean).join(' ')
})
</script>

<template>
  <el-drawer
    :model-value="props.modelValue"
    :direction="drawerDirection"
    :size="drawerSize"
    :destroy-on-close="props.destroyOnClose"
    :modal="props.modal"
    :close-on-click-modal="props.closeOnClickModal"
    :class="drawerClassName"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <slot name="header" :is-phone="appStore.isPhone" :is-tablet="appStore.isTablet" :is-desktop="appStore.isDesktop">
        <span>{{ props.title }}</span>
      </slot>
    </template>
    <div v-loading="props.loading" :class="bodyWrapperClassName">
      <slot :is-phone="appStore.isPhone" :is-tablet="appStore.isTablet" :is-desktop="appStore.isDesktop" />
    </div>
  </el-drawer>
</template>
