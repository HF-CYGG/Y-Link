/**
 * 模块说明：src/store/modules/theme.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { computed, nextTick, ref, watch } from 'vue'
import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

/**
 * 主题模式类型：
 * - light：亮色主题；
 * - dark：暗色主题。
 */
export type ThemeMode = 'light' | 'dark'

/**
 * 主题过渡策略：
 * - none：未执行动画；
 * - view-transition：浏览器支持 View Transitions API，使用截图级圆形揭幕；
 * - fallback：浏览器不支持时，退回到受控颜色过渡与点击点光晕提示。
 */
export type ThemeTransitionStrategy = 'none' | 'view-transition' | 'fallback'

/**
 * 主题切换触发点：
 * - 用于圆形扩散/收缩动画的中心点计算；
 * - 当点击坐标缺失时，回退到触发按钮中心或视口中心。
 */
interface ThemeTriggerPoint {
  x: number
  y: number
}

/**
 * 兼容类型：
 * - 部分 TypeScript DOM 版本尚未内建 startViewTransition；
 * - 这里在局部定义最小能力集，避免污染全局类型声明。
 */
type ViewTransitionController = {
  ready: Promise<void>
  finished: Promise<void>
  updateCallbackDone?: Promise<void>
  skipTransition?: () => void
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => Promise<void> | void) => ViewTransitionController
}

const THEME_STORAGE_KEY = 'y-link-theme-mode'
export const THEME_TRANSITION_DURATION_MS = 460
const THEME_TRANSITION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const THEME_SWITCH_ENABLED = false
const THEME_LOCKED_MODE: ThemeMode = 'light'

/**
 * 判定是否处于浏览器端：
 * - Store 可在应用启动前被提前创建；
 * - 因此所有 DOM 能力都必须先做运行环境保护。
 */
const isClientEnvironment = () => globalThis.window !== undefined && globalThis.document !== undefined

/**
 * 是否应强制走降级切换：
 * - 页面不可见时不执行动画，避免后台恢复后门控残留。
 */
const shouldForceFallbackTransition = () => {
  if (!isClientEnvironment()) {
    return false
  }

  return document.visibilityState !== 'visible'
}

/**
 * 解析动画触发点：
 * - 鼠标点击时优先使用真实点击坐标；
 * - 键盘触发或坐标不可用时退回到按钮中心；
 * - 若仍无法获得元素信息，则使用视口中心兜底。
 */
const resolveTriggerPoint = (event?: MouseEvent): ThemeTriggerPoint => {
  if (!isClientEnvironment()) {
    return { x: 0, y: 0 }
  }

  if (
    event
    && event.detail !== 0
    && Number.isFinite(event.clientX)
    && Number.isFinite(event.clientY)
  ) {
    return {
      x: Math.min(globalThis.window.innerWidth, Math.max(0, event.clientX)),
      y: Math.min(globalThis.window.innerHeight, Math.max(0, event.clientY)),
    }
  }

  const currentTarget = event?.currentTarget
  if (currentTarget instanceof HTMLElement) {
    const { left, top, width, height } = currentTarget.getBoundingClientRect()
    return {
      x: left + width / 2,
      y: top + height / 2,
    }
  }

  return {
    x: globalThis.window.innerWidth / 2,
    y: globalThis.window.innerHeight / 2,
  }
}

/**
 * 计算从点击点覆盖到整个视口所需的最大半径：
 * - View Transition 的裁剪动画需要知道最终圆半径；
 * - 通过四象限最大距离保证任意点击点都能完全覆盖页面。
 */
const resolveTransitionRadius = ({ x, y }: ThemeTriggerPoint) => {
  if (!isClientEnvironment()) {
    return 0
  }

  const w = Math.max(globalThis.window.innerWidth, document.documentElement.clientWidth)
  const h = Math.max(globalThis.window.innerHeight, document.documentElement.clientHeight)

  // 增加额外的半径缓冲（200px），避免移动端软键盘或浏览器地址栏收缩导致的视口变大而出现裁剪残影
  return Math.hypot(
    Math.max(x, w - x),
    Math.max(y, h - y),
  ) + 200
}

/**
 * 全局主题 Store：
 * - 统一管理主题模式持久化、DOM class 同步与动画策略；
 * - 将点击点、动画中状态、降级门控等细节从 UI 组件中抽离。
 */
export const useThemeStore = defineStore('theme', () => {
  const themeMode = useStorage<ThemeMode>(THEME_STORAGE_KEY, 'light', undefined, {
    listenToStorageChanges: true,
    writeDefaults: true,
  })

  const isDark = computed(() => themeMode.value === 'dark')
  const isTransitioning = ref(false)
  const activeTransitionStrategy = ref<ThemeTransitionStrategy>('none')
  const prefersReducedMotion = ref(false)
  const lastTriggerPoint = ref<ThemeTriggerPoint | null>(null)
  const initialized = ref(false)

  let reducedMotionMediaQuery: MediaQueryList | null = null
  let fallbackTimer: number | null = null
  let transitionWatchdogTimer: number | null = null
  let stopThemeDomSync: (() => void) | null = null
  let lifecycleGuardBound = false

  /**
   * 同步 DOM 主题态：
   * - 作为主题 Store 唯一的 DOM 写入函数，统一维护 html/body 的 dark、light class；
   * - 同步 data-theme-mode 与 color-scheme，保证原生控件和 CSS 都能感知当前主题；
   * - 所有主题切换路径都只修改响应式状态，再由这里落盘到真实 DOM，避免重复写入导致的竞争窗口。
   */
  const applyThemeToDom = (mode: ThemeMode) => {
    if (!isClientEnvironment()) {
      return
    }

    const isDarkMode = mode === 'dark'
    const root = document.documentElement
    const body = document.body

    root.classList.toggle('dark', isDarkMode)
    root.classList.toggle('light', !isDarkMode)
    root.dataset.themeMode = mode
    root.style.colorScheme = mode

    if (body) {
      body.classList.toggle('dark', isDarkMode)
      body.classList.toggle('light', !isDarkMode)
      body.dataset.themeMode = mode
      body.style.colorScheme = mode
    }
  }

  /**
   * 写入动画门控变量：
   * - 仅在切换主题时开启全局样式过渡；
   * - 将点击点坐标暴露给 CSS，供降级光晕与视图过渡伪元素共享。
   */
  const setTransitionGate = (strategy: Exclude<ThemeTransitionStrategy, 'none'>, mode: ThemeMode, point: ThemeTriggerPoint) => {
    if (!isClientEnvironment()) {
      return
    }

    const root = document.documentElement
    root.dataset.themeTransition = strategy
    root.dataset.themeTransitionMode = mode
    root.style.setProperty('--theme-transition-origin-x', `${point.x}px`)
    root.style.setProperty('--theme-transition-origin-y', `${point.y}px`)
    root.style.setProperty('--theme-transition-duration', `${THEME_TRANSITION_DURATION_MS}ms`)
    root.style.setProperty('--theme-transition-easing', THEME_TRANSITION_EASING)
  }

  /**
   * 清理动画门控变量：
   * - 动画完成后立即撤销，避免后续普通交互也带上颜色过渡；
   * - 保持全局样式“按需开启、按需关闭”。
   */
  const clearTransitionGate = () => {
    if (!isClientEnvironment()) {
      return
    }

    const root = document.documentElement
    delete root.dataset.themeTransition
    delete root.dataset.themeTransitionMode
    root.style.removeProperty('--theme-transition-origin-x')
    root.style.removeProperty('--theme-transition-origin-y')
    root.style.removeProperty('--theme-transition-duration')
    root.style.removeProperty('--theme-transition-easing')
  }

  /**
   * 结束当前主题动画：
   * - 统一回收门控与运行中状态；
   * - 先清理定时器，再撤销 DOM 门控，保证支持与降级两条路径收尾一致；
   * - 供 View Transition 与 CSS 降级路径复用。
   */
  const finishTransition = () => {
    clearFallbackTimer()
    clearTransitionWatchdog()
    clearTransitionGate()
    activeTransitionStrategy.value = 'none'
    isTransitioning.value = false
  }

  /**
   * 清理降级动画计时器：
   * - 防止快速重复切换时存在多个 setTimeout 竞争；
   * - 避免旧动画在新动画期间误清理门控。
   */
  const clearFallbackTimer = () => {
    if (fallbackTimer !== null && isClientEnvironment()) {
      globalThis.window.clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }

  /**
   * 清理主题切换看门狗：
   * - 防止 Promise 未结束导致门控残留；
   * - 每次新切换前都会重置，保证一条切换链只存在一个看门狗。
   */
  const clearTransitionWatchdog = () => {
    if (transitionWatchdogTimer !== null && isClientEnvironment()) {
      globalThis.window.clearTimeout(transitionWatchdogTimer)
      transitionWatchdogTimer = null
    }
  }

  const armTransitionWatchdog = () => {
    if (!isClientEnvironment()) {
      return
    }

    clearTransitionWatchdog()
    transitionWatchdogTimer = globalThis.window.setTimeout(() => {
      transitionWatchdogTimer = null
      finishTransition()
    }, THEME_TRANSITION_DURATION_MS + 1200)
  }

  /**
   * 根据媒体查询同步“减少动态效果”偏好：
   * - 用户主动开启系统级 reduce motion 时，禁用所有额外主题切换动画；
   * - 保留主题功能本身，只移除视觉运动。
   */
  const syncReducedMotionPreference = () => {
    if (!isClientEnvironment()) {
      return
    }

    if (!reducedMotionMediaQuery) {
      reducedMotionMediaQuery = globalThis.window.matchMedia('(prefers-reduced-motion: reduce)')
      const updatePreference = (event?: MediaQueryListEvent) => {
        prefersReducedMotion.value = event?.matches ?? reducedMotionMediaQuery?.matches ?? false
      }

      updatePreference()

      reducedMotionMediaQuery.addEventListener('change', updatePreference)
      return
    }

    prefersReducedMotion.value = reducedMotionMediaQuery.matches
  }

  /**
   * 提交主题模式：
   * - 只更新响应式主题状态，真实 DOM 同步交给统一 watcher；
   * - 这样可以把主题切换期间的 DOM 写入收敛成单写入源，避免 View Transition 与 watcher 双重落盘。
   */
  const commitThemeMode = (mode: ThemeMode) => {
    if (themeMode.value === mode) {
      return
    }

    themeMode.value = mode
  }

  /**
   * 降级动画：
   * - 浏览器不支持 View Transitions API 时，仅开启受控颜色过渡；
   * - 同时利用点击点光晕提示用户主题切换发起位置。
   */
  const runFallbackTransition = async (nextMode: ThemeMode, point: ThemeTriggerPoint) => {
    activeTransitionStrategy.value = 'fallback'
    isTransitioning.value = true
    setTransitionGate('fallback', nextMode, point)
    armTransitionWatchdog()

    try {
      commitThemeMode(nextMode)
      await nextTick()

      clearFallbackTimer()
      fallbackTimer = globalThis.window.setTimeout(() => {
        fallbackTimer = null
        finishTransition()
      }, THEME_TRANSITION_DURATION_MS + 80)
    } catch (error) {
      finishTransition()
      throw error
    }
  }

  /**
   * View Transition 主路径：
   * - 使用浏览器截图级过渡，获得真正的圆形扩散效果；
   * - 无论亮 -> 暗还是暗 -> 亮，都统一揭示“新视图”，避免旧视图收缩时露出底层黑底。
   */
  const runViewTransition = async (nextMode: ThemeMode, point: ThemeTriggerPoint) => {
    // 二次门控：即便调用链误入，也在这里直接降级，避免移动端出现裁剪残影。
    if (shouldForceFallbackTransition()) {
      await runFallbackTransition(nextMode, point)
      return
    }

    const documentWithViewTransition = document as DocumentWithViewTransition
    /**
     * 原生方法绑定修复：
     * - `startViewTransition` 属于 Document 实例方法，直接解构后调用会丢失 this；
     * - 在 Chromium 支持环境下会抛出 `TypeError: Illegal invocation`；
     * - 这里显式绑定到 document，保证登录页与主系统页的主题切换都能稳定执行。
     */
    const startViewTransition = documentWithViewTransition.startViewTransition?.bind(documentWithViewTransition)

    if (!startViewTransition) {
      await runFallbackTransition(nextMode, point)
      return
    }

    activeTransitionStrategy.value = 'view-transition'
    isTransitioning.value = true
    setTransitionGate('view-transition', nextMode, point)
    armTransitionWatchdog()

    let isTransitionSkipped = false

    try {
      const transition = startViewTransition(async () => {
        commitThemeMode(nextMode)
        await nextTick()
      })

      await transition.ready

      const radius = resolveTransitionRadius(point)
      const clipPathFrames = [
        `circle(0px at ${point.x}px ${point.y}px)`,
        `circle(${radius}px at ${point.x}px ${point.y}px)`,
      ]

      document.documentElement.animate(
        {
          clipPath: clipPathFrames,
        },
        {
          duration: THEME_TRANSITION_DURATION_MS,
          easing: THEME_TRANSITION_EASING,
          pseudoElement: '::view-transition-new(root)',
        },
      )

      const transitionFinishedTimeout = new Promise<void>((resolve) => {
        globalThis.window.setTimeout(() => {
          if (!isTransitionSkipped && transition.skipTransition) {
            transition.skipTransition()
            isTransitionSkipped = true
          }
          resolve()
        }, THEME_TRANSITION_DURATION_MS + 420)
      })
      
      await Promise.race([transition.finished, transitionFinishedTimeout])
      isTransitionSkipped = true
    } finally {
      finishTransition()
    }
  }

  /**
   * 设置主题模式：
   * - 根据浏览器能力自动选择 View Transition 或 CSS 降级；
   * - 若关闭动态效果，则直接切换主题，不做任何动画。
   */
  const setThemeMode = async (mode: ThemeMode, event?: MouseEvent) => {
    if (!isClientEnvironment()) {
      if (themeMode.value !== THEME_LOCKED_MODE) {
        commitThemeMode(THEME_LOCKED_MODE)
      }
      return
    }

    if (!THEME_SWITCH_ENABLED) {
      if (themeMode.value !== THEME_LOCKED_MODE) {
        commitThemeMode(THEME_LOCKED_MODE)
      }
      finishTransition()
      return
    }

    if (themeMode.value === mode || isTransitioning.value) {
      return
    }

    const point = resolveTriggerPoint(event)
    lastTriggerPoint.value = point
    clearTransitionGate()
    clearTransitionWatchdog()

    if (document.visibilityState !== 'visible') {
      commitThemeMode(mode)
      finishTransition()
      return
    }

    if (prefersReducedMotion.value) {
      commitThemeMode(mode)
      return
    }

    const supportsViewTransition = typeof (document as DocumentWithViewTransition).startViewTransition === 'function'
    const shouldPreferFallback = shouldForceFallbackTransition()

    if (supportsViewTransition && !shouldPreferFallback) {
      await runViewTransition(mode, point)
      return
    }

    await runFallbackTransition(mode, point)
  }

  /**
   * 切换亮暗主题：
   * - 供 UI 组件直接调用，内部自动计算目标主题；
   * - 组件无需关心动画能力与降级策略。
   */
  const toggleTheme = async (event?: MouseEvent) => {
    await setThemeMode(THEME_LOCKED_MODE, event)
  }

  /**
   * 初始化主题系统：
   * - 启动时建立主题状态 -> DOM 的唯一同步通道，并立即首帧同步；
   * - 只初始化一次，避免重复注册 watcher 与媒体查询监听。
   */
  const initializeTheme = () => {
    syncReducedMotionPreference()
    // 兜底清理上次异常中断遗留的过渡门控，避免首屏出现暗层残留。
    clearTransitionGate()
    clearTransitionWatchdog()
    // 临时下线主题切换：初始化时统一锁定为亮色，避免读取历史暗色缓存导致界面不一致。
    if (themeMode.value !== THEME_LOCKED_MODE) {
      commitThemeMode(THEME_LOCKED_MODE)
    }

    if (isClientEnvironment() && !lifecycleGuardBound) {
      lifecycleGuardBound = true
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') {
          finishTransition()
        }
      })
      globalThis.window.addEventListener('pagehide', () => {
        finishTransition()
      })
    }

    if (initialized.value) {
      return
    }

    initialized.value = true
    stopThemeDomSync?.()
    stopThemeDomSync = watch(themeMode, (mode) => {
      applyThemeToDom(mode)
    }, {
      immediate: true,
      flush: 'sync',
    })
  }

  return {
    themeMode,
    isDark,
    isTransitioning,
    activeTransitionStrategy,
    prefersReducedMotion,
    lastTriggerPoint,
    initializeTheme,
    setThemeMode,
    toggleTheme,
  }
})
