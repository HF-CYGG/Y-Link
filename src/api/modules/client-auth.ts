/**
 * 模块说明：客户端认证与账户安全 API 模块。
 * 文件职责：封装客户端注册、登录、验证码、找回密码、登录态资料与认证能力配置等接口及相关类型。
 * 维护说明：联调时重点关注验证码链路、`ClientAuthCapabilities` 配置下发结构与登录态资料字段兼容性。
 */

import { request } from '@/api/http'
import type { RequestConfig } from '@/api/http'
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
} from '../../../packages/shared-types/src/index'

export type {
  ClientAccountType,
  ClientAuthCapabilities,
  ClientAuthMode,
  ClientAuthSuccessResult,
  ClientCaptchaResult,
  ClientChangePasswordInput,
  ClientDepartmentOptionNode,
  ClientForgotPasswordVerifyInput,
  ClientForgotPasswordVerifyResult,
  ClientLoginInput,
  ClientProfileVerificationCodeSendInput,
  ClientProfileVerificationCodeSendResult,
  ClientRegisterInput,
  ClientRegisterResult,
  ClientResetPasswordInput,
  ClientSafeProfile,
  ClientStaffDirectoryLookupResult,
  ClientUpdateProfileInput,
  ClientValidationMode,
  ClientVerificationCodeSendInput,
  ClientVerificationCodeSendResult,
  ClientVerificationChannel,
  ClientVerificationScene,
  ClientVerificationTargetChannel,
} from '../../../packages/shared-types/src/index'

/**
 * 获取图形验证码：
 * - 用于客户端注册、登录、找回密码时的防刷。
 */
export const getClientCaptcha = (config?: RequestConfig) =>
  request<ClientCaptchaResult>({
    method: 'GET',
    url: '/client-auth/captcha',
    ...config,
  })

/**
 * 获取客户端认证能力配置：
 * - 在进入认证页面前调用，以决定渲染哪些输入框或验证通道。
 */
export const getClientAuthCapabilities = (config?: RequestConfig) =>
  request<ClientAuthCapabilities>({
    method: 'GET',
    url: '/client-auth/capabilities',
    ...config,
  })

/**
 * 发送验证码（短信/邮件）：
 * - 用于注册或找回密码时的身份验证。
 */
export const sendClientVerificationCode = (payload: ClientVerificationCodeSendInput, config?: RequestConfig) =>
  request<ClientVerificationCodeSendResult>({
    method: 'POST',
    url: '/client-auth/verification-code/send',
    data: payload,
    ...config,
  })

/**
 * 客户端注册：
 * - 支持图形验证码或短信/邮件验证码。
 */
export const clientRegister = (payload: ClientRegisterInput, config?: RequestConfig) =>
  request<ClientRegisterResult>({
    method: 'POST',
    url: '/client-auth/register',
    data: payload,
    ...config,
  })

/**
 * 客户端登录：
 * - 账号支持用户名、手机号或邮箱。
 */
export const clientLogin = (
  payload: ClientLoginInput,
  config?: RequestConfig,
) =>
  request<ClientAuthSuccessResult>({
    method: 'POST',
    url: '/client-auth/login',
    data: payload,
    ...config,
  })

/**
 * 验证找回密码身份：
 * - 提交账号和验证码，获取用于重置密码的临时 Token。
 */
export const verifyClientForgotPassword = (payload: ClientForgotPasswordVerifyInput, config?: RequestConfig) =>
  request<ClientForgotPasswordVerifyResult>({
    method: 'POST',
    url: '/client-auth/forgot-password/verify',
    data: payload,
    ...config,
  })

/**
 * 重置客户端密码：
 * - 依赖 verifyClientForgotPassword 颁发的 resetToken。
 */
export const resetClientPassword = (
  payload: ClientResetPasswordInput,
  config?: RequestConfig,
) =>
  request<boolean>({
    method: 'POST',
    url: '/client-auth/forgot-password/reset',
    data: payload,
    ...config,
  })

/**
 * 获取客户端当前登录用户信息：
 * - 用于页面刷新时恢复状态。
 */
export const getClientMe = (config?: RequestConfig) =>
  request<ClientSafeProfile>({
    method: 'GET',
    url: '/client-auth/me',
    ...config,
  })

/**
 * 客户端退出登录：
 * - 清除服务端的会话记录。
 */
export const clientLogout = (config?: RequestConfig) =>
  request<boolean>({
    method: 'POST',
    url: '/client-auth/logout',
    ...config,
  })

/**
 * 客户端本人修改密码：
 * - 成功后需重新登录。
 */
export const clientChangePassword = (data: ClientChangePasswordInput, config?: RequestConfig) =>
  request<boolean>({
    method: 'POST',
    url: '/client-auth/change-password',
    data,
    ...config,
  })

/**
 * 客户端更新个人资料：
 * - 仅允许普通个人账户维护姓名、手机号与邮箱；教师与部门共享账号身份资料由管理端或教职工目录维护。
 */
export const clientUpdateProfile = (data: ClientUpdateProfileInput, config?: RequestConfig) =>
  request<ClientSafeProfile>({
    method: 'PATCH',
    url: '/client-auth/profile',
    data,
    ...config,
  })

export const sendClientProfileVerificationCode = (
  data: ClientProfileVerificationCodeSendInput,
  config?: RequestConfig,
) => request<ClientProfileVerificationCodeSendResult>({
  method: 'POST',
  url: '/client-auth/profile/verification-code/send',
  data,
  ...config,
})
