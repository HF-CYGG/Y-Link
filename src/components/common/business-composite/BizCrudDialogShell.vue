<script setup lang="ts">
/**
 * 模块说明：src/components/common/business-composite/BizCrudDialogShell.vue
 * 文件职责：提供后台通用 CRUD 弹窗壳，统一封装宽度策略、关闭回传、底部按钮与低高度视口下的结构稳定性。
 * 实现逻辑：
 * - 根据手机、平板、桌面三端状态自动计算弹窗宽度；
 * - 对外统一透传 `update:modelValue`、`confirm` 与 `closed` 事件，页面层只维护业务状态；
 * - 通过统一类名挂接全局弹窗纵向安全网，避免长表单弹窗在低高度视口下出现底部按钮被挤掉的问题。
 * 维护说明：
 * - 若后续需要扩展“只读弹窗”“无底部按钮弹窗”等能力，应优先在此处扩展，而不是各业务页重复拼装 `el-dialog`。
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
  appendToBody?: boolean
  alignCenter?: boolean
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
  appendToBody: true,
  alignCenter: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: []
  closed: []
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
 * 统一弹窗类名：
 * - 固定挂载公共壳类名，便于全局样式精准命中；
 * - 若页面另传业务类名，则与公共类名一起生效，不覆盖业务侧视觉定制。
 */
const dialogClassName = computed(() => {
  return ['ylink-crud-dialog-shell', props.dialogClass].filter(Boolean).join(' ')
})

/**
 * 关闭弹窗：
 * - 统一通过 update:modelValue 回传给父组件；
 * - 让页面层只维护单一 visible 状态源。
 */
const handleClose = () => {
  emit('update:modelValue', false)
}

/**
 * 关闭完成回调：
 * - 与 Element Plus 的 `closed` 语义保持一致；
 * - 供页面在动画结束后安全重置表单、清理校验与临时状态。
 */
const handleClosed = () => {
  emit('closed')
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="props.title"
    :width="dialogWidth"
    :destroy-on-close="props.destroyOnClose"
    :append-to-body="props.appendToBody"
    :align-center="props.alignCenter"
    :class="dialogClassName"
    @update:model-value="emit('update:modelValue', $event)"
    @closed="handleClosed"
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
