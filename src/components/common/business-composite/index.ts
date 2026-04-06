/**
 * 业务组合组件导出层：
 * - 聚合列表壳、抽屉壳、弹窗壳等业务编排型共享组件；
 * - 页面统一从该入口接入组合能力，避免再次回到扁平文件直引。
 */
export { default as BizCrudDialogShell } from './BizCrudDialogShell.vue'
export { default as BizResponsiveDataCollectionShell } from './BizResponsiveDataCollectionShell.vue'
export { default as BizResponsiveDrawerShell } from './BizResponsiveDrawerShell.vue'
