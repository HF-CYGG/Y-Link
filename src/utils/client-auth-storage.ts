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
