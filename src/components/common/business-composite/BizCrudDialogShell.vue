<script setup lang="ts">
/**
 * 模块说明：src/components/common/business-composite/BizCrudDialogShell.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed } from 'vue'
import { useAppStore } from '@/store'

/**
 * 通用 CRUD 弹窗壳参数：
 * - 三端宽度由组件内部统一计算，页面只传业务差异；
 * - confirmLoading / confirmText / cancelText 统一底部交互体验。
 */
interface Props {
  modelValue: boolean
  title: string
  phoneWidth?: string
  tabletWidth?: string
  desktopWidth?: string
  confirmLoading?: boolean
  confirmText?: string
  cancelText?: string
  dialogClass?: string
  destroyOnClose?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  phoneWidth: '92%',
  tabletWidth: '640px',
  desktopWidth: '500px',
  confirmLoading: false,
  confirmText: '确认',
  cancelText: '取消',
  dialogClass: '',
  destroyOnClose: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
}>()

const appStore = useAppStore()

/**
 * 弹窗宽度策略：
 * - phone 优先接近全屏，提高表单可读性；
 * - tablet 使用中等宽度，减少字段换行；
 * - desktop 维持经典 CRUD 弹窗尺寸。
 */
const dialogWidth = computed(() => {
  if (appStore.isPhone) {
    return props.phoneWidth
  }

  if (appStore.isTablet) {
    return props.tabletWidth
  }

  return props.desktopWidth
})

/**
 * 关闭弹窗：
 * - 统一通过 update:modelValue 回传给父组件；
 * - 让页面层只维护单一 visible 状态源。
 */
const handleClose = () => {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="props.title"
    :width="dialogWidth"
    :destroy-on-close="props.destroyOnClose"
    :class="props.dialogClass"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="min-w-0">
      <slot :is-phone="appStore.isPhone" :is-tablet="appStore.isTablet" :is-desktop="appStore.isDesktop" />
    </div>

    <template #footer>
      <slot name="footer" :close="handleClose">
        <span class="flex flex-wrap justify-end gap-2">
          <el-button @click="handleClose">{{ props.cancelText }}</el-button>
          <el-button type="primary" :loading="props.confirmLoading" @click="emit('confirm')">
            {{ props.confirmText }}
          </el-button>
        </span>
      </slot>
    </template>
  </el-dialog>
</template>
