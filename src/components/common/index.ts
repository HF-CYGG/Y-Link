/**
 * 模块说明：src/components/common/index.ts
 * 文件职责：作为共享组件总出口，按基础展示、业务组合、页面共享和页面容器四个层级统一聚合对外接口。
 * 实现逻辑：
 * - 对页面层隐藏共享组件的内部目录结构，统一从同一入口导入公共组件；
 * - 通过分层导出维持共享组件边界清晰，避免业务代码直接依赖深层文件路径；
 * - 当共享组件内部目录调整时，只需维护这里的出口映射即可降低影响面。
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
