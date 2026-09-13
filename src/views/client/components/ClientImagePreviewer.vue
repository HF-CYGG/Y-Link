<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientImagePreviewer.vue
 * 文件职责：承载客户端商城的商品原图预览层，保证超宽、超长图在低高度或缩放后的旧浏览器视口里初始完整可见，并可显式放大、缩小、重置查看细节。
 * 实现逻辑：
 * - 遮罩用 top/right/bottom/left 四向定位铺满布局视口，不依赖 `inset` 与 `dvh`；面板为“工具栏 + 舞台”纵向 flex，工具栏不收缩，低高度时只压缩舞台；
 * - 缩放通过改变图片真实宽高实现，放大后由舞台原生滚动条、触摸滑动或方向键平移，滚动边界即图片边缘，图片不会丢失在可视区外；
 * - 桌面鼠标可额外拖拽平移，双击在完整适配与 2 倍之间切换，但按钮与键盘（Esc / + / - / 0）始终可用；
 * - 打开时记录并转移焦点、Tab 在面板内循环、锁定页面滚动；关闭时全部还原。
 * 维护说明：
 * - 比例、档位与缩放锚点计算统一收口在 `client-image-preview.helpers.ts`，不要在模板或样式里另写魔法比例；
 * - 键盘事件在 window 捕获阶段处理并阻止继续传播，避免从商品详情抽屉打开时 Esc 同时关闭底层抽屉。
 */

import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useZIndex } from 'element-plus'
import { Close, RefreshLeft, ZoomIn, ZoomOut } from '@element-plus/icons-vue'

import {
  canZoomInFurther,
  clampZoomStepIndex,
  resolveImageFitScale,
  resolveImagePreviewScale,
  resolveZoomAnchoredScroll,
} from '../client-image-preview.helpers'

const props = withDefaults(defineProps<{
  visible: boolean
  src: string
  alt?: string
}>(), {
  alt: '商品原图',
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

// 预览层必须高于 Element Plus 抽屉/遮罩、商城移动端搜索层与悬浮购物车。
const PREVIEW_BASE_Z_INDEX = 4000
const QUICK_ZOOM_STEP_INDEX = 2
const DRAG_MOVE_THRESHOLD = 3

const { nextZIndex } = useZIndex()

const panelRef = ref<HTMLElement | null>(null)
const stageRef = ref<HTMLElement | null>(null)
const imageRef = ref<HTMLImageElement | null>(null)
const overlayZIndex = ref(PREVIEW_BASE_Z_INDEX)
const loadState = ref<'loading' | 'loaded' | 'error'>('loading')
const zoomStepIndex = ref(0)
const naturalSize = reactive({ width: 0, height: 0 })
const stageSize = reactive({ width: 0, height: 0 })

let previousActiveElement: HTMLElement | null = null
let previousBodyOverflow: string | null = null
let stageResizeObserver: ResizeObserver | null = null
let measureFrameId: number | null = null
let dragState: { pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number; moved: boolean } | null = null
let suppressNextStageClick = false

const fitScale = computed(() => resolveImageFitScale({
  naturalWidth: naturalSize.width,
  naturalHeight: naturalSize.height,
  stageWidth: stageSize.width,
  stageHeight: stageSize.height,
}))
const currentScale = computed(() => resolveImagePreviewScale(fitScale.value, zoomStepIndex.value))
const isImageReady = computed(() => loadState.value === 'loaded' && naturalSize.width > 0 && naturalSize.height > 0)
const imageStyle = computed(() => {
  if (!isImageReady.value) {
    return undefined
  }
  // 向下取整，避免完整适配时因亚像素进位多出 1px 触发滚动条。
  return {
    width: `${Math.max(1, Math.floor(naturalSize.width * currentScale.value))}px`,
    height: `${Math.max(1, Math.floor(naturalSize.height * currentScale.value))}px`,
  }
})
const zoomPercentText = computed(() => (isImageReady.value ? `${Math.round(currentScale.value * 100)}%` : '--'))
const canZoomOut = computed(() => isImageReady.value && zoomStepIndex.value > 0)
const canZoomIn = computed(() => isImageReady.value && canZoomInFurther(fitScale.value, zoomStepIndex.value))

const close = () => {
  emit('update:visible', false)
}

const measureStage = () => {
  const stage = stageRef.value
  if (!stage) {
    return
  }
  // 使用 offset 尺寸（含滚动条占位），放大出现滚动条时基准比例保持稳定，不会反复抖动。
  stageSize.width = stage.offsetWidth
  stageSize.height = stage.offsetHeight
}

const scheduleStageMeasure = () => {
  if (measureFrameId !== null) {
    return
  }
  measureFrameId = globalThis.window.requestAnimationFrame(() => {
    measureFrameId = null
    measureStage()
  })
}

const resetViewState = () => {
  zoomStepIndex.value = 0
  loadState.value = 'loading'
  naturalSize.width = 0
  naturalSize.height = 0
  const stage = stageRef.value
  if (stage) {
    stage.scrollLeft = 0
    stage.scrollTop = 0
  }
}

const handleImageLoad = () => {
  const image = imageRef.value
  if (!image || !image.naturalWidth || !image.naturalHeight) {
    loadState.value = 'error'
    return
  }
  naturalSize.width = image.naturalWidth
  naturalSize.height = image.naturalHeight
  loadState.value = 'loaded'
  measureStage()
}

const handleImageError = () => {
  loadState.value = 'error'
}

const applyZoomStep = async (nextIndex: number) => {
  const targetIndex = clampZoomStepIndex(nextIndex)
  const stage = stageRef.value
  if (!isImageReady.value || targetIndex === zoomStepIndex.value || !stage) {
    return
  }
  const nextScale = resolveImagePreviewScale(fitScale.value, targetIndex)
  const anchoredScroll = resolveZoomAnchoredScroll({
    scrollLeft: stage.scrollLeft,
    scrollTop: stage.scrollTop,
    stageWidth: stage.clientWidth,
    stageHeight: stage.clientHeight,
    previousWidth: naturalSize.width * currentScale.value,
    previousHeight: naturalSize.height * currentScale.value,
    nextWidth: naturalSize.width * nextScale,
    nextHeight: naturalSize.height * nextScale,
  })
  zoomStepIndex.value = targetIndex
  await nextTick()
  // 以舞台视觉中心为锚点换算新滚动位置，放大/缩小后用户正在看的区域不跳走。
  stage.scrollLeft = anchoredScroll.left
  stage.scrollTop = anchoredScroll.top
}

const zoomIn = () => {
  if (canZoomIn.value) {
    void applyZoomStep(zoomStepIndex.value + 1)
  }
}

const zoomOut = () => {
  if (canZoomOut.value) {
    void applyZoomStep(zoomStepIndex.value - 1)
  }
}

const resetZoom = () => {
  void applyZoomStep(0)
}

const toggleQuickZoom = () => {
  void applyZoomStep(zoomStepIndex.value > 0 ? 0 : QUICK_ZOOM_STEP_INDEX)
}

const resolveFocusableElements = () => {
  const panel = panelRef.value
  if (!panel) {
    return [] as HTMLElement[]
  }
  return Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
}

const trapFocus = (event: KeyboardEvent) => {
  const focusableElements = resolveFocusableElements()
  if (!focusableElements.length) {
    return
  }
  const first = focusableElements[0]
  const last = focusableElements[focusableElements.length - 1]
  const activeElement = globalThis.document.activeElement
  const focusInside = !!activeElement && !!panelRef.value?.contains(activeElement)
  if (event.shiftKey && (!focusInside || activeElement === first)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (!focusInside || activeElement === last)) {
    event.preventDefault()
    first.focus()
  }
}

const handleWindowKeydown = (event: KeyboardEvent) => {
  if (!props.visible) {
    return
  }
  const consume = () => {
    event.preventDefault()
    event.stopPropagation()
  }
  switch (event.key) {
    case 'Escape':
    case 'Esc':
      consume()
      close()
      break
    case '+':
    case '=':
    case 'Add':
      consume()
      zoomIn()
      break
    case '-':
    case '_':
    case 'Subtract':
      consume()
      zoomOut()
      break
    case '0':
      consume()
      resetZoom()
      break
    case 'Tab':
      trapFocus(event)
      break
    default:
      break
  }
}

const isStageOverflowing = (stage: HTMLElement) => {
  return stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight
}

const handleStagePointerDown = (event: PointerEvent) => {
  const stage = stageRef.value
  // 触屏与触控笔直接交给原生滚动，只为鼠标补充拖拽平移。
  if (!stage || event.pointerType !== 'mouse' || event.button !== 0 || !isStageOverflowing(stage)) {
    return
  }
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: stage.scrollLeft,
    scrollTop: stage.scrollTop,
    moved: false,
  }
  stage.setPointerCapture?.(event.pointerId)
}

const handleStagePointerMove = (event: PointerEvent) => {
  const stage = stageRef.value
  if (!stage || !dragState || dragState.pointerId !== event.pointerId) {
    return
  }
  const deltaX = event.clientX - dragState.startX
  const deltaY = event.clientY - dragState.startY
  if (!dragState.moved && Math.abs(deltaX) < DRAG_MOVE_THRESHOLD && Math.abs(deltaY) < DRAG_MOVE_THRESHOLD) {
    return
  }
  dragState.moved = true
  event.preventDefault()
  stage.scrollLeft = dragState.scrollLeft - deltaX
  stage.scrollTop = dragState.scrollTop - deltaY
}

const handleStagePointerEnd = (event: PointerEvent) => {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return
  }
  suppressNextStageClick = dragState.moved
  stageRef.value?.releasePointerCapture?.(event.pointerId)
  dragState = null
}

const handleStageBlankClick = () => {
  if (suppressNextStageClick) {
    suppressNextStageClick = false
    return
  }
  // 放大查看细节时点到空白处不应误关，只有完整适配状态下才沿用“点空白关闭”。
  if (zoomStepIndex.value === 0) {
    close()
  }
}

const lockBodyScroll = () => {
  const body = globalThis.document?.body
  if (!body || previousBodyOverflow !== null) {
    return
  }
  previousBodyOverflow = body.style.overflow
  body.style.overflow = 'hidden'
}

const unlockBodyScroll = () => {
  const body = globalThis.document?.body
  if (!body || previousBodyOverflow === null) {
    return
  }
  body.style.overflow = previousBodyOverflow
  previousBodyOverflow = null
}

const bindRuntimeListeners = () => {
  const win = globalThis.window
  win.addEventListener('keydown', handleWindowKeydown, true)
  win.addEventListener('resize', scheduleStageMeasure, { passive: true })
  win.addEventListener('orientationchange', scheduleStageMeasure)
  win.visualViewport?.addEventListener('resize', scheduleStageMeasure)
  if (typeof win.ResizeObserver === 'function' && stageRef.value) {
    stageResizeObserver = new win.ResizeObserver(() => scheduleStageMeasure())
    stageResizeObserver.observe(stageRef.value)
  }
}

const unbindRuntimeListeners = () => {
  const win = globalThis.window
  win.removeEventListener('keydown', handleWindowKeydown, true)
  win.removeEventListener('resize', scheduleStageMeasure)
  win.removeEventListener('orientationchange', scheduleStageMeasure)
  win.visualViewport?.removeEventListener('resize', scheduleStageMeasure)
  stageResizeObserver?.disconnect()
  stageResizeObserver = null
  if (measureFrameId !== null) {
    win.cancelAnimationFrame(measureFrameId)
    measureFrameId = null
  }
  dragState = null
  suppressNextStageClick = false
}

const handleOpen = async () => {
  const activeElement = globalThis.document.activeElement
  previousActiveElement = activeElement instanceof HTMLElement ? activeElement : null
  overlayZIndex.value = Math.max(PREVIEW_BASE_Z_INDEX, nextZIndex())
  resetViewState()
  lockBodyScroll()
  await nextTick()
  if (!props.visible) {
    return
  }
  bindRuntimeListeners()
  measureStage()
  const image = imageRef.value
  // 缓存命中的图片可能在监听绑定前已完成解码，这里补一次同步，避免一直停在加载态。
  if (image?.complete && image.naturalWidth > 0 && loadState.value === 'loading') {
    handleImageLoad()
  }
  stageRef.value?.focus({ preventScroll: true })
}

const handleClose = () => {
  unbindRuntimeListeners()
  unlockBodyScroll()
  const restoreTarget = previousActiveElement
  previousActiveElement = null
  if (restoreTarget && globalThis.document.body.contains(restoreTarget)) {
    restoreTarget.focus({ preventScroll: true })
  }
}

watch(
  () => props.visible,
  (visible, previousVisible) => {
    if (visible) {
      void handleOpen()
    } else if (previousVisible) {
      handleClose()
    }
  },
  { immediate: true },
)

watch(
  () => props.src,
  () => {
    if (props.visible) {
      resetViewState()
    }
  },
)

onBeforeUnmount(() => {
  if (props.visible) {
    handleClose()
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="client-image-previewer">
      <div
        v-if="visible"
        class="client-image-previewer"
        :style="{ zIndex: overlayZIndex }"
        role="dialog"
        aria-modal="true"
        :aria-label="`${alt}预览`"
        @click.self="close"
      >
        <section ref="panelRef" class="client-image-previewer__panel">
          <header class="client-image-previewer__toolbar">
            <div class="client-image-previewer__zoom-group" role="group" aria-label="缩放控制">
              <el-button :icon="ZoomOut" :disabled="!canZoomOut" aria-label="缩小" @click="zoomOut">缩小</el-button>
              <span class="client-image-previewer__ratio" aria-live="polite">{{ zoomPercentText }}</span>
              <el-button :icon="ZoomIn" :disabled="!canZoomIn" aria-label="放大" @click="zoomIn">放大</el-button>
              <el-button :icon="RefreshLeft" :disabled="!canZoomOut" aria-label="重置为完整显示" @click="resetZoom">适配</el-button>
            </div>
            <el-button type="primary" :icon="Close" aria-label="关闭预览" @click="close">关闭</el-button>
          </header>
          <div
            ref="stageRef"
            class="client-image-previewer__stage"
            :class="{ 'is-zoomed': zoomStepIndex > 0 }"
            tabindex="0"
            aria-label="图片查看区域，放大后可用方向键滚动"
            @click.self="handleStageBlankClick"
            @pointerdown="handleStagePointerDown"
            @pointermove="handleStagePointerMove"
            @pointerup="handleStagePointerEnd"
            @pointercancel="handleStagePointerEnd"
          >
            <img
              v-show="loadState !== 'error'"
              ref="imageRef"
              :src="src"
              :alt="alt"
              class="client-image-previewer__image"
              :class="{ 'is-pending': !isImageReady }"
              :style="imageStyle"
              draggable="false"
              @load="handleImageLoad"
              @error="handleImageError"
              @dblclick="toggleQuickZoom"
            />
            <p v-if="loadState === 'loading'" class="client-image-previewer__status">图片加载中…</p>
            <p v-else-if="loadState === 'error'" class="client-image-previewer__status">图片加载失败，请关闭后重试</p>
          </div>
          <p class="client-image-previewer__hint">放大后可滑动、拖动或使用方向键查看其他区域，按 Esc 关闭</p>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.client-image-previewer {
  /* 旧浏览器不支持 inset 时遮罩会塌缩到内容尺寸，这里显式写四向定位铺满布局视口。 */
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  background: rgba(15, 23, 42, 0.86);
  padding: 0.75rem;
  padding:
    max(0.75rem, env(safe-area-inset-top))
    max(0.75rem, env(safe-area-inset-right))
    max(0.75rem, env(safe-area-inset-bottom))
    max(0.75rem, env(safe-area-inset-left));
}

.client-image-previewer__panel {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  max-width: 1100px;
  height: 100%;
  min-height: 0;
  gap: 0.5rem;
}

.client-image-previewer__toolbar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.client-image-previewer__zoom-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.client-image-previewer__zoom-group .el-button + .el-button {
  margin-left: 0;
}

.client-image-previewer__ratio {
  min-width: 3.2rem;
  color: #f8fafc;
  font-size: 0.82rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  text-align: center;
}

.client-image-previewer__stage {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.04);
  outline: none;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.client-image-previewer__stage:focus-visible {
  box-shadow: inset 0 0 0 2px rgba(94, 234, 212, 0.85);
}

.client-image-previewer__stage.is-zoomed {
  cursor: grab;
}

.client-image-previewer__stage.is-zoomed:active {
  cursor: grabbing;
}

.client-image-previewer__image {
  /* margin:auto 居中：内容溢出时仍能滚动到左上角，不会像 justify-content:center 那样裁掉起始边。 */
  display: block;
  flex: none;
  margin: auto;
  max-width: none;
  max-height: none;
  border-radius: 0.75rem;
  background: #ffffff;
  box-shadow: 0 24px 56px rgba(15, 23, 42, 0.28);
  -webkit-user-drag: none;
  user-select: none;
}

.client-image-previewer__image.is-pending {
  max-width: 100%;
  max-height: 100%;
  opacity: 0;
}

.client-image-previewer__status {
  position: absolute;
  top: 50%;
  right: 0;
  left: 0;
  margin: 0;
  color: #e2e8f0;
  font-size: 0.85rem;
  text-align: center;
  transform: translateY(-50%);
}

.client-image-previewer__hint {
  flex: 0 0 auto;
  margin: 0;
  color: rgba(226, 232, 240, 0.78);
  font-size: 0.72rem;
  text-align: center;
}

.client-image-previewer-enter-active,
.client-image-previewer-leave-active {
  transition: opacity var(--ylink-motion-normal, 200ms) var(--ylink-motion-ease, ease);
}

.client-image-previewer-enter-from,
.client-image-previewer-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .client-image-previewer__toolbar .el-button {
    padding: 0.45rem 0.6rem;
    font-size: 0.78rem;
  }
}

/* 低高度视口优先把空间留给舞台，提示文案隐藏，工具栏仍保持可见。 */
@media (max-height: 26rem) {
  .client-image-previewer__hint {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .client-image-previewer-enter-active,
  .client-image-previewer-leave-active {
    transition: none;
  }
}
</style>
