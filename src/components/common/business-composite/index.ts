/**
 * 模块说明：src/components/common/business-composite/index.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

/**
 * 业务组合组件导出层：
 * - 聚合列表壳、抽屉壳、弹窗壳等业务编排型共享组件；
 * - 页面统一从该入口接入组合能力，避免再次回到扁平文件直引。
 */
export { default as BizCrudDialogShell } from './BizCrudDialogShell.vue'
export { default as BizResponsiveDataCollectionShell } from './BizResponsiveDataCollectionShell.vue'
export { default as BizResponsiveDrawerShell } from './BizResponsiveDrawerShell.vue'
