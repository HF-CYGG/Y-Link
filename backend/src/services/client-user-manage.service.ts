/**
 * 模块说明：backend/src/services/client-user-manage.service.ts
 * 文件职责：管理端对客户端用户进行查询、手动创建、启停与重置密码。
 * 维护说明：
 * - 客户端用户与管理端用户分表治理，避免角色、权限和登录会话语义混用；
 * - 当前仅开放治理侧高频动作，客户端账号创建仍以客户端自助注册为主。
 */

import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import {
  CLIENT_USER_ACCOUNT_TYPES,
  CLIENT_USER_STATUSES,
  type ClientUserAccountType,
  type ClientUserStatus,
  ClientUser,
} from '../entities/client-user.entity.js'
import { ClientStaffDirectory } from '../entities/client-staff-directory.entity.js'
import { ClientUserSession } from '../entities/client-user-session.entity.js'
import { ClientMobileSession } from '../entities/client-mobile-session.entity.js'
import { AccountLifecycleEvent } from '../entities/account-lifecycle-event.entity.js'
import { ClientFeedbackAttachment } from '../entities/client-feedback-attachment.entity.js'
import { ClientFeedbackConversation } from '../entities/client-feedback-conversation.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { O2oReturnRequest } from '../entities/o2o-return-request.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { assertClientPasswordPolicy, hashPassword } from '../utils/password.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { assertPermanentDeletePassword } from '../utils/permanent-delete-password.js'
import { auditService } from './audit.service.js'
import { systemConfigService } from './system-config.service.js'
import type { EntityManager } from 'typeorm'
import { randomBytes } from 'node:crypto'
import { customerServiceRealtimeService } from './customer-service-realtime.service.js'

export interface ClientUserListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: ClientUserStatus
  accountType?: ClientUserAccountType
  profileKind?: ClientUserProfileKind
  departmentName?: string
  staffNo?: string
  accountState?: 'enabled' | 'disabled' | 'deactivated'
}

export interface ResetClientUserPasswordInput {
  newPassword: string
}

export interface CreateClientUserInput {
  profileKind?: ClientUserProfileKind
  username?: string
  mobile?: string
  email?: string
  departmentName?: string
  departmentNodeId?: string
  staffNo?: string
  password: string
  status: ClientUserStatus
}

export interface UpdateClientUserInput {
  username: string
  mobile?: string
  email?: string
  departmentName?: string
  departmentNodeId?: string
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
  departmentNodeId: string | null
  accountType: ClientUserAccountType
  profileKind: ClientUserProfileKind
  staffNo: string | null
  staffVerified: boolean
  status: ClientUserStatus
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
  accountState: 'enabled' | 'disabled' | 'deactivated'
  deactivatedAt: Date | null
  deactivationReason: string | null
  deactivatedByUsername: string | null
  deactivatedByDisplayName: string | null
  restoredAt: Date | null
  restoredByUsername: string | null
  restoredByDisplayName: string | null
}

export interface ClientAccountLifecycleReasonInput {
  reason: string
}

export interface ClientAccountPermanentDeleteInput extends ClientAccountLifecycleReasonInput {
  confirmAccount: string
  permanentDeletePassword?: string
}

export interface ClientAccountLifecyclePreview {
  domain: 'client_user'
  accountId: string
  account: string
  accountState: 'enabled' | 'disabled' | 'deactivated'
  canDeactivate: boolean
  canRestore: boolean
  canPermanentDelete: boolean
  blockers: Array<{ code: string; message: string; count: number }>
  referenceSummary: Record<string, number>
}

export interface DepartmentAccountPreviewInput {
  departmentNodeIds: string[]
}

export interface DepartmentAccountBatchInput {
  status: ClientUserStatus
  items: Array<{
    departmentNodeId: string
    account: string
    initialPassword: string
  }>
}

export interface DepartmentAccountBatchCreatedItem {
  id: string
  departmentNodeId: string
  departmentName: string
  account: string
  status: ClientUserStatus
}

export interface DepartmentAccountBatchSkippedItem {
  id: string
  departmentNodeId: string
  departmentName: string
  account: string
  status: ClientUserStatus
}

export const CLIENT_USER_PROFILE_KINDS = ['personal', 'teacher', 'department'] as const
export type ClientUserProfileKind = (typeof CLIENT_USER_PROFILE_KINDS)[number]

const deriveClientUserProfileKind = (user: Pick<ClientUser, 'accountType' | 'staffNo' | 'staffVerified'>): ClientUserProfileKind => {
  if (user.accountType === 'department') {
    return 'department'
  }
  return user.staffNo?.trim() ? 'teacher' : 'personal'
}

const isCurrentlyDeactivated = (user: Pick<ClientUser, 'deactivatedAt' | 'restoredAt'>) => (
  (user.deactivatedAt?.getTime() ?? 0) > (user.restoredAt?.getTime() ?? 0)
)

const resolveClientAccountState = (user: Pick<ClientUser, 'status' | 'deactivatedAt' | 'restoredAt'>) => (
  isCurrentlyDeactivated(user) ? 'deactivated' as const : user.status
)

const maskClientAccount = (value: string): string => {
  const normalized = value.trim()
  if (/^1\d{10}$/.test(normalized)) return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`
  const atIndex = normalized.indexOf('@')
  if (atIndex > 0) return `${normalized.slice(0, 1)}***${normalized.slice(atIndex)}`
  if (normalized.length <= 2) return '*'.repeat(Math.max(1, normalized.length))
  return `${normalized.slice(0, 1)}***${normalized.slice(-1)}`
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
    departmentNodeId: user.departmentNodeId ?? null,
    accountType: user.accountType,
    profileKind: deriveClientUserProfileKind(user),
    staffNo: user.staffNo ?? null,
    staffVerified: Boolean(user.staffVerified),
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    accountState: resolveClientAccountState(user),
    deactivatedAt: user.deactivatedAt,
    deactivationReason: user.deactivationReason,
    deactivatedByUsername: user.deactivatedByUsername,
    deactivatedByDisplayName: user.deactivatedByDisplayName,
    restoredAt: user.restoredAt,
    restoredByUsername: user.restoredByUsername,
    restoredByDisplayName: user.restoredByDisplayName,
  }
}

export class ClientUserManageService {
  private readonly userRepo = AppDataSource.getRepository(ClientUser)
  private readonly staffNoPattern = /^[A-Za-z0-9-]{4,32}$/

  private normalizeLifecycleReason(reason: string, label: string): string {
    const normalized = reason.trim()
    if (normalized.length < 2) throw new BizError(`请填写${label}原因（至少 2 个字符）`, 400)
    if (normalized.length > 500) throw new BizError(`${label}原因不能超过 500 个字符`, 400)
    return normalized
  }

  private resolveLifecycleAccount(user: ClientUser): string {
    return user.staffNo?.trim() || user.realName?.trim() || user.email || user.mobile || ''
  }

  private async buildLifecycleReferenceSummary(manager: EntityManager, userId: string) {
    const [pendingPreorders, allPreorders, pendingReturns, allReturns, openConversations, allConversations, attachments, webSessions, mobileSessions] = await Promise.all([
      manager.getRepository(O2oPreorder).count({ where: { clientUserId: userId, status: 'pending' } }),
      manager.getRepository(O2oPreorder).count({ where: { clientUserId: userId } }),
      manager.getRepository(O2oReturnRequest).count({ where: { clientUserId: userId, status: 'pending' } }),
      manager.getRepository(O2oReturnRequest).count({ where: { clientUserId: userId } }),
      manager.getRepository(ClientFeedbackConversation).createQueryBuilder('conversation')
        .where('conversation.client_user_id = :userId', { userId })
        .andWhere('conversation.status <> :closed', { closed: 'closed' })
        .getCount(),
      manager.getRepository(ClientFeedbackConversation).count({ where: { clientUserId: userId } }),
      manager.getRepository(ClientFeedbackAttachment).count({ where: { ownerClientUserId: userId } }),
      manager.getRepository(ClientUserSession).count({ where: { userId } }),
      manager.getRepository(ClientMobileSession).count({ where: { clientUserId: userId } }),
    ])
    return { pendingPreorders, allPreorders, pendingReturns, allReturns, openConversations, allConversations, attachments, webSessions, mobileSessions }
  }

  private async buildLifecyclePreview(manager: EntityManager, user: ClientUser): Promise<ClientAccountLifecyclePreview> {
    const referenceSummary = await this.buildLifecycleReferenceSummary(manager, user.id)
    const blockers: ClientAccountLifecyclePreview['blockers'] = []
    if (referenceSummary.pendingPreorders > 0) blockers.push({ code: 'pending_preorder', message: '仍有待处理预订单', count: referenceSummary.pendingPreorders })
    if (referenceSummary.pendingReturns > 0) blockers.push({ code: 'pending_return', message: '仍有非终态退货申请', count: referenceSummary.pendingReturns })
    if (referenceSummary.openConversations > 0) blockers.push({ code: 'open_feedback', message: '仍有未关闭客服会话', count: referenceSummary.openConversations })
    const deactivated = isCurrentlyDeactivated(user)
    const criticalCount = referenceSummary.allPreorders + referenceSummary.allReturns + referenceSummary.allConversations + referenceSummary.attachments
    return {
      domain: 'client_user',
      accountId: user.id,
      account: this.resolveLifecycleAccount(user),
      accountState: resolveClientAccountState(user),
      canDeactivate: !deactivated && blockers.length === 0,
      canRestore: deactivated,
      canPermanentDelete: deactivated && criticalCount === 0,
      blockers,
      referenceSummary,
    }
  }

  private async recordLifecycleEvent(
    manager: EntityManager,
    user: ClientUser,
    actor: AuthUserContext,
    eventType: 'deactivated' | 'restored' | 'permanently_deleted',
    reason: string,
    referenceSummary: Record<string, number>,
  ) {
    const repository = manager.getRepository(AccountLifecycleEvent)
    await repository.save(repository.create({
      accountDomain: 'client_user',
      accountIdSnapshot: user.id,
      accountMaskedSnapshot: maskClientAccount(this.resolveLifecycleAccount(user)),
      eventType,
      reason,
      actorUserIdSnapshot: actor.userId,
      actorUsernameSnapshot: actor.username,
      actorDisplayNameSnapshot: actor.displayName,
      referenceSummaryJson: JSON.stringify(referenceSummary),
      eventSummaryJson: JSON.stringify({
        accountType: user.accountType,
        profileKind: deriveClientUserProfileKind(user),
        status: user.status,
        eventType,
      }),
    }))
  }

  async previewDeactivation(id: string): Promise<ClientAccountLifecyclePreview> {
    const user = await this.userRepo.findOne({ where: { id } })
    if (!user) throw new BizError('客户端用户不存在', 404)
    return this.buildLifecyclePreview(AppDataSource.manager, user)
  }

  async deactivate(
    id: string,
    input: ClientAccountLifecycleReasonInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ClientUserManageSafeProfile> {
    const reason = this.normalizeLifecycleReason(input.reason, '注销')
    const result = await runInTransaction(async (manager) => {
      const user = await this.findClientUserForUpdate(id, manager)
      if (!user) throw new BizError('客户端用户不存在', 404)
      if (isCurrentlyDeactivated(user)) return { profile: sanitizeClientUserProfile(user), changed: false }
      const preview = await this.buildLifecyclePreview(manager, user)
      if (!preview.canDeactivate) throw new BizError(preview.blockers.map((item) => item.message).join('；'), 409)
      const now = new Date(Math.max(Date.now(), (user.restoredAt?.getTime() ?? 0) + 1))
      user.status = 'disabled'
      user.deactivatedAt = now
      user.deactivationReason = reason
      user.deactivatedByUserId = actor.userId
      user.deactivatedByUsername = actor.username
      user.deactivatedByDisplayName = actor.displayName
      const saved = await manager.getRepository(ClientUser).save(user)
      const revokedWeb = await manager.getRepository(ClientUserSession).delete({ userId: user.id })
      const revokedMobile = await manager.getRepository(ClientMobileSession).createQueryBuilder()
        .update(ClientMobileSession)
        .set({ revokedAt: now, revokeReason: 'account_disabled' })
        .where('client_user_id = :userId AND revoked_at IS NULL', { userId: user.id })
        .execute()
      await this.recordLifecycleEvent(manager, saved, actor, 'deactivated', reason, {
        ...preview.referenceSummary,
        revokedWebSessions: revokedWeb.affected ?? 0,
        revokedMobileSessions: revokedMobile.affected ?? 0,
      })
      return { profile: sanitizeClientUserProfile(saved), changed: true }
    })
    if (result.changed) {
      customerServiceRealtimeService.disconnectByOwner('client', id)
      await auditService.safeRecord({
        actionType: 'client_user.deactivate', actionLabel: '注销客户端用户', targetType: 'client_user', targetId: id,
        targetCode: result.profile.account, actor, requestMeta, detail: { reason },
      })
    }
    return result.profile
  }

  async restore(
    id: string,
    input: ClientAccountLifecycleReasonInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ClientUserManageSafeProfile> {
    const reason = this.normalizeLifecycleReason(input.reason, '恢复')
    const result = await runInTransaction(async (manager) => {
      const user = await this.findClientUserForUpdate(id, manager)
      if (!user) throw new BizError('客户端用户不存在', 404)
      if (!isCurrentlyDeactivated(user)) {
        if (user.restoredAt) return { profile: sanitizeClientUserProfile(user), changed: false }
        throw new BizError('账号当前未处于已注销状态', 409)
      }
      const referenceSummary = await this.buildLifecycleReferenceSummary(manager, user.id)
      user.status = 'disabled'
      user.restoredAt = new Date(Math.max(Date.now(), (user.deactivatedAt?.getTime() ?? 0) + 1))
      user.restoredByUserId = actor.userId
      user.restoredByUsername = actor.username
      user.restoredByDisplayName = actor.displayName
      const saved = await manager.getRepository(ClientUser).save(user)
      await this.recordLifecycleEvent(manager, saved, actor, 'restored', reason, referenceSummary)
      return { profile: sanitizeClientUserProfile(saved), changed: true }
    })
    if (result.changed) {
      await auditService.safeRecord({
        actionType: 'client_user.restore', actionLabel: '恢复客户端用户', targetType: 'client_user', targetId: id,
        targetCode: result.profile.account, actor, requestMeta, detail: { reason, statusAfter: 'disabled' },
      })
    }
    return result.profile
  }

  async permanentDelete(
    id: string,
    input: ClientAccountPermanentDeleteInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ deleted: true; accountId: string; accountMasked: string }> {
    const reason = this.normalizeLifecycleReason(input.reason, '永久删除')
    try {
      assertPermanentDeletePassword(input.permanentDeletePassword)
      const result = await runInTransaction(async (manager) => {
        const user = await this.findClientUserForUpdate(id, manager)
        if (!user) throw new BizError('客户端用户不存在', 404)
        if (!isCurrentlyDeactivated(user)) throw new BizError('仅允许永久删除已注销账号', 409)
        const account = this.resolveLifecycleAccount(user)
        if (input.confirmAccount !== account) throw new BizError('确认账号与目标账号不一致', 400)
        const preview = await this.buildLifecyclePreview(manager, user)
        const references = preview.referenceSummary
        const criticalCount = references.allPreorders + references.allReturns + references.allConversations + references.attachments
        if (criticalCount > 0) throw new BizError('账号仍存在关键业务关联，不能永久删除', 409)

        const webSessions = await manager.getRepository(ClientUserSession).delete({ userId: user.id })
        const mobileSessions = await manager.getRepository(ClientMobileSession).delete({ clientUserId: user.id })
        await this.recordLifecycleEvent(manager, user, actor, 'permanently_deleted', reason, {
          ...references,
          removedWebSessions: webSessions.affected ?? 0,
          removedMobileSessions: mobileSessions.affected ?? 0,
        })
        await manager.getRepository(ClientUser).delete({ id: user.id })
        return { deleted: true as const, accountId: user.id, accountMasked: maskClientAccount(account) }
      })
      customerServiceRealtimeService.disconnectByOwner('client', id)
      await auditService.safeRecord({
        actionType: 'client_user.permanent_delete', actionLabel: '永久删除客户端用户', targetType: 'client_user', targetId: id,
        targetCode: result.accountMasked, actor, requestMeta, detail: { reason },
      })
      return result
    } catch (error) {
      await auditService.safeRecord({
        actionType: 'client_user.permanent_delete', actionLabel: '永久删除客户端用户（失败）', targetType: 'client_user', targetId: id,
        actor, requestMeta, resultStatus: 'failed', detail: { reason: 'request_rejected' },
      })
      throw error
    }
  }

  private async findUserByAnyIdentifier(account: string, manager?: EntityManager) {
    const targetRepo = manager ? manager.getRepository(ClientUser) : this.userRepo
    return targetRepo
      .createQueryBuilder('user')
      .where('user.mobile = :account OR user.email = :account OR user.realName = :account OR user.staffNo = :account', { account })
      .getOne()
  }

  private normalizeProfileKind(profileKind: string | undefined): ClientUserProfileKind {
    const normalized = profileKind?.trim() || 'personal'
    if (CLIENT_USER_PROFILE_KINDS.includes(normalized as ClientUserProfileKind)) {
      return normalized as ClientUserProfileKind
    }
    throw new BizError('客户端用户身份类型非法', 400)
  }

  private normalizeStaffNo(value: string | undefined, fieldLabel = '教职工号') {
    const normalized = value?.trim() || ''
    if (!normalized) {
      throw new BizError(`${fieldLabel}不能为空`, 400)
    }
    if (!this.staffNoPattern.test(normalized)) {
      throw new BizError(`${fieldLabel}格式不正确，仅支持字母、数字和短横线（4-32位）`, 400)
    }
    return normalized
  }

  private createDepartmentAccountNoCandidate() {
    return `DEPT-${randomBytes(5).toString('hex').toUpperCase()}`
  }

  private async generateUniqueDepartmentAccountNo(manager: EntityManager) {
    const userRepo = manager.getRepository(ClientUser)
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = this.createDepartmentAccountNoCandidate()
      const existed = await userRepo.findOne({
        where: { staffNo: candidate },
        select: ['id'],
      })
      if (!existed) {
        return candidate
      }
    }
    throw new BizError('部门共享账号编号生成失败，请重试', 500)
  }

  private normalizeDepartmentAccountNo(value: string) {
    const account = value.trim()
    if (!/^DEPT-[A-F0-9]{10}$/.test(account)) {
      throw new BizError('部门共享账号编号格式非法', 400)
    }
    return account
  }

  private async assertDepartmentNodeUnbound(departmentNodeId: string, manager: EntityManager, excludedUserId?: string) {
    const existing = await manager.getRepository(ClientUser)
      .createQueryBuilder('user')
      .where('user.departmentNodeId = :departmentNodeId', { departmentNodeId })
      .getOne()
    if (existing && existing.id !== excludedUserId) {
      throw new BizError('该部门已存在共享账号，不能重复创建或绑定', 409)
    }
  }

  private async findClientUserForUpdate(id: string, manager: EntityManager) {
    const query = manager.getRepository(ClientUser)
      .createQueryBuilder('user')
      .where('user.id = :id', { id })
    if (manager.connection.options.type === 'mysql') {
      query.setLock('pessimistic_write')
    }
    return query.getOne()
  }

  /** 批量最多 100 项时按 4 路有界并发预生成密码哈希，避免把昂贵 scrypt 留在数据库事务内。 */
  private async hashDepartmentAccountPasswords(items: Array<{ initialPassword: string }>) {
    const hashes: string[] = []
    const concurrency = 4
    for (let offset = 0; offset < items.length; offset += concurrency) {
      const batch = items.slice(offset, offset + concurrency)
      const batchHashes = await Promise.all(batch.map((item) => hashPassword(item.initialPassword)))
      hashes.push(...batchHashes)
    }
    return hashes
  }

  private async resolveDepartmentAccountNodes(departmentNodeIds: string[]) {
    if (departmentNodeIds.length < 1 || departmentNodeIds.length > 100) {
      throw new BizError('一次最多可处理 100 个部门节点', 400)
    }
    const normalizedIds = departmentNodeIds.map((item) => item.trim())
    if (normalizedIds.some((item) => !item)) {
      throw new BizError('部门节点ID不能为空', 400)
    }
    if (new Set(normalizedIds).size !== normalizedIds.length) {
      throw new BizError('部门节点不能重复', 400)
    }
    return Promise.all(normalizedIds.map((departmentNodeId) => systemConfigService.resolveClientDepartmentNode(departmentNodeId)))
  }

  async previewDepartmentAccounts(input: DepartmentAccountPreviewInput): Promise<{
    creatable: Array<{ departmentNodeId: string; departmentName: string }>
    skipped: DepartmentAccountBatchSkippedItem[]
  }> {
    const nodes = await this.resolveDepartmentAccountNodes(input.departmentNodeIds)
    const nodeIds = nodes.map((node) => node.departmentNodeId)
    const existingUsers = nodeIds.length === 0 ? [] : await this.userRepo
      .createQueryBuilder('user')
      .where('user.departmentNodeId IN (:...nodeIds)', { nodeIds })
      .getMany()
    const existingByNodeId = new Map(existingUsers.map((user) => [user.departmentNodeId, user]))
    const creatable: Array<{ departmentNodeId: string; departmentName: string }> = []
    const skipped: DepartmentAccountBatchSkippedItem[] = []
    for (const node of nodes) {
      const existing = existingByNodeId.get(node.departmentNodeId)
      if (!existing) {
        creatable.push({ departmentNodeId: node.departmentNodeId, departmentName: node.departmentName })
        continue
      }
      skipped.push({
        id: existing.id,
        departmentNodeId: node.departmentNodeId,
        departmentName: node.departmentName,
        account: existing.staffNo ?? existing.realName,
        status: existing.status,
      })
    }
    return { creatable, skipped }
  }

  async createDepartmentAccountsBatch(
    input: DepartmentAccountBatchInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ created: DepartmentAccountBatchCreatedItem[]; skipped: DepartmentAccountBatchSkippedItem[] }> {
    if (!CLIENT_USER_STATUSES.includes(input.status)) {
      throw new BizError('客户端用户状态非法', 400)
    }
    if (input.items.length < 1 || input.items.length > 100) {
      throw new BizError('一次最多可创建 100 个部门共享账号', 400)
    }
    const requestedDepartmentNodeIds = input.items.map((item) => item.departmentNodeId.trim())
    if (requestedDepartmentNodeIds.some((departmentNodeId) => !departmentNodeId)) {
      throw new BizError('部门节点ID不能为空', 400)
    }
    if (new Set(requestedDepartmentNodeIds).size !== requestedDepartmentNodeIds.length) {
      throw new BizError('部门节点不能重复', 400)
    }
    const passwordCheckedItems = input.items.map((item, index) => ({
      departmentNodeId: requestedDepartmentNodeIds[index]!,
      account: this.normalizeDepartmentAccountNo(item.account),
      initialPassword: assertClientPasswordPolicy(item.initialPassword, '初始密码'),
    }))
    const passwordHashes = await this.hashDepartmentAccountPasswords(passwordCheckedItems)
    if (new Set(passwordCheckedItems.map((item) => item.account)).size !== passwordCheckedItems.length) {
      throw new BizError('部门共享账号编号不能重复', 400)
    }

    try {
      return await runInTransaction(async (manager) => {
        const userRepo = manager.getRepository(ClientUser)
        const latestDepartmentConfig = await systemConfigService.getClientDepartmentConfigs(manager, { lockForUpdate: true })
        const normalizedItems = passwordCheckedItems.map((item, index) => {
          const resolved = systemConfigService.resolveClientDepartmentNode(item.departmentNodeId, manager, latestDepartmentConfig)
          return { item, index, resolved }
        })
        const resolvedItems = await Promise.all(normalizedItems.map(async ({ item, index, resolved }) => {
          const department = await resolved
          return {
            departmentNodeId: department.departmentNodeId,
            departmentName: department.departmentName,
            account: item.account,
            passwordHash: passwordHashes[index]!,
          }
        }))
        const nodeIds = resolvedItems.map((item) => item.departmentNodeId)
        const existingUsersQuery = userRepo
          .createQueryBuilder('user')
          .where('user.departmentNodeId IN (:...nodeIds)', { nodeIds })
        if (manager.connection.options.type === 'mysql') {
          existingUsersQuery.setLock('pessimistic_write')
        }
        const existingUsers = await existingUsersQuery.getMany()
        const existingByNodeId = new Map(existingUsers.map((user) => [user.departmentNodeId, user]))
        const created: DepartmentAccountBatchCreatedItem[] = []
        const skipped: DepartmentAccountBatchSkippedItem[] = []

        for (const item of resolvedItems) {
          const existing = existingByNodeId.get(item.departmentNodeId)
          if (existing) {
            skipped.push({
              id: existing.id,
              departmentNodeId: item.departmentNodeId,
              departmentName: item.departmentName,
              account: existing.staffNo ?? existing.realName,
              status: existing.status,
            })
            continue
          }
          const duplicatedAccount = await this.findUserByAnyIdentifier(item.account, manager)
          if (duplicatedAccount) {
            throw new BizError('该账号编号已被其他客户端用户使用', 409)
          }
          const savedUser = await userRepo.save(userRepo.create({
            realName: item.account,
            mobile: null,
            email: null,
            departmentName: item.departmentName,
            departmentNodeId: item.departmentNodeId,
            accountType: 'department',
            staffNo: item.account,
            staffVerified: true,
            status: input.status,
            passwordHash: item.passwordHash,
            lastLoginAt: null,
          }))
          const createdItem: DepartmentAccountBatchCreatedItem = {
            id: savedUser.id,
            departmentNodeId: item.departmentNodeId,
            departmentName: item.departmentName,
            account: item.account,
            status: savedUser.status,
          }
          created.push(createdItem)
          await auditService.record({
            actionType: 'client_user.create',
            actionLabel: '批量新增部门共享账号',
            targetType: 'client_user',
            targetId: savedUser.id,
            targetCode: item.account,
            actor,
            requestMeta,
            detail: {
              accountType: 'department',
              departmentNodeId: item.departmentNodeId,
              departmentName: item.departmentName,
              status: savedUser.status,
              createdBy: 'admin_department_account_batch',
            },
          }, manager)
        }

        await auditService.record({
          actionType: 'client_user.create_department_accounts_batch',
          actionLabel: '批量创建部门共享账号',
          targetType: 'client_user_batch',
          targetCode: `created:${created.length};skipped:${skipped.length}`,
          actor,
          requestMeta,
          detail: {
            createdCount: created.length,
            skippedCount: skipped.length,
            departmentNodeIds: resolvedItems.map((item) => item.departmentNodeId),
          },
        }, manager)
        return { created, skipped }
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new BizError('部门或账号已被并发占用，请刷新后重试', 409)
      }
      throw error
    }
  }

  private async findActiveStaffDirectory(staffNo: string, manager: EntityManager) {
    return manager.getRepository(ClientStaffDirectory).findOne({
      where: { staffNo, status: 'active' },
    })
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

  async createProfile(
    input: CreateClientUserInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ClientUserManageSafeProfile> {
    if (!CLIENT_USER_STATUSES.includes(input.status)) {
      throw new BizError('客户端用户状态非法', 400)
    }

    const profileKind = this.normalizeProfileKind(input.profileKind)
    const mobile = this.normalizeMobile(input.mobile)
    const email = this.normalizeEmail(input.email)
    const password = assertClientPasswordPolicy(input.password, '登录密码')
    // scrypt 属于高开销 CPU 操作，必须在锁定部门配置和账号行之前完成。
    const passwordHash = await hashPassword(password)
    let staffNo = profileKind === 'teacher'
      ? this.normalizeStaffNo(input.staffNo, '教职工号')
      : null
    if (profileKind === 'department' && input.staffNo?.trim()) {
      staffNo = this.normalizeStaffNo(input.staffNo, '账号编号')
    }
    const inputDepartmentName = profileKind === 'personal' ? input.departmentName : undefined
    let username = profileKind === 'department' ? this.normalizeUsername(input.username) : ''
    let departmentName = profileKind === 'personal'
      ? await systemConfigService.assertClientDepartmentOption(inputDepartmentName)
      : ''
    let accountType: ClientUserAccountType = 'personal'
    let staffVerified = false

    if (profileKind === 'personal') {
      username = this.normalizeUsername(input.username)
    }
    if (profileKind === 'personal' && !mobile && !email) {
      throw new BizError('手机号和邮箱至少保留一项', 400)
    }
    if (profileKind === 'department') {
      accountType = 'department'
      staffVerified = true
    }

    try {
      return await runInTransaction(async (manager) => {
      const userRepo = manager.getRepository(ClientUser)

      if (profileKind === 'teacher') {
        const matchedStaff = await this.findActiveStaffDirectory(staffNo!, manager)
        if (!matchedStaff) {
          throw new BizError('教职工号未在学校目录中登记，请联系管理员核验', 409)
        }
        username = matchedStaff.realName.trim()
        departmentName = await systemConfigService.assertClientDepartmentOption(matchedStaff.departmentName)
        staffVerified = true
      }
      if (profileKind === 'department' && !staffNo) {
        staffNo = await this.generateUniqueDepartmentAccountNo(manager)
      }

      const latestDepartmentConfig = profileKind === 'department'
        ? await systemConfigService.getClientDepartmentConfigs(manager, { lockForUpdate: true })
        : null
      const resolvedDepartment = profileKind === 'department'
        ? await systemConfigService.resolveClientDepartmentReference(input, manager, latestDepartmentConfig!)
        : null
      if (resolvedDepartment) {
        departmentName = resolvedDepartment.departmentName
      }
      const departmentNodeId = resolvedDepartment?.departmentNodeId ?? null
      if (departmentNodeId) {
        await this.assertDepartmentNodeUnbound(departmentNodeId, manager)
      }

      if (staffNo) {
        const duplicatedStaffNoUser = await this.findUserByAnyIdentifier(staffNo, manager)
        if (duplicatedStaffNoUser) {
          throw new BizError(profileKind === 'department' ? '该账号编号已被其他客户端用户使用' : '该教职工号已绑定其他账号', 409)
        }
      }

      const duplicatedUsernameUser = await this.findUserByAnyIdentifier(username, manager)
      if (duplicatedUsernameUser) {
        throw new BizError('该用户名已被其他客户端用户使用', 409)
      }

      if (mobile) {
        const duplicatedMobileUser = await this.findUserByAnyIdentifier(mobile, manager)
        if (duplicatedMobileUser) {
          throw new BizError('该手机号已被其他客户端用户使用', 409)
        }
      }

      if (email) {
        const duplicatedEmailUser = await this.findUserByAnyIdentifier(email, manager)
        if (duplicatedEmailUser) {
          throw new BizError('该邮箱已被其他客户端用户使用', 409)
        }
      }

      const createdUser = userRepo.create({
        realName: username,
        mobile,
        email,
        departmentName,
        departmentNodeId,
        accountType,
        staffNo: staffNo ?? undefined,
        staffVerified,
        status: input.status,
        passwordHash,
        lastLoginAt: null,
      })
      const savedUser = await userRepo.save(createdUser)

      await auditService.record(
        {
          actionType: 'client_user.create',
          actionLabel: '手动新增客户端用户',
          targetType: 'client_user',
          targetId: savedUser.id,
          targetCode: savedUser.realName || savedUser.email || savedUser.mobile || '',
          actor,
          requestMeta,
          detail: {
            username: savedUser.realName,
            mobile: savedUser.mobile,
            email: savedUser.email,
            departmentName: savedUser.departmentName,
            departmentNodeId: savedUser.departmentNodeId,
            profileKind: deriveClientUserProfileKind(savedUser),
            accountType: savedUser.accountType,
            staffNo: savedUser.staffNo,
            staffVerified: savedUser.staffVerified,
            status: savedUser.status,
            createdBy: 'admin_manual_create',
            bypassedClientRegisterRiskGuard: true,
          },
        },
        manager,
      )

        return sanitizeClientUserProfile(savedUser)
      })
    } catch (error) {
      if (profileKind === 'department' && isUniqueConstraintError(error)) {
        throw new BizError('部门或账号已被并发占用，请刷新后重试', 409)
      }
      throw error
    }
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
            OR user.staffNo LIKE :keyword
          )
        `,
        { keyword: `%${query.keyword.trim()}%` },
      )
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
    if (query.accountType && CLIENT_USER_ACCOUNT_TYPES.includes(query.accountType)) {
      qb.andWhere('user.accountType = :accountType', { accountType: query.accountType })
    }
    if (query.profileKind === 'department') {
      qb.andWhere('user.accountType = :departmentProfileAccountType', { departmentProfileAccountType: 'department' })
    }
    if (query.profileKind === 'teacher') {
      qb.andWhere('user.accountType = :teacherProfileAccountType', { teacherProfileAccountType: 'personal' })
      qb.andWhere("user.staffNo IS NOT NULL AND user.staffNo <> ''")
    }
    if (query.profileKind === 'personal') {
      qb.andWhere('user.accountType = :personalProfileAccountType', { personalProfileAccountType: 'personal' })
      qb.andWhere("(user.staffNo IS NULL OR user.staffNo = '')")
    }
    if (query.departmentName?.trim()) {
      qb.andWhere('user.departmentName = :departmentName', { departmentName: query.departmentName.trim() })
    }
    if (query.staffNo?.trim()) {
      qb.andWhere('user.staffNo LIKE :staffNo', { staffNo: `%${query.staffNo.trim()}%` })
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

    const result = await runInTransaction(async (manager) => {
      const userRepo = manager.getRepository(ClientUser)
      const sessionRepo = manager.getRepository(ClientUserSession)
      const mobileSessionRepo = manager.getRepository(ClientMobileSession)
      // 与部门树保存、批量开户保持相同的“先配置、后账号”锁顺序，避免 MySQL 交叉等待。
      const latestDepartmentConfig = await systemConfigService.getClientDepartmentConfigs(manager, { lockForUpdate: true })
      const user = await this.findClientUserForUpdate(id, manager)
      if (!user) {
        throw new BizError('客户端用户不存在', 404)
      }

      if (user.status === status) {
        return { profile: sanitizeClientUserProfile(user), sessionMustBeRevoked: false }
      }

      if (status === 'enabled' && isCurrentlyDeactivated(user)) {
        throw new BizError('账号已注销，请先恢复后再启用', 409)
      }

      if (status === 'enabled' && user.accountType === 'department') {
        if (!user.departmentNodeId) {
          throw new BizError('部门共享账号所属部门已不存在，请先重新绑定有效部门后再启用', 409)
        }
        try {
          await systemConfigService.resolveClientDepartmentNode(user.departmentNodeId, manager, latestDepartmentConfig)
        } catch (error) {
          if (error instanceof BizError) {
            throw new BizError('部门共享账号所属部门已不存在，请先重新绑定有效部门后再启用', 409)
          }
          throw error
        }
      }

      const previousStatus = user.status
      user.status = status
      const savedUser = await userRepo.save(user)

      if (status !== 'enabled') {
        await sessionRepo.delete({ userId: savedUser.id })
        await mobileSessionRepo.createQueryBuilder()
          .update(ClientMobileSession)
          .set({ revokedAt: new Date(), revokeReason: 'account_disabled' })
          .where('client_user_id = :userId AND revoked_at IS NULL', { userId: savedUser.id })
          .execute()
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

      return { profile: sanitizeClientUserProfile(savedUser), sessionMustBeRevoked: status !== 'enabled' }
    })
    if (result.sessionMustBeRevoked) {
      customerServiceRealtimeService.disconnectByOwner('client', id)
    }
    return result.profile
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

    const result = await runInTransaction(async (manager) => {
      const userRepo = manager.getRepository(ClientUser)
      const sessionRepo = manager.getRepository(ClientUserSession)
      const mobileSessionRepo = manager.getRepository(ClientMobileSession)
      // 先锁定部门配置再锁账号行，和部门树更新及批量开户维持一致的锁顺序。
      const latestDepartmentConfig = await systemConfigService.getClientDepartmentConfigs(manager, { lockForUpdate: true })
      const user = await this.findClientUserForUpdate(id, manager)
      if (!user) {
        throw new BizError('客户端用户不存在', 404)
      }
      if (isCurrentlyDeactivated(user)) {
        throw new BizError('账号已注销，请先恢复后再编辑资料', 409)
      }
      if (deriveClientUserProfileKind(user) === 'personal' && !mobile && !email) {
        throw new BizError('手机号和邮箱至少保留一项', 400)
      }

      const duplicatedUsernameUser = await this.findUserByAnyIdentifier(username, manager)
      if (duplicatedUsernameUser && duplicatedUsernameUser.id !== user.id) {
        throw new BizError('该用户名已被其他客户端用户使用', 409)
      }

      if (mobile) {
        const duplicatedMobileUser = await this.findUserByAnyIdentifier(mobile, manager)
        if (duplicatedMobileUser && duplicatedMobileUser.id !== user.id) {
          throw new BizError('该手机号已被其他客户端用户使用', 409)
        }
      }
      if (email) {
        const duplicatedEmailUser = await this.findUserByAnyIdentifier(email, manager)
        if (duplicatedEmailUser && duplicatedEmailUser.id !== user.id) {
          throw new BizError('该邮箱已被其他客户端用户使用', 409)
        }
      }

      const before = sanitizeClientUserProfile(user)
      const previousDepartmentNodeId = user.departmentNodeId
      const profileKind = deriveClientUserProfileKind(user)
      const resolvedDepartment = profileKind === 'department'
        ? await systemConfigService.resolveClientDepartmentReference(input, manager, latestDepartmentConfig)
        : null
      user.realName = username
      user.mobile = mobile
      user.email = email
      user.departmentName = profileKind === 'department'
        ? resolvedDepartment!.departmentName
        : await systemConfigService.assertClientDepartmentOption(input.departmentName)
      user.departmentNodeId = resolvedDepartment?.departmentNodeId ?? null
      if (user.departmentNodeId) {
        await this.assertDepartmentNodeUnbound(user.departmentNodeId, manager, user.id)
      }
      user.status = input.status
      if (input.status === 'enabled' && isCurrentlyDeactivated(user)) {
        throw new BizError('账号已注销，请先恢复后再启用', 409)
      }
      let savedUser: ClientUser
      try {
        savedUser = await userRepo.save(user)
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new BizError('部门或账号已被并发占用，请刷新后重试', 409)
        }
        throw error
      }

      const identityChanged = before.realName !== savedUser.realName
        || before.mobile !== savedUser.mobile
        || before.email !== savedUser.email
        || before.departmentName !== savedUser.departmentName
        || previousDepartmentNodeId !== savedUser.departmentNodeId
        || before.status !== savedUser.status
      let revokedSessionCount = 0
      let revokedMobileSessionCount = 0
      if (identityChanged) {
        const deletedSessions = await sessionRepo.delete({ userId: savedUser.id })
        revokedSessionCount = deletedSessions.affected ?? 0
        const revokedMobileSessions = await mobileSessionRepo.createQueryBuilder()
          .update(ClientMobileSession)
          .set({ revokedAt: new Date(), revokeReason: savedUser.status !== 'enabled' ? 'account_disabled' : 'admin_revoke' })
          .where('client_user_id = :userId AND revoked_at IS NULL', { userId: savedUser.id })
          .execute()
        revokedMobileSessionCount = revokedMobileSessions.affected ?? 0
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
            revokedMobileSessionCount,
            identityChanged,
          },
        },
        manager,
      )

      return { profile: sanitizeClientUserProfile(savedUser), identityChanged }
    })
    if (result.identityChanged) {
      customerServiceRealtimeService.disconnectByOwner('client', id)
    }
    return result.profile
  }

  async resetPassword(
    id: string,
    input: ResetClientUserPasswordInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<ClientUserManageSafeProfile> {
    const newPassword = assertClientPasswordPolicy(input.newPassword, '新密码')
    if (!newPassword) {
      throw new BizError('新密码不能为空', 400)
    }

    const profile = await runInTransaction(async (manager) => {
      const userRepo = manager.getRepository(ClientUser)
      const sessionRepo = manager.getRepository(ClientUserSession)
      const mobileSessionRepo = manager.getRepository(ClientMobileSession)
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
      const revokedMobileSessions = await mobileSessionRepo.createQueryBuilder()
        .update(ClientMobileSession)
        .set({ revokedAt: new Date(), revokeReason: 'password_reset' })
        .where('client_user_id = :userId AND revoked_at IS NULL', { userId: savedUser.id })
        .execute()

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
            revokedMobileSessionCount: revokedMobileSessions.affected ?? 0,
          },
        },
        manager,
      )

      return sanitizeClientUserProfile(savedUser)
    })
    customerServiceRealtimeService.disconnectByOwner('client', id)
    return profile
  }
}

export const clientUserManageService = new ClientUserManageService()
