/**
 * Store 统一出口：
 * - 聚合 app / auth / theme store 及其相关类型 / 常量；
 * - 让 composable、布局层、页面层都从同一入口消费状态定义。
 */
export { DEVICE_BREAKPOINTS, useAppStore } from '@/store/modules/app'
export { useAuthStore } from '@/store/modules/auth'
export { useClientAuthStore } from '@/store/modules/client-auth'
export { THEME_TRANSITION_DURATION_MS, useThemeStore } from '@/store/modules/theme'
export type { DeviceMode } from '@/store/modules/app'
export type { ThemeMode, ThemeTransitionStrategy } from '@/store/modules/theme'
