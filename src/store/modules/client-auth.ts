/**
 * 模块说明：src/store/modules/client-auth.ts
 * 文件职责：维护客户端登录态、资料恢复与账号切换时的关联缓存清理。
 * 实现逻辑：
 * - 登录成功后仅持久化最小快照，完整资料通过 /client-auth/me 恢复；
 * - 所有会话恢复、登出、改密失败场景统一回到 clearAuthState；
 * - 切换账号时同步清理购物车、目录和订单缓存，避免串号。
 * 维护说明：若调整客户端登录返回结构或快照字段，需同步更新 applyAuthResult 与 normalizePersistedUser。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  type ClientAccountType,
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
  persistClientAuthState,
  readPersistedClientAuthState,
  type ClientAuthUserSnapshot,
} from '@/utils/client-auth-storage'
import { normalizeRequestError } from '@/utils/error'
import pinia from '@/store/pinia'
import { useClientCartStore } from './client-cart'
import { useClientCatalogStore } from './client-catalog'
import { useClientOrderStore } from './client-order'

export const useClientAuthStore = defineStore('client-auth', () => {
  const currentUser = ref<ClientSafeProfile | null>(null)
  const expiresAt = ref<string | null>(null)
  const initialized = ref(false)
  const initializing = ref(false)

  const clearClientScopedStores = () => {
    const clientCartStore = useClientCartStore(pinia)
    const clientCatalogStore = useClientCatalogStore(pinia)
    const clientOrderStore = useClientOrderStore(pinia)
    clientCartStore.clearAll()
    clientCatalogStore.clearAll()
    clientOrderStore.clearAll()
  }

  const isAuthenticated = computed(() => Boolean(currentUser.value))

const toUserSnapshot = (user: ClientSafeProfile): ClientAuthUserSnapshot => ({
    id: user.id,
    username: user.username,
    account: user.account,
    departmentName: user.departmentName ?? null,
    accountType: user.accountType,
    staffNo: user.staffNo ?? null,
    staffVerified: Boolean(user.staffVerified),
    status: user.status,
  })

  const applyAuthResult = (result: ClientAuthSuccessResult) => {
    const previousClientUserId = currentUser.value?.id ?? null
    if (previousClientUserId && previousClientUserId !== result.user.id) {
      clearClientScopedStores()
    }
    currentUser.value = result.user
    expiresAt.value = result.expiresAt

    persistClientAuthState({
      user: toUserSnapshot(result.user),
      expiresAt: result.expiresAt,
    })
  }

  const normalizePersistedUser = (user: ClientAuthUserSnapshot | null): ClientSafeProfile | null => {
    if (!user) {
      return null
    }
    const normalizedUsername = user.username?.trim() || user.account?.trim() || ''
    const normalizedAccount = user.account?.trim() || normalizedUsername
    return {
      id: user.id,
      account: normalizedAccount,
      username: normalizedUsername,
      realName: normalizedUsername,
      mobile: '',
      email: '',
      departmentName: user.departmentName ?? null,
      accountType: user.accountType === 'department' ? 'department' : 'personal',
      staffNo: user.staffNo ?? null,
      staffVerified: Boolean(user.staffVerified),
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

  const initializeAuth = async () => {
    if (initialized.value || initializing.value) {
      return
    }

    initializing.value = true
    try {
      const persisted = readPersistedClientAuthState()
      currentUser.value = normalizePersistedUser(persisted.user)
      expiresAt.value = persisted.expiresAt

      try {
        const profile = await getClientMe()
        currentUser.value = profile
        persistClientAuthState({
          user: toUserSnapshot(profile),
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
    accountType: ClientAccountType
    staffNo?: string
    password: string
    departmentName?: string
    verificationCode?: string
    captchaId?: string
    captchaCode?: string
  }, config?: RequestConfig) => {
    const result = await clientRegister(payload, config)
    applyAuthResult(result)
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
      await clientLogout()
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
      user: toUserSnapshot(profile),
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
