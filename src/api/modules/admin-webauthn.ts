/**
 * 模块说明：src/api/modules/admin-webauthn.ts
 * 文件职责：封装管理端 WebAuthn 匿名登录、本人凭据管理与注册请求。
 * 实现逻辑：浏览器断言只在内存中传递，认证结果归一化后交给管理端 Auth Store。
 * 维护说明：不得在这里持久化挑战、认证器响应、密码或恢复码。
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'
import { request, type RequestConfig } from '@/api/http'
import { normalizeUserSafeProfile, type LoginResult } from '@/api/modules/auth'
import type { AdminWebAuthnCapabilities } from '@/utils/admin-webauthn'

export interface AdminWebAuthnCredential {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  deviceType: string
  backedUp: boolean
  usage: 'passwordless' | 'second_factor'
}

export interface AdminWebAuthnRegistrationResult extends AdminWebAuthnCredential {
  /** 仅首次独立启用第二因素时返回，不能缓存或写入日志。 */
  recoveryCodes?: string[]
}

export interface AdminWebAuthnChallenge<T> {
  challengeId: string
  options: T
  expiresInSeconds: number
}

export interface AdminWebAuthnStepUp {
  currentPassword: string
  code?: string
  recoveryCode?: string
  stepUpProof?: string
}

export interface AdminWebAuthnRegisterPayload extends AdminWebAuthnStepUp {
  name: string
  kind: 'passkey' | 'security_key'
  usage?: 'passwordless' | 'second_factor'
}

export type AdminWebAuthnStepUpAction =
  | 'webauthn.register' | 'webauthn.delete' | 'mfa.totp.enroll' | 'mfa.totp.disable'
  | 'mfa.disable_all' | 'mfa.recovery_codes' | 'mfa.webauthn.enable'
  | 'user.mfa.reset' | 'user.webauthn.reset'

export const getAdminWebAuthnCapabilities = (config: RequestConfig = {}) =>
  request<AdminWebAuthnCapabilities>({ ...config, method: 'GET', url: '/auth/webauthn/capabilities' })

export const startAdminWebAuthnLogin = (payload: { captchaId?: string; code?: string }, config: RequestConfig = {}) =>
  request<AdminWebAuthnChallenge<PublicKeyCredentialRequestOptionsJSON>>({
    ...config, method: 'POST', url: '/auth/webauthn/login/options', data: payload,
  })

export const startAdminMfaWebAuthnLogin = (mfaTicket: string, config: RequestConfig = {}) =>
  request<AdminWebAuthnChallenge<PublicKeyCredentialRequestOptionsJSON>>({
    ...config, method: 'POST', url: '/auth/login/mfa/webauthn/options', data: { mfaTicket },
  })

export const startAdminWebAuthnStepUp = (payload: { currentPassword: string; action: AdminWebAuthnStepUpAction; targetId?: string }, config: RequestConfig = {}) =>
  request<AdminWebAuthnChallenge<PublicKeyCredentialRequestOptionsJSON>>({
    ...config, method: 'POST', url: '/auth/webauthn/step-up/options', data: payload,
  })

export const verifyAdminWebAuthnStepUp = (payload: { challengeId: string; response: AuthenticationResponseJSON }, config: RequestConfig = {}) =>
  request<{ stepUpProof: string; expiresInSeconds: number }>({
    ...config, method: 'POST', url: '/auth/webauthn/step-up/verify', data: payload,
  })

export const verifyAdminWebAuthnLogin = async (
  payload: { challengeId: string; response: AuthenticationResponseJSON }, config: RequestConfig = {},
): Promise<LoginResult> => {
  const result = await request<LoginResult>({ ...config, method: 'POST', url: '/auth/webauthn/login/verify', data: payload })
  return { ...result, user: normalizeUserSafeProfile(result.user) }
}

export const getAdminWebAuthnCredentials = (config: RequestConfig = {}) =>
  request<AdminWebAuthnCredential[]>({ ...config, method: 'GET', url: '/auth/webauthn/credentials' })

export const startAdminWebAuthnRegistration = (payload: AdminWebAuthnRegisterPayload, config: RequestConfig = {}) =>
  request<AdminWebAuthnChallenge<PublicKeyCredentialCreationOptionsJSON>>({
    ...config, method: 'POST', url: '/auth/webauthn/register/options', data: payload,
  })

export const verifyAdminWebAuthnRegistration = (
  payload: { challengeId: string; response: RegistrationResponseJSON }, config: RequestConfig = {},
) => request<AdminWebAuthnRegistrationResult>({ ...config, method: 'POST', url: '/auth/webauthn/register/verify', data: payload })

export const renameAdminWebAuthnCredential = (id: string, name: string, config: RequestConfig = {}) =>
  request<AdminWebAuthnCredential>({ ...config, method: 'PATCH', url: `/auth/webauthn/credentials/${encodeURIComponent(id)}`, data: { name } })

export const deleteAdminWebAuthnCredential = (id: string, payload: AdminWebAuthnStepUp, config: RequestConfig = {}) =>
  request<true>({ ...config, method: 'DELETE', url: `/auth/webauthn/credentials/${encodeURIComponent(id)}`, data: payload })
