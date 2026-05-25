/**
 * 模块说明：F:/Y-Link/src/components/common/page-shared/index.ts
 * 文件职责：页面共享组件导出入口。
 * 实现逻辑：聚合分页、工具条、扫描弹窗等共享组件。
 * 维护说明：新增共享组件时同步补导出。
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
