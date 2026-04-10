/**
 * 模块说明：backend/src/services/user.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { AppDataSource } from '../config/data-source.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import type { AuthUserContext, UserRole, UserSafeProfile, UserStatus } from '../types/auth.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { hashPassword } from '../utils/password.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { sanitizeUserProfile } from './auth.service.js'

export interface UserListQuery {
  page: number
  pageSize: number
  keyword?: string
  role?: UserRole
  status?: UserStatus
}

export interface CreateUserInput {
  username: string
  password: string
  displayName: string
  role: UserRole
  status?: UserStatus
}

export interface UpdateUserInput {
  displayName?: string
  role?: UserRole
  password?: string
}

/**
 * 管理员重置他人密码入参：
 * - newPassword 为目标用户的新密码；
 * - 仅管理员可调用，且不会记录任何明文密码到审计日志。
 */
export interface ResetUserPasswordInput {
  newPassword: string
}

const USERNAME_UNIQUE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_sys_user_username',
  sqliteColumns: ['sys_user.username'],
} as const

/**
 * 用户管理服务：
 * - 提供用户列表、创建、编辑与启停；
 * - 所有变更动作均同步写入审计日志，形成可追溯链路。
 */
export class UserService {
  private readonly userRepo = AppDataSource.getRepository(SysUser)

  async list(query: UserListQuery): Promise<{ page: number; pageSize: number; total: number; list: UserSafeProfile[] }> {
    const qb = this.userRepo.createQueryBuilder('user')

    if (query.keyword?.trim()) {
      qb.andWhere('(user.username LIKE :keyword OR user.displayName LIKE :keyword)', {
        keyword: `%${query.keyword.trim()}%`,
      })
    }
    if (query.role) {
      qb.andWhere('user.role = :role', { role: query.role })
    }
    if (query.status) {
      qb.andWhere('user.status = :status', { status: query.status })
    }

    const [list, total] = await qb
      .orderBy('user.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: list.map(sanitizeUserProfile),
    }
  }

  async create(input: CreateUserInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<UserSafeProfile> {
    const username = input.username.trim()
    const displayName = input.displayName.trim()
    const password = input.password.trim()

    if (!username) {
      throw new BizError('账号不能为空', 400)
    }
    if (!displayName) {
      throw new BizError('姓名不能为空', 400)
    }
    if (password.length < 6) {
      throw new BizError('密码长度至少为 6 位', 400)
    }

    try {
      return await AppDataSource.transaction(async (manager) => {
        const userRepo = manager.getRepository(SysUser)
        const passwordHash = await hashPassword(password)
        const entity = userRepo.create({
          username,
          passwordHash,
          displayName,
          role: input.role,
          status: input.status ?? 'enabled',
        })
        const savedUser = await userRepo.save(entity)

        await auditService.record(
          {
            actionType: 'user.create',
            actionLabel: '创建用户',
            targetType: 'user',
            targetId: savedUser.id,
            targetCode: savedUser.username,
            actor,
            requestMeta,
            detail: {
              role: savedUser.role,
              status: savedUser.status,
              displayName: savedUser.displayName,
            },
          },
          manager,
        )

        return sanitizeUserProfile(savedUser)
      })
    } catch (error) {
      if (isUniqueConstraintError(error, USERNAME_UNIQUE_CONSTRAINT_MATCHER)) {
        throw new BizError('账号已存在，请更换后重试', 409)
      }
      throw error
    }
  }

  async update(id: string, input: UpdateUserInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<UserSafeProfile> {
    const normalizedDisplayName = input.displayName?.trim()
    const normalizedPassword = input.password?.trim()

    if (
      normalizedDisplayName === undefined &&
      input.role === undefined &&
      normalizedPassword === undefined
    ) {
      throw new BizError('至少提供一项可更新字段', 400)
    }

    if (normalizedDisplayName !== undefined && !normalizedDisplayName) {
      throw new BizError('姓名不能为空', 400)
    }
    if (normalizedPassword !== undefined && normalizedPassword.length < 6) {
      throw new BizError('密码长度至少为 6 位', 400)
    }

    return AppDataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(SysUser)
      const user = await userRepo.findOne({ where: { id } })
      if (!user) {
        throw new BizError('用户不存在', 404)
      }

      if (actor.userId === user.id && input.role && input.role !== 'admin') {
        throw new BizError('不能将当前登录管理员降级为普通操作员', 400)
      }

      const changeSummary: Record<string, string | null> = {}

      if (normalizedDisplayName !== undefined && normalizedDisplayName !== user.displayName) {
        changeSummary.displayNameBefore = user.displayName
        changeSummary.displayNameAfter = normalizedDisplayName
        user.displayName = normalizedDisplayName
      }
      if (input.role && input.role !== user.role) {
        changeSummary.roleBefore = user.role
        changeSummary.roleAfter = input.role
        user.role = input.role
      }
      if (normalizedPassword !== undefined) {
        user.passwordHash = await hashPassword(normalizedPassword)
        changeSummary.passwordReset = 'true'
      }

      const savedUser = await userRepo.save(user)
      await auditService.record(
        {
          actionType: 'user.update',
          actionLabel: '编辑用户',
          targetType: 'user',
          targetId: savedUser.id,
          targetCode: savedUser.username,
          actor,
          requestMeta,
          detail: changeSummary,
        },
        manager,
      )

      return sanitizeUserProfile(savedUser)
    })
  }

  async updateStatus(
    id: string,
    status: UserStatus,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<UserSafeProfile> {
    return AppDataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(SysUser)
      const user = await userRepo.findOne({ where: { id } })
      if (!user) {
        throw new BizError('用户不存在', 404)
      }

      if (actor.userId === user.id && status !== 'enabled') {
        throw new BizError('不能停用当前登录账号', 400)
      }

      if (user.status === status) {
        return sanitizeUserProfile(user)
      }

      const previousStatus = user.status
      user.status = status
      const savedUser = await userRepo.save(user)

      if (status !== 'enabled') {
        await manager.getRepository(SysUserSession).delete({ userId: savedUser.id })
      }

      await auditService.record(
        {
          actionType: 'user.update_status',
          actionLabel: status === 'enabled' ? '启用用户' : '停用用户',
          targetType: 'user',
          targetId: savedUser.id,
          targetCode: savedUser.username,
          actor,
          requestMeta,
          detail: {
            statusBefore: previousStatus,
            statusAfter: savedUser.status,
          },
        },
        manager,
      )

      return sanitizeUserProfile(savedUser)
    })
  }

  /**
   * 管理员重置他人密码：
   * - 仅用于管理员处理“忘记密码/交接账号”等治理场景；
   * - 重置后立即作废目标账号全部会话，防止旧会话继续使用；
   * - 与通用编辑接口分离，便于单独审计“谁重置了谁的密码”。
   */
  async resetPassword(
    id: string,
    input: ResetUserPasswordInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<UserSafeProfile> {
    const newPassword = input.newPassword.trim()

    if (!newPassword) {
      throw new BizError('新密码不能为空', 400)
    }
    if (newPassword.length < 6) {
      throw new BizError('新密码长度至少为 6 位', 400)
    }
    if (actor.userId === id) {
      throw new BizError('请使用本人修改密码入口处理自己的密码', 400)
    }

    return AppDataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(SysUser)
      const sessionRepo = manager.getRepository(SysUserSession)
      const user = await userRepo.findOne({ where: { id } })
      if (!user) {
        throw new BizError('用户不存在', 404)
      }

      user.passwordHash = await hashPassword(newPassword)
      const savedUser = await userRepo.save(user)
      const deletedSessions = await sessionRepo.delete({ userId: savedUser.id })

      await auditService.record(
        {
          actionType: 'user.reset_password',
          actionLabel: '管理员重置密码',
          targetType: 'user',
          targetId: savedUser.id,
          targetCode: savedUser.username,
          actor,
          requestMeta,
          detail: {
            revokedSessionCount: deletedSessions.affected ?? 0,
            displayName: savedUser.displayName,
          },
        },
        manager,
      )

      return sanitizeUserProfile(savedUser)
    })
  }
}

export const userService = new UserService()
