/**
 * 模块说明：F:/Y-Link/src/components/common/page-shared/index.ts
 * 文件职责：页面共享组件导出入口。
 * 实现逻辑：聚合分页、工具条、扫描弹窗等高频页面骨架组件，约束页面统一使用同名组件与统一入口。
 * 维护说明：新增页面共享组件时需同步补充导出，避免页面回退到扁平直引。
 */
export { default as PagePaginationBar } from './PagePaginationBar.vue'
export { default as PageToolbarCard } from './PageToolbarCard.vue'
export { default as PassiveNumberInput } from './PassiveNumberInput.vue'
export { default as TabbedWorkbenchPage } from './TabbedWorkbenchPage.vue'
export { default as UnifiedScanDialog } from './UnifiedScanDialog.vue'
