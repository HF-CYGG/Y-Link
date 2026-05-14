/**
 * 模块说明：src/utils/auth-storage.ts
 * 文件职责：统一管理管理端本地安全快照与 CSRF Cookie 读取逻辑。
 * 实现逻辑：
 * - 管理端会话令牌不再落入 localStorage，只保留用户信息与过期时间等非敏感快照；
 * - 请求层通过读取可读 CSRF Cookie，为写操作自动补充 `x-csrf-token` 请求头；
 * - 同时兼容清理历史 Bearer Token 遗留键，避免旧版本本地数据继续生效。
 * 维护说明：
 * - 若后续扩展“会话提示态”或“即将过期提醒”，请继续沿用本文件统一收口；
 * - 禁止重新把管理端真实会话令牌写回可被脚本直接读取的存储介质。
 */

import type { UserSafeProfile } from '@/api/modules/auth'

/**
 * 本地登录态存储键：
 * - `AUTH_TOKEN_KEY` 为历史 Bearer 模式遗留键，只保留用于升级清理；
 * - user / expiresAt 作为恢复 UI 状态和登录页提示的轻量快照来源。
 */
const AUTH_TOKEN_KEY = 'y-link.auth.token'
const AUTH_USER_KEY = 'y-link.auth.user'
const AUTH_EXPIRES_AT_KEY = 'y-link.auth.expiresAt'
const ADMIN_CSRF_COOKIE_NAME = 'y_link_admin_csrf'

/**
 * 持久化登录态结构：
 * - user 采用安全用户信息，不落敏感字段；
 * - expiresAt 保留字符串，避免本地存储 Date 反序列化歧义；
 * - 不再保存真实会话令牌，由浏览器通过 HttpOnly Cookie 接管。
 */
export interface PersistedAuthState {
  user: UserSafeProfile | null
  expiresAt: string | null
}

/**
 * 运行环境兜底：
 * - SSR/测试环境下若不存在 window，则直接跳过存储访问；
 * - 当前项目主要运行于浏览器，但该保护能避免工具链阶段报错。
 */
const getStorage = (): Storage | null => {
  if (globalThis.window === undefined) {
    return null
  }

  return globalThis.window.localStorage
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
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
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
      user: null,
      expiresAt: null,
    }
  }

  return {
    user: safeParseJson<UserSafeProfile>(storage.getItem(AUTH_USER_KEY)),
    expiresAt: storage.getItem(AUTH_EXPIRES_AT_KEY),
  }
}

/**
 * 读取管理端 CSRF Cookie：
 * - 仅供管理端写操作请求自动补头使用；
 * - 若浏览器暂未拿到该 Cookie，则返回 null，由调用方决定是否继续发起请求。
 */
export const getAdminCsrfToken = (): string | null => {
  if (typeof document === 'undefined') {
    return null
  }

  const cookieEntry = document.cookie
    .split(';')
    .map((segment) => segment.trim())
    .find((segment) => segment.startsWith(`${ADMIN_CSRF_COOKIE_NAME}=`))

  if (!cookieEntry) {
    return null
  }

  const rawValue = cookieEntry.slice(ADMIN_CSRF_COOKIE_NAME.length + 1)
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

  /**
   * 升级清理：
   * - 管理端已切换到 HttpOnly Cookie，会话令牌绝不能继续停留在 localStorage；
   * - 因此每次持久化时都主动删除历史键，确保老数据被逐步淘汰。
   */
  storage.removeItem(AUTH_TOKEN_KEY)

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
    user: null,
    expiresAt: null,
  })
}
