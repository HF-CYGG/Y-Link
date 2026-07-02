/**
 * 模块说明：backend/src/services/client-user-manage.service.ts
 * 文件职责：管理端对客户端用户进行查询、手动创建、启停与重置密码。
 * 维护说明：
 * - 客户端用户与管理端用户分表治理，避免角色、权限和登录会话语义混用；
 * - 当前仅开放治理侧高频动作，客户端账号创建仍以客户端自助注册为主。
 */

import { AppDataSource } from '../config/data-source.js'
import {
  CLIENT_USER_ACCOUNT_TYPES,
  CLIENT_USER_STATUSES,
  type ClientUserAccountType,
  type ClientUserStatus,
  ClientUser,
} from '../entities/client-user.entity.js'
import { ClientStaffDirectory } from '../entities/client-staff-directory.entity.js'
import { ClientUserSession } from '../entities/client-user-session.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import { assertClientPasswordPolicy, hashPassword } from '../utils/password.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { systemConfigService } from './system-config.service.js'
import type { EntityManager } from 'typeorm'
import { randomBytes } from 'node:crypto'

export interface ClientUserListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: ClientUserStatus
  accountType?: ClientUserAccountType
  profileKind?: ClientUserProfileKind
  departmentName?: string
  staffNo?: string
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
  staffNo?: string
  password: string
  status: ClientUserStatus
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
  accountType: ClientUserAccountType
  profileKind: ClientUserProfileKind
  staffNo: string | null
  staffVerified: boolean
  status: ClientUserStatus
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export const CLIENT_USER_PROFILE_KINDS = ['personal', 'teacher', 'department'] as const
export type ClientUserProfileKind = (typeof CLIENT_USER_PROFILE_KINDS)[number]

const deriveClientUserProfileKind = (user: Pick<ClientUser, 'accountType' | 'staffNo' | 'staffVerified'>): ClientUserProfileKind => {
  if (user.accountType === 'department') {
    return 'department'
  }
  return user.staffVerified && Boolean(user.staffNo?.trim()) ? 'teacher' : 'personal'
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
    accountType: user.accountType,
    profileKind: deriveClientUserProfileKind(user),
    staffNo: user.staffNo ?? null,
    staffVerified: Boolean(user.staffVerified),
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

export class ClientUserManageService {
  private readonly userRepo = AppDataSource.getRepository(ClientUser)
  private readonly staffNoPattern = /^[A-Za-z0-9-]{4,32}$/

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
      departmentName = await systemConfigService.assertClientDepartmentOption(input.departmentName)
      if (!departmentName) {
        throw new BizError('部门共享账号必须选择所属部门', 400)
      }
      accountType = 'department'
      staffVerified = true
    }

    return AppDataSource.transaction(async (manager) => {
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
        accountType,
        staffNo: staffNo ?? undefined,
        staffVerified,
        status: input.status,
        passwordHash: await hashPassword(password),
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
    if (query.accountType && CLIENT_USER_ACCOUNT_TYPES.includes(query.accountType)) {
      qb.andWhere('user.accountType = :accountType', { accountType: query.accountType })
    }
    if (query.profileKind === 'department') {
      qb.andWhere('user.accountType = :departmentProfileAccountType', { departmentProfileAccountType: 'department' })
    }
    if (query.profileKind === 'teacher') {
      qb.andWhere('user.accountType = :teacherProfileAccountType', { teacherProfileAccountType: 'personal' })
      qb.andWhere('user.staffVerified = :teacherStaffVerified', { teacherStaffVerified: true })
      qb.andWhere("user.staffNo IS NOT NULL AND user.staffNo <> ''")
    }
    if (query.profileKind === 'personal') {
      qb.andWhere('user.accountType = :personalProfileAccountType', { personalProfileAccountType: 'personal' })
      qb.andWhere("(user.staffNo IS NULL OR user.staffNo = '' OR user.staffVerified = :personalStaffVerified)", {
        personalStaffVerified: false,
      })
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

    return AppDataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(ClientUser)
      const sessionRepo = manager.getRepository(ClientUserSession)
      const user = await userRepo.findOne({ where: { id } })
      if (!user) {
        throw new BizError('客户端用户不存在', 404)
      }
      if (deriveClientUserProfileKind(user) === 'personal' && !mobile && !email) {
        throw new BizError('手机号和邮箱至少保留一项', 400)
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
    const newPassword = assertClientPasswordPolicy(input.newPassword, '新密码')
    if (!newPassword) {
      throw new BizError('新密码不能为空', 400)
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
