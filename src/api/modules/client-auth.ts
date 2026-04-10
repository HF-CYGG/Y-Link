import { request } from '@/api/http'

export interface ClientCaptchaResult {
  captchaId: string
  captchaSvg: string
  expiresInSeconds: number
}

export interface ClientSafeProfile {
  id: string
  mobile: string
  realName: string
  departmentName: string | null
  status: string
  lastLoginAt: string | null
}

export interface ClientAuthSuccessResult {
  token: string
  expiresAt: string
  user: ClientSafeProfile
  verificationChannel: 'captcha' | 'sms'
}

export const getClientCaptcha = () =>
  request<ClientCaptchaResult>({
    method: 'GET',
    url: '/client-auth/captcha',
  })

export const clientRegister = (payload: {
  mobile: string
  password: string
  realName: string
  departmentName?: string
  captchaId: string
  captchaCode: string
}) =>
  request<ClientAuthSuccessResult>({
    method: 'POST',
    url: '/client-auth/register',
    data: payload,
  })

export const clientLogin = (payload: { mobile: string; password: string; captchaId: string; captchaCode: string }) =>
  request<ClientAuthSuccessResult>({
    method: 'POST',
    url: '/client-auth/login',
    data: payload,
  })

export const verifyClientForgotPassword = (payload: { mobile: string; captchaId: string; captchaCode: string }) =>
  request<{ resetToken: string; expiresInSeconds: number }>({
    method: 'POST',
    url: '/client-auth/forgot-password/verify',
    data: payload,
  })

export const resetClientPassword = (payload: { mobile: string; resetToken: string; newPassword: string }) =>
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
