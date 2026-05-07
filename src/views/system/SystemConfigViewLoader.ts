/**
 * 模块说明：src/views/system/SystemConfigViewLoader.ts
 * 文件职责：作为系统配置页的路由级异步加载入口，避免主路由分包在进入系统管理前就同步拉起整页实现。
 * 实现逻辑：
 * - 将真实页面改为动态 `import()` 默认导出；
 * - 保持路由层与预热层继续复用同一入口，不改动现有 `route-performance` 的命名口径。
 * 维护说明：
 * - 若后续系统配置页继续拆子块，这里仍应保持为最外层异步入口，不要再改回同步导出。
 */

export { default } from '@/views/system/SystemConfigView.vue'
