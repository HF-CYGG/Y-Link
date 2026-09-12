/**
 * 文件说明：该文件负责后台用户管理服务，统一处理系统用户的查询、创建、编辑、启停和管理员代重置密码等治理动作。
 * 实现逻辑：
 * 1. 以系统用户表和会话表为核心，维护后台账号的基础资料、角色状态与安全属性；
 * 2. 在新增与更新流程中集中做用户名、邮箱和密码策略校验，避免各入口重复实现用户治理规则；
 * 3. 所有敏感变更都会联动审计日志记录，保证后台人员管理动作具备可追溯性。
 */

import type { EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { resolvePermissionsByRole, type PermissionCode } from '../constants/auth-permissions.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import { AccountLifecycleEvent } from '../entities/account-lifecycle-event.entity.js'
import { BizInboundOrder } from '../entities/biz-inbound-order.entity.js'
import { ClientFeedbackConversation } from '../entities/client-feedback-conversation.entity.js'
import { ClientFeedbackMessage } from '../entities/client-feedback-message.entity.js'
import { NotificationInbox } from '../entities/notification-inbox.entity.js'
import { NotificationRule } from '../entities/notification-rule.entity.js'
import type { AuthUserContext, UserRole, UserSafeProfile, UserStatus } from '../types/auth.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { assertAdminPasswordPolicy, hashPassword } from '../utils/password.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { assertPermanentDeletePassword } from '../utils/permanent-delete-password.js'
import { auditService } from './audit.service.js'
import { sanitizeUserProfile } from './auth.service.js'
import { customerServiceRealtimeService } from './customer-service-realtime.service.js'
import { isAccountCurrentlyDeactivated, lockSysAccountsInStableOrder } from './account-business-guard.service.js'

export interface UserListQuery {
  page: number
  pageSize: number
  keyword?: string
  role?: UserRole
  status?: UserStatus
  accountState?: UserSafeProfile['accountState']
}

export interface CreateUserInput {
  username: string
  password: string
  displayName: string
  email?: string
  role: UserRole
  status?: UserStatus
}

export interface UpdateUserInput {
  displayName?: string
  email?: string
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

export interface AccountLifecycleReasonInput {
  reason: string
}

export interface AccountPermanentDeleteInput extends AccountLifecycleReasonInput {
  confirmAccount: string
  permanentDeletePassword?: string
}

export interface AccountLifecycleBlocker {
  code: string
  message: string
  count: number
}

export interface UserLifecyclePreview {
  domain: 'sys_user'
  accountId: string
  account: string
  accountState: UserSafeProfile['accountState']
  canDeactivate: boolean
  canRestore: boolean
  canPermanentDelete: boolean
  blockers: AccountLifecycleBlocker[]
  referenceSummary: Record<string, number>
}

const USERNAME_UNIQUE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_sys_user_username',
  sqliteColumns: ['sys_user.username'],
} as const

const EMAIL_UNIQUE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_sys_user_email',
  sqliteColumns: ['sys_user.email'],
} as const

const EMAIL_REGEXP = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isCurrentlyDeactivated = (user: Pick<SysUser, 'deactivatedAt' | 'restoredAt'>) => (
  (user.deactivatedAt?.getTime() ?? 0) > (user.restoredAt?.getTime() ?? 0)
)

const maskAccountIdentifier = (value: string): string => {
  const normalized = value.trim()
  if (/^1\d{10}$/.test(normalized)) return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`
  const atIndex = normalized.indexOf('@')
  if (atIndex > 0) return `${normalized.slice(0, 1)}***${normalized.slice(atIndex)}`
  if (normalized.length <= 2) return '*'.repeat(Math.max(1, normalized.length))
  return `${normalized.slice(0, 1)}***${normalized.slice(-1)}`
}

const parseUserIds = (value: string | null | undefined): string[] => {
  try {
    const parsed = JSON.parse(value || '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * 用户管理服务：
 * - 提供用户列表、创建、编辑与启停；
 * - 所有变更动作均同步写入审计日志，形成可追溯链路。
 */
export class UserService {
  private readonly userRepo = AppDataSource.getRepository(SysUser)

  private normalizeEmail(email: string | undefined): string | null {
    const normalized = (email ?? '').trim().toLowerCase()
    if (!normalized) {
      return null
    }
    if (normalized.length > 128) {
      throw new BizError('邮箱长度不能超过 128 个字符', 400)
    }
    if (!EMAIL_REGEXP.test(normalized)) {
      throw new BizError('邮箱格式不正确', 400)
    }
    return normalized
  }

  private normalizeLifecycleReason(reason: string, label: string): string {
    const normalized = reason.trim()
    if (normalized.length < 2) throw new BizError(`请填写${label}原因（至少 2 个字符）`, 400)
    if (normalized.length > 500) throw new BizError(`${label}原因不能超过 500 个字符`, 400)
    return normalized
  }

  private async findLifecycleUser(manager: EntityManager, id: string, lock = false): Promise<SysUser | null> {
    const query = manager.getRepository(SysUser).createQueryBuilder('user').where('user.id = :id', { id })
    if (lock && manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
    return query.getOne()
  }

  private assertLifecycleActor(user: SysUser | undefined, requiredPermission: PermissionCode): SysUser {
    if (
      !user
      || user.status !== 'enabled'
      || isAccountCurrentlyDeactivated(user)
      || user.role !== 'admin'
      || !resolvePermissionsByRole(user.role).includes(requiredPermission)
    ) {
      throw new BizError('当前管理员账号已失效或权限不足', 403)
    }
    return user
  }

  private async lockLifecycleActorAndTarget(
    manager: EntityManager,
    targetId: string,
    actor: AuthUserContext,
    requiredPermission: PermissionCode,
  ): Promise<SysUser> {
    const accounts = await lockSysAccountsInStableOrder(manager, [actor.userId, targetId])
    this.assertLifecycleActor(accounts.get(String(actor.userId)), requiredPermission)
    const target = accounts.get(String(targetId))
    if (!target) throw new BizError('用户不存在', 404)
    return target
  }

  private async buildReferenceSummary(manager: EntityManager, userId: string) {
    const [supplierPending, supplierAll, activeAssignments, assignmentHistory, serviceMessages, notificationInbox] = await Promise.all([
      manager.getRepository(BizInboundOrder).count({ where: { supplierId: userId, status: 'pending', isDeleted: false } }),
      manager.getRepository(BizInboundOrder).count({ where: { supplierId: userId } }),
      manager.getRepository(ClientFeedbackConversation).createQueryBuilder('conversation')
        .where('conversation.assigned_user_id = :userId', { userId })
        .andWhere('conversation.status <> :closed', { closed: 'closed' })
        .getCount(),
      manager.getRepository(ClientFeedbackConversation).createQueryBuilder('conversation')
        .where('conversation.assigned_user_id = :userId OR conversation.internal_remark_by_user_id = :userId', { userId })
        .getCount(),
      manager.getRepository(ClientFeedbackMessage).count({ where: { senderUserId: userId, senderType: 'service' } }),
      manager.getRepository(NotificationInbox).count({ where: { userId } }),
    ])
    const rules = await manager.getRepository(NotificationRule).find()
    const notificationResponsibilities = rules.filter((rule) => [
      ...parseUserIds(rule.recipientUserIdsJson),
      ...parseUserIds(rule.emailRecipientAdminUserIdsJson),
      ...parseUserIds(rule.emailRecipientSupplierUserIdsJson),
      ...parseUserIds(rule.watchedUserIdsJson),
    ].includes(userId)).length
    return {
      supplierPending,
      supplierAll,
      activeAssignments,
      assignmentHistory,
      serviceMessages,
      notificationResponsibilities,
      notificationInbox,
    }
  }

  private async buildLifecyclePreview(
    manager: EntityManager,
    user: SysUser,
    actor: AuthUserContext,
  ): Promise<UserLifecyclePreview> {
    const referenceSummary = await this.buildReferenceSummary(manager, user.id)
    const blockers: AccountLifecycleBlocker[] = []
    if (actor.userId === user.id) blockers.push({ code: 'current_account', message: '不能注销当前登录账号', count: 1 })
    if (user.role === 'admin' && user.status === 'enabled') {
      const enabledAdmins = await manager.getRepository(SysUser).count({ where: { role: 'admin', status: 'enabled' } })
      if (enabledAdmins <= 1) blockers.push({ code: 'last_enabled_admin', message: '该账号是系统中唯一启用的管理员', count: 1 })
    }
    if (referenceSummary.activeAssignments > 0) blockers.push({ code: 'customer_service_assignment', message: '仍有未关闭客服会话需要人工交接', count: referenceSummary.activeAssignments })
    if (referenceSummary.notificationResponsibilities > 0) blockers.push({ code: 'notification_responsibility', message: '仍承担通知接收或离线监测职责，需要人工交接', count: referenceSummary.notificationResponsibilities })
    if (referenceSummary.supplierPending > 0) blockers.push({ code: 'supplier_responsibility', message: '仍有待入库送货单，需要人工交接', count: referenceSummary.supplierPending })

    const deactivated = isCurrentlyDeactivated(user)
    const permanentBlockers = [
      referenceSummary.supplierAll,
      referenceSummary.assignmentHistory,
      referenceSummary.serviceMessages,
      referenceSummary.notificationResponsibilities,
      referenceSummary.notificationInbox,
    ].reduce((sum, count) => sum + count, 0)
    return {
      domain: 'sys_user',
      accountId: user.id,
      account: user.username,
      accountState: deactivated ? 'deactivated' : user.status,
      canDeactivate: !deactivated && blockers.length === 0,
      canRestore: deactivated,
      canPermanentDelete: deactivated && permanentBlockers === 0,
      blockers,
      referenceSummary,
    }
  }

  private async recordLifecycleEvent(
    manager: EntityManager,
    user: SysUser,
    actor: AuthUserContext,
    eventType: 'deactivated' | 'restored' | 'permanently_deleted',
    reason: string,
    referenceSummary: Record<string, number>,
  ): Promise<void> {
    const repository = manager.getRepository(AccountLifecycleEvent)
    await repository.save(repository.create({
      accountDomain: 'sys_user',
      accountIdSnapshot: user.id,
      accountMaskedSnapshot: maskAccountIdentifier(user.username),
      eventType,
      reason,
      actorUserIdSnapshot: actor.userId,
      actorUsernameSnapshot: actor.username,
      actorDisplayNameSnapshot: actor.displayName,
      referenceSummaryJson: JSON.stringify(referenceSummary),
      eventSummaryJson: JSON.stringify({ role: user.role, status: user.status, eventType }),
    }))
  }

  async previewDeactivation(id: string, actor: AuthUserContext): Promise<UserLifecyclePreview> {
    const user = await this.findLifecycleUser(AppDataSource.manager, id)
    if (!user) throw new BizError('用户不存在', 404)
    return this.buildLifecyclePreview(AppDataSource.manager, user, actor)
  }

  async deactivate(
    id: string,
    input: AccountLifecycleReasonInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<UserSafeProfile> {
    const reason = this.normalizeLifecycleReason(input.reason, '注销')
    const result = await runInTransaction(async (manager) => {
      const user = await this.lockLifecycleActorAndTarget(manager, id, actor, 'users:deactivate')
      if (isCurrentlyDeactivated(user)) return { profile: sanitizeUserProfile(user), changed: false }
      const preview = await this.buildLifecyclePreview(manager, user, actor)
      if (!preview.canDeactivate) throw new BizError(preview.blockers.map((item) => item.message).join('；'), 409)

      const now = new Date(Math.max(Date.now(), (user.restoredAt?.getTime() ?? 0) + 1))
      user.status = 'disabled'
      user.deactivatedAt = now
      user.deactivationReason = reason
      user.deactivatedByUserId = actor.userId
      user.deactivatedByUsername = actor.username
      user.deactivatedByDisplayName = actor.displayName
      const saved = await manager.getRepository(SysUser).save(user)
      const revoked = await manager.getRepository(SysUserSession).delete({ userId: user.id })
      await this.recordLifecycleEvent(manager, saved, actor, 'deactivated', reason, {
        ...preview.referenceSummary,
        revokedWebSessions: revoked.affected ?? 0,
      })
      return { profile: sanitizeUserProfile(saved), changed: true }
    })
    if (result.changed) {
      customerServiceRealtimeService.disconnectByOwner('service', id)
      await auditService.safeRecord({
        actionType: 'user.deactivate', actionLabel: '注销管理端用户', targetType: 'user', targetId: id,
        targetCode: result.profile.username, actor, requestMeta, detail: { reason },
      })
    }
    return result.profile
  }

  async restore(
    id: string,
    input: AccountLifecycleReasonInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<UserSafeProfile> {
    const reason = this.normalizeLifecycleReason(input.reason, '恢复')
    const result = await runInTransaction(async (manager) => {
      const user = await this.lockLifecycleActorAndTarget(manager, id, actor, 'users:deactivate')
      if (!isCurrentlyDeactivated(user)) {
        if (user.restoredAt) return { profile: sanitizeUserProfile(user), changed: false }
        throw new BizError('账号当前未处于已注销状态', 409)
      }
      const referenceSummary = await this.buildReferenceSummary(manager, user.id)
      user.status = 'disabled'
      user.restoredAt = new Date(Math.max(Date.now(), (user.deactivatedAt?.getTime() ?? 0) + 1))
      user.restoredByUserId = actor.userId
      user.restoredByUsername = actor.username
      user.restoredByDisplayName = actor.displayName
      const saved = await manager.getRepository(SysUser).save(user)
      await this.recordLifecycleEvent(manager, saved, actor, 'restored', reason, referenceSummary)
      return { profile: sanitizeUserProfile(saved), changed: true }
    })
    if (result.changed) {
      await auditService.safeRecord({
        actionType: 'user.restore', actionLabel: '恢复管理端用户', targetType: 'user', targetId: id,
        targetCode: result.profile.username, actor, requestMeta, detail: { reason, statusAfter: 'disabled' },
      })
    }
    return result.profile
  }

  async permanentDelete(
    id: string,
    input: AccountPermanentDeleteInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ deleted: true; accountId: string; accountMasked: string }> {
    const reason = this.normalizeLifecycleReason(input.reason, '永久删除')
    try {
      assertPermanentDeletePassword(input.permanentDeletePassword)
      const result = await runInTransaction(async (manager) => {
        const user = await this.lockLifecycleActorAndTarget(manager, id, actor, 'users:permanent_delete')
        if (!isCurrentlyDeactivated(user)) throw new BizError('仅允许永久删除已注销账号', 409)
        if (input.confirmAccount !== user.username) throw new BizError('确认账号与目标账号不一致', 400)
        const preview = await this.buildLifecyclePreview(manager, user, actor)
        const references = preview.referenceSummary
        const criticalCount = references.supplierAll
          + references.assignmentHistory
          + references.serviceMessages
          + references.notificationResponsibilities
          + references.notificationInbox
        if (criticalCount > 0) throw new BizError('账号仍存在关键业务关联，请先完成人工交接或保留账号', 409)

        const sessions = await manager.getRepository(SysUserSession).delete({ userId: user.id })
        await this.recordLifecycleEvent(manager, user, actor, 'permanently_deleted', reason, {
          ...references,
          removedWebSessions: sessions.affected ?? 0,
        })
        await manager.getRepository(SysUser).delete({ id: user.id })
        return { deleted: true as const, accountId: user.id, accountMasked: maskAccountIdentifier(user.username) }
      })
      customerServiceRealtimeService.disconnectByOwner('service', id)
      await auditService.safeRecord({
        actionType: 'user.permanent_delete', actionLabel: '永久删除管理端用户', targetType: 'user', targetId: id,
        targetCode: result.accountMasked, actor, requestMeta, detail: { reason },
      })
      return result
    } catch (error) {
      await auditService.safeRecord({
        actionType: 'user.permanent_delete', actionLabel: '永久删除管理端用户（失败）', targetType: 'user', targetId: id,
        actor, requestMeta, resultStatus: 'failed', detail: { reason: 'request_rejected' },
      })
      throw error
    }
  }

  async list(query: UserListQuery): Promise<{ page: number; pageSize: number; total: number; list: UserSafeProfile[] }> {
    const qb = this.userRepo.createQueryBuilder('user')

    if (query.keyword?.trim()) {
      qb.andWhere('(user.username LIKE :keyword OR user.displayName LIKE :keyword OR user.email LIKE :keyword)', {
        keyword: `%${query.keyword.trim()}%`,
      })
    }
    if (query.role) {
      qb.andWhere('user.role = :role', { role: query.role })
    }
    if (query.status) {
      qb.andWhere('user.status = :status', { status: query.status })
    }
    if (query.accountState === 'deactivated') {
      qb.andWhere('user.deactivatedAt IS NOT NULL AND (user.restoredAt IS NULL OR user.deactivatedAt > user.restoredAt)')
    } else if (query.accountState === 'enabled') {
      qb.andWhere('user.status = :enabledAccountState', { enabledAccountState: 'enabled' })
      qb.andWhere('(user.deactivatedAt IS NULL OR (user.restoredAt IS NOT NULL AND user.deactivatedAt <= user.restoredAt))')
    } else if (query.accountState === 'disabled') {
      qb.andWhere('user.status = :disabledAccountState', { disabledAccountState: 'disabled' })
      qb.andWhere('(user.deactivatedAt IS NULL OR (user.restoredAt IS NOT NULL AND user.deactivatedAt <= user.restoredAt))')
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
    const email = this.normalizeEmail(input.email)
    const password = assertAdminPasswordPolicy(input.password)

    if (!username) {
      throw new BizError('账号不能为空', 400)
    }
    if (!displayName) {
      throw new BizError('姓名不能为空', 400)
    }
    try {
      return await runInTransaction(async (manager) => {
        const userRepo = manager.getRepository(SysUser)
        const passwordHash = await hashPassword(password)
        const entity = userRepo.create({
          username,
          passwordHash,
          displayName,
          email,
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
      if (isUniqueConstraintError(error, EMAIL_UNIQUE_CONSTRAINT_MATCHER)) {
        throw new BizError('邮箱已被其他账号使用', 409)
      }
      throw error
    }
  }

  async update(id: string, input: UpdateUserInput, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<UserSafeProfile> {
    const normalizedDisplayName = input.displayName?.trim()
    const normalizedEmail = input.email === undefined ? undefined : this.normalizeEmail(input.email)
    const normalizedPassword = input.password === undefined ? undefined : assertAdminPasswordPolicy(input.password)

    if (
      normalizedDisplayName === undefined &&
      normalizedEmail === undefined &&
      input.role === undefined &&
      normalizedPassword === undefined
    ) {
      throw new BizError('至少提供一项可更新字段', 400)
    }

    if (normalizedDisplayName !== undefined && !normalizedDisplayName) {
      throw new BizError('姓名不能为空', 400)
    }
    try {
      const result = await runInTransaction(async (manager) => {
        const userRepo = manager.getRepository(SysUser)
        const sessionRepo = manager.getRepository(SysUserSession)
        const user = await userRepo.findOne({ where: { id } })
        if (!user) {
          throw new BizError('用户不存在', 404)
        }
        if (isCurrentlyDeactivated(user)) {
          throw new BizError('账号已注销，请先恢复后再编辑资料', 409)
        }

        if (actor.userId === user.id && input.role && input.role !== 'admin') {
          throw new BizError('不能将当前登录管理员降级为非管理员角色', 400)
        }

        const changeSummary: Record<string, string | null> = {}
        const roleChanged = input.role !== undefined && input.role !== user.role

        if (normalizedDisplayName !== undefined && normalizedDisplayName !== user.displayName) {
          changeSummary.displayNameBefore = user.displayName
          changeSummary.displayNameAfter = normalizedDisplayName
          user.displayName = normalizedDisplayName
        }
        if (normalizedEmail !== undefined && normalizedEmail !== user.email) {
          changeSummary.emailBefore = user.email
          changeSummary.emailAfter = normalizedEmail
          user.email = normalizedEmail
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
        const sessionMustBeRevoked = normalizedPassword !== undefined || roleChanged
        if (sessionMustBeRevoked) {
        /**
         * 安全修复：
         * - 管理端“编辑用户”也允许直接改密码；
         * - 若只更新密码哈希而不清理历史会话，旧 Bearer Token 仍可继续访问；
         * - 因此这里与专门改密接口保持一致，密码变更后立即吊销该账号全部会话。
         */
          const deletedSessions = await sessionRepo.delete({ userId: savedUser.id })
          changeSummary.revokedSessionCount = String(deletedSessions.affected ?? 0)
        }
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

        return { profile: sanitizeUserProfile(savedUser), sessionMustBeRevoked }
      })
      if (result.sessionMustBeRevoked) {
        customerServiceRealtimeService.disconnectByOwner('service', id)
      }
      return result.profile
    } catch (error) {
      if (isUniqueConstraintError(error, EMAIL_UNIQUE_CONSTRAINT_MATCHER)) {
        throw new BizError('邮箱已被其他账号使用', 409)
      }
      throw error
    }
  }

  async updateStatus(
    id: string,
    status: UserStatus,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<UserSafeProfile> {
    const result = await runInTransaction(async (manager) => {
      const userRepo = manager.getRepository(SysUser)
      const user = await userRepo.findOne({ where: { id } })
      if (!user) {
        throw new BizError('用户不存在', 404)
      }

      if (actor.userId === user.id && status !== 'enabled') {
        throw new BizError('不能停用当前登录账号', 400)
      }

      if (status === 'enabled' && isCurrentlyDeactivated(user)) {
        throw new BizError('已注销账号必须先恢复，不能直接启用', 409)
      }

      if (user.status === status) {
        return { profile: sanitizeUserProfile(user), sessionMustBeRevoked: false }
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

      return { profile: sanitizeUserProfile(savedUser), sessionMustBeRevoked: status !== 'enabled' }
    })
    if (result.sessionMustBeRevoked) {
      customerServiceRealtimeService.disconnectByOwner('service', id)
    }
    return result.profile
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
    const newPassword = assertAdminPasswordPolicy(input.newPassword, '新密码')

    if (!newPassword) {
      throw new BizError('新密码不能为空', 400)
    }
    if (actor.userId === id) {
      throw new BizError('请使用本人修改密码入口处理自己的密码', 400)
    }

    const profile = await runInTransaction(async (manager) => {
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
    customerServiceRealtimeService.disconnectByOwner('service', id)
    return profile
  }
}

export const userService = new UserService()
