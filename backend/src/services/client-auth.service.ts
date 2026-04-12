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
import type { RequestMeta } from '../utils/request-meta.js'
import { hashPassword, verifyPassword } from '../utils/password.js'
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

class ClientAuthService {
  private readonly userRepo = AppDataSource.getRepository(ClientUser)
  private readonly sessionRepo = AppDataSource.getRepository(ClientUserSession)

  private async getVerificationCapabilities(): Promise<ClientAuthCapabilities> {
    const configs = await systemConfigService.getVerificationProviderConfigs()
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
    }
  }

  private verifyCaptchaIfRequired(input: { captchaId?: string; captchaCode?: string }, message = '请输入图形验证码') {
    if (!input.captchaId?.trim() || !input.captchaCode?.trim()) {
      throw new BizError(message, 400)
    }
    captchaService.verifyCaptcha(input.captchaId, input.captchaCode)
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

  private async findUserWithPasswordByAccount(account: string) {
    return this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.mobile = :account OR user.email = :account', { account })
      .getOne()
  }

  private toClientProfile(user: ClientUser) {
    return {
      id: user.id,
      account: user.email ?? user.mobile ?? user.realName,
      mobile: user.mobile ?? '',
      email: user.email ?? '',
      realName: user.realName,
      departmentName: user.departmentName ?? '',
      status: user.status,
      lastLoginAt: user.lastLoginAt,
    }
  }

  private normalizeEmail(email: string) {
    const normalized = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new BizError('邮箱格式不正确', 400)
    }
    return normalized
  }

  private normalizeMobile(mobile: string) {
    const normalized = mobile.trim()
    if (!/^1\d{10}$/.test(normalized)) {
      throw new BizError('手机号格式不正确', 400)
    }
    return normalized
  }

  private resolveAccount(account: string) {
    const normalized = account.trim()
    if (!normalized) {
      throw new BizError('账号不能为空', 400)
    }
    if (normalized.includes('@')) {
      const email = this.normalizeEmail(normalized)
      return {
        channel: 'email' as const,
        account: email,
        mobile: null,
        email,
      }
    }
    const mobile = this.normalizeMobile(normalized)
    return {
      channel: 'mobile' as const,
      account: mobile,
      mobile,
      email: null,
    }
  }

  async createCaptcha(requestMeta?: RequestMeta) {
    await authSecurityService.guardClientCaptchaRequest(requestMeta)
    return captchaService.createCaptcha()
  }

  async getCapabilities(): Promise<ClientAuthCapabilities> {
    return this.getVerificationCapabilities()
  }

  async register(input: ClientRegisterInput, requestMeta?: RequestMeta) {
    const account = this.resolveAccount(input.account)
    const password = input.password.trim()
    if (password.length < 6) {
      throw new BizError('密码至少 6 位', 400)
    }
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

    const existed = await this.userRepo
      .createQueryBuilder('user')
      .where('user.mobile = :account OR user.email = :account', { account: account.account })
      .getOne()
    if (existed) {
      throw new BizError('该用户名已注册', 409)
    }
    const user = await this.userRepo.save(
      this.userRepo.create({
        mobile: account.mobile,
        email: account.email,
        passwordHash: await hashPassword(password),
        // 当前账号体系下，“用户名”直接使用注册时填写的手机号或邮箱。
        realName: account.account,
        departmentName: input.departmentName?.trim() || '',
        status: 'enabled',
      }),
    )
    return this.toClientProfile(user)
  }

  async login(input: ClientLoginInput, requestMeta?: RequestMeta) {
    const account = this.resolveAccount(input.account)
    const password = input.password.trim()
    if (authSecurityService.isClientLoginCaptchaRequired(requestMeta, account.account)) {
      this.verifyCaptchaIfRequired(input)
    }
    const user = await this.findUserWithPasswordByAccount(account.account)
    if (!user) {
      await authSecurityService.recordClientLoginFailure(requestMeta, account.account)
      await auditService.safeRecord({
        actionType: 'client.auth.login',
        actionLabel: '客户端登录',
        targetType: 'client_session',
        targetCode: account.account,
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
      await authSecurityService.recordClientLoginFailure(requestMeta, account.account)
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
    authSecurityService.clearClientLoginFailures(requestMeta, account.account)
    return {
      token,
      expiresAt,
      user: this.toClientProfile(user),
      verificationChannel: 'captcha',
    }
  }

  async verifyForgotPassword(input: ClientForgotVerifyInput, requestMeta?: RequestMeta) {
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

  async resetPassword(input: ClientResetPasswordInput, requestMeta?: RequestMeta) {
    const account = this.resolveAccount(input.account)
    const newPassword = input.newPassword.trim()
    if (newPassword.length < 6) {
      throw new BizError('新密码至少 6 位', 400)
    }
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
      account: session.user.email ?? session.user.mobile ?? session.user.realName,
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

    const account = user.email ?? user.mobile ?? user.realName
    const userWithPwd = await this.findUserWithPasswordByAccount(account)
    if (!userWithPwd) {
      throw new BizError('当前用户不存在', 404)
    }

    const matched = await verifyPassword(input.currentPassword, userWithPwd.passwordHash)
    if (!matched) {
      throw new BizError('原密码错误', 400)
    }

    const newPassword = input.newPassword.trim()
    if (newPassword.length < 6) {
      throw new BizError('新密码至少 6 位', 400)
    }

    user.passwordHash = await hashPassword(newPassword)
    await AppDataSource.transaction(async (manager) => {
      await manager.getRepository(ClientUser).save(user)
      await manager.getRepository(ClientUserSession).delete({ userId: user.id })
    })
  }

  async updateProfile(auth: ClientAuthContext, input: ClientUpdateProfileInput) {
    const user = await this.userRepo.findOne({ where: { id: auth.userId } })
    if (!user) {
      throw new BizError('当前用户不存在', 404)
    }

    const username = input.username.trim()
    if (!username) {
      throw new BizError('用户名不能为空', 400)
    }

    const mobile = input.mobile?.trim() ? this.normalizeMobile(input.mobile) : null
    const email = input.email?.trim() ? this.normalizeEmail(input.email) : null
    const departmentName = input.departmentName?.trim() || ''

    if (!mobile && !email) {
      throw new BizError('手机号和邮箱至少保留一项', 400)
    }
    if (username !== mobile && username !== email) {
      throw new BizError('用户名必须与手机号或邮箱保持一致', 400)
    }

    if (mobile) {
      const existedByMobile = await this.userRepo.findOne({ where: { mobile } })
      if (existedByMobile && existedByMobile.id !== user.id) {
        throw new BizError('该手机号已被其他用户使用', 409)
      }
    }
    if (email) {
      const existedByEmail = await this.userRepo.findOne({ where: { email } })
      if (existedByEmail && existedByEmail.id !== user.id) {
        throw new BizError('该邮箱已被其他用户使用', 409)
      }
    }

    user.realName = username
    user.mobile = mobile
    user.email = email
    user.departmentName = departmentName

    const savedUser = await this.userRepo.save(user)
    return this.toClientProfile(savedUser)
  }
}

export const clientAuthService = new ClientAuthService()
