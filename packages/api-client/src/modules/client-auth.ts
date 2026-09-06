import type {
  ClientAuthCapabilities,
  ClientAuthSuccessResult,
  ClientCaptchaResult,
  ClientChangePasswordInput,
  ClientForgotPasswordVerifyInput,
  ClientForgotPasswordVerifyResult,
  ClientLoginInput,
  ClientProfileVerificationCodeSendInput,
  ClientProfileVerificationCodeSendResult,
  ClientRegisterInput,
  ClientRegisterResult,
  ClientResetPasswordInput,
  ClientSafeProfile,
  ClientUpdateProfileInput,
  ClientVerificationCodeSendInput,
  ClientVerificationCodeSendResult,
} from '@ylink/shared-types'

import type { ApiRequestOptions, HttpAdapter } from '../types.ts'

/** 现有客户端认证 HTTP Contract；不负责 token、refresh 或 session revoke。 */
export const createClientAuthApi = (http: HttpAdapter) => ({
  getCaptcha(options: ApiRequestOptions = {}): Promise<ClientCaptchaResult> {
    return http.request({ ...options, method: 'GET', url: '/client-auth/captcha' })
  },

  getCapabilities(options: ApiRequestOptions = {}): Promise<ClientAuthCapabilities> {
    return http.request({ ...options, method: 'GET', url: '/client-auth/capabilities' })
  },

  sendVerificationCode(
    data: ClientVerificationCodeSendInput,
    options: ApiRequestOptions = {},
  ): Promise<ClientVerificationCodeSendResult> {
    return http.request({ ...options, method: 'POST', url: '/client-auth/verification-code/send', data })
  },

  register(data: ClientRegisterInput, options: ApiRequestOptions = {}): Promise<ClientRegisterResult> {
    return http.request({ ...options, method: 'POST', url: '/client-auth/register', data })
  },

  login(data: ClientLoginInput, options: ApiRequestOptions = {}): Promise<ClientAuthSuccessResult> {
    return http.request({ ...options, method: 'POST', url: '/client-auth/login', data })
  },

  verifyForgotPassword(
    data: ClientForgotPasswordVerifyInput,
    options: ApiRequestOptions = {},
  ): Promise<ClientForgotPasswordVerifyResult> {
    return http.request({ ...options, method: 'POST', url: '/client-auth/forgot-password/verify', data })
  },

  resetPassword(data: ClientResetPasswordInput, options: ApiRequestOptions = {}): Promise<boolean> {
    return http.request({ ...options, method: 'POST', url: '/client-auth/forgot-password/reset', data })
  },

  getMe(options: ApiRequestOptions = {}): Promise<ClientSafeProfile> {
    return http.request({ ...options, method: 'GET', url: '/client-auth/me' })
  },

  logout(options: ApiRequestOptions = {}): Promise<boolean> {
    return http.request({ ...options, method: 'POST', url: '/client-auth/logout' })
  },

  changePassword(data: ClientChangePasswordInput, options: ApiRequestOptions = {}): Promise<boolean> {
    return http.request({ ...options, method: 'POST', url: '/client-auth/change-password', data })
  },

  updateProfile(data: ClientUpdateProfileInput, options: ApiRequestOptions = {}): Promise<ClientSafeProfile> {
    return http.request({ ...options, method: 'PATCH', url: '/client-auth/profile', data })
  },

  sendProfileVerificationCode(
    data: ClientProfileVerificationCodeSendInput,
    options: ApiRequestOptions = {},
  ): Promise<ClientProfileVerificationCodeSendResult> {
    return http.request({ ...options, method: 'POST', url: '/client-auth/profile/verification-code/send', data })
  },
})
