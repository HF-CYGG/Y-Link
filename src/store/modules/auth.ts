import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  getCurrentUser,
  login as loginApi,
  logout as logoutApi,
  normalizeUserPermissions,
  normalizeUserSafeProfile,
  type LoginPayload,
  type PermissionCode,
  type UserSafeProfile,
} from '@/api/modules/auth'
import { preloadRouteComponents, resolvePostLoginWarmupTargets } from '@/router/route-performance'
import { clearPersistedAuthState, persistAuthState, readPersistedAuthState } from '@/utils/auth-storage'

/**
 * 主系统登录过渡时长：
 * - 控制“先壳后数”的短过渡节奏；
 * - 时间保持克制，避免为动效而牺牲效率。
 */
const POST_LOGIN_TRANSITION_MS = 520

/**
 * 统一认证 Store：
 * - 管理 token、当前用户、初始化状态与登录/退出流程；
 * - 所有鉴权判断都以这里为单一真源。
 */
export const useAuthStore = defineStore('auth', () => {
  const persisted = readPersistedAuthState()

  // 登录令牌：应用启动时优先从本地存储恢复，保证刷新后仍能续用会话。
  const token = ref<string | null>(persisted.token)

  // 当前用户信息：可先用本地快照回填，再通过 /auth/me 做服务端校验刷新。
  const currentUser = ref<UserSafeProfile | null>(persisted.user ? normalizeUserSafeProfile(persisted.user) : null)

  // 会话过期时间：用于登录页与头部的提示扩展，也便于后续增加即将过期提醒。
  const expiresAt = ref<string | null>(persisted.expiresAt)

  // initialized 表示“本轮启动是否已完成鉴权恢复流程”。
  const initialized = ref(false)

  // initializing 防止多个路由守卫并发触发重复的 /auth/me 请求。
  const initializing = ref(false)

  // enteringSystem 用于登录成功后短时间展示主系统壳层加载过渡。
  const enteringSystem = ref(false)

  let initializePromise: Promise<boolean> | null = null
  let transitionTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 是否已登录：
   * - token 与 currentUser 同时存在才视为“前端已确认登录”；
   * - 可避免仅有本地 token 但尚未校验成功时误判为已登录。
   */
  const isAuthenticated = computed(() => Boolean(token.value && currentUser.value))

  /**
   * 是否为管理员：
   * - 顶栏、侧栏菜单、管理员页面按钮均可直接复用；
   * - 让角色判断收敛到 Store 内部。
   */
  const isAdmin = computed(() => currentUser.value?.role === 'admin')

  /**
   * 当前用户权限点集合：
   * - 优先使用服务端返回的 permissions；
   * - 若读取到旧版本本地快照，则按角色自动补齐默认权限。
   */
  const permissionSet = computed(() => {
    if (!currentUser.value) {
      return new Set<PermissionCode>()
    }

    return new Set(normalizeUserPermissions(currentUser.value))
  })

  /**
   * 持久化当前内存态：
   * - 任何登录态变更都只通过该函数统一落盘；
   * - 避免 token/user/expiresAt 分散写入产生不一致。
   */
  const syncPersistedState = () => {
    persistAuthState({
      token: token.value,
      user: currentUser.value,
      expiresAt: expiresAt.value,
    })
  }

  /**
   * 设置登录态：
   * - 登录成功与 me 刷新成功都走同一入口；
   * - initialized 同步置为 true，表示当前状态已可信。
   */
  const setAuthState = (payload: { token?: string | null; user: UserSafeProfile; expiresAt?: string | null }) => {
    if (payload.token !== undefined) {
      token.value = payload.token
    }

    currentUser.value = normalizeUserSafeProfile(payload.user)
    if (payload.expiresAt !== undefined) {
      expiresAt.value = payload.expiresAt
    }
    initialized.value = true
    syncPersistedState()
  }

  /**
   * 清空登录态：
   * - 主动退出、接口返回未授权、账号被停用等场景统一复用；
   * - resetInitialized 可控制是否要求下次重新执行初始化流程。
   */
  const clearAuthState = (options?: { resetInitialized?: boolean }) => {
    token.value = null
    currentUser.value = null
    expiresAt.value = null
    initializing.value = false
    initializePromise = null
    initialized.value = !options?.resetInitialized
    clearPersistedAuthState()
  }

  /**
   * 启动登录成功后的主系统过渡：
   * - 在登录页跳转到业务壳层时展示短暂蒙层和骨架感；
   * - 用“短、轻、稳”的方式强化企业系统进入感。
   */
  const startPostLoginTransition = () => {
    enteringSystem.value = true

    if (transitionTimer) {
      clearTimeout(transitionTimer)
    }

    transitionTimer = setTimeout(() => {
      enteringSystem.value = false
      transitionTimer = null
    }, POST_LOGIN_TRANSITION_MS)
  }

  const warmupPostLoginEntry = async (redirectPath?: string) => {
    await preloadRouteComponents(resolvePostLoginWarmupTargets(redirectPath))
  }

  /**
   * 恢复并校验登录态：
   * - 若本地没有 token，则直接完成初始化；
   * - 若有 token，则调用 /auth/me 让服务端确认会话有效性。
   */
  const initializeAuth = async (): Promise<boolean> => {
    if (initialized.value) {
      return isAuthenticated.value
    }

    if (initializePromise !== null) {
      return initializePromise
    }

    if (!token.value) {
      initialized.value = true
      currentUser.value = null
      expiresAt.value = null
      return false
    }

    initializing.value = true
    initializePromise = (async () => {
      try {
        const user = await getCurrentUser()
        setAuthState({ user })
        return true
      } catch {
        clearAuthState()
        return false
      } finally {
        initializing.value = false
        initializePromise = null
      }
    })()

    return initializePromise
  }

  /**
   * 登录动作：
   * - 请求成功后同时更新 token/user/expiresAt；
   * - 进入主系统前触发短过渡态。
   */
  const login = async (payload: LoginPayload) => {
    const result = await loginApi(payload)
    token.value = result.token
    setAuthState({
      token: result.token,
      user: result.user,
      expiresAt: result.expiresAt,
    })
    startPostLoginTransition()
    return result
  }

  /**
   * 退出动作：
   * - 若服务端退出失败，仍保证前端本地态可以被清空；
   * - 防止“服务端异常导致用户无法退出”的问题。
   */
  const logout = async () => {
    try {
      if (token.value) {
        await logoutApi()
      }
    } finally {
      clearAuthState({ resetInitialized: true })
    }
  }

  /**
   * 被动失效处理：
   * - 当 HTTP 拦截器识别到 token 失效时调用；
   * - 需要让下次路由进入时重新走 initializeAuth 逻辑。
   */
  const handleSessionExpired = () => {
    clearAuthState({ resetInitialized: true })
  }

  /**
   * 是否拥有指定权限点：
   * - 路由守卫、菜单与按钮都复用同一判断入口；
   * - 让“权限点校验”在前端保持单一真源。
   */
  const hasPermission = (permission: PermissionCode) => permissionSet.value.has(permission)

  /**
   * 是否拥有全部权限点：
   * - 路由级别通常要求同时满足全部 requiredPermissions；
   * - 未配置权限时默认放行，便于兼容公共业务页面。
   */
  const hasPermissions = (permissions?: PermissionCode[]) => {
    if (!permissions?.length) {
      return true
    }

    return permissions.every((permission) => permissionSet.value.has(permission))
  }

  /**
   * 是否拥有任一权限点：
   * - 页面按钮组可用该方法快速判断“至少具备一项治理操作”；
   * - 适合控制批量操作栏、卡片操作区等组合能力入口。
   */
  const hasAnyPermission = (permissions: PermissionCode[]) => {
    return permissions.some((permission) => permissionSet.value.has(permission))
  }

  return {
    token,
    currentUser,
    expiresAt,
    initialized,
    initializing,
    enteringSystem,
    isAuthenticated,
    isAdmin,
    permissionSet,
    setAuthState,
    clearAuthState,
    initializeAuth,
    login,
    logout,
    handleSessionExpired,
    startPostLoginTransition,
    hasPermission,
    hasPermissions,
    hasAnyPermission,
    warmupPostLoginEntry,
  }
})
