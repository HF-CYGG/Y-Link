/**
 * 模块说明：F:/Y-Link/src/components/common/index.ts
 * 文件职责：公共组件总出口。
 * 实现逻辑：聚合 common 子目录导出，作为页面层统一导入入口。
 * 维护说明：新增公共组件后同步更新，避免页面使用深层路径。
 */

/**
 * 共享组件总入口：
 * - 通过显式分层目录统一暴露共享组件；
 * - 页面层默认只依赖该入口，减少对具体文件路径的耦合。
 */
export * from './base-display'
export * from './page-shared'
export * from './business-composite'
export * from './page-container'
