/**
 * 模块说明：src/utils/client-auth-storage.ts
 * 文件职责：统一维护客户端登录最小快照、会话恢复提示与客户端 CSRF Cookie 的浏览器侧访问能力。
 * 实现逻辑：
 * - 客户端真实会话由 HttpOnly Cookie 承担，本地仅保存界面恢复所需的非敏感快照；
 * - 登录页和路由守卫可通过“是否存在可恢复会话痕迹”决定是否值得探测 `/client-auth/me`；
 * - 读取客户端 CSRF Cookie 时只返回可安全透传的值，不在本地存储任何真实会话令牌。
 * 维护说明：
 * - 若后续扩展客户端会话提示或恢复策略，优先在本文件统一收口；
 * - 禁止重新把客户端真实会话令牌写入 localStorage 或 sessionStorage。
 */

const CLIENT_AUTH_USER_KEY = 'y-link.client-auth.user'
const CLIENT_AUTH_EXPIRES_AT_KEY = 'y-link.client-auth.expiresAt'
const CLIENT_CSRF_COOKIE_NAME = 'y_link_client_csrf'

export interface ClientAuthUserSnapshot {
  id: string
  username: string
  account: string
  departmentName: string | null
  accountType: 'personal' | 'department'
  staffNo: string | null
  staffVerified: boolean
  status: string
}

export interface PersistedClientAuthState {
  user: ClientAuthUserSnapshot | null
  expiresAt: string | null
}

const getStorage = (): Storage | null => {
  if (typeof globalThis.window === 'undefined') {
    return null
  }
  return globalThis.window.localStorage
}

const safeParseJson = <T>(value: string | null): T | null => {
  if (!value) {
    return null
  }
  try {
    return JSON.parse(value) as T
  } catch (error) {
    console.warn('[client-auth-storage] 客户端登录快照解析失败，已忽略损坏缓存。', error)
    return null
  }
}

export const readPersistedClientAuthState = (): PersistedClientAuthState => {
  const storage = getStorage()
  if (!storage) {
    return {
      user: null,
      expiresAt: null,
    }
  }
  return {
    user: safeParseJson<ClientAuthUserSnapshot>(storage.getItem(CLIENT_AUTH_USER_KEY)),
    expiresAt: storage.getItem(CLIENT_AUTH_EXPIRES_AT_KEY),
  }
}

export const getClientCsrfToken = (): string | null => {
  if (typeof document === 'undefined') {
    return null
  }

  const cookieEntry = document.cookie
    .split(';')
    .map((segment) => segment.trim())
    .find((segment) => segment.startsWith(`${CLIENT_CSRF_COOKIE_NAME}=`))

  if (!cookieEntry) {
    return null
  }

  const rawValue = cookieEntry.slice(CLIENT_CSRF_COOKIE_NAME.length + 1)
  if (!rawValue) {
    return null
  }

  try {
    return decodeURIComponent(rawValue)
  } catch (error) {
    if (error instanceof URIError) {
      return rawValue
    }
    throw error
  }
}

export const hasRecoverableClientSessionHint = (): boolean => {
  const persisted = readPersistedClientAuthState()
  return Boolean(persisted.user || persisted.expiresAt || getClientCsrfToken())
}

export const persistClientAuthState = (state: PersistedClientAuthState) => {
  const storage = getStorage()
  if (!storage) {
    return
  }

  if (state.user) {
    storage.setItem(CLIENT_AUTH_USER_KEY, JSON.stringify(state.user))
  } else {
    storage.removeItem(CLIENT_AUTH_USER_KEY)
  }

  if (state.expiresAt) {
    storage.setItem(CLIENT_AUTH_EXPIRES_AT_KEY, state.expiresAt)
  } else {
    storage.removeItem(CLIENT_AUTH_EXPIRES_AT_KEY)
  }
}

export const clearPersistedClientAuthState = () => {
  persistClientAuthState({
    user: null,
    expiresAt: null,
  })
}
