/**
 * 模块说明：F:/Y-Link/src/components/common/base-display/index.ts
 * 文件职责：基础展示组件导出入口。
 * 实现逻辑：集中导出最小可复用展示单元（空态、请求态、路由错误态），供页面与组合组件统一引用。
 * 维护说明：新增或调整基础展示组件后需同步维护本出口，确保调用方依赖路径稳定。
 */
export { default as BaseEmptyState } from './BaseEmptyState.vue'
export { default as BaseRequestState } from './BaseRequestState.vue'
export { default as BaseRouteErrorState } from './BaseRouteErrorState.vue'
