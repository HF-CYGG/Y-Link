/**
 * 模块说明：src/components/common/index.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
