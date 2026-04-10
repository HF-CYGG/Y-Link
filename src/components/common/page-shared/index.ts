/**
 * 模块说明：src/components/common/page-shared/index.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

/**
 * 页面级通用组件导出层：
 * - 聚合页面筛选栏、分页栏等高频页面骨架片段；
 * - 约束页面统一使用同名组件与统一接口入口。
 */
export { default as PagePaginationBar } from './PagePaginationBar.vue'
export { default as PageToolbarCard } from './PageToolbarCard.vue'
