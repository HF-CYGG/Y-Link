import type { UserSafeProfile } from '@/api/modules/auth'

/**
 * 本地登录态存储键：
 * - token 单独保存，便于 HTTP 拦截器无须依赖 Pinia 即可读取；
 * - user / expiresAt 作为恢复登录态和首屏展示的快照来源。
 */
const AUTH_TOKEN_KEY = 'y-link.auth.token'
const AUTH_USER_KEY = 'y-link.auth.user'
const AUTH_EXPIRES_AT_KEY = 'y-link.auth.expiresAt'

/**
 * 持久化登录态结构：
 * - user 采用安全用户信息，不落敏感字段；
 * - expiresAt 保留字符串，避免本地存储 Date 反序列化歧义。
 */
export interface PersistedAuthState {
  token: string | null
  user: UserSafeProfile | null
  expiresAt: string | null
}

/**
 * 运行环境兜底：
 * - SSR/测试环境下若不存在 window，则直接跳过存储访问；
 * - 当前项目主要运行于浏览器，但该保护能避免工具链阶段报错。
 */
const getStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null
  }

  return window.localStorage
}

/**
 * 安全解析 JSON：
 * - 本地存储若被手动篡改或版本升级导致结构不兼容，直接回退 null；
 * - 避免 JSON.parse 异常中断应用启动。
 */
const safeParseJson = <T>(value: string | null): T | null => {
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value) as T
  } catch (_error) {
    return null
  }
}

/**
 * 读取已保存登录态：
 * - 供 Auth Store 首次初始化和 HTTP 拦截器共享；
 * - 返回统一结构，便于调用端按需消费 token / user / expiresAt。
 */
export const readPersistedAuthState = (): PersistedAuthState => {
  const storage = getStorage()
  if (!storage) {
    return {
      token: null,
      user: null,
      expiresAt: null,
    }
  }

  return {
    token: storage.getItem(AUTH_TOKEN_KEY),
    user: safeParseJson<UserSafeProfile>(storage.getItem(AUTH_USER_KEY)),
    expiresAt: storage.getItem(AUTH_EXPIRES_AT_KEY),
  }
}

/**
 * 仅获取 token：
 * - 请求拦截器只关心令牌本身；
 * - 将读取动作做成轻量函数，减少不必要的 JSON 解析。
 */
export const getPersistedAuthToken = (): string | null => {
  return getStorage()?.getItem(AUTH_TOKEN_KEY) ?? null
}

/**
 * 保存登录态：
 * - 登录成功、刷新 me 成功后统一写入；
 * - user 为 null 时同步删除旧快照，防止展示脏数据。
 */
export const persistAuthState = (state: PersistedAuthState) => {
  const storage = getStorage()
  if (!storage) {
    return
  }

  if (state.token) {
    storage.setItem(AUTH_TOKEN_KEY, state.token)
  } else {
    storage.removeItem(AUTH_TOKEN_KEY)
  }

  if (state.user) {
    storage.setItem(AUTH_USER_KEY, JSON.stringify(state.user))
  } else {
    storage.removeItem(AUTH_USER_KEY)
  }

  if (state.expiresAt) {
    storage.setItem(AUTH_EXPIRES_AT_KEY, state.expiresAt)
  } else {
    storage.removeItem(AUTH_EXPIRES_AT_KEY)
  }
}

/**
 * 清空登录态：
 * - 主动退出、令牌失效、账号停用时统一复用；
 * - 保证内存态和本地态都能走相同清理策略。
 */
export const clearPersistedAuthState = () => {
  persistAuthState({
    token: null,
    user: null,
    expiresAt: null,
  })
}
