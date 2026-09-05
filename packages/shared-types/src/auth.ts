export type ClientAccountType = 'personal' | 'department'
export type ClientUserStatus = 'enabled' | 'disabled'
export type ClientAuthMode = 'cookie'
export type ClientValidationMode = 'captcha' | 'verification_code'
export type ClientVerificationChannel = 'captcha' | 'sms' | 'email'
export type ClientVerificationTargetChannel = 'mobile' | 'email'
export type ClientVerificationScene = 'register' | 'forgot_password'

export interface ClientCaptchaResult {
  captchaId: string
  captchaSvg: string
  expiresInSeconds: number
}

/** 客户端可安全展示的用户资料；不包含密码、会话令牌或验证码。 */
export interface ClientSafeProfile {
  id: string
  account: string
  username: string
  mobile: string
  email: string
  realName: string
  /** 当前服务会把无部门归一化为空字符串。 */
  departmentName: string
  accountType: ClientAccountType
  staffNo: string | null
  staffVerified: boolean
  status: ClientUserStatus
  lastLoginAt: string | null
  mobileVerifiedAt: string | null
  emailVerifiedAt: string | null
}

/** 登录和注册成功时的真实 Cookie 会话响应。 */
export interface ClientAuthSuccessResult {
  expiresAt: string
  user: ClientSafeProfile
  verificationChannel: ClientVerificationChannel
  authMode: ClientAuthMode
}

export type ClientRegisterResult = ClientAuthSuccessResult

export interface ClientVerificationCodeSendResult {
  expireSeconds: number
}

export interface ClientProfileVerificationCodeSendResult extends ClientVerificationCodeSendResult {
  userId: string
}

export interface ClientDepartmentOptionNode {
  id: string
  label: string
  children: ClientDepartmentOptionNode[]
}

export interface ClientAuthCapabilities {
  channels: Record<ClientVerificationTargetChannel, boolean>
  registerValidationModes: Record<ClientVerificationTargetChannel, ClientValidationMode>
  forgotPasswordEnabled: boolean
  departmentTree: ClientDepartmentOptionNode[]
  departmentRootOptions: string[]
  departmentOptions: string[]
}

export interface ClientVerificationCodeSendInput {
  channel: ClientVerificationTargetChannel
  target: string
  scene: ClientVerificationScene
  captchaId: string
  captchaCode: string
}

export interface ClientRegisterInput {
  username?: string
  account?: string
  accountType: ClientAccountType
  staffNo?: string
  inviteCode?: string
  password: string
  verificationCode?: string
  captchaId?: string
  captchaCode?: string
}

export interface ClientLoginInput {
  account: string
  password: string
  captchaId?: string
  captchaCode?: string
}

export interface ClientForgotPasswordVerifyInput {
  account: string
  verificationCode?: string
  captchaId?: string
  captchaCode?: string
}

export interface ClientForgotPasswordVerifyResult {
  resetToken: string
  expiresInSeconds: number
}

export interface ClientResetPasswordInput {
  account: string
  resetToken: string
  newPassword: string
}

export interface ClientChangePasswordInput {
  currentPassword: string
  newPassword: string
}

export interface ClientUpdateProfileInput {
  username: string
  mobile?: string
  email?: string
  currentPassword: string
  mobileVerificationCode?: string
  emailVerificationCode?: string
}

export interface ClientProfileVerificationCodeSendInput {
  channel: ClientVerificationTargetChannel
  target: string
}

/**
 * 教职工目录查询的 service 结果。
 * 当前后端尚未暴露对应 HTTP 路由，api-client 不得据此虚构 endpoint。
 */
export interface ClientStaffDirectoryLookupResult {
  matched: boolean
  staffNo: string
  realName: string | null
  departmentName: string | null
  isRegistered: boolean
}
