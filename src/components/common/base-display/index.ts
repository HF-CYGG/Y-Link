/**
 * 模块说明：src/components/common/base-display/index.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

/**
 * 基础展示组件导出层：
 * - 仅承载最小可复用展示单元；
 * - 页面与组合组件统一从该入口获取基础展示能力。
 */
export { default as BaseEmptyState } from './BaseEmptyState.vue'
export { default as BaseRequestState } from './BaseRequestState.vue'
