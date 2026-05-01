<script setup lang="ts">
/**
 * 模块说明：src/components/common/business-composite/BizCrudDialogShell.vue
 * 文件职责：提供后台通用 CRUD 弹窗壳，统一封装宽度策略、关闭回传、底部按钮，以及“短内容自适应 / 长内容滚动”两套高度模式。
 * 实现逻辑：
 * - 根据手机、平板、桌面三端状态自动计算弹窗宽度；
 * - 对外统一透传 `update:modelValue`、`confirm` 与 `closed` 事件，页面层只维护业务状态；
 * - 通过统一类名挂接全局弹窗纵向安全网，并显式表达 `auto / scroll` 高度模式，避免继续依赖业务白名单修补短弹窗高度。
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
  heightMode?: 'auto' | 'scroll'
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
  heightMode: 'scroll',
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
 * - 将高度模式转成显式类名，避免页面继续依赖全局白名单；
 * - 若页面另传业务类名，则与公共类名一起生效，不覆盖业务侧视觉定制。
 */
const dialogClassName = computed(() => {
  return ['ylink-crud-dialog-shell', `ylink-dialog-height-mode--${props.heightMode}`, props.dialogClass].filter(Boolean).join(' ')
})

/**
 * 统一遮罩层类名：
 * - BizCrudDialogShell 默认启用 `align-center`，Element Plus 会把 `.el-overlay-dialog` 设为 flex 容器；
 * - 若遮罩层不显式声明对齐语义，短内容弹窗虽然 footer 会被拉回，但外层白色卡片仍可能继续按最大高度参与布局；
 * - 因此在遮罩层挂接专用类名，让全局样式能够从根节点修复“卡片本体未缩小”的结构问题。
 */
const modalClassName = computed(() => {
  return ['ylink-crud-dialog-shell-overlay', `ylink-crud-dialog-shell-overlay--${props.heightMode}`].join(' ')
})

/**
 * 统一正文包裹类名：
 * - `scroll` 模式下补齐 `min-height: 0`，让长表单可以在弹窗正文安全滚动；
 * - `auto` 模式保持内容自然撑高，不再人为拉伸内部容器。
 */
const bodyWrapperClassName = computed(() => {
  return ['min-w-0', props.heightMode === 'scroll' ? 'min-h-0' : ''].filter(Boolean).join(' ')
})

/**
 * 统一正文类名：
 * - 直接挂到 Element Plus 的 `.el-dialog__body` 上，避免继续依赖外层选择器层级是否稳定；
 * - `auto` / `scroll` 两种模式都能精确命中真实正文节点，确保短弹窗本体高度真正受控。
 */
const bodyClassName = computed(() => {
  return ['ylink-crud-dialog-shell__body', `ylink-crud-dialog-shell__body--${props.heightMode}`].join(' ')
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
    :modal-class="modalClassName"
    :body-class="bodyClassName"
    :destroy-on-close="props.destroyOnClose"
    :append-to-body="props.appendToBody"
    :align-center="props.alignCenter"
    :class="dialogClassName"
    @update:model-value="emit('update:modelValue', $event)"
    @closed="handleClosed"
  >
    <div :class="bodyWrapperClassName">
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
