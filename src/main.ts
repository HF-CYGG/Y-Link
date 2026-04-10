/**
 * 模块说明：src/main.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './style.css'
import App from './App.vue'
import router from '@/router'
import { elementPlusIconWhitelist } from '@/icons/element-plus'
import { useThemeStore } from '@/store'

// 创建应用实例，作为全局能力挂载入口。
const app = createApp(App)
const pinia = createPinia()

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

// 注册 Element Plus：提供 PC 端高密度业务组件。
app.use(ElementPlus, {
  locale: zhCn,
})

// 挂载到根节点，启动 SPA 应用。
app.mount('#app')
