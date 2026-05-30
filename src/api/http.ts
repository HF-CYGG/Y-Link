/**
 * 模块说明：src/api/http.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import axios, { type AxiosRequestConfig, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import type { ApiResponse } from '@/types/api'
import { useAppStore } from '@/store/modules/app'
import { clearPersistedAuthState, getAdminCsrfToken } from '@/utils/auth-storage'
import { getClientRiskHeaderSnapshot } from '@/utils/client-auth-risk'
import { clearPersistedClientAuthState } from '@/utils/client-auth-storage'
import { normalizeRequestError, unwrapApiResponse } from '@/utils/error'
import pinia from '@/store/pinia'

export const SESSION_RELOGIN_EVENT = 'y-link:session-relogin'

export type SessionReloginDetail = {
  target: 'admin' | 'client'
  redirect: string
}

/**
 * 页面层可安全透传的请求控制项：
 * - 当前仅开放 signal，供高频列表页做请求取消；
 * - 避免业务层直接依赖完整 Axios 配置，保持模块边界清晰。
 */
export type RequestConfig = Pick<AxiosRequestConfig, 'signal'>

/**
 * 归一化请求地址：
 * - Axios 可能传入相对路径、绝对路径或带查询串的地址；
 * - 统一转为便于判断的字符串，供鉴权注入与失效处理复用。
 */
const normalizeRequestUrl = (url?: string) => {
  return typeof url === 'string' ? url : ''
}

/**
 * 是否处于客户端页面上下文：
 * - 共享接口 `/o2o/orders/*` 同时被管理端与客户端复用，不能只靠 URL 前缀判断归属；
 * - 因此需要结合当前浏览器路径，只有用户正在 `/client/*` 页面时才把这类共享接口视为客户端链路。
 */
const isClientRouteContext = () => {
  if (globalThis.window === undefined) {
    return false
  }
  return globalThis.window.location.pathname.startsWith('/client')
}

/**
 * 是否为登录接口请求：
 * - 登录失败属于正常业务反馈，不应被全局拦截器误判为“会话失效”；
 * - 因此需要排除 /auth/login 的 401 响应自动跳转逻辑。
 */
const isLoginRequest = (url?: string) => {
  return /\/auth\/login(?:\?|$)/.test(normalizeRequestUrl(url))
}

/**
 * 是否为会话探测请求：
 * - `/auth/me` 与 `/client-auth/me` 用于启动恢复阶段探测当前会话是否仍有效；
 * - 这类请求的 401 应交给调用方自行兜底，不应触发全局硬跳转，否则会在登录页形成整页重载循环。
 */
const isSessionProbeRequest = (url?: string) => {
  return /\/(?:auth|client-auth)\/me(?:\?|$)/.test(normalizeRequestUrl(url))
}

/**
 * 是否为客户端鉴权访客接口：
 * - 登录、注册、找回密码等接口即使返回 401，也不应触发“会话失效跳转”；
 * - 否则用户在输入错误验证码时会被莫名其妙重定向。
 */
const isClientGuestAuthRequest = (url?: string) => {
  return /\/client-auth\/(?:captcha|capabilities|login|register|verification-code\/send|forgot-password\/verify|forgot-password\/reset)(?:\?|$)/.test(
    normalizeRequestUrl(url),
  )
}

/**
 * 当前请求是否属于客户端链路：
 * - `/client-auth/*`、`/client-feedback/*` 与 `/o2o/mall/*` 使用客户端 token；
 * - `/o2o/orders/*` 属于前后端复用接口，需要结合当前是否在客户端页面中再决定归属；
 * - 管理端继续沿用原有管理员 token，避免两个端的鉴权头混用。
 */
const isClientRequest = (url?: string) => {
  const normalizedUrl = normalizeRequestUrl(url)
  if (/\/(?:client-auth|client-feedback|o2o\/mall)(?:\/|$)/.test(normalizedUrl)) {
    return true
  }
  if (/\/o2o\/orders(?:\/|$)/.test(normalizedUrl)) {
    return isClientRouteContext()
  }
  return false
}

/**
 * 当前请求是否属于管理端链路：
 * - `/api/*` 默认视为管理端接口；
 * - 但客户端专属接口以及客户端页面中的共享 O2O 订单接口，不参与管理端 CSRF。
 */
const isAdminRequest = (url?: string) => {
  const normalizedUrl = normalizeRequestUrl(url)
  if (!normalizedUrl) {
    return false
  }

  return !isClientRequest(normalizedUrl)
}

/**
 * 是否为安全方法：
 * - 只对会改动服务器状态的请求附加 CSRF 头；
 * - 读取类请求依赖 Cookie 会话即可，无需额外校验头。
 */
const isSafeRequestMethod = (method?: string) => {
  const normalizedMethod = (method ?? 'GET').toUpperCase()
  return ['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)
}

/**
 * 管理端 CSRF 头透传：
 * - 仅管理端非安全方法需要附加；
 * - 前端从可读 Cookie 中取值，与浏览器自动附带的 Cookie 共同完成“双提交”校验。
 */
const attachAdminCsrfHeader = (config: InternalAxiosRequestConfig) => {
  if (!isAdminRequest(config.url) || isSafeRequestMethod(config.method)) {
    return config
  }

  if (config.headers['x-csrf-token']) {
    return config
  }

  const csrfToken = getAdminCsrfToken()
  if (csrfToken) {
    config.headers['x-csrf-token'] = csrfToken
  }

  return config
}

/**
 * 客户端风控标识请求头：
 * - 客户端登录、注册、找回密码等访客链路不应只依赖公网 IP 频控；
 * - 统一透传“浏览器实例 + 浏览器会话”两个标识，供后端优先按会话/设备维度做风控。
 */
const attachClientRiskHeaders = (config: InternalAxiosRequestConfig) => {
  if (!isClientRequest(config.url)) {
    return config
  }

  const { browserId, sessionId } = getClientRiskHeaderSnapshot()
  if (!config.headers['x-client-risk-browser-id']) {
    config.headers['x-client-risk-browser-id'] = browserId
  }
  if (!config.headers['x-client-risk-session-id']) {
    config.headers['x-client-risk-session-id'] = sessionId
  }

  return config
}

/**
 * 统一跳回登录页：
 * - 先清空本地登录态，避免刷新后继续带着失效 token；
 * - 被动会话失效优先走 SPA 内部路由替换，避免首屏或首批接口偶发 401 时造成整页重刷；
 * - 若当前环境尚未注册事件桥接器，再回退到硬跳转兜底。
 */
const redirectToLogin = (target: 'admin' | 'client') => {
  if (globalThis.window === undefined) {
    return
  }

  if (target === 'client') {
    clearPersistedClientAuthState()
  } else {
    clearPersistedAuthState()
  }

  const currentPath = `${globalThis.window.location.pathname}${globalThis.window.location.search}${globalThis.window.location.hash}`
  const loginPath = target === 'client' ? '/client/login' : '/login'
  if (currentPath.startsWith(loginPath)) {
    return
  }

  const loginUrl = `${loginPath}?redirect=${encodeURIComponent(currentPath)}`
  const reloginEvent = new CustomEvent<SessionReloginDetail>(SESSION_RELOGIN_EVENT, {
    cancelable: true,
    detail: {
      target,
      redirect: loginUrl,
    },
  })
  const wasHandledBySpa = !globalThis.window.dispatchEvent(reloginEvent)
  if (wasHandledBySpa) {
    return
  }
  globalThis.window.location.replace(loginUrl)
}

/**
 * 是否需要触发全局重新登录：
 * - 401 代表会话缺失或过期，需要回到登录页；
 * - 403 中仅处理“账号已停用”场景，普通权限不足交由页面层自行提示。
 */
const shouldForceRelogin = (error: ReturnType<typeof normalizeRequestError>, requestUrl?: string) => {
  if (isLoginRequest(requestUrl) || isClientGuestAuthRequest(requestUrl) || isSessionProbeRequest(requestUrl)) {
    return false
  }

  if (error.status === 401) {
    return true
  }

  return error.status === 403 && /停用/.test(error.message)
}

/**
 * Axios 实例：
 * - 统一超时、基础路径；
 * - 统一请求头透传；
 * - 统一错误处理入口。
 */
const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  timeout: 15000,
  withCredentials: true,
})

/**
 * 请求拦截器：
 * - 开启全局加载计数；
 * - 预留鉴权 Token 注入位置。
 */
http.interceptors.request.use(
  (config) => {
    const appStore = useAppStore(pinia)
    appStore.startLoading()

    return attachAdminCsrfHeader(attachClientRiskHeaders(config))
  },
  (error) => {
    const appStore = useAppStore(pinia)
    appStore.endLoading()
    return Promise.reject(error)
  },
)

/**
 * 响应拦截器：
 * - 关闭全局加载计数；
 * - 仅返回 data 载荷，简化调用端处理。
 */
http.interceptors.response.use(
  (response: AxiosResponse<ApiResponse<unknown>>) => {
    const appStore = useAppStore(pinia)
    appStore.endLoading()
    return response
  },
  (error) => {
    const appStore = useAppStore(pinia)
    appStore.endLoading()
    const normalizedError = normalizeRequestError(error)

    if (shouldForceRelogin(normalizedError, error?.config?.url)) {
      redirectToLogin(isClientRequest(error?.config?.url) ? 'client' : 'admin')
    }

    return Promise.reject(normalizedError)
  },
)

/**
 * 通用请求方法封装：
 * - 自动解包后端响应；
 * - 统一返回 data 字段，便于业务层直接消费。
 */
export const request = async <T>(config: AxiosRequestConfig): Promise<T> => {
  try {
    const response = await http.request<ApiResponse<T>>(config)
    return unwrapApiResponse(response.data, {
      status: response.status,
    })
  } catch (error) {
    throw normalizeRequestError(error)
  }
}

export { http }
export default http
