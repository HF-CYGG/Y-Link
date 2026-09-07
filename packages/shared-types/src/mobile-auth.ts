import type {
  ClientForgotPasswordVerifyInput,
  ClientForgotPasswordVerifyResult,
  ClientSafeProfile,
  ClientUpdateProfileInput,
  ClientVerificationCodeSendInput,
  ClientVerificationCodeSendResult,
} from './auth.ts'

export type MobilePlatform = 'android' | 'ios'

export interface MobileDeviceMetadata {
  deviceId: string
  deviceName?: string
  platform: MobilePlatform
  appVersion?: string
}

export interface MobileAuthSessionSummary {
  id: string
  deviceId: string
  deviceName: string | null
  platform: MobilePlatform
  appVersion: string | null
  lastIp?: string | null
  lastAccessAt: string
  createdAt: string
  isCurrent?: boolean
}

/** Mobile 登录、注册、刷新与改密成功时的完整凭据束。 */
export interface MobileAuthSessionDTO {
  accessToken: string
  accessExpiresAt: string
  refreshToken: string
  refreshExpiresAt: string
  absoluteExpiresAt: string
  generation: number
  session: MobileAuthSessionSummary
  user: ClientSafeProfile
}

export interface MobileLoginInput {
  account: string
  password: string
  captchaId?: string
  captchaCode?: string
  device: MobileDeviceMetadata
}

export interface MobileRegisterInput {
  /** Mobile 自助注册只创建 personal；department 账号由管理员维护。 */
  accountType: 'personal'
  account?: string
  username?: string
  password: string
  staffNo?: string
  inviteCode?: string
  departmentName?: string
  verificationCode?: string
  captchaId?: string
  captchaCode?: string
  device: MobileDeviceMetadata
}

export interface MobileRefreshInput {
  refreshToken: string
  device: Pick<MobileDeviceMetadata, 'deviceId'> & Partial<Pick<MobileDeviceMetadata, 'appVersion'>>
}

export type MobileLogoutAllScope = 'all' | 'others'

export interface MobileLogoutResult {
  revoked: true
}

export interface MobileLogoutAllResult {
  revokedCount: number
  currentSessionRevoked: boolean
}

export interface MobileMeResult {
  user: ClientSafeProfile
  session: MobileAuthSessionSummary
}

export interface MobileSessionListResult {
  sessions: MobileAuthSessionSummary[]
  maxActiveSessions: number
}

export interface MobileSessionRevokeResult {
  revoked: true
}

export interface MobileChangePasswordInput {
  currentPassword: string
  newPassword: string
  device: MobileDeviceMetadata
}

export interface MobileResetPasswordInput {
  account: string
  resetToken: string
  newPassword: string
}

export interface MobileResetPasswordResult {
  ok: true
}

export type MobileUpdateProfileInput = ClientUpdateProfileInput
export type MobileForgotPasswordVerifyInput = ClientForgotPasswordVerifyInput
export type MobileForgotPasswordVerifyResult = ClientForgotPasswordVerifyResult
export type MobileVerificationCodeSendInput = ClientVerificationCodeSendInput
export type MobileVerificationCodeSendResult = ClientVerificationCodeSendResult

export type MobileAuthErrorCode =
  | 40100
  | 40101
  | 40102
  | 40110
  | 40111
  | 40112
  | 40113
  | 40120
  | 40300
  | 40900
  | 42900
