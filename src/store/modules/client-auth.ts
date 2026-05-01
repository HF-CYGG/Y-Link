/**
 * 模块说明：src/store/modules/client-auth.ts
 * 文件职责：维护客户端登录态、资料快照，并在账号切换或退出时联动清理客户端业务缓存。
 * 实现逻辑：
 * - 登录、注册、启动恢复都统一通过本 Store 落盘和清理会话；
 * - 当账号切换、退出登录或 token 失效时，同步清空订单缓存等与用户强相关的本地状态，避免串号；
 * - 若服务端校验发现本地 token 已失效，会自动回退到未登录空态，确保页面口径与服务端一致。
 * 维护说明：
 * - 新增“按用户隔离”的本地业务缓存时，应优先从 `clearAuthState()` 统一挂接清理逻辑；
 * - 若登录成功结果结构变更，需要同时检查 `applyAuthResult()` 与本地持久化字段兼容性。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  type ClientAuthSuccessResult,
  type ClientSafeProfile,
  clientLogin,
  clientLogout,
  clientRegister,
  clientUpdateProfile,
  getClientMe,
  resetClientPassword,
  sendClientVerificationCode,
  verifyClientForgotPassword,
} from '@/api/modules/client-auth'
import {
  clearPersistedClientAuthState,
  persistClientAuthState,
  readPersistedClientAuthState,
  type ClientAuthUserSnapshot,
} from '@/utils/client-auth-storage'
import { normalizeRequestError } from '@/utils/error'
import { useClientOrderStore } from './client-order'

/**
 * 客户端鉴权 Store：
 * - 独立于管理端登录态，避免两个端共用同一份 Pinia 状态；
 * - 负责客户端用户的登录、注册、找回密码与会话恢复。
 */
export const useClientAuthStore = defineStore('client-auth', () => {
  const token = ref<string | null>(null)
  const currentUser = ref<ClientSafeProfile | null>(null)
  const expiresAt = ref<string | null>(null)
  const initialized = ref(false)
  const initializing = ref(false)

  const clearClientScopedStores = () => {
    const clientOrderStore = useClientOrderStore()
    clientOrderStore.clearAll()
  }

  /**
   * 是否已登录：
   * - 以 token + 用户快照同时存在为准；
   * - 避免只有一半状态残留时页面误判为已登录。
   */
  const isAuthenticated = computed(() => {
    return Boolean(token.value && currentUser.value)
  })

  /**
   * 将接口成功结果写入内存与本地：
   * - 登录、注册后都会走相同的会话落盘逻辑；
   * - 保证刷新页面后仍能恢复客户端登录态。
   */
  const applyAuthResult = (result: ClientAuthSuccessResult) => {
    const previousClientUserId = currentUser.value?.id ?? null
    if (previousClientUserId && previousClientUserId !== result.user.id) {
      clearClientScopedStores()
    }
    token.value = result.token
    currentUser.value = result.user
    expiresAt.value = result.expiresAt

    persistClientAuthState({
      token: result.token,
      user: result.user,
      expiresAt: result.expiresAt,
    })
  }

  /**
   * 归一化历史本地快照：
   * - 旧缓存里可能还没有 `username` 字段；
   * - 这里统一补齐 `username` / `realName` / `account`，避免启动恢复阶段出现类型断裂。
   */
  const normalizePersistedUser = (user: ClientAuthUserSnapshot | null): ClientSafeProfile | null => {
    if (!user) {
      return null
    }

    const normalizedUsername = user.username?.trim() || user.account?.trim() || user.realName?.trim() || ''
    const normalizedAccount = user.account?.trim() || normalizedUsername || user.email?.trim() || user.mobile?.trim() || ''

    return {
      ...user,
      account: normalizedAccount,
      username: normalizedUsername,
      realName: user.realName?.trim() || normalizedUsername,
      mobile: user.mobile ?? '',
      email: user.email ?? '',
      departmentName: user.departmentName ?? null,
      lastLoginAt: user.lastLoginAt ?? null,
    }
  }

  /**
   * 清空客户端登录态：
   * - 主动退出和会话失效都复用该逻辑；
   * - 同步清掉本地持久化内容，避免刷新后回填旧用户。
   */
  const clearAuthState = () => {
    clearClientScopedStores()
    token.value = null
    currentUser.value = null
    expiresAt.value = null
    clearPersistedClientAuthState()
  }

  /**
   * 启动时恢复客户端会话：
   * - 先读本地 token，再调用 `/client-auth/me` 校验服务端状态；
   * - 若 token 失效则直接清理，保证页面不会展示过期账号。
   */
  const initializeAuth = async () => {
    if (initialized.value || initializing.value) {
      return
    }

    initializing.value = true
    try {
      const persisted = readPersistedClientAuthState()
      token.value = persisted.token
      currentUser.value = normalizePersistedUser(persisted.user)
      expiresAt.value = persisted.expiresAt

      if (!persisted.token) {
        initialized.value = true
        return
      }

      try {
        const profile = await getClientMe()
        currentUser.value = profile
        persistClientAuthState({
          token: persisted.token,
          user: profile,
          expiresAt: persisted.expiresAt,
        })
      } catch (error) {
        normalizeRequestError(error, '客户端登录态恢复失败')
        // 历史 token 失效或服务端会话已清理时，恢复阶段直接退回未登录态即可；
        // 这里显式消费异常，避免 Sonar 误判“吞异常”且便于后续接入埋点。
        clearAuthState()
      }

      initialized.value = true
    } finally {
      initializing.value = false
    }
  }

  /**
   * 客户端注册：
   * - 注册动作只负责创建账号本身；
   * - 注册成功后由页面层引导用户回到登录页完成正式登录。
   */
  const register = async (payload: {
    username: string
    account: string
    password: string
    departmentName?: string
    verificationCode?: string
    captchaId?: string
    captchaCode?: string
  }) => {
    const result = await clientRegister(payload)
    clearAuthState()
    initialized.value = true
    return result
  }

  /**
   * 客户端登录：
   * - 登录成功后统一落盘 token 和用户信息；
   * - 供登录页提交后直接跳转商城首页。
   */
  const login = async (payload: {
    account: string
    password: string
    captchaId?: string
    captchaCode?: string
  }) => {
    const result = await clientLogin(payload)
    applyAuthResult(result)
    initialized.value = true
    return result
  }

  /**
   * 发送手机/邮箱验证码：
   * - 注册与找回密码都复用同一接口；
   * - 具体走短信还是邮箱平台，由 payload.channel 决定。
   */
  const sendVerificationCode = async (payload: {
    channel: 'mobile' | 'email'
    target: string
    scene: 'register' | 'forgot_password'
    captchaId: string
    captchaCode: string
  }) => {
    return sendClientVerificationCode(payload)
  }

  /**
   * 客户端退出：
   * - 即使后端退出接口异常，也会清理本地登录态；
   * - 保证用户总能顺利切换账号。
   */
  const logout = async () => {
    try {
      if (token.value) {
        await clientLogout()
      }
    } finally {
      clearAuthState()
      initialized.value = true
    }
  }

  /**
   * 忘记密码第一步：
   * - 校验手机号与验证码，换取一次性的 resetToken；
   * - resetToken 仅在短时间内有效，避免被长期滥用。
   */
  const requestPasswordResetToken = async (payload: {
    account: string
    verificationCode?: string
    captchaId?: string
    captchaCode?: string
  }) => {
    return verifyClientForgotPassword(payload)
  }

  /**
   * 忘记密码第二步：
   * - 持 resetToken 提交新密码；
   * - 成功后要求用户重新登录，确保会话链路清晰。
   */
  const confirmPasswordReset = async (payload: {
    account: string
    resetToken: string
    newPassword: string
  }) => {
    return resetClientPassword(payload)
  }

  const updateProfile = async (payload: {
    username: string
    mobile?: string
    email?: string
    departmentName?: string
  }) => {
    const profile = await clientUpdateProfile(payload)
    currentUser.value = profile
    if (token.value && expiresAt.value) {
      persistClientAuthState({
        token: token.value,
        user: profile,
        expiresAt: expiresAt.value,
      })
    }
    return profile
  }

  return {
    token,
    currentUser,
    expiresAt,
    initialized,
    initializing,
    isAuthenticated,
    initializeAuth,
    register,
    login,
    logout,
    sendVerificationCode,
    requestPasswordResetToken,
    confirmPasswordReset,
    updateProfile,
    clearAuthState,
  }
})
