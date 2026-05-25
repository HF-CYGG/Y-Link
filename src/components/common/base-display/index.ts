/**
 * 模块说明：F:/Y-Link/src/components/common/base-display/index.ts
 * 文件职责：基础展示组件导出入口。
 * 实现逻辑：集中导出 base-display 目录组件，便于上层统一引用。
 * 维护说明：新增组件后需在此更新导出。
 */

/**
 * 基础展示组件导出层：
 * - 仅承载最小可复用展示单元；
 * - 页面与组合组件统一从该入口获取基础展示能力。
 */
export { default as BaseEmptyState } from './BaseEmptyState.vue'
export { default as BaseRequestState } from './BaseRequestState.vue'
export { default as BaseRouteErrorState } from './BaseRouteErrorState.vue'
