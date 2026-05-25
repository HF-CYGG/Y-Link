/**
 * 模块说明：src/utils/order-refresh-visual.ts
 * 文件职责：提供订单列表静默刷新时的可视锚点捕获与恢复能力，供客户端订单列表与管理端订单池复用。
 * 实现逻辑：
 * - 刷新前记录当前首个可视订单卡片及其相对视口顶部的位置；
 * - 刷新后重新定位同一张卡片，并按位移差值微调滚动容器，尽量保持用户正在看的内容不跳动；
 * - 同时兼容 `window` 页面滚动与局部 `HTMLElement` 滚动容器，避免不同页面各自实现一套滚动修正逻辑。
 * 维护说明：
 * - 本工具只处理“滚动稳定性”，不负责请求、动画或列表合并策略；
 * - 若后续需要支持虚拟列表，需改为由调用方提供可视项信息，而不是直接遍历 DOM。
 */
export interface OrderRefreshAnchorSnapshot {
  itemKey: string
  top: number
}

export interface OrderRefreshAnchorOptions {
  listRoot: HTMLElement | null
  scrollContainer?: HTMLElement | Window | null
  itemAttributeName: string
  visibilityTopOffset?: number
}

/**
 * 滚动容器允许传 `window` 或局部元素：
 * - 类型收窄统一在这里处理，避免后续每次访问 `scrollTop` 或尺寸时都重复判断；
 * - 这样也能让 TypeScript 明确知道局部分支里一定是 `HTMLElement`。
 */
const isHtmlScrollContainer = (
  scrollContainer?: HTMLElement | Window | null,
): scrollContainer is HTMLElement => {
  return Boolean(scrollContainer && scrollContainer !== globalThis.window)
}

const resolveViewportBottom = (scrollContainer?: HTMLElement | Window | null) => {
  if (!isHtmlScrollContainer(scrollContainer)) {
    return globalThis.window?.innerHeight ?? 0
  }
  return scrollContainer.getBoundingClientRect().bottom
}

const isElementVisibleForAnchor = (
  element: HTMLElement,
  viewportTop: number,
  viewportBottom: number,
) => {
  const rect = element.getBoundingClientRect()
  return rect.bottom > viewportTop && rect.top < viewportBottom
}

export const captureOrderRefreshAnchor = (
  options: OrderRefreshAnchorOptions,
): OrderRefreshAnchorSnapshot | null => {
  if (globalThis.window === undefined || !options.listRoot) {
    return null
  }
  const viewportTop = options.visibilityTopOffset ?? 0
  const viewportBottom = resolveViewportBottom(options.scrollContainer)
  const orderElements = Array.from(
    options.listRoot.querySelectorAll<HTMLElement>(`[${options.itemAttributeName}]`),
  )
  const anchorElement = orderElements.find((element) => isElementVisibleForAnchor(element, viewportTop, viewportBottom))
  if (!anchorElement) {
    return null
  }
  const itemKey = anchorElement.getAttribute(options.itemAttributeName)?.trim() ?? ''
  if (!itemKey) {
    return null
  }
  return {
    itemKey,
    top: anchorElement.getBoundingClientRect().top,
  }
}

export const restoreOrderRefreshAnchor = (
  snapshot: OrderRefreshAnchorSnapshot | null,
  options: OrderRefreshAnchorOptions,
) => {
  if (globalThis.window === undefined || !snapshot || !options.listRoot) {
    return
  }
  const anchorElement = options.listRoot.querySelector<HTMLElement>(
    `[${options.itemAttributeName}="${snapshot.itemKey}"]`,
  )
  if (!anchorElement) {
    return
  }
  const topDiff = anchorElement.getBoundingClientRect().top - snapshot.top
  if (Math.abs(topDiff) < 1) {
    return
  }
  const scrollContainer = options.scrollContainer
  if (!scrollContainer || scrollContainer === globalThis.window) {
    globalThis.window.scrollBy({
      top: topDiff,
      left: 0,
      behavior: 'auto',
    })
    return
  }
  if (isHtmlScrollContainer(scrollContainer)) {
    scrollContainer.scrollTop += topDiff
  }
}
