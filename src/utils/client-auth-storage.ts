/**
 * 妯″潡璇存槑锛歴rc/utils/client-auth-storage.ts
 * 鏂囦欢鑱岃矗锛氱淮鎶ゅ鎴风鏈€灏忕櫥褰曞揩鐓э紙涓嶅惈 token / 鎵嬫満鍙?/ 閭锛夈€? * 瀹炵幇閫昏緫锛氬彧鎸佷箙鍖?UI 鎭㈠闇€瑕佺殑鏈€灏忓瓧娈碉紝瀹屾暣璧勬枡缁熶竴鐢?/client-auth/me 鍥炲～銆? * 缁存姢璇存槑锛氬璋冩暣瀹㈡埛绔櫥褰曟€佸瓧娈碉紝闇€鍚屾鏇存柊 Store 鐨勫揩鐓у啓鍏ヤ笌鎭㈠閫昏緫銆? */

const CLIENT_AUTH_USER_KEY = 'y-link.client-auth.user'
const CLIENT_AUTH_EXPIRES_AT_KEY = 'y-link.client-auth.expiresAt'

export interface ClientAuthUserSnapshot {
  id: string
  username: string
  account: string
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
