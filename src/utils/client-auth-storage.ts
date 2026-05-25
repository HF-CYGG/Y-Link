/**
 * 模块说明：src/utils/client-auth-storage.ts
 * 文件职责：维护客户端登录态的本地最小快照与 CSRF Cookie 读取工具，支撑刷新恢复与会话探测。
 * 实现逻辑：
 * - localStorage 仅保存 `id/account/username/department/status/expiresAt`，不落地 token、手机号、邮箱；
 * - 刷新时先读取快照用于骨架回填，再由 `/client-auth/me` 做服务端会话确认；
 * - 兼容清理历史 `client-auth.token` 键，避免升级后遗留旧敏感数据。
 * 维护说明：若调整本地持久化字段，需要同步更新 `ClientAuthUserSnapshot` 与客户端鉴权 store 的恢复逻辑。
 */

const CLIENT_AUTH_TOKEN_KEY = 'y-link.client-auth.token'
const CLIENT_AUTH_USER_KEY = 'y-link.client-auth.user'
const CLIENT_AUTH_EXPIRES_AT_KEY = 'y-link.client-auth.expiresAt'
const CLIENT_CSRF_COOKIE_NAME = 'y_link_client_csrf'

export interface ClientAuthUserSnapshot {
  id: string
  account: string
  username?: string
  departmentName: string | null
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

// 容错解析本地 JSON，避免手工改动 localStorage 导致初始化阶段抛异常。
const safeParseJson = <T>(value: string | null): T | null => {
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value) as T
  } catch (error) {
    console.warn('[client-auth-storage] failed to parse persisted client auth snapshot', error)
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

// 是否存在“值得请求 /client-auth/me 再确认”的会话痕迹。
export const hasRecoverableClientSessionHint = (): boolean => {
  const persisted = readPersistedClientAuthState()
  return Boolean(persisted.user || persisted.expiresAt || getClientCsrfToken())
}

export const persistClientAuthState = (state: PersistedClientAuthState) => {
  const storage = getStorage()
  if (!storage) {
    return
  }

  storage.removeItem(CLIENT_AUTH_TOKEN_KEY)

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
