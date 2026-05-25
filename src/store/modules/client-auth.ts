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

  const clearClientScopedStores = () => {
    const clientCartStore = useClientCartStore(pinia)
    const clientCatalogStore = useClientCatalogStore(pinia)
    const clientOrderStore = useClientOrderStore(pinia)
    clientCartStore.clearAll()
    clientCatalogStore.clearAll()
    clientOrderStore.clearAll()
  }

  const isAuthenticated = computed(() => Boolean(currentUser.value))

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
        normalizeRequestError(error, '瀹㈡埛绔櫥褰曟€佹仮澶嶅け璐?')
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
