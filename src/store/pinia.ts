/**
 * 模块说明：src/store/pinia.ts
 * 文件职责：导出全局 Pinia 单例，供路由守卫、工具模块等组件外上下文安全使用 Store。
 * 实现逻辑：通过显式单例避免依赖隐式 activePinia，减少启动时序导致的 Store 未激活错误。
 * 维护说明：若后续引入测试注入或多实例场景，优先在该文件扩展工厂能力，避免业务侧直接改 Pinia 创建方式。
 */

import { createPinia } from 'pinia'

// 统一导出全局 Pinia 单例，避免在组件外调用 store 时依赖隐式 activePinia 时序。
export const pinia = createPinia()

export default pinia
