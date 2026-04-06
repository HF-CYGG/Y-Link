/**
 * 共享组件总入口：
 * - 通过显式分层目录统一暴露共享组件；
 * - 页面层默认只依赖该入口，减少对具体文件路径的耦合。
 */
export * from './base-display'
export * from './page-shared'
export * from './business-composite'
export * from './page-container'
