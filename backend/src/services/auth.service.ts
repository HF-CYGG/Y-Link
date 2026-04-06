import { LessThan, MoreThan } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { env } from '../config/env.js'
import { resolvePermissionsByRole } from '../constants/auth-permissions.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import type { AuthUserContext, UserSafeProfile } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { hashPassword, verifyPassword } from '../utils/password.js'
import { generateSessionToken } from '../utils/token.js'
import { auditService } from './audit.service.js'

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

function toSafeProfile(user: SysUser): UserSafeProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    permissions: resolvePermissionsByRole(user.role),
    status: user.status,
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
   * 按用户 ID 加载带密码哈希的用户：
   * - 供本人改密场景校验旧密码；
   * - 独立方法可避免各处重复书写查询构造逻辑。
   */
  private async findUserWithPasswordById(id: string): Promise<SysUser | null> {
    return this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.id = :id', { id })
      .getOne()
  }

  async login(input: LoginInput, requestMeta?: RequestMeta): Promise<{ token: string; expiresAt: Date; user: UserSafeProfile }> {
    const username = input.username.trim()
    const password = input.password.trim()

    if (!username || !password) {
      throw new BizError('账号和密码不能为空', 400)
    }

    const user = await this.findUserWithPasswordByUsername(username)

    if (!user) {
      await auditService.safeRecord({
        actionType: 'auth.login',
        actionLabel: '用户登录',
        targetType: 'session',
        targetCode: username,
        resultStatus: 'failed',
        requestMeta,
        detail: {
          reason: 'user_not_found',
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
          reason: 'user_disabled',
        },
      })
      throw new BizError('当前账号已停用，请联系管理员', 403)
    }

    const passwordMatched = await verifyPassword(password, user.passwordHash)
    if (!passwordMatched) {
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

    const now = new Date()
    const expiresAt = new Date(now.getTime() + env.AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000)
    const token = generateSessionToken()

    const data = await AppDataSource.transaction(async (manager) => {
      const sessionRepo = manager.getRepository(SysUserSession)
      const userRepo = manager.getRepository(SysUser)

      await sessionRepo.delete({
        expiresAt: LessThan(now),
      })

      user.lastLoginAt = now
      const savedUser = await userRepo.save(user)
      const session = await sessionRepo.save(
        sessionRepo.create({
          sessionToken: token,
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
          },
        },
        manager,
      )

      return {
        token,
        expiresAt,
        user: toSafeProfile(savedUser),
      }
    })

    return data
  }

  async logout(auth: AuthUserContext, requestMeta?: RequestMeta): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      const sessionRepo = manager.getRepository(SysUserSession)
      const existedSession = await sessionRepo.findOne({
        where: { sessionToken: auth.sessionToken },
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
    const newPassword = input.newPassword.trim()

    if (!currentPassword || !newPassword) {
      throw new BizError('当前密码和新密码不能为空', 400)
    }
    if (newPassword.length < 6) {
      throw new BizError('新密码长度至少为 6 位', 400)
    }
    if (currentPassword === newPassword) {
      throw new BizError('新密码不能与当前密码相同', 400)
    }

    const user = await this.findUserWithPasswordById(auth.userId)
    if (!user) {
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
          reason: 'user_not_found',
        },
      })
      throw new BizError('当前用户不存在', 404)
    }

    const passwordMatched = await verifyPassword(currentPassword, user.passwordHash)
    if (!passwordMatched) {
      await auditService.safeRecord({
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
      })
      throw new BizError('当前密码错误', 400)
    }

    await AppDataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(SysUser)
      const sessionRepo = manager.getRepository(SysUserSession)

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
    })
  }

  async resolveAuthUserByToken(sessionToken: string): Promise<AuthUserContext> {
    const now = new Date()
    const session = await this.sessionRepo.findOne({
      where: {
        sessionToken,
        expiresAt: MoreThan(now),
      },
    })

    if (!session) {
      throw new BizError('登录状态已失效，请重新登录', 401)
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
      sessionToken: session.sessionToken,
    }
  }

  async ensureDefaultAdmin(): Promise<{ initialized: boolean; username: string }> {
    const existedAdmin = await this.userRepo.findOne({
      where: { username: env.INIT_ADMIN_USERNAME },
    })

    if (existedAdmin) {
      return {
        initialized: false,
        username: existedAdmin.username,
      }
    }

    const passwordHash = await hashPassword(env.INIT_ADMIN_PASSWORD)
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
    }
  }
}

export const authService = new AuthService()
export const sanitizeUserProfile = toSafeProfile
