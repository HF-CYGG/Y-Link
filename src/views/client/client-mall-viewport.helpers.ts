/**
 * 模块说明：src/views/client/client-mall-viewport.helpers.ts
 * 文件职责：计算商城页悬浮购物车对内容区的真实遮挡高度，以及文档流尾部与内部滚动列表所需的尾部留白。
 * 实现逻辑：
 * - 视口高度取 `innerHeight` 与 `documentElement.clientHeight` 中的有效较大值，不依赖 `visualViewport`，兼容旧浏览器；
 * - 遮挡高度以悬浮购物车“收起态摘要栏顶边”到视口底部的实测距离为准，测量失败时退回保守值；
 * - 内部滚动列表尾部垫块同时满足“末项越过购物车”和“末尾分组可顶到定位线”两个诉求，并限制上限，避免列表未受高度约束时出现巨大空白。
 * 维护说明：本文件只放纯函数，不访问 DOM，便于 `scripts/verify-client-mall-floating-layout.ts` 直接回归。
 */

export interface ViewportHeightSource {
  innerHeight?: number | null
  documentClientHeight?: number | null
}

export interface FloatingOcclusionInput {
  viewportHeight: number
  /** 悬浮购物车收起态摘要栏顶边相对视口顶部的坐标（px）。 */
  summaryTop: number | null
  /** 测量不可用时使用的保守遮挡高度（px）。 */
  fallback: number
  /** 在遮挡高度之上额外保留的可见安全距离（px）。 */
  gap: number
}

export interface ScrollerTailSpacerInput {
  /** 内部滚动容器当前可视高度（px）。 */
  clientHeight: number
  viewportHeight: number
  /** 末尾分组顶到定位线所需的可视高度比例，沿用手机 0.96 / 桌面 0.75 规则。 */
  anchorRatio: number
  /** 悬浮层遮挡高度（已包含安全距离，px）。 */
  occlusion: number
  /** 尾部垫块下限（px）。 */
  minimum: number
}

export const MALL_FLOATING_OCCLUSION_GAP = 12
export const PHONE_FLOATING_OCCLUSION_FALLBACK = 240
export const DESKTOP_FLOATING_OCCLUSION_FALLBACK = 200

const isPositiveFinite = (value: number | null | undefined): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export const resolveViewportHeight = (source: ViewportHeightSource): number => {
  // 固定定位元素以布局视口为参照；两个来源取较大值，宁可多留几像素滚动条高度，也不低估遮挡。
  const candidates = [source.innerHeight, source.documentClientHeight].filter(isPositiveFinite)
  return candidates.length ? Math.max(...candidates) : 0
}

export const resolveFloatingOcclusion = ({ viewportHeight, summaryTop, fallback, gap }: FloatingOcclusionInput): number => {
  const safeFallback = Math.ceil(Math.max(0, fallback) + Math.max(0, gap))
  if (!isPositiveFinite(viewportHeight) || typeof summaryTop !== 'number' || !Number.isFinite(summaryTop)) {
    return safeFallback
  }
  const measured = viewportHeight - summaryTop
  // 摘要栏顶边落在视口外（页面隐藏、切页过渡中或布局尚未完成）时，实测值不可信，统一走保守回退。
  if (measured <= 0 || measured > viewportHeight) {
    return safeFallback
  }
  return Math.ceil(measured + Math.max(0, gap))
}

export const resolveScrollerTailSpacer = ({
  clientHeight,
  viewportHeight,
  anchorRatio,
  occlusion,
  minimum,
}: ScrollerTailSpacerInput): number => {
  const safeClientHeight = isPositiveFinite(clientHeight) ? clientHeight : 0
  // 旧浏览器不支持 dvh 时列表可能失去 max-height，clientHeight 会接近整列内容高度；
  // 这里用视口高度封顶，避免尾部垫块随列表内容一起膨胀成大片空白。
  const anchorBase = isPositiveFinite(viewportHeight) ? Math.min(safeClientHeight, viewportHeight) : safeClientHeight
  const anchorRoom = Math.floor(anchorBase * Math.max(0, anchorRatio))
  return Math.max(Math.ceil(minimum), anchorRoom, Math.ceil(Math.max(0, occlusion)))
}
