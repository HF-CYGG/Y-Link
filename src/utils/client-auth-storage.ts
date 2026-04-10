/**
 * 模块说明：src/utils/client-auth-storage.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

/**
 * 客户端登录态本地存储键：
 * - 与管理端登录态隔离，避免两个端共用同一 token 造成串号；
 * - 约定统一前缀，便于后续排查浏览器缓存时快速识别。
 */
const CLIENT_AUTH_TOKEN_KEY = 'y-link.client-auth.token'
const CLIENT_AUTH_USER_KEY = 'y-link.client-auth.user'
const CLIENT_AUTH_EXPIRES_AT_KEY = 'y-link.client-auth.expiresAt'

/**
 * 客户端用户信息快照：
 * - 仅保留页面展示和恢复登录态需要的字段；
 * - 避免把敏感信息直接落入本地存储。
 */
export interface ClientAuthUserSnapshot {
  id: string
  mobile: string
  realName: string
  departmentName: string | null
  status: string
  lastLoginAt: string | null
}

/**
 * 客户端持久化登录态：
 * - token 供请求拦截器直接读取；
 * - user / expiresAt 供首屏恢复和头部信息展示复用。
 */
export interface PersistedClientAuthState {
  token: string | null
  user: ClientAuthUserSnapshot | null
  expiresAt: string | null
}

/**
 * 浏览器存储访问兜底：
 * - 测试或 SSR 场景下没有 window 时直接返回 null；
 * - 保证工具链阶段不会因为 localStorage 不存在而报错。
 */
const getStorage = (): Storage | null => {
  if (typeof globalThis.window === 'undefined') {
    return null
  }

  return globalThis.window.localStorage
}

/**
 * 安全 JSON 解析：
 * - 若本地数据被篡改或历史结构不兼容，则自动回退为 null；
 * - 避免 parse 异常打断应用启动流程。
 */
const safeParseJson = <T>(value: string | null): T | null => {
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value) as T
  } catch (error) {
    console.warn('[client-auth-storage] 本地客户端登录态解析失败，已忽略损坏缓存。', error)
    return null
  }
}

/**
 * 读取客户端持久化登录态：
 * - 供客户端 Store 初始化与路由守卫共享；
 * - 返回统一结构，避免每个调用点自己读 localStorage。
 */
export const readPersistedClientAuthState = (): PersistedClientAuthState => {
  const storage = getStorage()
  if (!storage) {
    return {
      token: null,
      user: null,
      expiresAt: null,
    }
  }

  return {
    token: storage.getItem(CLIENT_AUTH_TOKEN_KEY),
    user: safeParseJson<ClientAuthUserSnapshot>(storage.getItem(CLIENT_AUTH_USER_KEY)),
    expiresAt: storage.getItem(CLIENT_AUTH_EXPIRES_AT_KEY),
  }
}

/**
 * 仅获取客户端 token：
 * - 请求拦截器只需要令牌值本身；
 * - 避免每次请求都做一次完整 JSON 解析。
 */
export const getPersistedClientAuthToken = (): string | null => {
  return getStorage()?.getItem(CLIENT_AUTH_TOKEN_KEY) ?? null
}

/**
 * 持久化客户端登录态：
 * - 注册后登录、登录成功、获取 me 成功时统一调用；
 * - 任一字段为空时删除旧值，防止界面读到脏数据。
 */
export const persistClientAuthState = (state: PersistedClientAuthState) => {
  const storage = getStorage()
  if (!storage) {
    return
  }

  if (state.token) {
    storage.setItem(CLIENT_AUTH_TOKEN_KEY, state.token)
  } else {
    storage.removeItem(CLIENT_AUTH_TOKEN_KEY)
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

/**
 * 清空客户端登录态：
 * - 主动退出、会话失效或切换账号时复用；
 * - 保证 token、用户快照、过期时间同步被清除。
 */
export const clearPersistedClientAuthState = () => {
  persistClientAuthState({
    token: null,
    user: null,
    expiresAt: null,
  })
}
