/**
 * 模块说明：backend/src/services/client-user-manage.service.ts
 * 文件职责：管理端对客户端用户进行查询、启停与重置密码。
 * 维护说明：
 * - 客户端用户与管理端用户分表治理，避免角色、权限和登录会话语义混用；
 * - 当前仅开放治理侧高频动作，客户端账号创建仍以客户端自助注册为主。
 */

import { AppDataSource } from '../config/data-source.js'
import { CLIENT_USER_STATUSES, type ClientUserStatus, ClientUser } from '../entities/client-user.entity.js'
import { ClientUserSession } from '../entities/client-user-session.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import { hashPassword } from '../utils/password.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { systemConfigService } from './system-config.service.js'

export interface ClientUserListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: ClientUserStatus
}

export interface ResetClientUserPasswordInput {
  newPassword: string
}

export interface UpdateClientUserInput {
  username: string
  mobile?: string
  email?: string
  departmentName?: string
  status: ClientUserStatus
}

export interface ClientUserManageSafeProfile {
  id: string
  account: string
  username: string
  mobile: string
  email: string
  realName: string
  departmentName: string
  status: ClientUserStatus
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const sanitizeClientUserProfile = (user: ClientUser): ClientUserManageSafeProfile => {
  const normalizedUsername = user.realName?.trim() || ''
  const account = normalizedUsername || user.email || user.mobile || ''
  return {
    id: user.id,
    account,
    // 字段口径说明：
    // - `username` 代表客户端用户名，是管理端编辑与展示应优先使用的字段；
    // - `realName` 暂保留为历史兼容别名，当前与 username 保持同值；
    // - `account` 继续保留旧字段，避免旧页面或旧缓存直接断裂。
    username: normalizedUsername,
    mobile: user.mobile ?? '',
    email: user.email ?? '',
    realName: normalizedUsername,
    departmentName: user.departmentName ?? '',
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

export class ClientUserManageService {
  private readonly userRepo = AppDataSource.getRepository(ClientUser)

  private async findUserByAnyIdentifier(account: string) {
    return this.userRepo
      .createQueryBuilder('user')
      .where('user.mobile = :account OR user.email = :account OR user.realName = :account', { account })
      .getOne()
  }

  private normalizeMobile(mobile: string | undefined) {
    const normalized = mobile?.trim() || ''
    if (!normalized) {
      return null
    }
    if (!/^1\d{10}$/.test(normalized)) {
      throw new BizError('手机号格式不正确', 400)
    }
    return normalized
  }

  private normalizeEmail(email: string | undefined) {
    const normalized = email?.trim().toLowerCase() || ''
    if (!normalized) {
      return null
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new BizError('邮箱格式不正确', 400)
    }
    return normalized
  }

  private normalizeUsername(username: string | undefined) {
    const normalized = username?.trim() || ''
    if (!normalized) {
      throw new BizError('用户名不能为空', 400)
    }
    return normalized
  }

  async list(query: ClientUserListQuery): Promise<{
    page: number
    pageSize: number
    total: number
    list: ClientUserManageSafeProfile[]
  }> {
    const qb = this.userRepo.createQueryBuilder('user')

    if (query.keyword?.trim()) {
      qb.andWhere(
        `
          (
            user.mobile LIKE :keyword
            OR user.email LIKE :keyword
            OR user.realName LIKE :keyword
            OR user.departmentName LIKE :keyword
          )
        `,
        { keyword: `%${query.keyword.trim()}%` },
      )
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
      list: list.map(sanitizeClientUserProfile),
    }
  }

  async updateStatus(
    id: string,
    status: ClientUserStatus,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ClientUserManageSafeProfile> {
    if (!CLIENT_USER_STATUSES.includes(status)) {
      throw new BizError('客户端用户状态非法', 400)
    }

    return AppDataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(ClientUser)
      const sessionRepo = manager.getRepository(ClientUserSession)
      const user = await userRepo.findOne({ where: { id } })
      if (!user) {
        throw new BizError('客户端用户不存在', 404)
      }

      if (user.status === status) {
        return sanitizeClientUserProfile(user)
      }

      const previousStatus = user.status
      user.status = status
      const savedUser = await userRepo.save(user)

      if (status !== 'enabled') {
        await sessionRepo.delete({ userId: savedUser.id })
      }

      await auditService.record(
        {
          actionType: 'client_user.update_status',
          actionLabel: status === 'enabled' ? '启用客户端用户' : '停用客户端用户',
          targetType: 'client_user',
          targetId: savedUser.id,
          targetCode: savedUser.email ?? savedUser.mobile ?? savedUser.realName,
          actor,
          requestMeta,
          detail: {
            statusBefore: previousStatus,
            statusAfter: savedUser.status,
            departmentName: savedUser.departmentName,
          },
        },
        manager,
      )

      return sanitizeClientUserProfile(savedUser)
    })
  }

  async updateProfile(
    id: string,
    input: UpdateClientUserInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ClientUserManageSafeProfile> {
    if (!CLIENT_USER_STATUSES.includes(input.status)) {
      throw new BizError('客户端用户状态非法', 400)
    }

    const username = this.normalizeUsername(input.username)
    const mobile = this.normalizeMobile(input.mobile)
    const email = this.normalizeEmail(input.email)
    const departmentName = await systemConfigService.assertClientDepartmentOption(input.departmentName)

    if (!mobile && !email) {
      throw new BizError('手机号和邮箱至少保留一项', 400)
    }

    return AppDataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(ClientUser)
      const sessionRepo = manager.getRepository(ClientUserSession)
      const user = await userRepo.findOne({ where: { id } })
      if (!user) {
        throw new BizError('客户端用户不存在', 404)
      }

      const duplicatedUsernameUser = await this.findUserByAnyIdentifier(username)
      if (duplicatedUsernameUser && duplicatedUsernameUser.id !== user.id) {
        throw new BizError('该用户名已被其他客户端用户使用', 409)
      }

      if (mobile) {
        const duplicatedMobileUser = await this.findUserByAnyIdentifier(mobile)
        if (duplicatedMobileUser && duplicatedMobileUser.id !== user.id) {
          throw new BizError('该手机号已被其他客户端用户使用', 409)
        }
      }
      if (email) {
        const duplicatedEmailUser = await this.findUserByAnyIdentifier(email)
        if (duplicatedEmailUser && duplicatedEmailUser.id !== user.id) {
          throw new BizError('该邮箱已被其他客户端用户使用', 409)
        }
      }

      const before = sanitizeClientUserProfile(user)
      user.realName = username
      user.mobile = mobile
      user.email = email
      user.departmentName = departmentName
      user.status = input.status
      const savedUser = await userRepo.save(user)

      let revokedSessionCount = 0
      if (savedUser.status !== 'enabled') {
        const deletedSessions = await sessionRepo.delete({ userId: savedUser.id })
        revokedSessionCount = deletedSessions.affected ?? 0
      }

      await auditService.record(
        {
          actionType: 'client_user.update_profile',
          actionLabel: '编辑客户端用户资料',
          targetType: 'client_user',
          targetId: savedUser.id,
          targetCode: savedUser.realName || savedUser.email || savedUser.mobile || '',
          actor,
          requestMeta,
          detail: {
            before,
            after: sanitizeClientUserProfile(savedUser),
            revokedSessionCount,
          },
        },
        manager,
      )

      return sanitizeClientUserProfile(savedUser)
    })
  }

  async resetPassword(
    id: string,
    input: ResetClientUserPasswordInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ClientUserManageSafeProfile> {
    const newPassword = input.newPassword.trim()
    if (!newPassword) {
      throw new BizError('新密码不能为空', 400)
    }
    if (newPassword.length < 6) {
      throw new BizError('新密码长度至少为 6 位', 400)
    }

    return AppDataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(ClientUser)
      const sessionRepo = manager.getRepository(ClientUserSession)
      const user = await userRepo
        .createQueryBuilder('user')
        .addSelect('user.passwordHash')
        .where('user.id = :id', { id })
        .getOne()
      if (!user) {
        throw new BizError('客户端用户不存在', 404)
      }

      user.passwordHash = await hashPassword(newPassword)
      const savedUser = await userRepo.save(user)
      const deletedSessions = await sessionRepo.delete({ userId: savedUser.id })

      await auditService.record(
        {
          actionType: 'client_user.reset_password',
          actionLabel: '重置客户端用户密码',
          targetType: 'client_user',
          targetId: savedUser.id,
          targetCode: savedUser.email ?? savedUser.mobile ?? savedUser.realName,
          actor,
          requestMeta,
          detail: {
            departmentName: savedUser.departmentName,
            revokedSessionCount: deletedSessions.affected ?? 0,
          },
        },
        manager,
      )

      return sanitizeClientUserProfile(savedUser)
    })
  }
}

export const clientUserManageService = new ClientUserManageService()
