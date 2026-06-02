/**
 * 模块说明：src/store/index.ts
 * 文件职责：作为前端 Store 的统一出口，集中聚合各业务 Store、共享常量与对外暴露的类型定义。
 * 实现逻辑：
 * - 对页面、布局和 composable 隐藏具体模块文件路径，统一从单一入口导入状态能力；
 * - 在导出层顺带聚合公共常量与类型，减少跨目录重复依赖具体实现文件；
 * - 保持 Store 访问路径稳定，便于后续重构模块内部结构而不影响调用方。
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
