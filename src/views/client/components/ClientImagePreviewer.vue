<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientImagePreviewer.vue
 * 文件职责：承载客户端商城的商品原图预览层，保证超宽、超长图在低高度或缩放后的旧浏览器视口里初始完整可见，并可用滚轮缩放、按住拖动查看细节。
 * 实现逻辑：
 * - 遮罩用 top/right/bottom/left 四向定位铺满布局视口，不依赖 `inset` 与 `dvh`；右上角只保留一个关闭按钮，舞台占满其余空间；
 * - 舞台 overflow:hidden 且打开期间锁定页面滚动，因此滚轮缩放只需被动监听（符合 verify:passive-wheel），无需阻止默认行为；
 * - 缩放改变图片真实宽高并以指针位置为锚点换算滚动位置；按住左键（或触屏按住）拖动改写舞台滚动位置，边界即图片边缘；
 * - 双击在完整适配与 2 倍之间切换；键盘保留 Esc 关闭、+ / - / 0 缩放与方向键平移；打开时转移焦点并在预览层内循环，关闭时还原。
 * 维护说明：
 * - 比例、倍率与缩放锚点计算统一收口在 `client-image-preview.helpers.ts`，不要在模板或样式里另写魔法比例；
 * - 不要改成非被动 wheel 监听或 ElImageViewer，否则会重新触发滚动性能告警；
 * - 键盘事件在 window 捕获阶段处理并阻止继续传播，避免从商品详情抽屉打开时 Esc 同时关闭底层抽屉。
 */

import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useZIndex } from 'element-plus'
import { Close } from '@element-plus/icons-vue'

import {
  CLIENT_IMAGE_PREVIEW_KEYBOARD_ZOOM_FACTOR,
  clampImagePreviewScale,
  resolveImageFitScale,
  resolveWheelZoomScale,
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
const QUICK_ZOOM_FACTOR = 2
const DRAG_MOVE_THRESHOLD = 3
const KEYBOARD_PAN_STEP = 48
const ZOOMED_EPSILON = 0.001

const { nextZIndex } = useZIndex()

const overlayRef = ref<HTMLElement | null>(null)
const stageRef = ref<HTMLElement | null>(null)
const imageRef = ref<HTMLImageElement | null>(null)
const overlayZIndex = ref(PREVIEW_BASE_Z_INDEX)
const loadState = ref<'loading' | 'loaded' | 'error'>('loading')
// 缩放倍率相对“完整适配”记录，窗口尺寸变化重新计算适配比例后仍保持用户当前的放大程度。
const zoomFactor = ref(1)
const dragging = ref(false)
const naturalSize = reactive({ width: 0, height: 0 })
const stageSize = reactive({ width: 0, height: 0 })

let previousActiveElement: HTMLElement | null = null
let previousBodyOverflow: string | null = null
let stageResizeObserver: ResizeObserver | null = null
let measureFrameId: number | null = null
let pendingScroll: { left: number; top: number } | null = null
let dragState: { pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number; moved: boolean } | null = null
let suppressNextStageClick = false

const fitScale = computed(() => resolveImageFitScale({
  naturalWidth: naturalSize.width,
  naturalHeight: naturalSize.height,
  stageWidth: stageSize.width,
  stageHeight: stageSize.height,
}))
const currentScale = computed(() => clampImagePreviewScale(fitScale.value * zoomFactor.value, fitScale.value))
const isImageReady = computed(() => loadState.value === 'loaded' && naturalSize.width > 0 && naturalSize.height > 0)
const isZoomed = computed(() => isImageReady.value && currentScale.value > fitScale.value * (1 + ZOOMED_EPSILON))
const imageStyle = computed(() => {
  if (!isImageReady.value) {
    return undefined
  }
  // 向下取整，避免完整适配时因亚像素进位多出 1px。
  return {
    width: `${Math.max(1, Math.floor(naturalSize.width * currentScale.value))}px`,
    height: `${Math.max(1, Math.floor(naturalSize.height * currentScale.value))}px`,
  }
})

const close = () => {
  emit('update:visible', false)
}

const measureStage = () => {
  const stage = stageRef.value
  if (!stage) {
    return
  }
  stageSize.width = stage.clientWidth
  stageSize.height = stage.clientHeight
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
  zoomFactor.value = 1
  loadState.value = 'loading'
  naturalSize.width = 0
  naturalSize.height = 0
  pendingScroll = null
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

const applyScale = async (nextScale: number, anchor?: { x: number; y: number }) => {
  const stage = stageRef.value
  if (!isImageReady.value || !stage) {
    return
  }
  const targetScale = clampImagePreviewScale(nextScale, fitScale.value)
  if (Math.abs(targetScale - currentScale.value) < 1e-4) {
    return
  }
  // 连续滚轮事件可能早于 DOM 更新到达，优先以尚未写入的目标滚动位置为基准，避免锚点漂移。
  const scrollBase = pendingScroll ?? { left: stage.scrollLeft, top: stage.scrollTop }
  pendingScroll = resolveZoomAnchoredScroll({
    scrollLeft: scrollBase.left,
    scrollTop: scrollBase.top,
    stageWidth: stage.clientWidth,
    stageHeight: stage.clientHeight,
    previousWidth: naturalSize.width * currentScale.value,
    previousHeight: naturalSize.height * currentScale.value,
    nextWidth: naturalSize.width * targetScale,
    nextHeight: naturalSize.height * targetScale,
    anchorX: anchor?.x,
    anchorY: anchor?.y,
  })
  zoomFactor.value = targetScale / fitScale.value
  await nextTick()
  if (pendingScroll) {
    stage.scrollLeft = pendingScroll.left
    stage.scrollTop = pendingScroll.top
    pendingScroll = null
  }
}

const resolveStageAnchor = (event: MouseEvent) => {
  const stage = stageRef.value
  if (!stage) {
    return undefined
  }
  const rect = stage.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

const handleStageWheel = (event: WheelEvent) => {
  // Ctrl + 滚轮保留给浏览器页面缩放；被动监听无法阻止默认行为，舞台与页面均不可滚动，因此不会产生额外滚动。
  if (!isImageReady.value || event.ctrlKey) {
    return
  }
  const nextScale = resolveWheelZoomScale({
    currentScale: currentScale.value,
    fitScale: fitScale.value,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
  })
  void applyScale(nextScale, resolveStageAnchor(event))
}

const toggleQuickZoom = (event: MouseEvent) => {
  void applyScale(isZoomed.value ? fitScale.value : fitScale.value * QUICK_ZOOM_FACTOR, resolveStageAnchor(event))
}

const panStage = (deltaX: number, deltaY: number) => {
  const stage = stageRef.value
  if (!stage) {
    return
  }
  stage.scrollLeft += deltaX
  stage.scrollTop += deltaY
}

const resolveFocusableElements = () => {
  const overlay = overlayRef.value
  if (!overlay) {
    return [] as HTMLElement[]
  }
  return Array.from(overlay.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
}

const trapFocus = (event: KeyboardEvent) => {
  const focusableElements = resolveFocusableElements()
  if (!focusableElements.length) {
    return
  }
  const first = focusableElements[0]
  const last = focusableElements[focusableElements.length - 1]
  const activeElement = globalThis.document.activeElement
  const focusInside = !!activeElement && !!overlayRef.value?.contains(activeElement)
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
      void applyScale(currentScale.value * CLIENT_IMAGE_PREVIEW_KEYBOARD_ZOOM_FACTOR)
      break
    case '-':
    case '_':
    case 'Subtract':
      consume()
      void applyScale(currentScale.value / CLIENT_IMAGE_PREVIEW_KEYBOARD_ZOOM_FACTOR)
      break
    case '0':
      consume()
      void applyScale(fitScale.value)
      break
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
      if (isZoomed.value) {
        consume()
        panStage(
          event.key === 'ArrowLeft' ? -KEYBOARD_PAN_STEP : event.key === 'ArrowRight' ? KEYBOARD_PAN_STEP : 0,
          event.key === 'ArrowUp' ? -KEYBOARD_PAN_STEP : event.key === 'ArrowDown' ? KEYBOARD_PAN_STEP : 0,
        )
      }
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
  // 鼠标只响应左键按住；触屏与触控笔按住即可拖动。
  if (!stage || (event.pointerType === 'mouse' && event.button !== 0) || !isStageOverflowing(stage)) {
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
  dragging.value = true
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
  dragging.value = false
}

const handleStageBlankClick = () => {
  if (suppressNextStageClick) {
    suppressNextStageClick = false
    return
  }
  // 放大查看细节时点到空白处不应误关，只有完整适配状态下才沿用“点空白关闭”。
  if (!isZoomed.value) {
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
  dragging.value = false
  pendingScroll = null
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
        ref="overlayRef"
        class="client-image-previewer"
        :style="{ zIndex: overlayZIndex }"
        role="dialog"
        aria-modal="true"
        :aria-label="`${alt}预览`"
        @click.self="close"
      >
        <el-button class="client-image-previewer__close" round :icon="Close" aria-label="关闭预览" @click="close">关闭</el-button>
        <section class="client-image-previewer__panel">
          <div
            ref="stageRef"
            class="client-image-previewer__stage"
            :class="{ 'is-zoomed': isZoomed, 'is-dragging': dragging }"
            tabindex="0"
            aria-label="图片查看区域：滚轮缩放，按住左键拖动查看"
            @click.self="handleStageBlankClick"
            @wheel.passive="handleStageWheel"
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
          <p class="client-image-previewer__hint">滚轮缩放，按住左键拖动查看，双击快速放大或还原，按 Esc 关闭</p>
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
  padding: 1rem;
  padding:
    max(1rem, env(safe-area-inset-top))
    max(1rem, env(safe-area-inset-right))
    max(1rem, env(safe-area-inset-bottom))
    max(1rem, env(safe-area-inset-left));
}

.client-image-previewer__close {
  /* 沿用原预览层的单个白色胶囊关闭按钮，固定在视口右上角，始终可见。 */
  position: absolute;
  top: max(0.75rem, env(safe-area-inset-top));
  right: max(0.75rem, env(safe-area-inset-right));
  z-index: 2;
  --el-button-bg-color: rgba(255, 255, 255, 0.94);
  --el-button-border-color: transparent;
  --el-button-text-color: #0f172a;
  --el-button-hover-bg-color: #ffffff;
  --el-button-hover-border-color: transparent;
  --el-button-hover-text-color: #0f172a;
  --el-button-active-bg-color: #f1f5f9;
  --el-button-active-border-color: transparent;
  --el-button-active-text-color: #0f172a;
  font-weight: 600;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.24);
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

.client-image-previewer__stage {
  /* 舞台不可原生滚动：滚轮只负责缩放，平移由拖动改写 scrollLeft/scrollTop 完成。 */
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  border-radius: 1rem;
  outline: none;
  touch-action: none;
  user-select: none;
}

.client-image-previewer__stage:focus-visible {
  box-shadow: inset 0 0 0 2px rgba(94, 234, 212, 0.85);
}

.client-image-previewer__stage.is-zoomed {
  cursor: grab;
}

.client-image-previewer__stage.is-dragging {
  cursor: grabbing;
}

.client-image-previewer__image {
  /* margin:auto 居中：内容溢出时仍能拖到左上角，不会像 justify-content:center 那样裁掉起始边。 */
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

/* 低高度视口优先把空间留给舞台，提示文案隐藏，关闭按钮仍固定可见。 */
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
