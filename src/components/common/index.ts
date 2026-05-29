/**
 * 模块说明：F:/Y-Link/src/components/common/index.ts
 * 文件职责：公共组件总出口。
 * 实现逻辑：聚合 common 子目录导出，页面层默认只从该入口引入，减少对深层文件路径的直接耦合。
 * 维护说明：新增或重命名公共组件后需同步更新本入口，避免页面出现分散导入和路径漂移。
 */
export * from './base-display'
export * from './page-shared'
export * from './business-composite'
export * from './page-container'
