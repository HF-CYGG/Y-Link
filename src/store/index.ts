/**
 * 模块说明：F:/Y-Link/src/store/index.ts
 * 文件职责：store 聚合导出入口。
 * 实现逻辑：集中导出各 Pinia store，降低页面导入复杂度。
 * 维护说明：新增 store 时同步导出并保持命名一致。
 */

/**
 * Store 统一出口：
 * - 聚合 app / auth / theme store 及其相关类型 / 常量；
 * - 让 composable、布局层、页面层都从同一入口消费状态定义。
 */
export { DEVICE_BREAKPOINTS, useAppStore } from '@/store/modules/app'
export { useAuthStore } from '@/store/modules/auth'
export { useClientAuthStore } from '@/store/modules/client-auth'
export { useClientCatalogStore } from '@/store/modules/client-catalog'
export { useClientCartStore } from '@/store/modules/client-cart'
export { useClientOrderStore } from '@/store/modules/client-order'
export { THEME_TRANSITION_DURATION_MS, useThemeStore } from '@/store/modules/theme'
export type { DeviceMode } from '@/store/modules/app'
export type { ThemeMode, ThemeTransitionStrategy } from '@/store/modules/theme'
