/**
 * 模块说明：src/store/modules/app.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * 统一设备模式类型：
 * - phone：手机等窄屏设备，采用抽屉式导航；
 * - tablet：中等宽度设备，采用紧凑布局；
 * - desktop：桌面宽屏设备，采用常驻侧栏。
 */
export type DeviceMode = 'phone' | 'tablet' | 'desktop'

/**
 * 统一断点配置：
 * - 让 composable 与 store 共用同一套设备判断规则；
 * - 后续若需要调整断点，仅修改此处即可全局生效。
 */
export const DEVICE_BREAKPOINTS = {
  phoneMaxWidth: 767,
  tabletMaxWidth: 1199,
} as const

/**
 * 全局 App Store：
 * - 管理三态设备模式与布局派生状态；
 * - 管理手机端抽屉导航开关；
 * - 管理全局请求加载态，供壳层顶部进度条使用。
 */
export const useAppStore = defineStore('app', () => {
  // 当前设备模式默认按 desktop 初始化，运行时由 useDevice 自动同步。
  const device = ref<DeviceMode>('desktop')

  // 手机端侧栏抽屉显隐状态，仅在 phone 模式下生效。
  const sidebarOpened = ref(false)

  // 全局网络请求中的计数器，可支持并发请求场景。
  const pendingRequestCount = ref(0)

  // 设备派生状态：供布局层和页面层直接复用，避免散落判断。
  const isPhone = computed(() => device.value === 'phone')
  const isTablet = computed(() => device.value === 'tablet')
  const isDesktop = computed(() => device.value === 'desktop')

  // 布局辅助状态：便于模板中表达“是否紧凑布局 / 是否抽屉侧栏”。
  const isCompactLayout = computed(() => device.value !== 'desktop')
  const shouldUseDrawerSidebar = computed(() => isPhone.value)

  // 基于计数器推导是否处于加载中，避免手动维护布尔值不一致。
  const isGlobalLoading = computed(() => pendingRequestCount.value > 0)

  /**
   * 设置设备类型：
   * - 仅在设备模式发生变化时更新，减少无意义响应；
   * - 离开 phone 模式时自动关闭抽屉，防止遮罩残留。
   */
  const setDevice = (value: DeviceMode) => {
    if (device.value === value) {
      return
    }

    device.value = value

    if (value !== 'phone') {
      sidebarOpened.value = false
    }
  }

  /**
   * 手机端导航控制：
   * - open / close 只在 phone 模式下真正生效；
   * - 避免桌面端误触发导致状态污染。
   */
  const openSidebar = () => {
    if (!isPhone.value) {
      return
    }
    sidebarOpened.value = true
  }

  const closeSidebar = () => {
    sidebarOpened.value = false
  }

  const toggleSidebar = () => {
    if (!isPhone.value) {
      return
    }
    sidebarOpened.value = !sidebarOpened.value
  }

  // 进入加载态（计数 +1）。
  const startLoading = () => {
    pendingRequestCount.value += 1
  }

  // 结束加载态（计数 -1，且不低于 0）。
  const endLoading = () => {
    pendingRequestCount.value = Math.max(0, pendingRequestCount.value - 1)
  }

  return {
    device,
    sidebarOpened,
    isPhone,
    isTablet,
    isDesktop,
    isCompactLayout,
    shouldUseDrawerSidebar,
    isGlobalLoading,
    setDevice,
    openSidebar,
    closeSidebar,
    toggleSidebar,
    startLoading,
    endLoading,
  }
})
