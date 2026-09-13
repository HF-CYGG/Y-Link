/**
 * 模块说明：src/views/client/client-image-preview.helpers.ts
 * 文件职责：为客户端商品原图预览计算“完整适配”基准比例、缩放档位与缩放后保持视觉中心的滚动位置。
 * 实现逻辑：
 * - 基准比例 = 原图等比缩入舞台的比例，小图不放大；
 * - 缩放以基准比例乘以固定档位得到，放大上限同时受“原图 4 倍”约束，缩小下限始终是完整适配；
 * - 缩放通过改变图片真实尺寸配合舞台原生滚动实现，滚动边界天然等于图片边缘，图片不会丢失在可视区外。
 * 维护说明：本文件只放纯函数，不访问 DOM，便于 `scripts/verify-client-mall-floating-layout.ts` 直接回归。
 */

export const CLIENT_IMAGE_PREVIEW_ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const
export const CLIENT_IMAGE_PREVIEW_MAX_NATURAL_MULTIPLIER = 4

export interface ImageFitInput {
  naturalWidth: number
  naturalHeight: number
  stageWidth: number
  stageHeight: number
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
}

const isPositiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0

export const resolveImageFitScale = ({ naturalWidth, naturalHeight, stageWidth, stageHeight }: ImageFitInput): number => {
  if (![naturalWidth, naturalHeight, stageWidth, stageHeight].every(isPositiveFinite)) {
    return 1
  }
  return Math.min(1, stageWidth / naturalWidth, stageHeight / naturalHeight)
}

export const clampZoomStepIndex = (index: number, steps: readonly number[] = CLIENT_IMAGE_PREVIEW_ZOOM_STEPS): number => {
  if (!Number.isFinite(index) || steps.length === 0) {
    return 0
  }
  return Math.min(steps.length - 1, Math.max(0, Math.trunc(index)))
}

export const resolveImagePreviewScale = (
  fitScale: number,
  stepIndex: number,
  steps: readonly number[] = CLIENT_IMAGE_PREVIEW_ZOOM_STEPS,
): number => {
  const safeFit = isPositiveFinite(fitScale) ? fitScale : 1
  const factor = steps[clampZoomStepIndex(stepIndex, steps)] ?? 1
  // 超大原图的适配比例本身很小，4 倍原图上限不会先生效；小图则避免被放大到严重失真。
  const maxScale = Math.max(safeFit, CLIENT_IMAGE_PREVIEW_MAX_NATURAL_MULTIPLIER)
  return Math.min(maxScale, safeFit * factor)
}

/** 当前档位已经触达放大上限时，继续放大不会再改变尺寸，按钮应禁用。 */
export const canZoomInFurther = (
  fitScale: number,
  stepIndex: number,
  steps: readonly number[] = CLIENT_IMAGE_PREVIEW_ZOOM_STEPS,
): boolean => {
  const currentIndex = clampZoomStepIndex(stepIndex, steps)
  if (currentIndex >= steps.length - 1) {
    return false
  }
  return resolveImagePreviewScale(fitScale, currentIndex + 1, steps) > resolveImagePreviewScale(fitScale, currentIndex, steps)
}

const resolveAxisScroll = (scroll: number, stage: number, previous: number, next: number): number => {
  const maxScroll = Math.max(0, next - stage)
  if (maxScroll === 0 || !isPositiveFinite(previous)) {
    return maxScroll === 0 ? 0 : maxScroll / 2
  }
  // 内容小于舞台时图片通过 margin:auto 居中，需要先扣掉居中偏移再换算视觉中心在图片上的比例。
  const previousOffset = Math.max(0, (stage - previous) / 2)
  const centerRatio = Math.min(1, Math.max(0, (scroll + stage / 2 - previousOffset) / previous))
  const target = centerRatio * next - stage / 2
  return Math.min(maxScroll, Math.max(0, target))
}

export const resolveZoomAnchoredScroll = (input: ZoomAnchoredScrollInput): { left: number; top: number } => {
  return {
    left: resolveAxisScroll(input.scrollLeft, input.stageWidth, input.previousWidth, input.nextWidth),
    top: resolveAxisScroll(input.scrollTop, input.stageHeight, input.previousHeight, input.nextHeight),
  }
}
