/**
 * 模块说明：src/composables/useDevice.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { computed, watch } from 'vue'
import { useWindowSize } from '@vueuse/core'
import { DEVICE_BREAKPOINTS, type DeviceMode, useAppStore } from '@/store'

const { width } = useWindowSize()

/**
 * 共享设备态：
 * - 保持单一 width 响应源，避免每次 useDevice 调用都创建一套独立监听；
 * - 所有调用方共享同一份 device 计算结果，减少无效响应链路。
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

let hasBoundStoreSync = false

/**
 * 绑定全局 store 同步（单例守卫）：
 * - 仅首次调用 useDevice 时建立 watch，防止多实例重复写入 appStore.setDevice；
 * - immediate 保证首次进入页面即可把当前设备态同步到 store。
 */
const ensureDeviceStoreSync = () => {
  if (hasBoundStoreSync) {
    return
  }

  const appStore = useAppStore()
  watch(
    device,
    (value) => {
      appStore.setDevice(value)
    },
    { immediate: true },
  )
  hasBoundStoreSync = true
}

/**
 * 设备模式识别 Hook：
 * - 基于统一断点输出 phone / tablet / desktop 三态；
 * - 同步写入全局 store，保证布局壳层与业务页面判断一致；
 * - 额外暴露常用布尔派生，减少各组件重复比较字符串。
 */
export const useDevice = () => {
  ensureDeviceStoreSync()

  return {
    width,
    device,
    isPhone: computed(() => device.value === 'phone'),
    isTablet: computed(() => device.value === 'tablet'),
    isDesktop: computed(() => device.value === 'desktop'),
  }
}
