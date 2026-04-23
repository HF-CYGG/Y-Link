/**
 * 模块说明：backend/src/services/client-auth.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { LessThan } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { env } from '../config/env.js'
import { ClientUser } from '../entities/client-user.entity.js'
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
import { generateSessionToken } from '../utils/token.js'
import { auditService } from './audit.service.js'
import { authSecurityService } from './auth-security.service.js'
import { captchaService } from './captcha.service.js'
import { systemConfigService } from './system-config.service.js'
import { verificationCodeService } from './verification-code.service.js'

interface ResetTicket {
  userId: string
  expireAt: number
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const RESET_TICKET_TTL_MS = 10 * 60 * 1000
const resetTicketStore = new Map<string, ResetTicket>()

export interface ClientRegisterInput {
  username: string
  account: string
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

class ClientAuthService {
  private readonly userRepo = AppDataSource.getRepository(ClientUser)
  private readonly sessionRepo = AppDataSource.getRepository(ClientUserSession)

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
    return {
      id: user.id,
      account: user.realName || user.email || user.mobile,
      mobile: user.mobile ?? '',
      email: user.email ?? '',
      realName: user.realName,
      departmentName: user.departmentName ?? '',
      status: user.status,
      lastLoginAt: user.lastLoginAt,
    }
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

  async register(input: ClientRegisterInput, _requestMeta?: RequestMeta) {
    const account = this.resolveAccount(input.account)
    const username = normalizeClientUsername(input.username)
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
    const selectedDepartmentName = await systemConfigService.assertClientDepartmentOption(input.departmentName)
    const user = await this.userRepo.save(
      this.userRepo.create({
        mobile: account.mobile,
        email: account.email,
        passwordHash: await hashPassword(password),
        // 当前账号体系下，用户名与登录账号分离，支持用户自定义用户名。
        realName: username.value,
        departmentName: selectedDepartmentName,
        status: 'enabled',
      }),
    )
    return this.toClientProfile(user)
  }

  async login(input: ClientLoginInput, requestMeta?: RequestMeta) {
    const account = this.resolveLoginAccount(input.account)
    const password = input.password.trim()
    if (authSecurityService.isClientLoginCaptchaRequired(requestMeta, account.normalizedValue)) {
      this.verifyCaptchaIfRequired(input)
    }
    const user = await this.findUserWithPasswordByAccount(account)
    if (!user) {
      await authSecurityService.recordClientLoginFailure(requestMeta, account.normalizedValue)
      await auditService.safeRecord({
        actionType: 'client.auth.login',
        actionLabel: '客户端登录',
        targetType: 'client_session',
        targetCode: account.normalizedValue,
        resultStatus: 'failed',
        requestMeta,
        detail: { reason: 'user_not_found' },
      })
      throw new BizError('用户名或密码错误', 401)
    }
    if (user.status !== 'enabled') {
      throw new BizError('当前账号已停用', 403)
    }
    const matched = await verifyPassword(password, user.passwordHash)
    if (!matched) {
      await authSecurityService.recordClientLoginFailure(requestMeta, account.normalizedValue)
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
      throw new BizError('用户名或密码错误', 401)
    }
    const now = new Date()
    const expiresAt = new Date(now.getTime() + env.AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000)
    const token = generateSessionToken()
    await AppDataSource.transaction(async (manager) => {
      await manager.getRepository(ClientUserSession).delete({ expiresAt: LessThan(now) })
      user.lastLoginAt = now
      await manager.getRepository(ClientUser).save(user)
      await manager.getRepository(ClientUserSession).save(
        manager.getRepository(ClientUserSession).create({
          sessionToken: token,
          userId: user.id,
          expiresAt,
          lastAccessAt: now,
        }),
      )
    })
    authSecurityService.clearClientLoginFailures(requestMeta, account.normalizedValue)
    return {
      token,
      expiresAt,
      user: this.toClientProfile(user),
      verificationChannel: 'captcha',
    }
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
    if (!ticket || ticket.expireAt <= Date.now()) {
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
    const session = await this.sessionRepo.findOne({ where: { sessionToken: token }, relations: { user: true } })
    if (!session || session.expiresAt <= now || !session.user) {
      throw new BizError('未登录或登录状态已失效', 401)
    }
    if (session.user.status !== 'enabled') {
      throw new BizError('当前账号已停用', 403)
    }
    session.lastAccessAt = now
    await this.sessionRepo.save(session)
    return {
      userId: session.user.id,
      mobile: session.user.mobile ?? '',
      email: session.user.email ?? '',
      account: session.user.realName || session.user.email || session.user.mobile || '',
      realName: session.user.realName,
      sessionToken: session.sessionToken,
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
    await this.sessionRepo.delete({ sessionToken: auth.sessionToken })
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

    const username = normalizeClientUsername(input.username)
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
