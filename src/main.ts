/**
 * 模块说明：src/main.ts
 * 文件职责：负责初始化前端应用实例，并挂载全局状态、路由、主题、图标与少量全局指令。
 * 实现逻辑：
 * 1. 统一创建 Vue 应用与 Pinia，保证主题、权限、路由都从同一入口初始化；
 * 2. 仅注册项目真实使用到的 Element Plus 图标与加载指令，避免入口整包注入 UI 组件；
 * 3. Element Plus 组件本体与样式改由 Vite 编译期按需引入，降低 `ui-kit` 与总产物体积。
 */

import { createApp } from 'vue'
import { ElLoadingDirective } from 'element-plus'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './style.css'
import App from './App.vue'
import router from '@/router'
import { elementPlusIconWhitelist } from '@/icons/element-plus'
import { useThemeStore } from '@/store'
import pinia from '@/store/pinia'

// 创建应用实例，作为全局能力挂载入口。
const app = createApp(App)

// 统一日期/时间中文化，避免日期面板出现英文月份与星期。
dayjs.locale('zh-cn')

/**
 * 注册 Element Plus 图标白名单：
 * - 仅注册当前项目实际用到的图标组件；
 * - 避免整包图标注入，收敛前端打包体积。
 */
for (const [iconName, iconComponent] of Object.entries(elementPlusIconWhitelist)) {
  app.component(iconName, iconComponent)
}

// 注册 Pinia：统一承载全局状态管理。
app.use(pinia)

/**
 * 初始化主题系统：
 * - 在应用挂载前先同步 html/body 的主题 class，降低首屏闪烁；
 * - 让后续任意组件都从同一份主题状态读取。
 */
useThemeStore(pinia).initializeTheme()

// 注册 Vue Router：管理页面级路由与跳转守卫。
app.use(router)

/**
 * 注册 Element Plus 全局加载指令：
 * - 项目中的 `v-loading` 属于少量跨页面通用能力，继续在入口统一挂载；
 * - 其余 UI 组件改由编译期按需引入，避免运行时整包注册。
 */
app.directive('loading', ElLoadingDirective)

// 挂载到根节点，启动 SPA 应用。
app.mount('#app')
