/**
 * 模块说明：src/api/modules/client-auth.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { request } from '@/api/http'

export interface ClientCaptchaResult {
  captchaId: string
  captchaSvg: string
  expiresInSeconds: number
}

export interface ClientSafeProfile {
  id: string
  account: string
  mobile: string
  email: string
  realName: string
  departmentName: string | null
  status: string
  lastLoginAt: string | null
}

export interface ClientAuthSuccessResult {
  token: string
  expiresAt: string
  user: ClientSafeProfile
  verificationChannel: 'captcha' | 'sms' | 'email'
}

export type ClientRegisterResult = ClientSafeProfile

export interface ClientVerificationCodeSendResult {
  expireSeconds: number
}

export type ClientValidationMode = 'captcha' | 'verification_code'

export interface ClientAuthCapabilities {
  channels: {
    mobile: boolean
    email: boolean
  }
  registerValidationModes: {
    mobile: ClientValidationMode
    email: ClientValidationMode
  }
  forgotPasswordEnabled: boolean
}

export const getClientCaptcha = () =>
  request<ClientCaptchaResult>({
    method: 'GET',
    url: '/client-auth/captcha',
  })

export const getClientAuthCapabilities = () =>
  request<ClientAuthCapabilities>({
    method: 'GET',
    url: '/client-auth/capabilities',
  })

export const sendClientVerificationCode = (payload: {
  channel: 'mobile' | 'email'
  target: string
  scene: 'register' | 'forgot_password'
}) =>
  request<ClientVerificationCodeSendResult>({
    method: 'POST',
    url: '/client-auth/verification-code/send',
    data: payload,
  })

export const clientRegister = (payload: {
  account: string
  password: string
  departmentName?: string
  verificationCode?: string
  captchaId?: string
  captchaCode?: string
}) =>
  request<ClientRegisterResult>({
    method: 'POST',
    url: '/client-auth/register',
    data: payload,
  })

export const clientLogin = (payload: { account: string; password: string; captchaId?: string; captchaCode?: string }) =>
  request<ClientAuthSuccessResult>({
    method: 'POST',
    url: '/client-auth/login',
    data: payload,
  })

export const verifyClientForgotPassword = (payload: {
  account: string
  verificationCode?: string
  captchaId?: string
  captchaCode?: string
}) =>
  request<{ resetToken: string; expiresInSeconds: number }>({
    method: 'POST',
    url: '/client-auth/forgot-password/verify',
    data: payload,
  })

export const resetClientPassword = (payload: { account: string; resetToken: string; newPassword: string }) =>
  request<boolean>({
    method: 'POST',
    url: '/client-auth/forgot-password/reset',
    data: payload,
  })

export const getClientMe = () =>
  request<ClientSafeProfile>({
    method: 'GET',
    url: '/client-auth/me',
  })

export const clientLogout = () =>
  request<boolean>({
    method: 'POST',
    url: '/client-auth/logout',
  })

export const clientChangePassword = (data: { currentPassword: string; newPassword: string }) =>
  request<boolean>({
    method: 'POST',
    url: '/client-auth/change-password',
    data,
  })
