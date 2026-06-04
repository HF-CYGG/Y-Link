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
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import './style.css'
import App from './App.vue'
import { SESSION_RELOGIN_EVENT, type SessionReloginDetail } from '@/api/http'
import router from '@/router'
import { elementPlusIconWhitelist } from '@/icons/element-plus'
import { useAuthStore, useClientAuthStore, useThemeStore } from '@/store'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import pinia from '@/store/pinia'

/**
 * 开发态统一预加载 Element Plus 全量样式：
 * - 懒加载页面若在运行中首次暴露新的组件样式深导入，Vite 会重新做依赖预构建并整页 reload；
 * - 客户端反馈页、系统治理页这类首次进入偶发“页面进不去又整体刷新”，核心就是这里的开发态重优化；
 * - 因此本地开发阶段直接一次性加载完整样式，生产构建仍保持按组件拆分，不影响正式包体预算。
 */
if (import.meta.env.DEV) {
  void import('element-plus/dist/index.css')
}

const USER_CANCEL_MESSAGES = new Set(['cancel', 'close'])
const EXTERNAL_SCRIPT_SOURCE_PATTERN =
  /(userscript\.html|chrome-extension:\/\/|moz-extension:\/\/|safari-extension:\/\/|tampermonkey|violentmonkey|greasemonkey|content-script|injected-script|extension-script)/i

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const normalizeRuntimeText = (value: unknown) => {
  return typeof value === 'string' ? value.trim() : ''
}

const collectRuntimeSourceText = (value: unknown) => {
  if (value instanceof Error) {
    return [value.name, value.message, value.stack].filter(Boolean).join('\n')
  }

  if (isRecord(value)) {
    return [
      normalizeRuntimeText(value.message),
      normalizeRuntimeText(value.stack),
      normalizeRuntimeText(value.filename),
      normalizeRuntimeText(value.sourceURL),
    ].filter(Boolean).join('\n')
  }

  return normalizeRuntimeText(value)
}

const isUserCancelRuntimeError = (value: unknown) => {
  if (typeof value === 'string') {
    return USER_CANCEL_MESSAGES.has(value.trim().toLowerCase())
  }
  if (value instanceof Error) {
    return USER_CANCEL_MESSAGES.has(value.message.trim().toLowerCase())
  }
  if (isRecord(value)) {
    return USER_CANCEL_MESSAGES.has(normalizeRuntimeText(value.message).toLowerCase())
  }
  return false
}

const isElementFormValidationItem = (value: unknown) => {
  return isRecord(value)
    && typeof value.message === 'string'
    && (typeof value.field === 'string' || 'fieldValue' in value)
}

const isElementFormValidationErrorList = (value: unknown) => {
  return Array.isArray(value) && value.length > 0 && value.every(isElementFormValidationItem)
}

const isElementFormValidationPayload = (value: unknown) => {
  if (!isRecord(value) || value instanceof Error) {
    return false
  }

  const fieldErrors = Object.values(value)
  return fieldErrors.length > 0 && fieldErrors.every(isElementFormValidationErrorList)
}

const isExternalScriptRuntimeError = (value: unknown, extraSource = '') => {
  const sourceText = [extraSource, collectRuntimeSourceText(value)].filter(Boolean).join('\n')
  return EXTERNAL_SCRIPT_SOURCE_PATTERN.test(sourceText)
}

const shouldIgnoreGlobalRuntimeError = (value: unknown, extraSource = '') => {
  return isUserCancelRuntimeError(value)
    || isElementFormValidationPayload(value)
    || isExternalScriptRuntimeError(value, extraSource)
}

// 创建应用实例，作为全局能力挂载入口。
const app = createApp(App)

/**
 * 精简开发台警告输出：
 * - Vue 会在每次首次渲染 `Suspense` 时提示实验特性告警，这条信息当前对项目排障价值较低；
 * - 这里仅过滤这条已知固定提示，其余 Vue 警告仍继续保留，避免掩盖真实问题。
 */
app.config.warnHandler = (message, _instance, trace) => {
  if (message.includes('<Suspense> is an experimental feature')) {
    return
  }

  console.warn(`[vue warn] ${message}${trace}`)
}

app.config.errorHandler = (error, _instance, info) => {
  if (shouldIgnoreGlobalRuntimeError(error)) {
    return
  }

  console.error('[vue error]', info, error)
  void showCriticalErrorDialog(error, {
    title: '页面运行异常',
    fallback: '页面运行异常，请刷新后重试',
    operation: `Vue ${info}`,
  })
}

// 统一日期/时间中文化，避免日期面板出现英文月份与星期。
dayjs.locale('zh-cn')

/**
 * 固定 Element Plus 品牌色：
 * - Vite 开发态按需注入组件样式时，默认色板可能在后续样式注入中覆盖主色变量；
 * - 入口阶段用内联变量强制写回品牌色，确保管理端始终使用深绿色主色。
 */
const applyElementBrandPalette = () => {
  const root = document.documentElement
  root.style.setProperty('--el-color-primary', '#005b52')
  root.style.setProperty('--el-color-primary-light-3', '#4d8c85')
  root.style.setProperty('--el-color-primary-light-5', '#80ada8')
  root.style.setProperty('--el-color-primary-light-7', '#b3cecb')
  root.style.setProperty('--el-color-primary-light-8', '#ccdcdb')
  root.style.setProperty('--el-color-primary-light-9', '#e6efee')
  root.style.setProperty('--el-color-primary-dark-2', '#004942')
}

applyElementBrandPalette()

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
 * 会话失效桥接器：
 * - HTTP 拦截器只负责识别“需要重新登录”的被动失效场景；
 * - 真正的导航在这里统一收口为 `router.replace`，避免因为 `window.location.replace` 触发整页重刷；
 * - 主动退出、改密重登仍保留各自的硬跳逻辑，不受这里影响。
 */
const installSessionReloginBridge = () => {
  if (globalThis.window === undefined) {
    return
  }

  globalThis.window.addEventListener(SESSION_RELOGIN_EVENT, (rawEvent) => {
    const event = rawEvent as CustomEvent<SessionReloginDetail>
    const redirectPath = typeof event.detail?.redirect === 'string' ? event.detail.redirect : '/login'
    event.preventDefault()

    if (event.detail?.target === 'client') {
      useClientAuthStore(pinia).clearAuthState()
    } else {
      useAuthStore(pinia).handleSessionExpired()
    }

    void router.replace(redirectPath).catch(() => undefined)
  })
}

installSessionReloginBridge()

if (globalThis.window !== undefined) {
  window.addEventListener('error', (event) => {
    if (shouldIgnoreGlobalRuntimeError(event.error || event.message, event.filename)) {
      event.preventDefault()
      return
    }

    void showCriticalErrorDialog(event.error || event.message, {
      title: '页面脚本异常',
      fallback: '页面脚本异常，请刷新后重试',
      operation: 'window.onerror',
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    if (shouldIgnoreGlobalRuntimeError(event.reason)) {
      event.preventDefault()
      return
    }

    void showCriticalErrorDialog(event.reason, {
      title: '页面异步操作异常',
      fallback: '页面异步操作异常，请刷新后重试',
      operation: 'unhandledrejection',
    })
  })
}

/**
 * 注册 Element Plus 全局加载指令：
 * - 项目中的 `v-loading` 属于少量跨页面通用能力，继续在入口统一挂载；
 * - 其余 UI 组件改由编译期按需引入，避免运行时整包注册。
 */
app.directive('loading', ElLoadingDirective)

// 挂载到根节点，启动 SPA 应用。
app.mount('#app')
