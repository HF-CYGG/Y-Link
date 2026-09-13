/**
 * 模块说明：src/views/client/client-mall-viewport.helpers.ts
 * 文件职责：计算商城页悬浮购物车对内容区的真实遮挡高度，以及分类浏览列表在页面滚到底时恰好越过购物车所需的高度。
 * 实现逻辑：
 * - 视口高度取 `innerHeight` 与 `documentElement.clientHeight` 中的有效较大值，不依赖 `visualViewport`，兼容旧浏览器；
 * - 遮挡高度以悬浮购物车“收起态摘要栏顶边”到视口底部的实测距离为准，测量失败时退回保守值；
 * - 分类浏览列表与分类栏共用按文档高度推导的实测高度，页面滚到底时末项恰好停在购物车上方，不再额外撑出尾部空白。
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

export interface BrowseListHeightInput {
  /** 客户端布局根节点的文档流高度（不含商城页绝对定位内容，px）。 */
  layoutHeight: number
  viewportHeight: number
  /** 商品列表顶边相对文档顶部的坐标（px）。 */
  listDocumentTop: number
  /** 列表底边之后到文档底部的留白：面板底内边距 + 页面尾部留白（px）。 */
  tailPadding: number
  /** 最小可浏览高度（px）。 */
  minimum: number
}

export const MALL_FLOATING_OCCLUSION_GAP = 12
export const MALL_BROWSE_LIST_MIN_HEIGHT = 256
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

/**
 * 计算分类浏览列表（与分类栏共用）的高度：页面滚动到底时，列表底边恰好停在悬浮购物车上方。
 *
 * 推导：商城页挂在布局的绝对定位舞台里，文档高度 = max(布局文档流高度, 视口高度, 商城内容底边)。
 * 令 列表高度 = 文档高度 - 列表文档顶边 - 尾部留白（面板底内边距 + 页面尾部留白），商城内容底边恰好等于文档高度；
 * 滚动到底时列表底边距视口底部 = 尾部留白，而页面尾部留白等于购物车实测遮挡高度，因此末项刚好越过购物车，
 * 既不会被遮挡，也不会在列表下方留出与窗口高度相关的大片空白。
 * 返回 0 表示尺寸不可测，调用方应沿用样式里的 clamp 兜底高度。
 */
export const resolveBrowseListHeight = ({
  layoutHeight,
  viewportHeight,
  listDocumentTop,
  tailPadding,
  minimum,
}: BrowseListHeightInput): number => {
  const documentHeight = Math.max(
    isPositiveFinite(layoutHeight) ? layoutHeight : 0,
    isPositiveFinite(viewportHeight) ? viewportHeight : 0,
  )
  if (documentHeight <= 0 || !Number.isFinite(listDocumentTop) || listDocumentTop < 0) {
    return 0
  }
  const available = documentHeight - listDocumentTop - Math.max(0, Number.isFinite(tailPadding) ? tailPadding : 0)
  // 极矮视口下保留最小可浏览高度，此时依靠页面滚动把列表底边带到购物车上方。
  return Math.max(Math.ceil(Math.max(0, minimum)), Math.floor(available))
}
