/**
 * 模块说明：F:/Y-Link/src/components/common/business-composite/index.ts
 * 文件职责：业务复合组件导出入口。
 * 实现逻辑：统一导出业务壳组件与复合表单容器。
 * 维护说明：导出名变更会影响大量页面引用，需谨慎。
 */

/**
 * 业务组合组件导出层：
 * - 聚合列表壳、抽屉壳、弹窗壳等业务编排型共享组件；
 * - 页面统一从该入口接入组合能力，避免再次回到扁平文件直引。
 */
export { default as BizCrudDialogShell } from './BizCrudDialogShell.vue'
export { default as BizResponsiveDataCollectionShell } from './BizResponsiveDataCollectionShell.vue'
export { default as BizResponsiveDrawerShell } from './BizResponsiveDrawerShell.vue'
