/**
 * 模块说明：src/views/client/client-image-preview.helpers.ts
 * 文件职责：为客户端商品原图预览计算完整适配比例、滚轮缩放后的比例，以及以指针为锚点缩放后的舞台滚动位置。
 * 实现逻辑：
 * - 基准比例 = 原图等比缩入舞台的比例，小图不放大；缩放比例始终限制在“完整适配 ~ 放大上限”之间；
 * - 滚轮增量按指数换算为连续倍率，统一像素 / 行 / 页三种 deltaMode，鼠标滚轮与触控板手感一致；
 * - 缩放改变图片真实尺寸，并以指针位置为锚点换算舞台滚动位置，滚动边界天然等于图片边缘，图片不会丢失在可视区外。
 * 维护说明：本文件只放纯函数，不访问 DOM，便于 `scripts/verify-client-mall-floating-layout.ts` 直接回归。
 */

export const CLIENT_IMAGE_PREVIEW_MAX_NATURAL_SCALE = 4
export const CLIENT_IMAGE_PREVIEW_MIN_ZOOM_CEILING = 2
export const CLIENT_IMAGE_PREVIEW_KEYBOARD_ZOOM_FACTOR = 1.25

const WHEEL_ZOOM_SENSITIVITY = 0.0015
const WHEEL_LINE_HEIGHT = 16
const WHEEL_PAGE_HEIGHT = 800
const WHEEL_MAX_STEP_FACTOR = 2

export interface ImageFitInput {
  naturalWidth: number
  naturalHeight: number
  stageWidth: number
  stageHeight: number
}

export interface WheelZoomInput {
  currentScale: number
  fitScale: number
  deltaY: number
  /** WheelEvent.deltaMode：0 像素、1 行、2 页。 */
  deltaMode: number
}

export interface ZoomAnchoredScrollInput {
  scrollLeft: number
  scrollTop: number
  stageWidth: number
  stageHeight: number
  previousWidth: number
  previousHeight: number
  nextWidth: number
  nextHeight: number
  /** 缩放锚点在舞台可视区内的坐标（px），缺省为舞台中心。 */
  anchorX?: number
  anchorY?: number
}

const isPositiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const resolveImageFitScale = ({ naturalWidth, naturalHeight, stageWidth, stageHeight }: ImageFitInput): number => {
  if (![naturalWidth, naturalHeight, stageWidth, stageHeight].every(isPositiveFinite)) {
    return 1
  }
  return Math.min(1, stageWidth / naturalWidth, stageHeight / naturalHeight)
}

export const resolveImagePreviewMaxScale = (fitScale: number): number => {
  const safeFit = isPositiveFinite(fitScale) ? fitScale : 1
  // 超大原图至少可放大到原图 2 倍看清细节；小图最多放大到原图 4 倍，避免严重失真。
  return Math.max(safeFit, Math.min(CLIENT_IMAGE_PREVIEW_MAX_NATURAL_SCALE, Math.max(safeFit * 4, CLIENT_IMAGE_PREVIEW_MIN_ZOOM_CEILING)))
}

export const clampImagePreviewScale = (scale: number, fitScale: number): number => {
  const safeFit = isPositiveFinite(fitScale) ? fitScale : 1
  if (!Number.isFinite(scale)) {
    return safeFit
  }
  return clamp(scale, safeFit, resolveImagePreviewMaxScale(safeFit))
}

export const normalizeWheelDelta = (deltaY: number, deltaMode: number): number => {
  if (!Number.isFinite(deltaY)) {
    return 0
  }
  if (deltaMode === 1) {
    return deltaY * WHEEL_LINE_HEIGHT
  }
  if (deltaMode === 2) {
    return deltaY * WHEEL_PAGE_HEIGHT
  }
  return deltaY
}

export const resolveWheelZoomScale = ({ currentScale, fitScale, deltaY, deltaMode }: WheelZoomInput): number => {
  const delta = normalizeWheelDelta(deltaY, deltaMode)
  // 向上滚（delta < 0）放大、向下滚缩小；单次事件倍率限制在 0.5 ~ 2，避免高精度滚轮一次跳变过大。
  const factor = clamp(Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY), 1 / WHEEL_MAX_STEP_FACTOR, WHEEL_MAX_STEP_FACTOR)
  const safeCurrent = Number.isFinite(currentScale) ? currentScale : fitScale
  return clampImagePreviewScale(safeCurrent * factor, fitScale)
}

const resolveAxisScroll = (scroll: number, stage: number, previous: number, next: number, anchor: number | undefined): number => {
  const maxScroll = Math.max(0, next - stage)
  if (maxScroll === 0) {
    return 0
  }
  if (!isPositiveFinite(previous)) {
    return maxScroll / 2
  }
  const safeAnchor = typeof anchor === 'number' && Number.isFinite(anchor) ? clamp(anchor, 0, stage) : stage / 2
  // 内容小于舞台时图片通过 margin:auto 居中，需要先扣掉居中偏移再换算锚点在图片上的比例。
  const previousOffset = Math.max(0, (stage - previous) / 2)
  const anchorRatio = clamp((scroll + safeAnchor - previousOffset) / previous, 0, 1)
  return clamp(anchorRatio * next - safeAnchor, 0, maxScroll)
}

export const resolveZoomAnchoredScroll = (input: ZoomAnchoredScrollInput): { left: number; top: number } => {
  return {
    left: resolveAxisScroll(input.scrollLeft, input.stageWidth, input.previousWidth, input.nextWidth, input.anchorX),
    top: resolveAxisScroll(input.scrollTop, input.stageHeight, input.previousHeight, input.nextHeight, input.anchorY),
  }
}
