/**
 * 模块说明：src/components/common/page-container/index.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

/**
 * 页面容器层导出入口：
 * - 统一承接页面标题、描述、宽度与内边距策略；
 * - 所有页面容器统一从该层导出，形成清晰落点。
 */
export { default as PageContainer } from './PageContainer.vue'
