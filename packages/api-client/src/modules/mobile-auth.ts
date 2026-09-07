import type {
  ClientAuthCapabilities,
  ClientCaptchaResult,
  ClientSafeProfile,
  MobileAuthSessionDTO,
  MobileChangePasswordInput,
  MobileForgotPasswordVerifyInput,
  MobileForgotPasswordVerifyResult,
  MobileLoginInput,
  MobileLogoutAllResult,
  MobileLogoutAllScope,
  MobileLogoutResult,
  MobileMeResult,
  MobileRefreshInput,
  MobileRegisterInput,
  MobileResetPasswordInput,
  MobileResetPasswordResult,
  MobileSessionListResult,
  MobileSessionRevokeResult,
  MobileUpdateProfileInput,
  MobileVerificationCodeSendInput,
  MobileVerificationCodeSendResult,
} from '@ylink/shared-types'

import type { ApiRequestOptions, HttpAdapter } from '../types.ts'

const encodePathSegment = (value: string) => encodeURIComponent(value)

/** Mobile Bearer Auth Contract；不实现凭据持久化、自动 refresh 或请求重放。 */
export const createMobileAuthApi = (http: HttpAdapter) => ({
  getCaptcha(options: ApiRequestOptions = {}): Promise<ClientCaptchaResult> {
    return http.request({ ...options, method: 'GET', url: '/v1/mobile-auth/captcha', auth: 'none' })
  },

  getCapabilities(options: ApiRequestOptions = {}): Promise<ClientAuthCapabilities> {
    return http.request({ ...options, method: 'GET', url: '/v1/mobile-auth/capabilities', auth: 'none' })
  },

  sendVerificationCode(
    data: MobileVerificationCodeSendInput,
    options: ApiRequestOptions = {},
  ): Promise<MobileVerificationCodeSendResult> {
    return http.request({ ...options, method: 'POST', url: '/v1/mobile-auth/verification-code', data, auth: 'none' })
  },

  register(data: MobileRegisterInput, options: ApiRequestOptions = {}): Promise<MobileAuthSessionDTO> {
    return http.request({ ...options, method: 'POST', url: '/v1/mobile-auth/register', data, auth: 'none' })
  },

  login(data: MobileLoginInput, options: ApiRequestOptions = {}): Promise<MobileAuthSessionDTO> {
    return http.request({ ...options, method: 'POST', url: '/v1/mobile-auth/login', data, auth: 'none' })
  },

  refresh(data: MobileRefreshInput, options: ApiRequestOptions = {}): Promise<MobileAuthSessionDTO> {
    return http.request({ ...options, method: 'POST', url: '/v1/mobile-auth/refresh', data, auth: 'none' })
  },

  logout(options: ApiRequestOptions = {}): Promise<MobileLogoutResult> {
    return http.request({ ...options, method: 'POST', url: '/v1/mobile-auth/logout' })
  },

  logoutAll(
    input: { scope?: MobileLogoutAllScope } = {},
    options: ApiRequestOptions = {},
  ): Promise<MobileLogoutAllResult> {
    return http.request({ ...options, method: 'POST', url: '/v1/mobile-auth/logout-all', params: { scope: input.scope } })
  },

  getMe(options: ApiRequestOptions = {}): Promise<MobileMeResult> {
    return http.request({ ...options, method: 'GET', url: '/v1/mobile-auth/me' })
  },

  listSessions(options: ApiRequestOptions = {}): Promise<MobileSessionListResult> {
    return http.request({ ...options, method: 'GET', url: '/v1/mobile-auth/sessions' })
  },

  revokeSession(id: string, options: ApiRequestOptions = {}): Promise<MobileSessionRevokeResult> {
    return http.request({ ...options, method: 'DELETE', url: `/v1/mobile-auth/sessions/${encodePathSegment(id)}` })
  },

  updateProfile(
    data: MobileUpdateProfileInput,
    options: ApiRequestOptions = {},
  ): Promise<ClientSafeProfile> {
    return http.request({ ...options, method: 'PATCH', url: '/v1/mobile-auth/profile', data })
  },

  changePassword(
    data: MobileChangePasswordInput,
    options: ApiRequestOptions = {},
  ): Promise<MobileAuthSessionDTO> {
    return http.request({ ...options, method: 'POST', url: '/v1/mobile-auth/change-password', data })
  },

  verifyForgotPassword(
    data: MobileForgotPasswordVerifyInput,
    options: ApiRequestOptions = {},
  ): Promise<MobileForgotPasswordVerifyResult> {
    return http.request({ ...options, method: 'POST', url: '/v1/mobile-auth/forgot-password/verify', data, auth: 'none' })
  },

  resetPassword(
    data: MobileResetPasswordInput,
    options: ApiRequestOptions = {},
  ): Promise<MobileResetPasswordResult> {
    return http.request({ ...options, method: 'POST', url: '/v1/mobile-auth/forgot-password/reset', data, auth: 'none' })
  },
})
