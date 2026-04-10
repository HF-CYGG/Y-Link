/**
 * 模块说明：src/store/index.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
