/**
 * 模块说明：F:/Y-Link/src/components/common/page-container/index.ts
 * 文件职责：页面容器组件导出入口。
 * 实现逻辑：向页面层提供统一布局容器导出。
 * 维护说明：容器组件重命名需同步全局替换引用。
 */

/**
 * 页面容器层导出入口：
 * - 统一承接页面标题、描述、宽度与内边距策略；
 * - 所有页面容器统一从该层导出，形成清晰落点。
 */
export { default as PageContainer } from './PageContainer.vue'
