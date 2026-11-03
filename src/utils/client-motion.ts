/**
 * 模块说明：src/utils/client-motion.ts
 * 文件职责：客户端商城的轻量交互动效与触感反馈工具，包括“减少动效”判定、轻触震动和加购“飞入购物车”小圆点。
 * 实现逻辑：
 * - 所有动效先判断 `prefers-reduced-motion`，命中时直接跳过，只保留业务状态变化本身；
 * - 飞入动画使用 Web Animations API 驱动一个 fixed 定位的小圆点，水平匀速、垂直先抬升后下落形成抛物线，结束即移除节点；
 * - 震动只在支持 `navigator.vibrate` 的设备（主要是 Android）生效，iOS 与桌面静默忽略。
 * 维护说明：
 * - 这里只做视觉反馈，不得承载任何购物车业务判断；调用方必须在加购成功后再触发；
 * - 动画节点设置 `pointer-events: none` 与 `aria-hidden`，避免影响点击与读屏；
 * - 同时在途的飞入节点有上限，防止用户连点时堆积大量 DOM。
 */

const MAX_FLYING_DOTS = 6
let flyingDotCount = 0

/** 当前是否应减少动效：SSR/无 matchMedia 环境按“减少动效”处理，保证安全降级。 */
export const shouldReduceClientMotion = (): boolean => {
  if (globalThis.window === undefined || typeof globalThis.window.matchMedia !== 'function') {
    return true
  }
  return globalThis.window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 轻触震动：用于加购成功、步进器加减等确认型操作；不支持或减少动效时静默忽略。 */
export const triggerClientHaptic = (durationMs = 10): void => {
  if (shouldReduceClientMotion()) {
    return
  }
  const navigatorRef = globalThis.navigator as (Navigator & { vibrate?: (pattern: number) => boolean }) | undefined
  if (typeof navigatorRef?.vibrate !== 'function') {
    return
  }
  try {
    navigatorRef.vibrate(Math.max(1, Math.min(40, Math.round(durationMs))))
  } catch {
    // 部分 WebView 在非用户手势上下文调用会抛错，视觉反馈不应因此中断。
  }
}

const resolveElementCenter = (element: Element) => {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, visible: rect.width > 0 && rect.height > 0 }
}

/**
 * 加购“飞入购物车”动效：从触发元素中心飞向目标元素中心。
 * 返回动画结束的 Promise，调用方可在落点时触发购物车角标弹跳。
 */
export const flyToClientCart = (source: Element | null | undefined, target: Element | null | undefined, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted || !source || !target || shouldReduceClientMotion() || flyingDotCount >= MAX_FLYING_DOTS) {
    return Promise.resolve()
  }
  const from = resolveElementCenter(source)
  const to = resolveElementCenter(target)
  if (!from.visible || !to.visible) {
    return Promise.resolve()
  }

  const dot = document.createElement('span')
  dot.className = 'client-fly-dot'
  dot.setAttribute('aria-hidden', 'true')
  Object.assign(dot.style, {
    position: 'fixed',
    left: `${from.x - 7}px`,
    top: `${from.y - 7}px`,
    width: '14px',
    height: '14px',
    borderRadius: '9999px',
    background: 'var(--ylink-color-primary-strong, #0f766e)',
    boxShadow: '0 4px 12px rgba(15, 118, 110, 0.35)',
    pointerEvents: 'none',
    zIndex: '3000',
    willChange: 'transform, opacity',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(dot)
  flyingDotCount += 1

  const deltaX = to.x - from.x
  const deltaY = to.y - from.y
  // 抛物线顶点高于起终点，距离越远抬升越高，但设上限避免飞出视口。
  const arcLift = Math.min(160, Math.max(48, Math.abs(deltaX) * 0.35 + 36))
  const keyframes: Keyframe[] = [
    { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
    { transform: `translate3d(${deltaX * 0.5}px, ${Math.min(0, deltaY) * 0.5 - arcLift}px, 0) scale(0.9)`, opacity: 1, offset: 0.45 },
    { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(0.45)`, opacity: 0.6 },
  ]

  return new Promise<void>((resolve) => {
    let finished = false
    let animation: Animation | undefined
    const cancel = () => animation?.cancel()
    const finish = () => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', cancel)
      dot.remove()
      flyingDotCount = Math.max(0, flyingDotCount - 1)
      resolve()
    }
    if (typeof dot.animate !== 'function') {
      finish()
      return
    }
    animation = dot.animate(keyframes, { duration: 520, easing: 'cubic-bezier(0.32, 0, 0.67, 1)', fill: 'forwards' })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) animation.cancel()
    animation.onfinish = finish
    animation.oncancel = finish
  })
}
