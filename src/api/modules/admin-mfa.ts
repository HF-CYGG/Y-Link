/**
 * 模块说明：src/api/modules/admin-mfa.ts
 * 文件职责：封装管理端本人两步验证（TOTP）的状态查询、绑定、停用与恢复码重生成接口。
 * 实现逻辑：
 * - 只被异步加载的两步验证弹窗引用，独立成模块以免进入首屏公共包；
 * - 发起绑定、停用、重生成恢复码都要求当前密码，服务端与登录共用失败锁定；
 * - 秘钥与恢复码只在对应响应中出现一次，调用方用完即清，不得写入本地存储或日志。
 * 维护说明：两段登录的第二步接口属于登录链路，放在 `auth.ts` 的 `completeMfaLogin`，不要挪到这里。
 */

import { request } from '@/api/http'

export interface AdminMfaStatus {
  enabled: boolean
  mfaRequired: boolean
  totpEnabled: boolean
  availableMethods: Array<'totp' | 'recovery_code' | 'webauthn'>
  enabledAt: string | null
  recoveryCodesRemaining: number
}

export interface AdminMfaEnrollment {
  secret: string
  otpauthUri: string
  expiresInSeconds: number
}

export interface AdminMfaRecoveryCodes {
  recoveryCodes: string[]
}

export interface DisableAdminMfaPayload {
  currentPassword: string
  code?: string
  recoveryCode?: string
  stepUpProof?: string
}

export interface RegenerateAdminMfaRecoveryCodesPayload {
  currentPassword: string
  code?: string
  stepUpProof?: string
}

export const getAdminMfaStatus = () =>
  request<AdminMfaStatus>({
    method: 'GET',
    url: '/auth/mfa/status',
  })

export const startAdminMfaEnrollment = (currentPassword: string, proof: { code?: string; recoveryCode?: string; stepUpProof?: string } = {}) =>
  request<AdminMfaEnrollment>({
    method: 'POST',
    url: '/auth/mfa/enroll',
    data: { currentPassword, ...proof },
  })

export const confirmAdminMfaEnrollment = (code: string) =>
  request<AdminMfaRecoveryCodes>({
    method: 'POST',
    url: '/auth/mfa/enroll/confirm',
    data: { code },
  })

export const disableAdminMfa = (payload: DisableAdminMfaPayload) =>
  request<boolean>({
    method: 'POST',
    url: '/auth/mfa/disable',
    data: payload,
  })

export const disableAdminTotp = (payload: DisableAdminMfaPayload) =>
  request<boolean>({ method: 'POST', url: '/auth/mfa/totp/disable', data: payload })

export const enableAdminWebAuthnMfa = (payload: { currentPassword: string; stepUpProof: string }) =>
  request<AdminMfaRecoveryCodes>({ method: 'POST', url: '/auth/mfa/webauthn/enable', data: payload })

export const regenerateAdminMfaRecoveryCodes = (payload: RegenerateAdminMfaRecoveryCodesPayload) =>
  request<AdminMfaRecoveryCodes>({
    method: 'POST',
    url: '/auth/mfa/recovery-codes',
    data: payload,
  })
