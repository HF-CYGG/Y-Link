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

/**
 * 客户端鉴权 Store：
 * - 独立于管理端登录态，避免两个端共用同一份 Pinia 状态；
 * - 负责客户端用户的登录、注册、找回密码与会话恢复。
 */
export const useClientAuthStore = defineStore('client-auth', () => {
  const currentUser = ref<ClientSafeProfile | null>(null)
  const expiresAt = ref<string | null>(null)
  const initialized = ref(false)
  const initializing = ref(false)
  let initializePromise: Promise<boolean> | null = null

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

  /**
   * 将完整用户资料压缩为本地最小快照：
   * - 仅保留刷新后恢复展示态所必需的安全字段；
   * - 手机号、邮箱、最后登录时间等可通过 `/client-auth/me` 再次回填。
   */
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

  /**
   * 是否已登录：
   * - 客户端已改为 Cookie 会话，前端不再持有 token；
   * - 当前用户存在即可视为本轮会话已完成恢复。
   */
  const isAuthenticated = computed(() => {
    return Boolean(currentUser.value)
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

    const normalizedUsername = user.username.trim() || user.account.trim()
    const normalizedAccount = user.account.trim() || normalizedUsername

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
    initializing.value = false
    initializePromise = null
    clearPersistedClientAuthState()
  }

  /**
   * 启动时恢复客户端会话：
   * - 先读本地 token，再调用 `/client-auth/me` 校验服务端状态；
   * - 若 token 失效则直接清理，保证页面不会展示过期账号。
   */
  const initializeAuth = async (): Promise<boolean> => {
    if (initialized.value) {
      return isAuthenticated.value
    }

    if (initializePromise) {
      return initializePromise
    }

    const persisted = readPersistedClientAuthState()
    currentUser.value = normalizePersistedUser(persisted.user)
    expiresAt.value = persisted.expiresAt

    if (!hasRecoverableClientSessionHint()) {
      initialized.value = true
      return false
    }

    initializing.value = true
    initializePromise = (async () => {
      try {
        const profile = await getClientMe()
        currentUser.value = profile
        persistClientAuthState({
          user: toUserSnapshot(profile),
          expiresAt: persisted.expiresAt,
        })
        initialized.value = true
        return true
      } catch (error) {
        normalizeRequestError(error, '客户端登录态恢复失败')
        clearAuthState()
        initialized.value = true
        return false
      } finally {
        initializing.value = false
        initializePromise = null
      }
    })()

    return initializePromise
  }

  const register = async (payload: {
    username?: string
    account?: string
    accountType: ClientAccountType
    staffNo?: string
    password: string
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
      if (isAuthenticated.value) {
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
