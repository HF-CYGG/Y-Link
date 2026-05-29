/**
 * 模块说明：F:/Y-Link/src/components/common/business-composite/index.ts
 * 文件职责：业务复合组件导出入口。
 * 实现逻辑：统一导出列表壳、抽屉壳、弹窗壳等业务编排组件，避免页面回退到扁平文件直引。
 * 维护说明：导出名变更会影响大量页面引用，调整时需同步全局检索并回归主要页面流。
 */
export { default as BizCrudDialogShell } from './BizCrudDialogShell.vue'
export { default as BizResponsiveDataCollectionShell } from './BizResponsiveDataCollectionShell.vue'
export { default as BizResponsiveDrawerShell } from './BizResponsiveDrawerShell.vue'
