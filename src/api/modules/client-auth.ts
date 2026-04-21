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

/**
 * 客户端安全用户资料：
 * - 不包含密码等敏感信息。
 * - 包含用户的基本身份和联系方式。
 */
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

/**
 * 客户端登录成功结果：
 * - 包含 Token、过期时间及用户信息。
 * - verificationChannel 指示最终采用的验证方式。
 */
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

export interface ClientDepartmentOptionNode {
  id: string
  label: string
  children: ClientDepartmentOptionNode[]
}

/**
 * 客户端认证能力配置：
 * - 动态下发当前系统支持的注册、登录和找回密码验证方式。
 */
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
  departmentTree: ClientDepartmentOptionNode[]
  departmentRootOptions: string[]
  departmentOptions: string[]
}

/**
 * 获取图形验证码：
 * - 用于客户端注册、登录、找回密码时的防刷。
 */
export const getClientCaptcha = () =>
  request<ClientCaptchaResult>({
    method: 'GET',
    url: '/client-auth/captcha',
  })

/**
 * 获取客户端认证能力配置：
 * - 在进入认证页面前调用，以决定渲染哪些输入框或验证通道。
 */
export const getClientAuthCapabilities = () =>
  request<ClientAuthCapabilities>({
    method: 'GET',
    url: '/client-auth/capabilities',
  })

/**
 * 发送验证码（短信/邮件）：
 * - 用于注册或找回密码时的身份验证。
 */
export const sendClientVerificationCode = (payload: {
  channel: 'mobile' | 'email'
  target: string
  scene: 'register' | 'forgot_password'
  captchaId: string
  captchaCode: string
}) =>
  request<ClientVerificationCodeSendResult>({
    method: 'POST',
    url: '/client-auth/verification-code/send',
    data: payload,
  })

/**
 * 客户端注册：
 * - 支持图形验证码或短信/邮件验证码。
 */
export const clientRegister = (payload: {
  username: string
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

/**
 * 客户端登录：
 * - 账号支持用户名、手机号或邮箱。
 */
export const clientLogin = (payload: { account: string; password: string; captchaId?: string; captchaCode?: string }) =>
  request<ClientAuthSuccessResult>({
    method: 'POST',
    url: '/client-auth/login',
    data: payload,
  })

/**
 * 验证找回密码身份：
 * - 提交账号和验证码，获取用于重置密码的临时 Token。
 */
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

/**
 * 重置客户端密码：
 * - 依赖 verifyClientForgotPassword 颁发的 resetToken。
 */
export const resetClientPassword = (payload: { account: string; resetToken: string; newPassword: string }) =>
  request<boolean>({
    method: 'POST',
    url: '/client-auth/forgot-password/reset',
    data: payload,
  })

/**
 * 获取客户端当前登录用户信息：
 * - 用于页面刷新时恢复状态。
 */
export const getClientMe = () =>
  request<ClientSafeProfile>({
    method: 'GET',
    url: '/client-auth/me',
  })

/**
 * 客户端退出登录：
 * - 清除服务端的会话记录。
 */
export const clientLogout = () =>
  request<boolean>({
    method: 'POST',
    url: '/client-auth/logout',
  })

/**
 * 客户端本人修改密码：
 * - 成功后需重新登录。
 */
export const clientChangePassword = (data: { currentPassword: string; newPassword: string }) =>
  request<boolean>({
    method: 'POST',
    url: '/client-auth/change-password',
    data,
  })

/**
 * 客户端更新个人资料：
 * - 允许更新用户名、手机号、邮箱及部门名称。
 */
export const clientUpdateProfile = (data: {
  username: string
  mobile?: string
  email?: string
  departmentName?: string
}) =>
  request<ClientSafeProfile>({
    method: 'PATCH',
    url: '/client-auth/profile',
    data,
  })
