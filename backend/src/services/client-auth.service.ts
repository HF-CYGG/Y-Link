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
import { hashPassword, verifyPassword } from '../utils/password.js'
import { generateSessionToken } from '../utils/token.js'
import { captchaService } from './captcha.service.js'

interface ResetTicket {
  userId: string
  expireAt: number
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const RESET_TICKET_TTL_MS = 10 * 60 * 1000
const resetTicketStore = new Map<string, ResetTicket>()

export interface ClientRegisterInput {
  mobile: string
  password: string
  realName: string
  departmentName?: string
  captchaId: string
  captchaCode: string
}

export interface ClientLoginInput {
  mobile: string
  password: string
  captchaId: string
  captchaCode: string
}

export interface ClientForgotVerifyInput {
  mobile: string
  captchaId: string
  captchaCode: string
}

export interface ClientResetPasswordInput {
  mobile: string
  resetToken: string
  newPassword: string
}

class ClientAuthService {
  private readonly userRepo = AppDataSource.getRepository(ClientUser)
  private readonly sessionRepo = AppDataSource.getRepository(ClientUserSession)

  private async findUserWithPasswordByMobile(mobile: string) {
    return this.userRepo.createQueryBuilder('user').addSelect('user.passwordHash').where('user.mobile = :mobile', { mobile }).getOne()
  }

  private toClientProfile(user: ClientUser) {
    return {
      id: user.id,
      mobile: user.mobile,
      realName: user.realName,
      departmentName: user.departmentName ?? '',
      status: user.status,
      lastLoginAt: user.lastLoginAt,
    }
  }

  private normalizeMobile(mobile: string) {
    const normalized = mobile.trim()
    if (!/^1\d{10}$/.test(normalized)) {
      throw new BizError('手机号格式不正确', 400)
    }
    return normalized
  }

  async createCaptcha() {
    return captchaService.createCaptcha()
  }

  async register(input: ClientRegisterInput) {
    const mobile = this.normalizeMobile(input.mobile)
    const password = input.password.trim()
    if (password.length < 6) {
      throw new BizError('密码至少 6 位', 400)
    }
    captchaService.verifyCaptcha(input.captchaId, input.captchaCode)
    const existed = await this.userRepo.findOne({ where: { mobile } })
    if (existed) {
      throw new BizError('手机号已注册', 409)
    }
    const user = await this.userRepo.save(
      this.userRepo.create({
        mobile,
        passwordHash: await hashPassword(password),
        realName: input.realName.trim() || mobile,
        departmentName: input.departmentName?.trim() || '',
        status: 'enabled',
      }),
    )
    return this.toClientProfile(user)
  }

  async login(input: ClientLoginInput) {
    const mobile = this.normalizeMobile(input.mobile)
    const password = input.password.trim()
    captchaService.verifyCaptcha(input.captchaId, input.captchaCode)
    const user = await this.findUserWithPasswordByMobile(mobile)
    if (!user) {
      throw new BizError('手机号或密码错误', 401)
    }
    if (user.status !== 'enabled') {
      throw new BizError('当前账号已停用', 403)
    }
    const matched = await verifyPassword(password, user.passwordHash)
    if (!matched) {
      throw new BizError('手机号或密码错误', 401)
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
    return {
      token,
      expiresAt,
      user: this.toClientProfile(user),
      verificationChannel: 'captcha',
    }
  }

  async verifyForgotPassword(input: ClientForgotVerifyInput) {
    const mobile = this.normalizeMobile(input.mobile)
    captchaService.verifyCaptcha(input.captchaId, input.captchaCode)
    const user = await this.userRepo.findOne({ where: { mobile } })
    if (!user) {
      throw new BizError('手机号未注册', 404)
    }
    const resetToken = generateSessionToken()
    resetTicketStore.set(resetToken, { userId: user.id, expireAt: Date.now() + RESET_TICKET_TTL_MS })
    return {
      resetToken,
      expiresInSeconds: Math.floor(RESET_TICKET_TTL_MS / 1000),
    }
  }

  async resetPassword(input: ClientResetPasswordInput) {
    const mobile = this.normalizeMobile(input.mobile)
    const newPassword = input.newPassword.trim()
    if (newPassword.length < 6) {
      throw new BizError('新密码至少 6 位', 400)
    }
    const ticket = resetTicketStore.get(input.resetToken)
    if (!ticket || ticket.expireAt <= Date.now()) {
      resetTicketStore.delete(input.resetToken)
      throw new BizError('重置凭证已失效', 400)
    }
    const user = await this.userRepo.findOne({ where: { id: ticket.userId, mobile } })
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
      mobile: session.user.mobile,
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
}

export const clientAuthService = new ClientAuthService()
