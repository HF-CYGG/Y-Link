/**
 * 模块说明：src/views/client/client-mall-viewport.helpers.ts
 * 文件职责：计算商城页悬浮购物车对内容区的真实遮挡高度、分类浏览列表在页面滚到底时恰好越过购物车所需的高度、
 *   右侧滚动位置对应的当前分类，以及左侧分类栏为保持激活分类可见所需的最小滚动位置。
 * 实现逻辑：
 * - 视口高度取 `innerHeight` 与 `documentElement.clientHeight` 中的有效较大值，不依赖 `visualViewport`，兼容旧浏览器；
 * - 遮挡高度以悬浮购物车“收起态摘要栏顶边”到视口底部的实测距离为准，测量失败时退回保守值；
 * - 分类浏览列表与分类栏共用按文档高度推导的实测高度，页面滚到底时末项恰好停在购物车上方，不再额外撑出尾部空白。
 * - 当前分类按“锚线以上最后一个分组”判定，并对切换加滞回，避免分组标题停在临界点时来回闪烁；
 * - 分类栏“跟随可见”只在激活项越出可视区时按最小位移滚动，已完整可见时返回 null，不强制置顶；
 *   其可视区底部要扣掉悬浮购物车盖住分类栏的那一段，否则激活项会停在被购物车遮挡的位置。
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

export interface KeepVisibleScrollInput {
  /** 滚动容器当前 scrollTop（px）。 */
  scrollTop: number
  /** 滚动容器可视高度 clientHeight（px）。 */
  viewportHeight: number
  /** 滚动容器内容总高度 scrollHeight（px）。 */
  contentHeight: number
  /** 目标项顶边相对滚动内容起点的坐标（px）。 */
  itemTop: number
  itemHeight: number
  /** 滚动后目标项与可视区边缘保留的间距（px）。 */
  padding: number
  /** 可视区底部被悬浮元素遮挡的高度（px），默认 0。 */
  bottomInset?: number
}

/**
 * 计算让目标项完整进入滚动容器可视区所需的新 scrollTop（“跟随可见”）：
 * - 目标项已完整可见时返回 null，调用方不应滚动，避免分类栏无意义抖动；
 * - 顶部越界时向上滚到“项顶边 - 间距”，底部越界时向下滚到“项底边 + 间距”恰好贴住可视区底部，均为最小位移；
 * - “可视区底部”会扣掉 bottomInset，即悬浮购物车遮住分类栏的那一段，保证激活项落在真正看得见的区域；
 * - 目标项比可视区还高时优先保证顶边可见；结果限制在 [0, 最大滚动距离] 内，尺寸不可测时返回 null。
 */
export const resolveKeepVisibleScrollTop = ({
  scrollTop,
  viewportHeight,
  contentHeight,
  itemTop,
  itemHeight,
  padding,
  bottomInset = 0,
}: KeepVisibleScrollInput): number | null => {
  if (!isPositiveFinite(viewportHeight) || ![scrollTop, contentHeight, itemTop, itemHeight].every(Number.isFinite)) {
    return null
  }
  const safePadding = Math.max(0, Number.isFinite(padding) ? padding : 0)
  // 遮挡高度异常（不可测、为负或不小于容器本身）时按无遮挡处理，避免可视区被算成 0 而反复滚动。
  const safeBottomInset = Number.isFinite(bottomInset) && bottomInset > 0 && bottomInset < viewportHeight
    ? bottomInset
    : 0
  const usableHeight = viewportHeight - safeBottomInset
  const itemBottom = itemTop + Math.max(0, itemHeight)
  const viewportBottom = scrollTop + usableHeight
  if (itemTop >= scrollTop && itemBottom <= viewportBottom) {
    return null
  }
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight)
  const alignTop = itemTop - safePadding
  const alignBottom = itemBottom + safePadding - usableHeight
  const rawTarget = itemTop < scrollTop || itemBottom - itemTop > usableHeight ? alignTop : alignBottom
  const target = Math.round(Math.min(maxScrollTop, Math.max(0, rawTarget)))
  return Math.abs(target - scrollTop) < 1 ? null : target
}

export interface ViewportCategorySection {
  key: string
  /** 分组顶边相对滚动内容起点的坐标（px）。 */
  top: number
  height: number
}

export interface ViewportCategoryInput {
  /** 按展示顺序排列的分组位置，缺少 DOM 的分组不要传入。 */
  sections: ViewportCategorySection[]
  scrollTop: number
  viewportHeight: number
  contentHeight: number
  /** 激活锚线距可视区顶部的距离（px）：越过该线的分组视为“当前分类”。 */
  anchorOffset: number
  /** 切换分类需要多越过锚线的距离（px）：同一临界点不双向触发。 */
  hysteresis: number
  /** 分组底部至少露出多少才算“清晰可见”（px），用于列表滚到底时的兜底。 */
  bottomVisiblePadding: number
  /** 判定“已在顶部/已到底”的容差（px）。 */
  edgeThreshold: number
  /** 当前激活分类，用于滞回判定。 */
  currentKey: string
  firstCategoryKey: string
}

/**
 * 按右侧滚动位置推导当前分类：
 * - 滚动位置在顶部容差内时，“全部”保持“全部”，其余情况归属第一个真实分类；
 * - 其余位置先按锚线取候选分组：优先跨过锚线的分组，否则取锚线以上最后一个分组；
 *   滚到底时改用“最后一个清晰可见的分组”，避免末尾分组顶不到锚线而永远无法激活；
 * - 候选与当前分类不一致时再判滞回：向下接管要多越过 hysteresis，向上回退要当前分组多退
 *   hysteresis，同一个临界点不会被双向反复触发。
 */
export const resolveViewportCategoryKey = ({
  sections,
  scrollTop,
  viewportHeight,
  contentHeight,
  anchorOffset,
  hysteresis,
  bottomVisiblePadding,
  edgeThreshold,
  currentKey,
  firstCategoryKey,
}: ViewportCategoryInput): string => {
  if (scrollTop <= edgeThreshold) {
    return currentKey === 'all' ? 'all' : firstCategoryKey
  }
  const safeHysteresis = Math.max(0, Number.isFinite(hysteresis) ? hysteresis : 0)
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight)
  let passedCategoryKey = 'all'
  let visibleCategoryKey = 'all'
  let straddlingCategoryKey: string | null = null

  sections.forEach((section) => {
    const relativeTop = section.top - scrollTop
    const relativeBottom = relativeTop + section.height
    if (relativeTop <= anchorOffset) {
      passedCategoryKey = section.key
    }
    if (relativeBottom > 0 && relativeTop < viewportHeight - bottomVisiblePadding) {
      visibleCategoryKey = section.key
    }
    if (straddlingCategoryKey === null && relativeTop <= anchorOffset && relativeBottom > anchorOffset) {
      straddlingCategoryKey = section.key
    }
  })

  // 列表已到底：末尾分组无法再顶到锚线，改以“最后一个清晰可见分组”为准。
  if (maxScrollTop - scrollTop <= edgeThreshold) {
    return visibleCategoryKey
  }

  const candidateKey = straddlingCategoryKey ?? passedCategoryKey
  if (candidateKey === currentKey) {
    return currentKey
  }
  const candidateIndex = sections.findIndex((section) => section.key === candidateKey)
  const currentIndex = sections.findIndex((section) => section.key === currentKey)
  if (safeHysteresis <= 0 || candidateIndex < 0 || currentIndex < 0) {
    // 当前分类还不在分组列表里（如“全部”或数据刚变化）时无需滞回，直接采用候选。
    return candidateKey
  }
  if (candidateIndex > currentIndex) {
    // 向下切换：候选分组要多越过锚线，才从当前分类手里接管。
    const candidateRelativeTop = sections[candidateIndex].top - scrollTop
    return candidateRelativeTop <= anchorOffset - safeHysteresis ? candidateKey : currentKey
  }
  // 向上回退：当前分组要退出锚线一段距离，才把激活交还上一个分类。
  const currentRelativeTop = sections[currentIndex].top - scrollTop
  return currentRelativeTop > anchorOffset + safeHysteresis ? candidateKey : currentKey
}
