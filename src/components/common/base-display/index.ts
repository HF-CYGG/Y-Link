/**
 * 模块说明：src/components/common/base-display/index.ts
 * 文件职责：作为基础展示组件导出入口，统一暴露空状态、请求状态等最小可复用视觉单元。
 * 实现逻辑：
 * - 把基础展示类组件从更复杂的业务壳层中拆分出来，形成稳定的最小复用层；
 * - 页面与共享壳组件都通过该入口获取基础展示能力，避免直接耦合具体文件路径；
 * - 通过索引文件明确该目录只承载“展示单元”，不混入业务编排逻辑。
 */

/**
 * 基础展示组件导出层：
 * - 仅承载最小可复用展示单元；
 * - 页面与组合组件统一从该入口获取基础展示能力。
 */
export { default as BaseEmptyState } from './BaseEmptyState.vue'
export { default as BaseRequestState } from './BaseRequestState.vue'
