<script setup lang="ts">
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
</script>

<template>
  <el-drawer
    :model-value="props.modelValue"
    :direction="drawerDirection"
    :size="drawerSize"
    :destroy-on-close="props.destroyOnClose"
    :modal="props.modal"
    :close-on-click-modal="props.closeOnClickModal"
    :class="props.drawerClass"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <slot name="header" :is-phone="appStore.isPhone" :is-tablet="appStore.isTablet" :is-desktop="appStore.isDesktop">
        <span>{{ props.title }}</span>
      </slot>
    </template>
    <div v-loading="props.loading" :class="['h-full min-w-0 overflow-y-auto pr-2', props.bodyClass]">
      <slot :is-phone="appStore.isPhone" :is-tablet="appStore.isTablet" :is-desktop="appStore.isDesktop" />
    </div>
  </el-drawer>
</template>
