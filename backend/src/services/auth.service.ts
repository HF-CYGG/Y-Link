/**
 * 文件说明：该文件负责管理端认证服务，统一处理后台登录、退出、当前用户读取、本人改密与默认管理员初始化。
 * 实现逻辑：
 * 1. 以后台用户表和会话表为核心，维护管理端账号的登录态、权限画像与服务端失效控制；
 * 2. 将密码校验、密码哈希、会话令牌签发和账号状态判断集中在服务层，避免路由层分散实现认证规则；
 * 3. 认证过程会联动风控服务和审计服务，兼顾登录安全、问题追溯与后续治理扩展。
 */

import { LessThan, MoreThan, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { env } from '../config/env.js'
import { resolvePermissionsByRole } from '../constants/auth-permissions.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import type { AuthUserContext, UserSafeProfile } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import {
  assertAdminPasswordPolicy,
  hashPassword,
  verifyPassword,
  verifyPasswordDetailed,
  verifyPasswordForNonexistentAccount,
} from '../utils/password.js'
import { hashSessionToken } from '../utils/session-token.js'
import { generateSessionToken } from '../utils/token.js'
import { EphemeralTicketStore } from '../utils/ephemeral-ticket-store.js'
import { maskLoginInputForAudit } from '../utils/audit-subject-mask.js'
import { isAdminSessionIdleExpired } from '../utils/admin-session-idle.js'
import { auditService } from './audit.service.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { authSecurityService, type ResolvedLoginRiskSubject } from './auth-security.service.js'
import { adminMfaService, type AdminMfaFactorInput } from './admin-mfa.service.js'
import { customerServiceRealtimeService } from './customer-service-realtime.service.js'

export interface LoginInput {
  username: string
  password: string
}

/**
 * 本人修改密码入参：
 * - currentPassword 为当前密码，用于确认操作者确实知晓旧凭证；
 * - newPassword 为目标新密码，仅传输明文到服务层，落库前统一转换为哈希。
 */
export interface ChangeOwnPasswordInput {
  currentPassword: string
  newPassword: string
}

interface AdminLoginSecuritySnapshot {
  passwordHash: string
  username: string
  role: SysUser['role']
  status: SysUser['status']
}

export interface AdminLoginSession {
  mfaRequired?: false
  token: string
  expiresAt: Date
  user: UserSafeProfile
  securityReminder?: string
  /** 本次用恢复码完成两步验证时返回剩余数量，前端据此提醒及时重新生成。 */
  recoveryCodesRemaining?: number
}

export interface AdminLoginMfaChallenge {
  mfaRequired: true
  mfaTicket: string
  expiresInSeconds: number
}

export type AdminLoginResult = AdminLoginSession | AdminLoginMfaChallenge

export interface AdminMfaLoginInput extends AdminMfaFactorInput {
  mfaTicket: string
}

/**
 * 两步验证登录票据：密码校验通过后签发，只保存第二步签发会话所需的安全快照与可能的重哈希结果，
 * 不保存密码明文；5 分钟有效，最多 5 次动态码尝试，每次提交都先取出票据，天然串行化同一票据的并发尝试。
 */
interface AdminMfaLoginTicket {
  userId: string
  username: string
  securitySnapshot: AdminLoginSecuritySnapshot
  upgradedPasswordHash: string | null
  expiresAt: number
  attemptsLeft: number
}

const MFA_LOGIN_TICKET_TTL_MS = 5 * 60 * 1000
const MFA_LOGIN_MAX_ATTEMPTS = 5
const mfaLoginTicketStore = new EphemeralTicketStore<AdminMfaLoginTicket>({
  maxSize: 5000,
  resolveExpiresAt: (ticket) => ticket.expiresAt,
})
const MFA_TICKET_EXPIRED_REASON = 'ADMIN_MFA_TICKET_EXPIRED'

const LEGACY_DEFAULT_BOOTSTRAP_PASSWORD = ['Admin', '@', '123456'].join('')

export function resolveAccountState(user: Pick<SysUser, 'status' | 'deactivatedAt' | 'restoredAt'>): UserSafeProfile['accountState'] {
  const deactivatedAt = user.deactivatedAt?.getTime() ?? 0
  const restoredAt = user.restoredAt?.getTime() ?? 0
  return deactivatedAt > restoredAt ? 'deactivated' : user.status
}

function toSafeProfile(user: SysUser): UserSafeProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    permissions: resolvePermissionsByRole(user.role),
    status: user.status,
    accountState: resolveAccountState(user),
    deactivatedAt: user.deactivatedAt,
    deactivationReason: user.deactivationReason,
    deactivatedByUsername: user.deactivatedByUsername,
    deactivatedByDisplayName: user.deactivatedByDisplayName,
    restoredAt: user.restoredAt,
    restoredByUsername: user.restoredByUsername,
    restoredByDisplayName: user.restoredByDisplayName,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

/**
 * 认证服务：
 * - 统一处理登录、退出、当前用户、默认管理员初始化；
 * - 认证令牌采用数据库会话模式，便于主动退出与服务端失效控制。
 */
export class AuthService {
  private readonly userRepo = AppDataSource.getRepository(SysUser)
  private readonly sessionRepo = AppDataSource.getRepository(SysUserSession)

  /**
   * 按账号加载带密码哈希的用户：
   * - TypeORM 默认不会返回 select: false 字段；
   * - 登录、改密等安全场景必须显式取回密码哈希做校验。
   */
  private async findUserWithPasswordByUsername(username: string): Promise<SysUser | null> {
    return this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.username = :username', { username })
      .getOne()
  }

  /**
   * 解析登录风控主体：
   * - 账号存在时返回数据库中的规范用户名，锁定与验证码判定都按它计数；
   * - MySQL 常用排序规则大小写、重音、全角不敏感，`Ádmin`/`ａｄｍｉｎ` 都能命中 `admin`，
   *   若按输入原文计数，攻击者每换一种写法就得到一个全新的失败桶，账号锁定形同虚设；
   * - 账号不存在时退回输入原文，与失败记录口径保持一致；
   * - `resolved` 标明是否命中真实账号：未命中时的原文可能是误填的密码，守卫写审计前必须脱敏。
   */
  async resolveLoginRiskSubject(username: string): Promise<ResolvedLoginRiskSubject> {
    const normalizedUsername = username.trim()
    if (!normalizedUsername) {
      return { subject: normalizedUsername, resolved: false }
    }
    const user = await this.userRepo.findOne({
      where: { username: normalizedUsername },
      select: { id: true, username: true },
    })
    return user ? { subject: user.username, resolved: true } : { subject: normalizedUsername, resolved: false }
  }

  private buildLoginSecuritySnapshot(user: SysUser): AdminLoginSecuritySnapshot {
    return {
      passwordHash: user.passwordHash,
      username: user.username,
      role: user.role,
      status: user.status,
    }
  }

  private async lockUserForSession(manager: EntityManager, userId: string): Promise<SysUser | null> {
    const query = manager.getRepository(SysUser)
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :userId', { userId })
    if (manager.connection.options.type === 'mysql') {
      query.setLock('pessimistic_write')
    }
    return query.getOne()
  }

  private isLoginSecuritySnapshotCurrent(user: SysUser, snapshot: AdminLoginSecuritySnapshot): boolean {
    return user.passwordHash === snapshot.passwordHash
      && user.username === snapshot.username
      && user.role === snapshot.role
      && user.status === snapshot.status
      && user.status === 'enabled'
  }

  /**
   * 在调用方事务内签发会话：调用方必须已锁定账号并复核安全快照。
   * 顺带清理过期会话、写入最近登录时间与可能的重哈希结果，并写登录成功审计。
   */
  private async createSessionInTransaction(
    manager: EntityManager,
    lockedUser: SysUser,
    upgradedPasswordHash: string | null,
    requestMeta: RequestMeta | undefined,
    auditDetail: Record<string, unknown>,
  ): Promise<AdminLoginSession> {
    const sessionRepo = manager.getRepository(SysUserSession)
    const userRepo = manager.getRepository(SysUser)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + env.AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000)
    const token = generateSessionToken()

    await sessionRepo.delete({
      expiresAt: LessThan(now),
    })

    lockedUser.lastLoginAt = now
    if (upgradedPasswordHash) {
      lockedUser.passwordHash = upgradedPasswordHash
    }
    const savedUser = await userRepo.save(lockedUser)
    const session = await sessionRepo.save(
      sessionRepo.create({
        sessionToken: hashSessionToken(token),
        userId: savedUser.id,
        expiresAt,
        lastAccessAt: now,
      }),
    )

    await auditService.record(
      {
        actionType: 'auth.login',
        actionLabel: '用户登录',
        targetType: 'session',
        targetId: session.id,
        targetCode: savedUser.username,
        actor: {
          userId: savedUser.id,
          username: savedUser.username,
          displayName: savedUser.displayName,
        },
        requestMeta,
        detail: {
          sessionId: session.id,
          expiresAt: expiresAt.toISOString(),
          passwordHashUpgraded: Boolean(upgradedPasswordHash),
          ...auditDetail,
        },
      },
      manager,
    )

    return {
      token,
      expiresAt,
      user: toSafeProfile(savedUser),
    }
  }

  async login(
    input: LoginInput,
    requestMeta?: RequestMeta,
  ): Promise<AdminLoginResult> {
    const username = input.username.trim()
    const password = input.password.trim()

    if (!username || !password) {
      throw new BizError('账号和密码不能为空', 400)
    }

    const user = await this.findUserWithPasswordByUsername(username)

    if (!user) {
      await verifyPasswordForNonexistentAccount(password)
      await authSecurityService.recordAdminLoginFailure(requestMeta, username, { subjectResolved: false })
      await auditService.safeRecord({
        actionType: 'auth.login',
        actionLabel: '用户登录',
        targetType: 'session',
        // 账号不存在时输入原文可能是误填的密码或他人手机号，只记掩码与指纹。
        targetCode: maskLoginInputForAudit(username),
        resultStatus: 'failed',
        requestMeta,
        detail: {
          reason: 'user_not_found',
        },
      })
      throw new BizError('账号或密码错误', 401)
    }

    const passwordVerification = await verifyPasswordDetailed(password, user.passwordHash)
    if (!passwordVerification.matched) {
      await authSecurityService.recordAdminLoginFailure(requestMeta, user.username)
      await auditService.safeRecord({
        actionType: 'auth.login',
        actionLabel: '用户登录',
        targetType: 'session',
        targetId: user.id,
        targetCode: user.username,
        actor: {
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
        },
        resultStatus: 'failed',
        requestMeta,
        detail: {
          reason: 'password_mismatch',
        },
      })
      throw new BizError('账号或密码错误', 401)
    }

    if (user.status !== 'enabled') {
      await auditService.safeRecord({
        actionType: 'auth.login',
        actionLabel: '用户登录',
        targetType: 'session',
        targetId: user.id,
        targetCode: user.username,
        actor: {
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
        },
        resultStatus: 'failed',
        requestMeta,
        detail: {
          reason: 'user_disabled' },
      })
      throw new BizError('当前账号已停用，请联系管理员', 403)
    }

    const securitySnapshot = this.buildLoginSecuritySnapshot(user)
    // 旧参数哈希透明升级：新哈希在事务外算好（CPU 密集），事务内确认安全快照未变后随会话一并写入。
    const upgradedPasswordHash = passwordVerification.needsRehash ? await hashPassword(password) : null

    // 已开启两步验证：密码正确也不签发会话，只发放第二步票据；失败计数要到第二步成功才清空。
    if (await adminMfaService.isEnabled(user.id)) {
      const mfaTicket = generateSessionToken()
      mfaLoginTicketStore.set(mfaTicket, {
        userId: String(user.id),
        username: user.username,
        securitySnapshot,
        upgradedPasswordHash,
        expiresAt: Date.now() + MFA_LOGIN_TICKET_TTL_MS,
        attemptsLeft: MFA_LOGIN_MAX_ATTEMPTS,
      })
      await auditService.safeRecord({
        actionType: 'auth.mfa.challenge',
        actionLabel: '登录待两步验证',
        targetType: 'session',
        targetId: user.id,
        targetCode: user.username,
        actor: {
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
        },
        requestMeta,
        detail: { expiresInSeconds: MFA_LOGIN_TICKET_TTL_MS / 1000 },
      })
      return {
        mfaRequired: true,
        mfaTicket,
        expiresInSeconds: MFA_LOGIN_TICKET_TTL_MS / 1000,
      }
    }

    const data = await runInTransaction(async (manager) => {
      // 密码散列校验保持在事务外；签发前在同一事务内锁定账号并复核安全快照。
      // 这样改密、停用或角色变更与会话插入必然形成明确先后，晚到的旧校验结果不能重新创建会话。
      const lockedUser = await this.lockUserForSession(manager, user.id)
      if (!lockedUser || !this.isLoginSecuritySnapshotCurrent(lockedUser, securitySnapshot)) {
        throw new BizError('账号或密码错误', 401)
      }
      // 事务外判定“未开启”后若恰好刚开启两步验证，不能沿用旧判断直接签发会话。
      if (await adminMfaService.isEnabled(lockedUser.id, manager)) {
        throw new BizError('账号安全设置已变化，请重新登录', 401)
      }
      return this.createSessionInTransaction(manager, lockedUser, upgradedPasswordHash, requestMeta, { mfaMethod: null })
    })

    // 登录成功后清空该来源与该账号的失败计数，避免历史失败导致后续误锁；按规范用户名清理，与失败记录同一个桶。
    await authSecurityService.clearAdminLoginFailures(requestMeta, user.username)
    return data
  }

  /**
   * 两步验证登录第二步：
   * - 先取出票据（同一票据的并发提交只有一个能继续），再走与登录相同的来源频控与账号锁定；
   * - 事务内锁定账号、复核第一步的安全快照，再校验动态码或恢复码并签发会话，改密/停用/重置两步验证后旧票据自然失效；
   * - 动态码错误计入账号登录失败锁定，票据剩余次数用尽即作废，需重新输入账号密码。
   */
  async completeMfaLogin(input: AdminMfaLoginInput, requestMeta?: RequestMeta): Promise<AdminLoginSession> {
    const ticketId = input.mfaTicket.trim()
    const ticket = ticketId ? mfaLoginTicketStore.take(ticketId) : undefined
    if (!ticket) {
      throw new BizError('登录验证已过期，请重新输入账号和密码', 401, { reason: MFA_TICKET_EXPIRED_REASON })
    }
    await authSecurityService.guardAdminMfaLoginRequest(requestMeta, ticket.username)

    const outcome = await runInTransaction(async (manager) => {
      const lockedUser = await this.lockUserForSession(manager, ticket.userId)
      if (!lockedUser || !this.isLoginSecuritySnapshotCurrent(lockedUser, ticket.securitySnapshot)) {
        return { kind: 'stale' as const }
      }
      const factor = await adminMfaService.verifyFactor(manager, lockedUser.id, {
        code: input.code,
        recoveryCode: input.recoveryCode,
      })
      if (!factor.ok) {
        return { kind: 'rejected' as const, factor }
      }
      const session = await this.createSessionInTransaction(manager, lockedUser, ticket.upgradedPasswordHash, requestMeta, {
        mfaMethod: factor.method,
        ...(factor.method === 'recovery_code' ? { recoveryCodesRemaining: factor.recoveryCodesRemaining } : {}),
      })
      return { kind: 'issued' as const, session, factor }
    })

    if (outcome.kind === 'issued') {
      await authSecurityService.clearAdminLoginFailures(requestMeta, ticket.username)
      return outcome.factor.method === 'recovery_code'
        ? { ...outcome.session, recoveryCodesRemaining: outcome.factor.recoveryCodesRemaining }
        : outcome.session
    }
    // 账号改密、停用或两步验证已被重置：第一步的结论不再可信，必须重新输入账号密码。
    if (outcome.kind === 'stale' || outcome.factor.reason === 'not_enabled') {
      throw new BizError('账号安全设置已变化，请重新登录', 401, { reason: MFA_TICKET_EXPIRED_REASON })
    }
    if (outcome.factor.reason === 'factor_missing') {
      mfaLoginTicketStore.set(ticketId, ticket)
      throw new BizError('请输入 6 位动态码或恢复码', 400)
    }

    const auditBase = {
      actionType: 'auth.login',
      actionLabel: '用户登录',
      targetType: 'session',
      targetId: ticket.userId,
      targetCode: ticket.username,
      resultStatus: 'failed' as const,
      requestMeta,
    }
    if (outcome.factor.reason === 'secret_unreadable') {
      await auditService.safeRecord({ ...auditBase, detail: { reason: 'mfa_secret_unreadable' } })
      throw new BizError('两步验证数据无法解密，请联系管理员重置两步验证', 409, { reason: MFA_TICKET_EXPIRED_REASON })
    }

    const attemptsLeft = ticket.attemptsLeft - 1
    if (attemptsLeft > 0) {
      mfaLoginTicketStore.set(ticketId, { ...ticket, attemptsLeft })
    }
    await authSecurityService.recordAdminLoginFailure(requestMeta, ticket.username)
    await auditService.safeRecord({ ...auditBase, detail: { reason: 'mfa_code_mismatch', attemptsLeft } })
    if (attemptsLeft > 0) {
      throw new BizError('动态码或恢复码不正确', 401, { reason: 'ADMIN_MFA_CODE_INVALID', attemptsLeft })
    }
    throw new BizError('验证失败次数过多，请重新输入账号和密码', 401, { reason: MFA_TICKET_EXPIRED_REASON })
  }

  async logout(auth: AuthUserContext, requestMeta?: RequestMeta): Promise<void> {
    await runInTransaction(async (manager) => {
      const sessionRepo = manager.getRepository(SysUserSession)
      const sessionTokenHash = hashSessionToken(auth.sessionToken)
      const existedSession = await sessionRepo.findOne({
        where: { sessionToken: sessionTokenHash },
      })

      if (existedSession) {
        await sessionRepo.delete({ id: existedSession.id })
      }

      await auditService.record(
        {
          actionType: 'auth.logout',
          actionLabel: '用户退出登录',
          targetType: 'session',
          targetId: existedSession?.id ?? null,
          targetCode: auth.username,
          actor: {
            userId: auth.userId,
            username: auth.username,
            displayName: auth.displayName,
          },
          requestMeta,
        },
        manager,
      )
    })
    customerServiceRealtimeService.disconnectBySessionHash('service', hashSessionToken(auth.sessionToken))
  }

  async me(auth: AuthUserContext): Promise<UserSafeProfile> {
    const user = await this.userRepo.findOne({ where: { id: auth.userId } })
    if (!user) {
      throw new BizError('当前用户不存在', 404)
    }
    return toSafeProfile(user)
  }

  /**
   * 本人修改密码：
   * - 必须先校验旧密码，避免仅凭当前会话即可静默改密；
   * - 修改成功后作废该账号全部会话，强制使用新密码重新登录；
   * - 成功与失败都会写入审计日志，形成完整安全留痕。
   */
  async changeOwnPassword(auth: AuthUserContext, input: ChangeOwnPasswordInput, requestMeta?: RequestMeta): Promise<void> {
    const currentPassword = input.currentPassword.trim()
    const newPassword = assertAdminPasswordPolicy(input.newPassword, '新密码', { identifiers: [auth.username] })

    if (!currentPassword || !newPassword) {
      throw new BizError('当前密码和新密码不能为空', 400)
    }
    if (currentPassword === newPassword) {
      throw new BizError('新密码不能与当前密码相同', 400)
    }
    // 旧密码复核与登录共用失败锁定：会话被劫持时不能借改密接口无限试错当前密码。
    await authSecurityService.assertAdminPasswordReauthAllowed(requestMeta, auth.username)

    let result: { changed: boolean; userId: string }
    try {
      result = await runInTransaction(async (manager) => {
        await lockActiveSysAccountForBusiness(manager, auth.userId)
        const userRepo = manager.getRepository(SysUser)
        const sessionRepo = manager.getRepository(SysUserSession)
        const user = await userRepo
          .createQueryBuilder('user')
          .addSelect('user.passwordHash')
          .where('user.id = :id', { id: auth.userId })
          .getOne()

        if (!user) {
          throw new BizError('当前用户不存在', 404)
        }

        const passwordMatched = await verifyPassword(currentPassword, user.passwordHash)
        if (!passwordMatched) {
          await auditService.record(
            {
              actionType: 'auth.change_password',
              actionLabel: '本人修改密码',
              targetType: 'user',
              targetId: user.id,
              targetCode: user.username,
              actor: {
                userId: user.id,
                username: user.username,
                displayName: user.displayName,
              },
              resultStatus: 'failed',
              requestMeta,
              detail: {
                reason: 'current_password_mismatch',
              },
            },
            manager,
          )
          return { changed: false, userId: user.id }
        }

        user.passwordHash = await hashPassword(newPassword)
        await userRepo.save(user)

        const deletedSessions = await sessionRepo.delete({ userId: user.id })

        await auditService.record(
          {
            actionType: 'auth.change_password',
            actionLabel: '本人修改密码',
            targetType: 'user',
            targetId: user.id,
            targetCode: user.username,
            actor: {
              userId: user.id,
              username: user.username,
              displayName: user.displayName,
            },
            requestMeta,
            detail: {
              revokedSessionCount: deletedSessions.affected ?? 0,
            },
          },
          manager,
        )
        return { changed: true, userId: user.id }
      })
    } catch (error) {
      if (error instanceof BizError && /(系统账号不存在|账号已停用或已注销|当前用户不存在)/.test(error.message)) {
        await auditService.safeRecord({
          actionType: 'auth.change_password',
          actionLabel: '本人修改密码',
          targetType: 'user',
          targetId: auth.userId,
          targetCode: auth.username,
          actor: {
            userId: auth.userId,
            username: auth.username,
            displayName: auth.displayName,
          },
          resultStatus: 'failed',
          requestMeta,
          detail: {
            reason: 'account_inactive_or_missing',
            statusCode: error.statusCode,
          },
        })
      }
      throw error
    }

    if (!result.changed) {
      // 事务外计数，避免在 SQLite 单写者事务内再写风控状态。
      await authSecurityService.recordAdminLoginFailure(requestMeta, auth.username)
      throw new BizError('当前密码错误', 400)
    }
    customerServiceRealtimeService.disconnectByOwner('service', result.userId)
  }

  /**
   * 敏感操作前的本人密码复核（step-up，ASVS 5.0 V6/V7 “敏感操作前重新认证”）：
   * - 会话被劫持时，攻击者不知道当前密码就无法执行全量导出等高风险操作；
   * - 与登录共用“来源 + 账号”失败计数与临时锁定，复核接口不能被当成在线猜密码的通道；
   * - 失败统一返回 400（不是 401），避免前端把复核失败误判为会话失效而跳转登录页；
   * - 审计只记录用途与失败原因，任何情况下都不记录提交的密码。
   */
  async verifyStepUpPassword(
    auth: AuthUserContext,
    password: string,
    requestMeta: RequestMeta | undefined,
    purpose: string,
  ): Promise<void> {
    const normalizedPassword = password.trim()
    if (!normalizedPassword) {
      throw new BizError('请输入当前登录密码完成身份复核', 400)
    }
    await authSecurityService.assertAdminPasswordReauthAllowed(requestMeta, auth.username)
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id: auth.userId })
      .getOne()
    if (!user || user.status !== 'enabled') {
      throw new BizError('当前账号已停用，请联系管理员', 403)
    }
    if (await verifyPassword(normalizedPassword, user.passwordHash)) {
      return
    }
    await authSecurityService.recordAdminLoginFailure(requestMeta, user.username)
    await auditService.safeRecord({
      actionType: 'auth.step_up',
      actionLabel: '敏感操作身份复核',
      targetType: 'user',
      targetId: user.id,
      targetCode: user.username,
      actor: {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
      },
      resultStatus: 'failed',
      requestMeta,
      detail: {
        purpose,
        reason: 'password_mismatch',
      },
    })
    throw new BizError('当前密码错误，身份复核未通过', 400)
  }

  async resolveAuthUserByToken(sessionToken: string): Promise<AuthUserContext> {
    const now = new Date()
    const sessionTokenHash = hashSessionToken(sessionToken)
    const session = await this.sessionRepo.findOne({
      where: {
        sessionToken: sessionTokenHash,
        expiresAt: MoreThan(now),
      },
    })

    if (!session) {
      throw new BizError('登录状态已失效，请重新登录', 401)
    }
    // 空闲超时：遗留在公共设备上的管理端会话不能凭 7 天绝对时效长期可用。
    if (isAdminSessionIdleExpired(session, now)) {
      await this.sessionRepo.delete({ id: session.id })
      customerServiceRealtimeService.disconnectBySessionHash('service', sessionTokenHash)
      throw new BizError('登录已因长时间未操作失效，请重新登录', 401)
    }

    const user = await this.userRepo.findOne({ where: { id: session.userId } })
    if (!user) {
      await this.sessionRepo.delete({ id: session.id })
      throw new BizError('登录状态无效，请重新登录', 401)
    }

    if (user.status !== 'enabled') {
      await this.sessionRepo.delete({ id: session.id })
      throw new BizError('当前账号已停用，请联系管理员', 403)
    }

    return {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      permissions: resolvePermissionsByRole(user.role),
      status: user.status,
      sessionToken,
      // 认证来源由中间件根据“本次请求从 Cookie 还是 Bearer 进入”最终覆写。
      authSource: 'bearer',
    }
  }

  /**
   * 会话活跃时间写入节流：
   * - 管理端每个请求都可能走鉴权链路，若每次都更新 last_access_at，会在 SQLite 下产生额外写压；
   * - 仅当上次活跃时间超过最小间隔时才写库，兼顾在线状态准确性和并发稳定性。
   */
  async touchSessionActivity(sessionToken: string, minIntervalMs = 60_000): Promise<void> {
    const now = new Date()
    const threshold = new Date(now.getTime() - Math.max(1_000, minIntervalMs))
    const sessionTokenHash = hashSessionToken(sessionToken)
    await this.sessionRepo
      .createQueryBuilder()
      .update(SysUserSession)
      .set({ lastAccessAt: now })
      .where('session_token = :sessionToken', { sessionToken: sessionTokenHash })
      .andWhere('(last_access_at IS NULL OR last_access_at < :threshold)', { threshold })
      .execute()
  }

  async ensureDefaultAdmin(): Promise<{
    initialized: boolean
    username: string
    displayName: string
    usedPrivateBootstrapPassword: boolean
    rotatedLegacyDefaultPassword: boolean
  }> {
    const existedAdmin = await this.findUserWithPasswordByUsername(env.INIT_ADMIN_USERNAME)

    if (existedAdmin) {
      const stillUsingLegacyDefaultPassword = await verifyPassword(
        LEGACY_DEFAULT_BOOTSTRAP_PASSWORD,
        existedAdmin.passwordHash,
      )

      if (stillUsingLegacyDefaultPassword) {
        const privateBootstrapPassword = this.resolvePrivateBootstrapPassword()
        existedAdmin.passwordHash = await hashPassword(privateBootstrapPassword)
        const savedUser = await this.userRepo.save(existedAdmin)
        await auditService.safeRecord({
          actionType: 'user.bootstrap_admin.rotate_legacy_password',
          actionLabel: '迁移默认管理员历史默认口令',
          targetType: 'user',
          targetId: savedUser.id,
          targetCode: savedUser.username,
          actor: {
            userId: savedUser.id,
            username: savedUser.username,
            displayName: savedUser.displayName,
          },
          detail: {
            reason: 'legacy_default_password_detected',
          },
        })
        return {
          initialized: false,
          username: savedUser.username,
          displayName: savedUser.displayName,
          usedPrivateBootstrapPassword: true,
          rotatedLegacyDefaultPassword: true,
        }
      }

      return {
        initialized: false,
        username: existedAdmin.username,
        displayName: existedAdmin.displayName,
        usedPrivateBootstrapPassword: false,
        rotatedLegacyDefaultPassword: false,
      }
    }

    const privateBootstrapPassword = this.resolvePrivateBootstrapPassword()
    const passwordHash = await hashPassword(privateBootstrapPassword)
    const user = this.userRepo.create({
      username: env.INIT_ADMIN_USERNAME,
      passwordHash,
      displayName: env.INIT_ADMIN_DISPLAY_NAME,
      role: 'admin',
      status: 'enabled',
    })
    const savedUser = await this.userRepo.save(user)

    await auditService.safeRecord({
      actionType: 'user.bootstrap_admin',
      actionLabel: '初始化默认管理员',
      targetType: 'user',
      targetId: savedUser.id,
      targetCode: savedUser.username,
      actor: {
        userId: savedUser.id,
        username: savedUser.username,
        displayName: savedUser.displayName,
      },
      detail: {
        role: savedUser.role,
        status: savedUser.status,
      },
    })

    return {
      initialized: true,
      username: savedUser.username,
      displayName: savedUser.displayName,
      usedPrivateBootstrapPassword: true,
      rotatedLegacyDefaultPassword: false,
    }
  }

  /**
   * 解析管理员初始化私有密码：
   * - 未配置时，不再回退到任何内置默认密码；
   * - 若仍配置历史默认口令，启动阶段直接拒绝，避免再次写入弱凭证。
   */
  private resolvePrivateBootstrapPassword(): string {
    const configuredPassword = env.INIT_ADMIN_PASSWORD?.trim()
    if (!configuredPassword) {
      throw new Error('管理员初始化需要私有配置 `INIT_ADMIN_PASSWORD`，当前未检测到可用值。')
    }
    if (configuredPassword === LEGACY_DEFAULT_BOOTSTRAP_PASSWORD) {
      throw new Error('禁止继续使用历史默认管理员口令，请将 `INIT_ADMIN_PASSWORD` 设置为私有强密码。')
    }
    return assertAdminPasswordPolicy(configuredPassword, '管理员初始密码')
  }
}

export const authService = new AuthService()
export const sanitizeUserProfile = toSafeProfile
