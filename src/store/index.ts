/**
 * 模块说明：F:/Y-Link/src/store/index.ts
 * 文件职责：store 聚合导出入口。
 * 实现逻辑：集中导出各 Pinia store 及相关类型/常量，让页面、布局层和 composable 使用统一状态入口。
 * 维护说明：新增 store 或类型常量时需同步补充导出并保持命名一致，避免出现多入口状态引用。
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
