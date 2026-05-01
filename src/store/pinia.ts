import { createPinia } from 'pinia'

// 统一导出全局 Pinia 单例，避免在组件外调用 store 时依赖隐式 activePinia 时序。
export const pinia = createPinia()

export default pinia
