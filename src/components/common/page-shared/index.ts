/**
 * 模块说明：src/components/common/page-shared/index.ts
 * 文件职责：作为页面级共享组件的聚合导出入口，统一暴露筛选栏、分页栏、工作台页签壳和扫码弹窗等高频页面骨架。
 * 实现逻辑：
 * - 把 page-shared 目录下可复用的页面结构组件集中导出，减少业务页直接依赖具体文件路径；
 * - 通过单一入口明确共享组件分层，方便后续补充或替换页面壳层实现；
 * - 让页面层在导入时直接面向稳定接口，而不是关心底层目录组织方式。
 */

/**
 * 页面级通用组件导出层：
 * - 聚合页面筛选栏、分页栏等高频页面骨架片段；
 * - 约束页面统一使用同名组件与统一接口入口。
 */
export { default as PagePaginationBar } from './PagePaginationBar.vue'
export { default as PageToolbarCard } from './PageToolbarCard.vue'
export { default as PassiveNumberInput } from './PassiveNumberInput.vue'
export { default as TabbedWorkbenchPage } from './TabbedWorkbenchPage.vue'
export { default as UnifiedScanDialog } from './UnifiedScanDialog.vue'
