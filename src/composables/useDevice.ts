import { computed, watchEffect } from 'vue'
import { useWindowSize } from '@vueuse/core'
import { DEVICE_BREAKPOINTS, type DeviceMode, useAppStore } from '@/store'

/**
 * 设备模式识别 Hook：
 * - 基于统一断点输出 phone / tablet / desktop 三态；
 * - 同步写入全局 store，保证布局壳层与业务页面判断一致；
 * - 额外暴露常用布尔派生，减少各组件重复比较字符串。
 */
export const useDevice = () => {
  const appStore = useAppStore()
  const { width } = useWindowSize()

  /**
   * 统一断点策略：
   * - 小于等于 767px 为 phone；
   * - 768px ~ 1199px 为 tablet；
   * - 1200px 及以上为 desktop。
   */
  const device = computed<DeviceMode>(() => {
    if (width.value <= DEVICE_BREAKPOINTS.phoneMaxWidth) {
      return 'phone'
    }

    if (width.value <= DEVICE_BREAKPOINTS.tabletMaxWidth) {
      return 'tablet'
    }

    return 'desktop'
  })

  // 将窗口宽度推导结果同步到全局 store，供所有页面复用。
  watchEffect(() => {
    appStore.setDevice(device.value)
  })

  return {
    width,
    device,
    isPhone: computed(() => device.value === 'phone'),
    isTablet: computed(() => device.value === 'tablet'),
    isDesktop: computed(() => device.value === 'desktop'),
  }
}
