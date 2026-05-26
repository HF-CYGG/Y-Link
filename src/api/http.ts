/**
 * 模块说明：F:/Y-Link/src/api/http.ts
 * 文件职责：前端 HTTP 基础层，统一处理鉴权头、CSRF、防重登、错误归一化与可选 GET 短缓存。
 * 实现逻辑：
 * - 管理端与客户端根据 URL 自动分流鉴权策略；
 * - 显式开启 `cache` 的 GET 请求支持内存短缓存 + ETag 条件请求；
 * - 写操作成功后清理相关缓存，避免页面读到旧状态。
 * 维护说明：
 * - 缓存默认关闭，必须由业务调用点显式开启；
 * - 认证与敏感接口禁止启用缓存。
 */

import axios, { type AxiosRequestConfig, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import type { ApiResponse } from '@/types/api'
import { useAppStore } from '@/store/modules/app'
import { clearPersistedAuthState, getAdminCsrfToken, readPersistedAuthState } from '@/utils/auth-storage'
import { getClientRiskHeaderSnapshot } from '@/utils/client-auth-risk'
import {
  clearPersistedClientAuthState,
  getClientCsrfToken,
  readPersistedClientAuthState,
} from '@/utils/client-auth-storage'
import { AppRequestError, normalizeRequestError, unwrapApiResponse } from '@/utils/error'
import pinia from '@/store/pinia'

export const SESSION_RELOGIN_EVENT = 'y-link:session-relogin'

export type SessionReloginDetail = {
  target: 'admin' | 'client'
  redirect: string
}

export type RequestCacheScope = 'auto' | 'public' | 'client-user' | 'admin-user'

export interface RequestCachePolicy {
  enabled?: boolean
  ttlMs: number
  scope?: RequestCacheScope
  key?: string
}

export type RequestConfig = Pick<AxiosRequestConfig, 'signal'> & {
  cache?: RequestCachePolicy
}

type RequestConfigWithCache = AxiosRequestConfig & { cache?: RequestCachePolicy }

interface NormalizedCachePolicy {
  ttlMs: number
  scope: RequestCacheScope
  key?: string
}

interface CachedResponseEntry<T = unknown> {
  data: T
  etag: string | null
  lastModified: string | null
  expiresAt: number
}

const requestCacheStore = new Map<string, CachedResponseEntry>()

const normalizeRequestUrl = (url?: string) => {
  return typeof url === 'string' ? url : ''
}

const isClientRouteContext = () => {
  if (globalThis.window === undefined) {
    return false
  }
  return globalThis.window.location.pathname.startsWith('/client')
}

const isLoginRequest = (url?: string) => {
  return /\/auth\/login(?:\?|$)/.test(normalizeRequestUrl(url))
}

const isSessionProbeRequest = (url?: string) => {
  return /\/(?:auth|client-auth)\/me(?:\?|$)/.test(normalizeRequestUrl(url))
}

const isClientGuestAuthRequest = (url?: string) => {
  return /\/client-auth\/(?:captcha|capabilities|login|register|verification-code\/send|forgot-password\/verify|forgot-password\/reset)(?:\?|$)/.test(
    normalizeRequestUrl(url),
  )
}

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

const isAdminRequest = (url?: string) => {
  const normalizedUrl = normalizeRequestUrl(url)
  if (!normalizedUrl) {
    return false
  }
  return !isClientRequest(normalizedUrl)
}

const isSafeRequestMethod = (method?: string) => {
  const normalizedMethod = (method ?? 'GET').toUpperCase()
  return ['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)
}

const isCacheForbiddenPath = (url?: string) => {
  const normalizedUrl = normalizeRequestUrl(url)
  return /\/(?:auth|client-auth)(?:\/|$)/.test(normalizedUrl)
}

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

const attachClientCsrfHeader = (config: InternalAxiosRequestConfig) => {
  if (!isClientRequest(config.url) || isSafeRequestMethod(config.method)) {
    return config
  }

  if (config.headers['x-csrf-token']) {
    return config
  }

  const csrfToken = getClientCsrfToken()
  if (csrfToken) {
    config.headers['x-csrf-token'] = csrfToken
  }
  return config
}

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

const shouldForceRelogin = (error: ReturnType<typeof normalizeRequestError>, requestUrl?: string) => {
  if (isLoginRequest(requestUrl) || isClientGuestAuthRequest(requestUrl) || isSessionProbeRequest(requestUrl)) {
    return false
  }

  if (error.status === 401) {
    return true
  }

  return error.status === 403 && /停用/.test(error.message)
}

const getStableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => getStableValue(item))
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const objectValue = value as Record<string, unknown>
  return Object.keys(objectValue)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = getStableValue(objectValue[key])
      return result
    }, {})
}

const buildStableString = (value: unknown) => {
  if (value === undefined) {
    return ''
  }
  try {
    return JSON.stringify(getStableValue(value))
  } catch {
    return String(value)
  }
}

const resolveCacheActor = (scope: RequestCacheScope, url?: string): string => {
  if (scope === 'public') {
    return 'public'
  }

  const normalizedUrl = normalizeRequestUrl(url)
  const resolvedScope =
    scope === 'auto' ? (isClientRequest(normalizedUrl) ? 'client-user' : 'admin-user') : scope

  if (resolvedScope === 'client-user') {
    const state = readPersistedClientAuthState()
    return `client:${state.user?.id ?? state.user?.account ?? 'guest'}`
  }

  const state = readPersistedAuthState()
  return `admin:${state.user?.id ?? state.user?.username ?? 'guest'}`
}

const resolveCachePolicy = (
  method: string,
  url: string,
  policy?: RequestCachePolicy,
): NormalizedCachePolicy | null => {
  if (method !== 'GET') {
    return null
  }
  if (!policy || policy.enabled === false) {
    return null
  }
  if (!Number.isFinite(policy.ttlMs) || policy.ttlMs <= 0) {
    return null
  }
  if (isCacheForbiddenPath(url)) {
    return null
  }

  return {
    ttlMs: Math.max(1000, Math.floor(policy.ttlMs)),
    scope: policy.scope ?? 'auto',
    key: policy.key?.trim() || undefined,
  }
}

const buildRequestCacheKey = (config: AxiosRequestConfig, policy: NormalizedCachePolicy) => {
  const method = (config.method ?? 'GET').toUpperCase()
  const url = normalizeRequestUrl(config.url)
  const paramsSegment = buildStableString(config.params)
  const actor = resolveCacheActor(policy.scope, url)
  const customKey = policy.key ?? ''
  return `${method}|${url}|${paramsSegment}|${actor}|${customKey}`
}

const toHeaderRecord = (headers?: AxiosRequestConfig['headers']) => {
  if (!headers) {
    return {} as Record<string, string>
  }
  return headers as Record<string, string>
}

const clearRequestCache = () => {
  requestCacheStore.clear()
}

const setCacheEntry = <T>(
  key: string,
  response: AxiosResponse<ApiResponse<T>>,
  data: T,
  ttlMs: number,
) => {
  const etagHeader = response.headers?.etag
  const lastModifiedHeader = response.headers?.['last-modified']
  const etag = typeof etagHeader === 'string' ? etagHeader : null
  const lastModified = typeof lastModifiedHeader === 'string' ? lastModifiedHeader : null
  requestCacheStore.set(key, {
    data,
    etag,
    lastModified,
    expiresAt: Date.now() + ttlMs,
  })
}

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  timeout: 15000,
  withCredentials: true,
})

http.interceptors.request.use(
  (config) => {
    const appStore = useAppStore(pinia)
    appStore.startLoading()

    return attachClientCsrfHeader(attachAdminCsrfHeader(attachClientRiskHeaders(config)))
  },
  (error) => {
    const appStore = useAppStore(pinia)
    appStore.endLoading()
    return Promise.reject(error)
  },
)

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

export const request = async <T>(config: RequestConfigWithCache): Promise<T> => {
  const { cache, ...axiosConfig } = config
  const method = (axiosConfig.method ?? 'GET').toUpperCase()
  const requestUrl = normalizeRequestUrl(axiosConfig.url)
  const cachePolicy = resolveCachePolicy(method, requestUrl, cache)

  let cacheKey: string | null = null
  let cachedEntry: CachedResponseEntry<T> | null = null
  if (cachePolicy) {
    cacheKey = buildRequestCacheKey(axiosConfig, cachePolicy)
    const matchedEntry = requestCacheStore.get(cacheKey) as CachedResponseEntry<T> | undefined
    if (matchedEntry) {
      cachedEntry = matchedEntry
      if (matchedEntry.expiresAt > Date.now()) {
        return matchedEntry.data
      }
    }

    const requestHeaders = toHeaderRecord(axiosConfig.headers)
    if (cachedEntry?.etag) {
      requestHeaders['If-None-Match'] = cachedEntry.etag
    }
    if (cachedEntry?.lastModified) {
      requestHeaders['If-Modified-Since'] = cachedEntry.lastModified
    }
    axiosConfig.headers = requestHeaders
  }

  try {
    const response = await http.request<ApiResponse<T>>(axiosConfig)
    const payload = unwrapApiResponse(response.data, {
      status: response.status,
    })

    if (cachePolicy && cacheKey) {
      setCacheEntry(cacheKey, response, payload, cachePolicy.ttlMs)
    } else if (!isSafeRequestMethod(method)) {
      clearRequestCache()
    }

    return payload
  } catch (error) {
    const normalizedError = normalizeRequestError(error)
    if (cachePolicy && cacheKey && normalizedError instanceof AppRequestError && normalizedError.status === 304) {
      const fallbackEntry = (requestCacheStore.get(cacheKey) as CachedResponseEntry<T> | undefined) ?? cachedEntry
      if (fallbackEntry) {
        fallbackEntry.expiresAt = Date.now() + cachePolicy.ttlMs
        requestCacheStore.set(cacheKey, fallbackEntry)
        return fallbackEntry.data
      }
    }
    throw normalizedError
  }
}

export { http }
export default http
