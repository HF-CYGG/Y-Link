/**
 * 模块说明：src/utils/client-auth-storage.ts
 * 文件职责：维护客户端登录最小快照（不包含 token、手机号、邮箱）在浏览器本地的读写。
 * 实现逻辑：仅持久化 UI 恢复所需字段；完整用户资料统一通过 `/client-auth/me` 回填。
 * 维护说明：若调整登录态字段，需同步更新 Store 的快照写入与恢复流程。
 */

const CLIENT_AUTH_USER_KEY = 'y-link.client-auth.user'
const CLIENT_AUTH_EXPIRES_AT_KEY = 'y-link.client-auth.expiresAt'

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
    console.warn('[client-auth-storage] failed to parse persisted auth snapshot, ignored corrupted cache', error)
    return null
  }
}

export const readPersistedClientAuthState = (): PersistedClientAuthState => {
  const storage = getStorage()
  if (!storage) {
    return { user: null, expiresAt: null }
  }
  return {
    user: safeParseJson<ClientAuthUserSnapshot>(storage.getItem(CLIENT_AUTH_USER_KEY)),
    expiresAt: storage.getItem(CLIENT_AUTH_EXPIRES_AT_KEY),
  }
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
