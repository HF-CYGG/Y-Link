/**
 * 模块说明：backend/src/services/client-auth.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { LessThan } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { env } from '../config/env.js'
import { ClientStaffDirectory } from '../entities/client-staff-directory.entity.js'
import { CLIENT_USER_ACCOUNT_TYPES, ClientUser, type ClientUserAccountType } from '../entities/client-user.entity.js'
import { ClientUserSession } from '../entities/client-user-session.entity.js'
import type { ClientAuthContext } from '../types/client-auth.js'
import { BizError } from '../utils/errors.js'
import {
  type NormalizedClientAccount,
  normalizeClientAccount,
  normalizeClientVerificationTarget,
  normalizeClientUsername,
} from '../utils/client-auth-account.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { assertClientPasswordPolicy, hashPassword, verifyPassword } from '../utils/password.js'
import { hashSessionToken } from '../utils/session-token.js'
import { generateSessionToken } from '../utils/token.js'
import { auditService } from './audit.service.js'
import { authSecurityService } from './auth-security.service.js'
import { captchaService } from './captcha.service.js'
import { systemConfigService } from './system-config.service.js'
import { verificationCodeService } from './verification-code.service.js'
import { EphemeralTicketStore } from '../utils/ephemeral-ticket-store.js'

interface ResetTicket {
  userId: string
  expireAt: number
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const RESET_TICKET_TTL_MS = 10 * 60 * 1000
const CLIENT_SESSION_ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000
const resetTicketStore = new EphemeralTicketStore<ResetTicket>({
  maxSize: 3000,
  resolveExpiresAt: (ticket) => ticket.expireAt,
})

export interface ClientRegisterInput {
  username: string
  account: string
  accountType: ClientUserAccountType
  staffNo?: string
  password: string
  departmentName?: string
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

export interface ClientForgotVerifyInput {
  account: string
  verificationCode?: string
  captchaId?: string
  captchaCode?: string
}

export interface ClientVerificationCodeSendInput {
  channel: 'mobile' | 'email'
  target: string
  scene: 'register' | 'forgot_password'
  captchaId: string
  captchaCode: string
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
  departmentName?: string
}

export type ClientValidationMode = 'captcha' | 'verification_code'

export interface ClientDepartmentOptionNode {
  id: string
  label: string
  children: ClientDepartmentOptionNode[]
}

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

export interface ClientAuthSessionResult {
  token: string
  expiresAt: Date
  user: {
    id: string
    account: string
    username: string
    mobile: string
    email: string
    realName: string
    departmentName: string | null
    accountType: ClientUserAccountType
    staffNo: string | null
    staffVerified: boolean
    status: string
    lastLoginAt: Date | null
  }
  verificationChannel: 'captcha' | 'sms' | 'email'
}

class ClientAuthService {
  private readonly userRepo = AppDataSource.getRepository(ClientUser)
  private readonly sessionRepo = AppDataSource.getRepository(ClientUserSession)
  private readonly clientStaffDirectoryRepo = AppDataSource.getRepository(ClientStaffDirectory)
  private readonly staffNoPattern = /^[A-Za-z0-9-]{4,32}$/
  private readonly realNamePattern = /^[\u4e00-\u9fa5][\u4e00-\u9fa5· ]{1,19}$/

  private async getVerificationCapabilities(): Promise<ClientAuthCapabilities> {
    const [configs, departmentConfigs] = await Promise.all([
      systemConfigService.getVerificationProviderConfigs(),
      systemConfigService.getClientDepartmentConfigs(),
    ])
    const mobileEnabled = configs.mobile.enabled
    const emailEnabled = configs.email.enabled

    return {
      channels: {
        mobile: mobileEnabled,
        email: emailEnabled,
      },
      registerValidationModes: {
        mobile: mobileEnabled ? 'verification_code' : 'captcha',
        email: emailEnabled ? 'verification_code' : 'captcha',
      },
      forgotPasswordEnabled: mobileEnabled && emailEnabled,
      departmentTree: departmentConfigs.tree,
      departmentRootOptions: departmentConfigs.tree.map((node) => node.label),
      departmentOptions: departmentConfigs.options,
    }
  }

  private verifyCaptchaIfRequired(input: { captchaId?: string; captchaCode?: string }, message = '请输入图形验证码') {
    if (!input.captchaId?.trim() || !input.captchaCode?.trim()) {
      throw new BizError(message, 400)
    }
    captchaService.verifyCaptcha(input.captchaId, input.captchaCode)
  }

  /**
   * 发送短信/邮箱验证码前强制校验图形验证码：
   * - 避免验证码发送接口被脚本直接滥刷；
   * - 图形验证码校验成功后即作废，减少重放空间。
   */
  verifyCaptchaBeforeVerificationSend(input: ClientVerificationCodeSendInput) {
    this.verifyCaptchaIfRequired(input, '发送验证码前请先输入图形验证码')
  }

  private verifyCodeIfRequired(
    input: {
      verificationCode?: string
    },
    payload: {
      channel: 'mobile' | 'email'
      target: string
      scene: 'register' | 'forgot_password'
    },
    message = '请输入验证码',
  ) {
    if (!input.verificationCode?.trim()) {
      throw new BizError(message, 400)
    }
    verificationCodeService.verifyCode({
      channel: payload.channel,
      target: payload.target,
      scene: payload.scene,
      code: input.verificationCode,
    })
  }

  /**
   * 统一按归一化账号查找用户：
   * - 手机号、邮箱使用精确匹配；
   * - 用户名统一按小写键比较，避免 `Alice` / `alice` 形成大小写绕过。
   */
  private buildUserIdentifierQuery(identifier: NormalizedClientAccount, includePasswordHash = false) {
    const query = this.userRepo.createQueryBuilder('user')
    if (includePasswordHash) {
      query.addSelect('user.passwordHash')
    }
    if (identifier.channel === 'username') {
      query.where('LOWER(user.realName) = :account', { account: identifier.normalizedValue })
      return query
    }
    query.where(`user.${identifier.channel} = :account`, { account: identifier.normalizedValue })
    return query
  }

  private async findUserWithPasswordByAccount(identifier: NormalizedClientAccount) {
    return this.buildUserIdentifierQuery(identifier, true).getOne()
  }

  private async findUserByAnyIdentifier(identifier: NormalizedClientAccount) {
    return this.buildUserIdentifierQuery(identifier).getOne()
  }

  private toClientProfile(user: ClientUser) {
    const normalizedUsername = user.realName?.trim() || ''
    return {
      id: user.id,
      // 兼容口径说明：
      // - `username` 是客户端前端应优先消费的用户名字段；
      // - `realName` 仍保留给历史调用方做兼容别名，当前值与 username 保持一致；
      // - `account` 继续保留旧字段，避免旧缓存或旧页面因字段缺失直接失效。
      account: normalizedUsername || user.email || user.mobile || '',
      username: normalizedUsername,
      mobile: user.mobile ?? '',
      email: user.email ?? '',
      realName: normalizedUsername,
      departmentName: user.departmentName ?? '',
      accountType: user.accountType,
      staffNo: user.staffNo ?? null,
      staffVerified: Boolean(user.staffVerified),
      status: user.status,
      lastLoginAt: user.lastLoginAt,
    }
  }

  private normalizeAccountType(value: string | null | undefined): ClientUserAccountType {
    const normalized = value?.trim().toLowerCase() ?? ''
    if (CLIENT_USER_ACCOUNT_TYPES.includes(normalized as ClientUserAccountType)) {
      return normalized as ClientUserAccountType
    }
    throw new BizError('账号类型非法，仅支持 personal 或 department', 400)
  }

  private normalizeStaffNo(value: string | null | undefined): string {
    const normalized = value?.trim() ?? ''
    if (!normalized) {
      throw new BizError('部门账户必须填写教职工号', 400)
    }
    if (!this.staffNoPattern.test(normalized)) {
      throw new BizError('教职工号格式不正确，仅支持字母、数字和短横线（4-32位）', 400)
    }
    return normalized
  }

  private assertRealName(value: string): string {
    const normalized = value.trim()
    if (!this.realNamePattern.test(normalized)) {
      throw new BizError('用户名必须为2-20位中文真实姓名，可包含空格或·', 400)
    }
    return normalized
  }

  private resolveAccount(account: string): {
    channel: 'mobile' | 'email'
    account: string
    mobile: string | null
    email: string | null
  } {
    const normalizedAccount = normalizeClientAccount(account, {
      allowUsername: false,
      fieldLabel: '账号',
    })
    if (normalizedAccount.channel === 'username') {
      throw new BizError('账号格式不正确，请输入手机号或邮箱', 400)
    }
    const mobile = normalizedAccount.channel === 'mobile' ? normalizedAccount.normalizedValue : null
    const email = normalizedAccount.channel === 'email' ? normalizedAccount.normalizedValue : null
    return {
      channel: normalizedAccount.channel,
      account: normalizedAccount.normalizedValue,
      mobile,
      email,
    }
  }

  private resolveLoginAccount(account: string) {
    return normalizeClientAccount(account, {
      allowUsername: true,
      fieldLabel: '账号',
    })
  }

  async createCaptcha(requestMeta?: RequestMeta) {
    await authSecurityService.guardClientCaptchaRequest(requestMeta)
    return captchaService.createCaptcha()
  }

  async getCapabilities(): Promise<ClientAuthCapabilities> {
    return this.getVerificationCapabilities()
  }

  private async createSessionForUser(user: ClientUser) {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + env.AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000)
    const token = generateSessionToken()
    await AppDataSource.transaction(async (manager) => {
      await manager.getRepository(ClientUserSession).delete({ expiresAt: LessThan(now) })
      user.lastLoginAt = now
      await manager.getRepository(ClientUser).save(user)
      await manager.getRepository(ClientUserSession).save(
        manager.getRepository(ClientUserSession).create({
          sessionToken: hashSessionToken(token),
          userId: user.id,
          expiresAt,
          lastAccessAt: now,
        }),
      )
    })
    return {
      token,
      expiresAt,
    }
  }

  async register(input: ClientRegisterInput, _requestMeta?: RequestMeta) {
    const account = this.resolveAccount(input.account)
    const username = normalizeClientUsername(this.assertRealName(input.username))
    const accountType = this.normalizeAccountType(input.accountType)
    const password = assertClientPasswordPolicy(input.password)
    const capabilities = await this.getVerificationCapabilities()
    const validationMode = capabilities.registerValidationModes[account.channel]

    if (validationMode === 'verification_code') {
      this.verifyCodeIfRequired(
        input,
        {
          channel: account.channel,
          target: account.account,
          scene: 'register',
        },
        `请输入${account.channel === 'email' ? '邮箱' : '手机'}验证码`,
      )
    } else {
      this.verifyCaptchaIfRequired(input)
    }

    const existedByAccount = await this.findUserByAnyIdentifier({
      channel: account.channel,
      rawValue: account.account,
      normalizedValue: account.account,
    })
    if (existedByAccount) {
      throw new BizError('该手机号或邮箱已被占用', 409)
    }
    const existedByUsername = await this.findUserByAnyIdentifier({
      channel: 'username',
      rawValue: username.value,
      normalizedValue: username.normalizedValue,
    })
    if (existedByUsername) {
      throw new BizError('该用户名已被占用', 409)
    }
    await authSecurityService.guardClientRegisterAccountRequest(_requestMeta, account.account)
    let departmentName = await systemConfigService.assertClientDepartmentOption(input.departmentName)
    let staffNo: string | null = null
    let staffVerified = false

    if (accountType === 'department') {
      staffNo = this.normalizeStaffNo(input.staffNo)
      const existedByStaffNo = await this.userRepo.findOne({
        where: { staffNo },
        select: ['id'],
      })
      if (existedByStaffNo) {
        throw new BizError('该教职工号已绑定其他账号', 409)
      }

      const activeDirectoryCount = await this.clientStaffDirectoryRepo.count({
        where: { status: 'active' },
      })
      if (activeDirectoryCount > 0) {
        const matchedStaff = await this.clientStaffDirectoryRepo.findOne({
          where: { staffNo, status: 'active' },
        })
        if (!matchedStaff) {
          throw new BizError('教职工号未在学校目录中登记，请联系管理员核验', 409)
        }
        username.value = this.assertRealName(matchedStaff.realName)
        username.normalizedValue = username.value.toLowerCase()
        departmentName = await systemConfigService.assertClientDepartmentOption(matchedStaff.departmentName)
        staffVerified = true
      } else if (!departmentName) {
        throw new BizError('部门账户在目录未导入时，必须手动选择所属部门', 400)
      }
    } else {
      staffNo = null
      staffVerified = false
    }

    const user = await this.userRepo.save(
      this.userRepo.create({
        mobile: account.mobile,
        email: account.email,
        passwordHash: await hashPassword(password),
        // 当前账号体系下，用户名与登录账号分离，支持用户自定义用户名。
        realName: username.value,
        departmentName,
        accountType,
        staffNo,
        staffVerified,
        status: 'enabled',
      }),
    )
    const session = await this.createSessionForUser(user)
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: this.toClientProfile(user),
      verificationChannel: validationMode === 'verification_code'
        ? (account.channel === 'mobile' ? 'sms' : 'email')
        : 'captcha',
    } satisfies ClientAuthSessionResult
  }

  async login(input: ClientLoginInput, requestMeta?: RequestMeta) {
    const account = this.resolveLoginAccount(input.account)
    const password = input.password.trim()
    if (authSecurityService.isClientLoginCaptchaRequired(requestMeta, account.normalizedValue)) {
      this.verifyCaptchaIfRequired(input)
    }
    const user = await this.findUserWithPasswordByAccount(account)
    if (!user) {
      const loginFailureResult = await authSecurityService.recordClientLoginFailure(requestMeta, account.normalizedValue)
      await auditService.safeRecord({
        actionType: 'client.auth.login',
        actionLabel: '客户端登录',
        targetType: 'client_session',
        targetCode: account.normalizedValue,
        resultStatus: 'failed',
        requestMeta,
        detail: { reason: 'user_not_found' },
      })
      const loginErrorMessage = loginFailureResult.shouldWarnRemaining
        ? `用户名或密码错误（还可尝试 ${loginFailureResult.remainingAttempts} 次）`
        : '用户名或密码错误'
      throw new BizError(loginErrorMessage, 401)
    }
    if (user.status !== 'enabled') {
      throw new BizError('当前账号已停用', 403)
    }
    const matched = await verifyPassword(password, user.passwordHash)
    if (!matched) {
      const loginFailureResult = await authSecurityService.recordClientLoginFailure(requestMeta, account.normalizedValue)
      await auditService.safeRecord({
        actionType: 'client.auth.login',
        actionLabel: '客户端登录',
        targetType: 'client_session',
        targetId: user.id,
        targetCode: user.email ?? user.mobile ?? user.realName,
        resultStatus: 'failed',
        requestMeta,
        detail: { reason: 'password_mismatch' },
      })
      const loginErrorMessage = loginFailureResult.shouldWarnRemaining
        ? `用户名或密码错误（还可尝试 ${loginFailureResult.remainingAttempts} 次）`
        : '用户名或密码错误'
      throw new BizError(loginErrorMessage, 401)
    }
    const session = await this.createSessionForUser(user)
    authSecurityService.clearClientLoginFailures(requestMeta, account.normalizedValue)
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: this.toClientProfile(user),
      verificationChannel: 'captcha',
    } satisfies ClientAuthSessionResult
  }

  async verifyForgotPassword(input: ClientForgotVerifyInput, _requestMeta?: RequestMeta) {
    const capabilities = await this.getVerificationCapabilities()
    if (!capabilities.forgotPasswordEnabled) {
      throw new BizError('当前系统未同时启用手机与邮箱验证码，暂不支持自助找回密码，请联系管理员手动修改密码', 400)
    }

    const account = this.resolveAccount(input.account)
    this.verifyCodeIfRequired(
      input,
      {
        channel: account.channel,
        target: account.account,
        scene: 'forgot_password',
      },
      `请输入${account.channel === 'email' ? '邮箱' : '手机'}验证码`,
    )
    const user = await this.userRepo
      .createQueryBuilder('user')
      .where('user.mobile = :account OR user.email = :account', { account: account.account })
      .getOne()
    if (!user) {
      // 找回密码不直接暴露“账号是否已注册”，降低批量枚举账号的风险。
      throw new BizError('身份校验失败，请确认用户名、验证码后重试', 400)
    }
    const resetToken = generateSessionToken()
    resetTicketStore.set(resetToken, { userId: user.id, expireAt: Date.now() + RESET_TICKET_TTL_MS })
    return {
      resetToken,
      expiresInSeconds: Math.floor(RESET_TICKET_TTL_MS / 1000),
    }
  }

  async resetPassword(input: ClientResetPasswordInput, _requestMeta?: RequestMeta) {
    const account = this.resolveAccount(input.account)
    const newPassword = assertClientPasswordPolicy(input.newPassword, '新密码')
    const ticket = resetTicketStore.get(input.resetToken)
    if (!ticket) {
      resetTicketStore.delete(input.resetToken)
      throw new BizError('重置凭证已失效', 400)
    }
    const user = await this.userRepo
      .createQueryBuilder('user')
      .where('user.id = :userId', { userId: ticket.userId })
      .andWhere('(user.mobile = :account OR user.email = :account)', { account: account.account })
      .getOne()
    if (!user) {
      throw new BizError('用户不存在', 404)
    }
    user.passwordHash = await hashPassword(newPassword)
    await AppDataSource.transaction(async (manager) => {
      await manager.getRepository(ClientUser).save(user)
      await manager.getRepository(ClientUserSession).delete({ userId: user.id })
    })
    resetTicketStore.delete(input.resetToken)
  }

  async resolveClientByToken(token: string): Promise<ClientAuthContext> {
    const now = new Date()
    const session = await this.sessionRepo.findOne({
      where: { sessionToken: hashSessionToken(token) },
      relations: { user: true },
    })
    if (!session || session.expiresAt <= now || !session.user) {
      throw new BizError('未登录或登录状态已失效', 401)
    }
    if (session.user.status !== 'enabled') {
      throw new BizError('当前账号已停用', 403)
    }
    const threshold = new Date(now.getTime() - CLIENT_SESSION_ACTIVITY_WRITE_INTERVAL_MS)
    if (!session.lastAccessAt || session.lastAccessAt < threshold) {
      await this.sessionRepo
        .createQueryBuilder()
        .update(ClientUserSession)
        .set({ lastAccessAt: now })
        .where('id = :id', { id: session.id })
        .execute()
    }
    return {
      userId: session.user.id,
      mobile: session.user.mobile ?? '',
      email: session.user.email ?? '',
      account: session.user.realName || session.user.email || session.user.mobile || '',
      realName: session.user.realName,
      accountType: session.user.accountType,
      staffNo: session.user.staffNo ?? null,
      sessionToken: token,
    }
  }

  async me(auth: ClientAuthContext) {
    const user = await this.userRepo.findOne({ where: { id: auth.userId } })
    if (!user) {
      throw new BizError('当前用户不存在', 404)
    }
    return this.toClientProfile(user)
  }

  async logout(auth: ClientAuthContext) {
    await this.sessionRepo.delete({ sessionToken: hashSessionToken(auth.sessionToken) })
  }

  async changePassword(auth: ClientAuthContext, input: ClientChangePasswordInput) {
    const user = await this.userRepo.findOne({ where: { id: auth.userId } })
    if (!user) {
      throw new BizError('当前用户不存在', 404)
    }

    const account = normalizeClientAccount(user.email ?? user.mobile ?? user.realName, {
      allowUsername: true,
      fieldLabel: '账号',
    })
    const userWithPwd = await this.findUserWithPasswordByAccount(account)
    if (!userWithPwd) {
      throw new BizError('当前用户不存在', 404)
    }

    const matched = await verifyPassword(input.currentPassword, userWithPwd.passwordHash)
    if (!matched) {
      throw new BizError('原密码错误', 400)
    }

    const newPassword = assertClientPasswordPolicy(input.newPassword, '新密码')

    user.passwordHash = await hashPassword(newPassword)
    await AppDataSource.transaction(async (manager) => {
      await manager.getRepository(ClientUser).save(user)
      await manager.getRepository(ClientUserSession).delete({ userId: user.id })
    })
  }

  private buildProfileUniquenessChecks(username: ReturnType<typeof normalizeClientUsername>, mobile: string | null, email: string | null) {
    return [
      {
        value: {
          channel: 'username' as const,
          rawValue: username.value,
          normalizedValue: username.normalizedValue,
        },
        message: '该用户名已被其他用户使用',
      },
      { value: mobile, message: '该手机号已被其他用户使用' },
      { value: email, message: '该邮箱已被其他用户使用' },
    ]
  }

  private async ensureProfileIdentifiersUnique(
    checks: ReturnType<ClientAuthService['buildProfileUniquenessChecks']>,
    currentUserId: string,
  ) {
    for (const check of checks) {
      if (!check.value) {
        continue
      }
      const existed =
        typeof check.value === 'string'
          ? await this.findUserByAnyIdentifier({
              channel: check.value.includes('@') ? 'email' : 'mobile',
              rawValue: check.value,
              normalizedValue: check.value,
            })
          : await this.findUserByAnyIdentifier(check.value)
      if (existed && existed.id !== currentUserId) {
        throw new BizError(check.message, 409)
      }
    }
  }

  async updateProfile(auth: ClientAuthContext, input: ClientUpdateProfileInput) {
    const user = await this.userRepo.findOne({ where: { id: auth.userId } })
    if (!user) {
      throw new BizError('当前用户不存在', 404)
    }

    const username = normalizeClientUsername(this.assertRealName(input.username))
    const mobile = input.mobile?.trim()
      ? normalizeClientVerificationTarget('mobile', input.mobile)
      : null
    const email = input.email?.trim()
      ? normalizeClientVerificationTarget('email', input.email)
      : null
    const departmentName = await systemConfigService.assertClientDepartmentOption(input.departmentName)

    if (!mobile && !email) {
      throw new BizError('手机号和邮箱至少保留一项', 400)
    }

    if (user.accountType === 'department' && user.staffVerified) {
      if (username.value !== (user.realName?.trim() || '')) {
        throw new BizError('部门账号已通过工号目录校验，姓名不可修改', 409)
      }
      if (departmentName !== (user.departmentName ?? null)) {
        throw new BizError('部门账号已通过工号目录校验，所属部门不可修改', 409)
      }
    }

    const checks = this.buildProfileUniquenessChecks(username, mobile, email)
    await this.ensureProfileIdentifiersUnique(checks, user.id)

    user.realName = username.value
    user.mobile = mobile
    user.email = email
    user.departmentName = departmentName

    const savedUser = await this.userRepo.save(user)
    return this.toClientProfile(savedUser)
  }
}

export const clientAuthService = new ClientAuthService()
