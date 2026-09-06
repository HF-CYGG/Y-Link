/**
 * 模块说明：src/rescue/main.ts
 * 文件职责：启动独立数据库救援页面，刻意不初始化普通应用路由、Store、鉴权或全局维护轮询。
 * 实现逻辑：
 * - 救援页模板中的 Element Plus 组件由 Vite 编译期按需注册并注入生产样式；
 * - 仅显式加载命令式消息提示的样式，开发态才异步补充全量样式；
 * - 中文 locale 由页面根部的 ElConfigProvider 提供，避免注册整包组件。
 * 维护说明：此入口必须保持可在普通登录态不可用时单独加载。
 */

import { createApp } from 'vue'
import 'element-plus/es/components/message/style/css'
import './rescue.css'
import DatabaseRescueView from './DatabaseRescueView.vue'

if (import.meta.env.DEV) {
  void import('element-plus/dist/index.css')
}

createApp(DatabaseRescueView).mount('#app')
