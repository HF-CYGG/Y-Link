/**
 * 模块说明：src/api/http.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import axios, { type AxiosRequestConfig, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import type { ApiResponse } from '@/types/api'
import { useAppStore } from '@/store/modules/app'
import { clearPersistedAuthState, getPersistedAuthToken } from '@/utils/auth-storage'
import { clearPersistedClientAuthState, getPersistedClientAuthToken } from '@/utils/client-auth-storage'
import { normalizeRequestError, unwrapApiResponse } from '@/utils/error'
import pinia from '@/store/pinia'

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
 * 是否为登录接口请求：
 * - 登录失败属于正常业务反馈，不应被全局拦截器误判为“会话失效”；
 * - 因此需要排除 /auth/login 的 401 响应自动跳转逻辑。
 */
const isLoginRequest = (url?: string) => {
  return /\/auth\/login(?:\?|$)/.test(normalizeRequestUrl(url))
}

/**
 * 是否为客户端鉴权访客接口：
 * - 登录、注册、找回密码等接口即使返回 401，也不应触发“会话失效跳转”；
 * - 否则用户在输入错误验证码时会被莫名其妙重定向。
 */
const isClientGuestAuthRequest = (url?: string) => {
  return /\/client-auth\/(?:captcha|login|register|forgot-password\/verify|forgot-password\/reset)(?:\?|$)/.test(normalizeRequestUrl(url))
}

/**
 * 当前请求是否属于客户端链路：
 * - `/client-auth/*` 与 `/o2o/mall/*` 使用客户端 token；
 * - 管理端继续沿用原有管理员 token，避免两个端的鉴权头混用。
 */
const isClientRequest = (url?: string) => {
  return /\/(?:client-auth|o2o\/mall)(?:\/|$)/.test(normalizeRequestUrl(url))
}

/**
 * 判断当前请求是否应注入 Authorization：
 * - 只要本地存在 token，统一走 Bearer 头传递；
 * - 若调用方已手动传入 Authorization，则以调用方配置为准。
 */
const attachAuthorizationHeader = (config: InternalAxiosRequestConfig) => {
  const token = isClientRequest(config.url) ? getPersistedClientAuthToken() : getPersistedAuthToken()
  if (!token) {
    return config
  }

  const currentAuthorization = config.headers.Authorization
  if (!currentAuthorization) {
    config.headers.Authorization = `Bearer ${token}`
  }

  return config
}

/**
 * 统一跳回登录页：
 * - 先清空本地登录态，避免刷新后继续带着失效 token；
 * - 使用硬跳转强制重建前端内存态，确保 Pinia 中的旧用户信息同步被清理。
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
    globalThis.window.location.replace(loginPath)
    return
  }

  const loginUrl = `${loginPath}?redirect=${encodeURIComponent(currentPath)}`
  globalThis.window.location.replace(loginUrl)
}

/**
 * 是否需要触发全局重新登录：
 * - 401 代表会话缺失或过期，需要回到登录页；
 * - 403 中仅处理“账号已停用”场景，普通权限不足交由页面层自行提示。
 */
const shouldForceRelogin = (error: ReturnType<typeof normalizeRequestError>, requestUrl?: string) => {
  if (isLoginRequest(requestUrl) || isClientGuestAuthRequest(requestUrl)) {
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

    return attachAuthorizationHeader(config)
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
