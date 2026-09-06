/**
 * 文件职责：统一管理全体教师共用的注册邀请码，只持久化带 pepper 的摘要。
 * 实现逻辑：配置状态与审计同事务提交；注册先读锁配置，再锁工号，防止并发改码绕过校验。
 * 维护边界：不读取或改写历史个人邀请码；公开视图只返回状态与更新时间，不返回摘要。
 */
import type { EntityManager } from 'typeorm'
import { runInTransaction } from '../config/transaction-runner.js'
import { SystemConfig } from '../entities/system-config.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import {
  STAFF_INVITE_CODE_PATTERN,
  STAFF_INVITE_CONFIG_KEY,
  digestSharedStaffInviteCode,
  normalizeStaffInviteCode,
  verifySharedStaffInviteCode,
} from '../utils/staff-invite-code.js'
import { auditService } from './audit.service.js'

interface StaffInviteConfigValue {
  enabled: boolean
  digest: string | null
}

export interface ClientStaffInviteCodeConfig {
  status: 'not_set' | 'enabled' | 'disabled'
  updatedAt: string | null
}

export class ClientStaffInviteCodeService {
  private parseConfig(row: SystemConfig | null): StaffInviteConfigValue {
    if (!row) return { enabled: false, digest: null }
    try {
      const value: unknown = JSON.parse(row.configValue)
      if (typeof value === 'object' && value !== null && 'enabled' in value && 'digest' in value
        && typeof value.enabled === 'boolean'
        && (value.digest === null || (typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)))
        && (!value.enabled || value.digest !== null)) {
        return { enabled: value.enabled, digest: value.digest }
      }
    } catch {
      // 不在错误信息中包含原始配置，避免摘要意外进入日志或接口。
    }
    throw new BizError('教师统一邀请码配置异常，请联系管理员', 503)
  }

  private toView(row: SystemConfig | null): ClientStaffInviteCodeConfig {
    const value = this.parseConfig(row)
    return {
      status: !value.digest ? 'not_set' : value.enabled ? 'enabled' : 'disabled',
      updatedAt: value.digest && row ? row.updatedAt.toISOString() : null,
    }
  }

  private readLockedConfig(manager: EntityManager, write = false) {
    const query = manager.getRepository(SystemConfig).createQueryBuilder('config')
      .where('config.configKey = :key', { key: STAFF_INVITE_CONFIG_KEY })
    if (manager.connection.options.type === 'mysql') {
      query.setLock(write ? 'pessimistic_write' : 'pessimistic_read')
    }
    return query.getOne()
  }

  async getConfig(): Promise<ClientStaffInviteCodeConfig> {
    return runInTransaction(async (manager) => this.toView(await this.readLockedConfig(manager)))
  }

  /** 调用方必须在同一事务内继续锁定工号并创建账号，不能在验证后提前释放配置锁。 */
  async verifyForRegistration(manager: EntityManager, inviteCode: string): Promise<boolean> {
    const value = this.parseConfig(await this.readLockedConfig(manager))
    if (!value.digest) throw new BizError('教师统一邀请码未设置，请联系管理员', 503)
    if (!value.enabled) throw new BizError('教师统一邀请码已禁用，请联系管理员', 503)
    return STAFF_INVITE_CODE_PATTERN.test(inviteCode.trim())
      && verifySharedStaffInviteCode(inviteCode, value.digest)
  }

  private async assertCanUpdate(actor: AuthUserContext, requestMeta?: RequestMeta) {
    if (actor.role === 'admin' && actor.permissions.includes('system_configs:update')) return
    await auditService.safeRecord({
      actionType: 'system_config.staff_invite.forbidden',
      actionLabel: '统一教师邀请码维护越权拦截',
      targetType: 'system_config',
      targetCode: STAFF_INVITE_CONFIG_KEY,
      actor,
      requestMeta,
      resultStatus: 'failed',
    })
    throw new BizError('当前账号无权执行该操作', 403)
  }

  async setInviteCode(inviteCode: string, actor: AuthUserContext, requestMeta?: RequestMeta) {
    await this.assertCanUpdate(actor, requestMeta)
    const digest = digestSharedStaffInviteCode(normalizeStaffInviteCode(inviteCode))
    return this.updateConfig(digest, actor, requestMeta)
  }

  async disableInviteCode(actor: AuthUserContext, requestMeta?: RequestMeta) {
    await this.assertCanUpdate(actor, requestMeta)
    return this.updateConfig(null, actor, requestMeta)
  }

  private async updateConfig(digest: string | null, actor: AuthUserContext, requestMeta?: RequestMeta) {
    return runInTransaction(async (manager) => {
      const repo = manager.getRepository(SystemConfig)
      // 默认行由启动流程补齐；直接取写锁，避免 INSERT IGNORE 的重复键共享锁升级死锁。
      const row = await this.readLockedConfig(manager, true)
      if (!row) throw new BizError('教师统一邀请码配置缺失，请联系管理员', 503)
      const before = this.toView(row)
      const current = this.parseConfig(row)
      if (digest === null && !current.enabled) return before
      row.configValue = JSON.stringify({ enabled: digest !== null, digest: digest ?? current.digest })
      const saved = await repo.save(row)
      const after = this.toView(saved)
      await auditService.record({
        actionType: digest === null ? 'system_config.staff_invite.disable' : 'system_config.staff_invite.set',
        actionLabel: digest === null ? '禁用教师统一邀请码' : '设置教师统一邀请码',
        targetType: 'system_config',
        targetId: saved.id,
        targetCode: STAFF_INVITE_CONFIG_KEY,
        actor,
        requestMeta,
        detail: { before, after },
      }, manager)
      return after
    })
  }
}

export const clientStaffInviteCodeService = new ClientStaffInviteCodeService()
