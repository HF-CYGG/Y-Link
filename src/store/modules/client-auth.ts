/**
 * 模块说明：src/store/modules/client-auth.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
} from '@/utils/client-auth-storage'

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
   * 清空客户端登录态：
   * - 主动退出和会话失效都复用该逻辑；
   * - 同步清掉本地持久化内容，避免刷新后回填旧用户。
   */
  const clearAuthState = () => {
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
      currentUser.value = persisted.user
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
      } catch (_error) {
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
