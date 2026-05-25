/**
 * 模块说明：src/store/modules/client-auth.ts
 * 文件职责：管理客户端登录态、会话恢复、注册/登录/登出/资料更新等认证相关状态与动作。
 * 实现逻辑：
 * - 启动时先从本地快照恢复最小用户信息，再调用 `/client-auth/me` 回填服务端真实状态；
 * - 登录成功后刷新 Pinia 状态并持久化最小快照，避免本地落地手机号/邮箱等敏感字段；
 * - 退出或会话失效时统一清理客户端购物车、商品快照、订单缓存，防止跨账号数据串读。
 * 维护说明：若新增客户端强绑定状态模块，需要挂接 `clearClientScopedStores` 一并清理。
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
import type { RequestConfig } from '@/api/http'
import {
  clearPersistedClientAuthState,
  hasRecoverableClientSessionHint,
  persistClientAuthState,
  readPersistedClientAuthState,
  type ClientAuthUserSnapshot,
} from '@/utils/client-auth-storage'
import { normalizeRequestError } from '@/utils/error'
import pinia from '@/store/pinia'
import { useClientCartStore } from './client-cart'
import { useClientCatalogStore } from './client-catalog'
import { useClientOrderStore } from './client-order'

const toClientSnapshot = (user: ClientSafeProfile): ClientAuthUserSnapshot => ({
  id: user.id,
  account: user.account,
  username: user.username,
  departmentName: user.departmentName ?? null,
  status: user.status,
})

export const useClientAuthStore = defineStore('client-auth', () => {
  const currentUser = ref<ClientSafeProfile | null>(null)
  const expiresAt = ref<string | null>(null)
  const initialized = ref(false)
  const initializing = ref(false)

  /**
   * 清理与客户端账号强绑定的本地缓存：
   * - 账号切换时必须先清，避免旧账号的购物车/订单数据残留到新账号；
   * - 登出场景也复用该链路，保持状态收口一致。
   */
  const clearClientScopedStores = () => {
    const clientCartStore = useClientCartStore(pinia)
    const clientCatalogStore = useClientCatalogStore(pinia)
    const clientOrderStore = useClientOrderStore(pinia)
    clientCartStore.clearAll()
    clientCatalogStore.clearAll()
    clientOrderStore.clearAll()
  }

  const isAuthenticated = computed(() => Boolean(currentUser.value))

  // 登录成功或刷新登录态后统一落地最小快照，供刷新恢复时先渲染骨架态。
  const applyAuthResult = (result: ClientAuthSuccessResult) => {
    const previousClientUserId = currentUser.value?.id ?? null
    if (previousClientUserId && previousClientUserId !== result.user.id) {
      clearClientScopedStores()
    }

    currentUser.value = result.user
    expiresAt.value = result.expiresAt
    persistClientAuthState({
      user: toClientSnapshot(result.user),
      expiresAt: result.expiresAt,
    })
  }

  const normalizePersistedUser = (user: ClientAuthUserSnapshot | null): ClientSafeProfile | null => {
    if (!user) {
      return null
    }

    const normalizedUsername = user.username?.trim() || user.account?.trim() || ''
    const normalizedAccount = user.account?.trim() || normalizedUsername || ''

    return {
      id: user.id,
      account: normalizedAccount,
      username: normalizedUsername,
      realName: normalizedUsername,
      mobile: '',
      email: '',
      departmentName: user.departmentName ?? null,
      status: user.status,
      lastLoginAt: null,
    }
  }

  const clearAuthState = () => {
    clearClientScopedStores()
    currentUser.value = null
    expiresAt.value = null
    clearPersistedClientAuthState()
  }

  /**
   * 会话初始化流程：
   * 1) 先尝试加载本地最小快照（只含非敏感字段）；
   * 2) 若存在可恢复会话迹象，再请求 `/client-auth/me` 做服务端确认；
   * 3) 失败则清理本地状态并回到未登录态，避免展示过期用户信息。
   */
  const initializeAuth = async () => {
    if (initialized.value || initializing.value) {
      return
    }

    initializing.value = true
    try {
      const persisted = readPersistedClientAuthState()
      currentUser.value = normalizePersistedUser(persisted.user)
      expiresAt.value = persisted.expiresAt

      if (!hasRecoverableClientSessionHint()) {
        initialized.value = true
        return
      }

      try {
        const profile = await getClientMe()
        currentUser.value = profile
        persistClientAuthState({
          user: toClientSnapshot(profile),
          expiresAt: persisted.expiresAt,
        })
      } catch (error) {
        normalizeRequestError(error, '客户端登录态恢复失败')
        clearAuthState()
      }

      initialized.value = true
    } finally {
      initializing.value = false
    }
  }

  const register = async (payload: {
    username: string
    account: string
    password: string
    departmentName?: string
    verificationCode?: string
    captchaId?: string
    captchaCode?: string
  }, config?: RequestConfig) => {
    const result = await clientRegister(payload, config)
    clearAuthState()
    initialized.value = true
    return result
  }

  const login = async (payload: {
    account: string
    password: string
    captchaId?: string
    captchaCode?: string
  }, config?: RequestConfig) => {
    const result = await clientLogin(payload, config)
    applyAuthResult(result)
    initialized.value = true
    return result
  }

  const sendVerificationCode = async (payload: {
    channel: 'mobile' | 'email'
    target: string
    scene: 'register' | 'forgot_password'
    captchaId: string
    captchaCode: string
  }, config?: RequestConfig) => {
    return sendClientVerificationCode(payload, config)
  }

  const logout = async () => {
    try {
      if (currentUser.value) {
        await clientLogout()
      }
    } finally {
      clearAuthState()
      initialized.value = true
    }
  }

  const requestPasswordResetToken = async (payload: {
    account: string
    verificationCode?: string
    captchaId?: string
    captchaCode?: string
  }, config?: RequestConfig) => {
    return verifyClientForgotPassword(payload, config)
  }

  const confirmPasswordReset = async (payload: {
    account: string
    resetToken: string
    newPassword: string
  }, config?: RequestConfig) => {
    return resetClientPassword(payload, config)
  }

  const updateProfile = async (payload: {
    username: string
    mobile?: string
    email?: string
    departmentName?: string
  }) => {
    const profile = await clientUpdateProfile(payload)
    currentUser.value = profile
    persistClientAuthState({
      user: toClientSnapshot(profile),
      expiresAt: expiresAt.value,
    })
    return profile
  }

  return {
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
