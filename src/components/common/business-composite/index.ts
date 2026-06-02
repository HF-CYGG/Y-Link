/**
 * 模块说明：src/components/common/business-composite/index.ts
 * 文件职责：作为业务组合型共享组件的导出入口，统一暴露弹窗壳、抽屉壳和数据采集壳等编排组件。
 * 实现逻辑：
 * - 集中收口多个业务组合壳层组件的对外接口，方便页面从单一入口接入共享编排能力；
 * - 通过目录级索引保持“基础展示”和“业务组合”边界清晰，减少跨层误用；
 * - 当组合壳内部实现调整时，可通过这里维持调用方导入路径稳定。
 */

/**
 * 业务组合组件导出层：
 * - 聚合列表壳、抽屉壳、弹窗壳等业务编排型共享组件；
 * - 页面统一从该入口接入组合能力，避免再次回到扁平文件直引。
 */
export { default as BizCrudDialogShell } from './BizCrudDialogShell.vue'
export { default as BizResponsiveDataCollectionShell } from './BizResponsiveDataCollectionShell.vue'
export { default as BizResponsiveDrawerShell } from './BizResponsiveDrawerShell.vue'
