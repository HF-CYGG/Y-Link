/**
 * 文件说明：管理端 TOTP 两步验证服务（所有管理端账号自愿开启）。
 * 实现逻辑：
 * - 绑定分两步：发起时（路由层已复核当前密码）生成 20 字节秘钥，放入按账号覆盖的 10 分钟短期票据；
 *   确认时校验一次动态码才落库，同时生成 10 个一次性恢复码，明文只返回这一次；
 * - 秘钥经 `data-encryption` 加密落库，AAD 绑定账号 ID，密文不能挪给其他账号；恢复码只存 HMAC-SHA256 摘要
 *   （数据加密主密钥派生的子密钥），数据库单独泄露时既拿不到秘钥也无法离线穷举恢复码；
 * - 第二因素校验在调用方事务内完成：动态码允许 ±1 个时间步漂移，`last_used_step` 以比较并交换方式推进，
 *   同一动态码不能重放；恢复码使用后以比较并交换方式移出摘要列表，并发提交同一恢复码只有一个成功；
 * - 停用与重生成恢复码要求当前密码（路由层）+ 第二因素，第二因素错误计入登录失败锁定。
 * 维护说明：
 * - 数据加密主密钥丢失或更换后秘钥与恢复码都无法校验，只能由其他管理员在用户管理中重置，
 *   或在服务器本地执行 `admin-mfa-reset-cli` 应急重置；
 * - 永久删除账号时必须在同一事务内调用 `deleteForUser`（外键 RESTRICT）。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { In, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { webauthnConfig } from '../config/webauthn.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { SysUserMfa } from '../entities/sys-user-mfa.entity.js'
import { SysUserWebauthnCredential } from '../entities/sys-user-webauthn-credential.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { deriveDataSubkey, describeDataEncryptionKey, openSensitiveValue, sealSensitiveValue } from '../utils/data-encryption.js'
import { EphemeralTicketStore } from '../utils/ephemeral-ticket-store.js'
import { BizError } from '../utils/errors.js'
import { isAdminSessionIdleExpired } from '../utils/admin-session-idle.js'
import { hashSessionToken } from '../utils/session-token.js'
import { verifyPassword } from '../utils/password.js'
import type { RequestMeta } from '../utils/request-meta.js'
import {
  buildTotpUri,
  generateRecoveryCode,
  generateTotpSecret,
  isRecoveryCodeShape,
  matchTotpStep,
  normalizeRecoveryCode,
} from '../utils/totp.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { auditService } from './audit.service.js'
import { authSecurityService } from './auth-security.service.js'
import { customerServiceRealtimeService } from './customer-service-realtime.service.js'

const ENROLLMENT_TTL_MS = 10 * 60 * 1000
const ENROLLMENT_MAX_ATTEMPTS = 5
const RECOVERY_CODE_COUNT = 10
const RECOVERY_DIGEST_LABEL = 'admin-mfa-recovery-code.v1'
const KEY_UNAVAILABLE_MESSAGE = '数据加密密钥不可用，暂时无法开启两步验证，请联系管理员检查服务端数据目录中的密钥文件'

interface PendingEnrollment {
  userId: string
  secret: string
  sessionDigest: string
  passwordHash: string
  role: SysUser['role']
  status: SysUser['status']
  deactivatedAt: number
  restoredAt: number
  mfaId: string | null
  mfaRevision: number | null
  expiresAt: number
  attemptsLeft: number
}

const pendingEnrollmentStore = new EphemeralTicketStore<PendingEnrollment>({
  maxSize: 2000,
  resolveExpiresAt: (ticket) => ticket.expiresAt,
})

export interface AdminMfaFactorInput {
  code?: string | null
  recoveryCode?: string | null
  stepUpProof?: string | null
}

export type AdminMfaFactorMethod = 'totp' | 'recovery_code' | 'webauthn'

export type AdminMfaFactorResult =
  | { ok: true; method: AdminMfaFactorMethod; recoveryCodesRemaining: number }
  | { ok: false; reason: 'not_enabled' | 'factor_missing' | 'code_mismatch' | 'secret_unreadable' }

export interface AdminMfaStatus {
  enabled: boolean
  mfaRequired: boolean
  totpEnabled: boolean
  availableMethods: Array<'totp' | 'recovery_code' | 'webauthn'>
  enabledAt: Date | null
  recoveryCodesRemaining: number
}

const secretContext = (userId: string | number) => `sys_user_mfa:${String(userId)}:totp_secret`

/**
 * 恢复码摘要列表同时记录生成时的数据加密密钥 ID：密钥被更换后摘要注定对不上，
 * 据此直接判定“无法校验”，而不是把正确的恢复码当成错码计入登录失败锁定。
 */
function parseRecoveryDigests(json: string | null | undefined): { digests: string[]; keyId: string | null } {
  try {
    const parsed = JSON.parse(json ?? '') as { codes?: unknown; kid?: unknown }
    return {
      digests: Array.isArray(parsed.codes)
        ? parsed.codes.filter((digest): digest is string => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest))
        : [],
      keyId: typeof parsed.kid === 'string' ? parsed.kid : null,
    }
  } catch {
    return { digests: [], keyId: null }
  }
}

const serializeRecoveryDigests = (digests: string[], keyId: string | null) => JSON.stringify({ v: 1, kid: keyId, codes: digests })
const currentDataKeyId = () => describeDataEncryptionKey()?.keyId ?? null

function digestRecoveryCode(userId: string | number, normalizedCode: string): string | null {
  const key = deriveDataSubkey(RECOVERY_DIGEST_LABEL)
  if (!key) return null
  return createHmac('sha256', key).update(`${String(userId)}:${normalizedCode}`).digest('hex')
}

function isSameDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

const actorOf = (auth: AuthUserContext) => ({ userId: auth.userId, username: auth.username, displayName: auth.displayName })

export class AdminMfaService {
  private readonly repo = AppDataSource.getRepository(SysUserMfa)

  private generateRecoveryCodes(userId: string | number): { codes: string[]; digests: string[] } {
    const codes: string[] = []
    const digests: string[] = []
    while (codes.length < RECOVERY_CODE_COUNT) {
      const code = generateRecoveryCode()
      const digest = digestRecoveryCode(userId, normalizeRecoveryCode(code))
      if (!digest) throw new BizError(KEY_UNAVAILABLE_MESSAGE, 503)
      if (digests.includes(digest)) continue
      codes.push(code)
      digests.push(digest)
    }
    return { codes, digests }
  }

  /** 首次绑定第二因素或明确开启密码后 MFA 时创建策略；恢复码仅在创建响应中返回。 */
  async enableWithWebauthnInTransaction(manager: EntityManager, userId: string): Promise<string[]> {
    const repo = manager.getRepository(SysUserMfa)
    if (await repo.countBy({ userId })) return []
    const { codes, digests } = this.generateRecoveryCodes(userId)
    await repo.insert({ userId, totpSecretSealed: null,
      recoveryCodesJson: serializeRecoveryDigests(digests, currentDataKeyId()), enabledAt: new Date(),
      lastUsedStep: null, factorRevision: 1 })
    return codes
  }

  async bumpFactorRevision(manager: EntityManager, userId: string): Promise<void> {
    await manager.getRepository(SysUserMfa).createQueryBuilder().update(SysUserMfa)
      .set({ factorRevision: () => 'factor_revision + 1' }).where('user_id = :userId', { userId }).execute()
  }

  async getStatus(userId: string): Promise<AdminMfaStatus> {
    const record = await this.repo
      .createQueryBuilder('mfa')
      .addSelect(['mfa.recoveryCodesJson', 'mfa.totpSecretSealed'])
      .where('mfa.user_id = :userId', { userId })
      .getOne()
    if (!record) {
      return { enabled: false, mfaRequired: false, totpEnabled: false, availableMethods: [], enabledAt: null, recoveryCodesRemaining: 0 }
    }
    const remaining = parseRecoveryDigests(record.recoveryCodesJson).digests.length
    const availableMethods: AdminMfaStatus['availableMethods'] = []
    if (record.totpSecretSealed) availableMethods.push('totp')
    if (remaining > 0) availableMethods.push('recovery_code')
    if (await this.countUsableWebauthnCredentials(AppDataSource.manager, userId) > 0) {
      availableMethods.push('webauthn')
    }
    return {
      enabled: Boolean(record.totpSecretSealed),
      mfaRequired: true,
      totpEnabled: Boolean(record.totpSecretSealed),
      availableMethods,
      enabledAt: record.enabledAt,
      recoveryCodesRemaining: remaining,
    }
  }

  async hasRecoveryCodes(manager: EntityManager, userId: string): Promise<boolean> {
    const record = await manager.getRepository(SysUserMfa).createQueryBuilder('mfa')
      .addSelect('mfa.recoveryCodesJson').where('mfa.user_id = :userId', { userId }).getOne()
    return Boolean(record && parseRecoveryDigests(record.recoveryCodesJson).digests.length)
  }

  /** 当前 RP 可验签的合法用途密钥；旧 RP 密钥仍可列表管理，但不构成当前密码 MFA 因素。 */
  async countUsableWebauthnCredentials(manager: EntityManager, userId: string,
    usage?: 'passwordless' | 'second_factor'): Promise<number> {
    if (!webauthnConfig.enabled || !webauthnConfig.rpId) return 0
    return manager.getRepository(SysUserWebauthnCredential).countBy({
      userId, rpId: webauthnConfig.rpId, usage: usage ?? In(['passwordless', 'second_factor']),
    })
  }

  async verifyFactorOrProof(manager: EntityManager, auth: AuthUserContext, factor: AdminMfaFactorInput,
    action: import('./admin-webauthn.service.js').AdminStepUpAction, targetId?: string): Promise<AdminMfaFactorResult> {
    await this.assertSessionLiveUnderAccountLock(manager, auth)
    if (factor.stepUpProof) {
      if (factor.code || factor.recoveryCode) return { ok: false, reason: 'factor_missing' }
      const { adminWebauthnService } = await import('./admin-webauthn.service.js')
      await adminWebauthnService.consumeStepUpProofInTransaction(manager, auth, factor.stepUpProof, action, targetId)
      return { ok: true, method: 'webauthn', recoveryCodesRemaining: 0 }
    }
    if (Boolean(factor.code) === Boolean(factor.recoveryCode)) return { ok: false, reason: 'factor_missing' }
    return this.verifyFactor(manager, auth.userId, factor)
  }

  /** 敏感事务取得账号锁后仍须核实会话；HTTP 层鉴权不覆盖排队期间的撤销和空闲超时。 */
  async assertSessionLiveUnderAccountLock(manager: EntityManager, auth: AuthUserContext): Promise<void> {
    const session = await manager.getRepository(SysUserSession).findOneBy({
      userId: auth.userId, sessionToken: hashSessionToken(auth.sessionToken),
    })
    const now = new Date()
    if (!session || session.expiresAt <= now || isAdminSessionIdleExpired(session, now)) {
      throw new BizError('登录状态已失效，请重新登录', 401)
    }
  }

  async isEnabled(userId: string, manager?: EntityManager): Promise<boolean> {
    const repo = manager ? manager.getRepository(SysUserMfa) : this.repo
    return (await repo.count({ where: { userId } })) > 0
  }

  /** 用户列表批量标注两步验证状态；返回值统一为字符串 ID，SQLite 下主键运行时为数字。 */
  async listEnabledUserIds(userIds: Array<string | number>): Promise<Set<string>> {
    if (!userIds.length) return new Set()
    const rows = await this.repo.find({ where: { userId: In(userIds.map(String)) }, select: { id: true, userId: true } })
    return new Set(rows.map((row) => String(row.userId)))
  }

  async listTotpEnabledUserIds(userIds: Array<string | number>): Promise<Set<string>> {
    if (!userIds.length) return new Set()
    const rows = await this.repo.createQueryBuilder('mfa').addSelect('mfa.totpSecretSealed')
      .where('mfa.user_id IN (:...userIds)', { userIds: userIds.map(String) }).getMany()
    return new Set(rows.filter((row) => Boolean(row.totpSecretSealed)).map((row) => String(row.userId)))
  }

  /** 发起绑定：调用方必须已完成当前密码复核；同一账号重复发起时覆盖旧的待确认秘钥。 */
  async beginEnrollment(auth: AuthUserContext, input: AdminMfaFactorInput & { currentPassword: string }, requestMeta?: RequestMeta) {
    const snapshot = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, auth.userId)
      const user = await manager.getRepository(SysUser).createQueryBuilder('user')
        .addSelect('user.passwordHash').where('user.id = :id', { id: auth.userId }).getOneOrFail()
      if (!await verifyPassword(input.currentPassword.trim(), user.passwordHash)) throw new BizError('当前密码错误', 400)
      const mfa = await manager.getRepository(SysUserMfa).createQueryBuilder('mfa')
        .addSelect('mfa.totpSecretSealed').where('mfa.user_id = :userId', { userId: auth.userId }).getOne()
      if (mfa?.totpSecretSealed) throw new BizError('动态码已开启；请先单独停用再重新绑定', 409)
      if (mfa) {
        const factor = await this.verifyFactorOrProof(manager, auth, input, 'mfa.totp.enroll')
        if (!factor.ok) throw new BizError('身份复核未通过', 400)
      }
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      return { sessionDigest: hashSessionToken(auth.sessionToken), passwordHash: user.passwordHash,
        role: user.role, status: user.status,
        deactivatedAt: user.deactivatedAt?.getTime() ?? 0, restoredAt: user.restoredAt?.getTime() ?? 0,
        mfaId: mfa?.id ?? null, mfaRevision: mfa?.factorRevision ?? null }
    })
    if (!deriveDataSubkey(RECOVERY_DIGEST_LABEL)) {
      throw new BizError(KEY_UNAVAILABLE_MESSAGE, 503)
    }
    const secret = generateTotpSecret()
    pendingEnrollmentStore.set(String(auth.userId), {
      userId: String(auth.userId),
      secret,
      ...snapshot,
      expiresAt: Date.now() + ENROLLMENT_TTL_MS,
      attemptsLeft: ENROLLMENT_MAX_ATTEMPTS,
    })
    await auditService.safeRecord({
      actionType: 'auth.mfa.enroll_start',
      actionLabel: '发起绑定两步验证',
      targetType: 'user',
      targetId: auth.userId,
      targetCode: auth.username,
      actor: actorOf(auth),
      requestMeta,
    })
    return {
      secret,
      otpauthUri: buildTotpUri({ accountName: auth.username, secret }),
      expiresInSeconds: Math.floor(ENROLLMENT_TTL_MS / 1000),
    }
  }

  /** 确认绑定：动态码正确才落库；错误次数用尽后作废待确认秘钥，需重新发起。 */
  async confirmEnrollment(auth: AuthUserContext, code: string, requestMeta?: RequestMeta): Promise<{ recoveryCodes: string[] }> {
    const ticketKey = String(auth.userId)
    const pending = pendingEnrollmentStore.get(ticketKey)
    if (!pending) {
      throw new BizError('绑定已过期，请重新发起绑定', 409)
    }
    const matchedStep = matchTotpStep(pending.secret, code)
    if (matchedStep === null) {
      const attemptsLeft = pending.attemptsLeft - 1
      if (attemptsLeft > 0) {
        pendingEnrollmentStore.set(ticketKey, { ...pending, attemptsLeft })
      } else {
        pendingEnrollmentStore.delete(ticketKey)
      }
      await auditService.safeRecord({
        actionType: 'auth.mfa.enable',
        actionLabel: '开启两步验证',
        targetType: 'user',
        targetId: auth.userId,
        targetCode: auth.username,
        actor: actorOf(auth),
        resultStatus: 'failed',
        requestMeta,
        detail: { reason: 'code_mismatch', attemptsLeft },
      })
      throw new BizError(
        attemptsLeft > 0 ? '动态码不正确，请确认手机时间准确后输入最新的 6 位动态码' : '动态码错误次数过多，请重新发起绑定',
        400,
      )
    }

    const { codes, digests } = this.generateRecoveryCodes(auth.userId)
    const sealedSecret = sealSensitiveValue(secretContext(auth.userId), pending.secret)
    await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, auth.userId)
      const repo = manager.getRepository(SysUserMfa)
      const user = await manager.getRepository(SysUser).createQueryBuilder('user')
        .addSelect('user.passwordHash').where('user.id = :id', { id: auth.userId }).getOneOrFail()
      const existing = await repo.createQueryBuilder('mfa').addSelect('mfa.totpSecretSealed')
        .where('mfa.user_id = :userId', { userId: auth.userId }).getOne()
      const session = await manager.getRepository(SysUserSession).findOneBy({ userId: auth.userId, sessionToken: pending.sessionDigest })
      const now = new Date()
      if (!session || session.expiresAt <= now || isAdminSessionIdleExpired(session, now)
        || pending.sessionDigest !== hashSessionToken(auth.sessionToken)
        || user.passwordHash !== pending.passwordHash || user.role !== pending.role || user.status !== pending.status
        || (user.deactivatedAt?.getTime() ?? 0) !== pending.deactivatedAt
        || (user.restoredAt?.getTime() ?? 0) !== pending.restoredAt
        || (existing?.id ?? null) !== pending.mfaId || (existing?.factorRevision ?? null) !== pending.mfaRevision
        || existing?.totpSecretSealed) {
        throw new BizError('账号安全设置已变化，请重新绑定', 409)
      }
      if (existing) {
        existing.totpSecretSealed = sealedSecret
        existing.lastUsedStep = matchedStep
        existing.factorRevision += 1
        await repo.save(existing)
      } else {
        await repo.insert({ userId: auth.userId, totpSecretSealed: sealedSecret,
          recoveryCodesJson: serializeRecoveryDigests(digests, currentDataKeyId()),
          enabledAt: new Date(), lastUsedStep: matchedStep, factorRevision: 1 })
      }
      await auditService.record(
        {
          actionType: 'auth.mfa.enable',
          actionLabel: '开启两步验证',
          targetType: 'user',
          targetId: auth.userId,
          targetCode: auth.username,
          actor: actorOf(auth),
          requestMeta,
          detail: { recoveryCodeCount: existing ? 0 : codes.length },
        },
        manager,
      )
    })
    pendingEnrollmentStore.delete(ticketKey)
    return { recoveryCodes: pending.mfaId ? [] : codes }
  }

  /**
   * 在调用方事务内校验第二因素（动态码或恢复码二选一）：
   * - 成功时同时推进防重放游标或消耗恢复码，调用方事务回滚则一并撤销；
   * - 只返回结果，不写失败计数与审计，由调用方按场景处理（登录、停用、重生成恢复码）。
   */
  async verifyFactor(
    manager: EntityManager,
    userId: string,
    factor: AdminMfaFactorInput,
    nowMs = Date.now(),
  ): Promise<AdminMfaFactorResult> {
    const repo = manager.getRepository(SysUserMfa)
    const record = await repo
      .createQueryBuilder('mfa')
      .addSelect(['mfa.totpSecretSealed', 'mfa.recoveryCodesJson'])
      .where('mfa.user_id = :userId', { userId })
      .getOne()
    if (!record) {
      return { ok: false, reason: 'not_enabled' }
    }
    const { digests, keyId: digestKeyId } = parseRecoveryDigests(record.recoveryCodesJson)

    const code = factor.code?.replace(/\s/g, '') ?? ''
    if (code) {
      if (!record.totpSecretSealed) return { ok: false, reason: 'factor_missing' }
      const opened = openSensitiveValue(secretContext(userId), record.totpSecretSealed)
      // 秘钥只接受本服务加密写入的密文；明文或无法解密都视为数据异常，不能退化为“无需第二因素”。
      if (opened.state !== 'sealed') {
        return { ok: false, reason: 'secret_unreadable' }
      }
      const matchedStep = matchTotpStep(opened.value, code, { nowMs, afterStep: record.lastUsedStep })
      if (matchedStep === null) {
        return { ok: false, reason: 'code_mismatch' }
      }
      const updated = await repo
        .createQueryBuilder()
        .update(SysUserMfa)
        .set({ lastUsedStep: matchedStep })
        .where('id = :id', { id: record.id })
        .andWhere('(last_used_step IS NULL OR last_used_step < :step)', { step: matchedStep })
        .execute()
      if (updated.affected === 0) {
        return { ok: false, reason: 'code_mismatch' }
      }
      return { ok: true, method: 'totp', recoveryCodesRemaining: digests.length }
    }

    const recoveryCode = normalizeRecoveryCode(factor.recoveryCode ?? '')
    if (recoveryCode) {
      if (!isRecoveryCodeShape(recoveryCode)) {
        return { ok: false, reason: 'code_mismatch' }
      }
      const candidate = digestRecoveryCode(userId, recoveryCode)
      const keyId = currentDataKeyId()
      if (!candidate || (digestKeyId && keyId && digestKeyId !== keyId)) {
        return { ok: false, reason: 'secret_unreadable' }
      }
      let matchedIndex = -1
      digests.forEach((digest, index) => {
        if (isSameDigest(digest, candidate) && matchedIndex < 0) matchedIndex = index
      })
      if (matchedIndex < 0) {
        return { ok: false, reason: 'code_mismatch' }
      }
      const remaining = digests.filter((_, index) => index !== matchedIndex)
      const updated = await repo
        .createQueryBuilder()
        .update(SysUserMfa)
        .set({ recoveryCodesJson: serializeRecoveryDigests(remaining, digestKeyId) })
        .where('id = :id', { id: record.id })
        .andWhere('recovery_codes_json = :previous', { previous: record.recoveryCodesJson })
        .execute()
      if (updated.affected === 0) {
        return { ok: false, reason: 'code_mismatch' }
      }
      return { ok: true, method: 'recovery_code', recoveryCodesRemaining: remaining.length }
    }

    return { ok: false, reason: 'factor_missing' }
  }

  /** 本人自助场景的第二因素失败处理：错误码计入登录失败锁定并留痕，其余原因给出明确提示。 */
  private async rejectSelfServiceFactor(
    auth: AuthUserContext,
    result: Extract<AdminMfaFactorResult, { ok: false }>,
    requestMeta: RequestMeta | undefined,
    audit: { actionType: string; actionLabel: string },
  ): Promise<never> {
    if (result.reason === 'not_enabled') {
      throw new BizError('当前账号未开启两步验证', 409)
    }
    if (result.reason === 'factor_missing') {
      throw new BizError('请输入 6 位动态码或恢复码', 400)
    }
    await auditService.safeRecord({
      actionType: audit.actionType,
      actionLabel: audit.actionLabel,
      targetType: 'user',
      targetId: auth.userId,
      targetCode: auth.username,
      actor: actorOf(auth),
      resultStatus: 'failed',
      requestMeta,
      detail: { reason: result.reason },
    })
    if (result.reason === 'secret_unreadable') {
      throw new BizError('两步验证数据无法解密，请联系其他管理员重置两步验证', 409)
    }
    await authSecurityService.recordAdminLoginFailure(requestMeta, auth.username)
    throw new BizError('动态码或恢复码不正确', 400)
  }

  /** 停用：调用方已复核当前密码，这里再校验动态码或恢复码。 */
  async disable(auth: AuthUserContext, factor: AdminMfaFactorInput & { currentPassword: string }, requestMeta?: RequestMeta): Promise<void> {
    const outcome = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, auth.userId)
      const user = await manager.getRepository(SysUser).createQueryBuilder('user').addSelect('user.passwordHash')
        .where('user.id = :id', { id: auth.userId }).getOneOrFail()
      if (!await verifyPassword(factor.currentPassword.trim(), user.passwordHash)) throw new BizError('当前密码错误', 400)
      if (!await manager.getRepository(SysUserMfa).countBy({ userId: auth.userId })) throw new BizError('当前账号未开启两步验证', 409)
      const result = await this.verifyFactorOrProof(manager, auth, factor, 'mfa.disable_all')
      if (!result.ok) return result
      await manager.getRepository(SysUserMfa).delete({ userId: auth.userId })
      await manager.getRepository(SysUserWebauthnCredential).delete({ userId: auth.userId, usage: 'second_factor' })
      await manager.getRepository(SysUserSession).delete({ userId: auth.userId })
      await auditService.record(
        {
          actionType: 'auth.mfa.disable',
          actionLabel: '停用两步验证',
          targetType: 'user',
          targetId: auth.userId,
          targetCode: auth.username,
          actor: actorOf(auth),
          requestMeta,
          detail: { method: result.method },
        },
        manager,
      )
      return result
    })
    if (!outcome.ok) {
      await this.rejectSelfServiceFactor(auth, outcome, requestMeta, { actionType: 'auth.mfa.disable', actionLabel: '停用两步验证' })
    }
    customerServiceRealtimeService.disconnectByOwner('service', auth.userId)
  }

  async disableTotp(auth: AuthUserContext, factor: AdminMfaFactorInput & { currentPassword: string }, requestMeta?: RequestMeta): Promise<void> {
    const outcome = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, auth.userId)
      const user = await manager.getRepository(SysUser).createQueryBuilder('user').addSelect('user.passwordHash')
        .where('user.id = :id', { id: auth.userId }).getOneOrFail()
      if (!await verifyPassword(factor.currentPassword.trim(), user.passwordHash)) throw new BizError('当前密码错误', 400)
      const mfa = await manager.getRepository(SysUserMfa).createQueryBuilder('mfa')
        .addSelect('mfa.totpSecretSealed').where('mfa.user_id = :userId', { userId: auth.userId }).getOne()
      if (!mfa?.totpSecretSealed) throw new BizError('当前未开启动态码', 409)
      const result = await this.verifyFactorOrProof(manager, auth, factor, 'mfa.totp.disable')
      if (!result.ok) return result
      const remainingKeys = await this.countUsableWebauthnCredentials(manager, auth.userId)
      if (!remainingKeys) throw new BizError('不能移除最后一个常规验证方式，请使用明确停用全部两步验证', 409)
      mfa.totpSecretSealed = null
      mfa.lastUsedStep = null
      mfa.factorRevision += 1
      await manager.getRepository(SysUserMfa).save(mfa)
      await auditService.record({ actionType: 'auth.mfa.totp.disable', actionLabel: '单独停用动态码',
        targetType: 'user', targetId: auth.userId, targetCode: auth.username, actor: actorOf(auth), requestMeta,
        detail: { method: result.method } }, manager)
      return result
    })
    if (!outcome.ok) await this.rejectSelfServiceFactor(auth, outcome, requestMeta,
      { actionType: 'auth.mfa.totp.disable', actionLabel: '单独停用动态码' })
  }

  /** 重新生成恢复码：调用方已复核当前密码，这里只接受动态码（恢复码不能用来换新恢复码）。 */
  async regenerateRecoveryCodes(auth: AuthUserContext, input: AdminMfaFactorInput & { currentPassword: string }, requestMeta?: RequestMeta): Promise<{ recoveryCodes: string[] }> {
    const { codes, digests } = this.generateRecoveryCodes(auth.userId)
    const outcome = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, auth.userId)
      const user = await manager.getRepository(SysUser).createQueryBuilder('user').addSelect('user.passwordHash')
        .where('user.id = :id', { id: auth.userId }).getOneOrFail()
      if (!await verifyPassword(input.currentPassword.trim(), user.passwordHash)) throw new BizError('当前密码错误', 400)
      if (!await manager.getRepository(SysUserMfa).countBy({ userId: auth.userId })) throw new BizError('当前账号未开启两步验证', 409)
      if (input.recoveryCode) throw new BizError('恢复码不能用于重新生成恢复码', 400)
      const result = await this.verifyFactorOrProof(manager, auth, input, 'mfa.recovery_codes')
      if (!result.ok) return result
      await manager.getRepository(SysUserMfa).createQueryBuilder().update(SysUserMfa)
        .set({ recoveryCodesJson: serializeRecoveryDigests(digests, currentDataKeyId()), factorRevision: () => 'factor_revision + 1' })
        .where('user_id = :userId', { userId: auth.userId }).execute()
      await auditService.record(
        {
          actionType: 'auth.mfa.recovery_codes.regenerate',
          actionLabel: '重新生成两步验证恢复码',
          targetType: 'user',
          targetId: auth.userId,
          targetCode: auth.username,
          actor: actorOf(auth),
          requestMeta,
          detail: { recoveryCodeCount: codes.length },
        },
        manager,
      )
      return result
    })
    if (!outcome.ok) {
      await this.rejectSelfServiceFactor(auth, outcome, requestMeta, {
        actionType: 'auth.mfa.recovery_codes.regenerate',
        actionLabel: '重新生成两步验证恢复码',
      })
    }
    return { recoveryCodes: codes }
  }

  /** 在调用方事务内删除两步验证记录（管理员重置、账号永久删除）；返回是否确有记录被删除。 */
  async deleteForUser(manager: EntityManager, userId: string): Promise<boolean> {
    const deleted = await manager.getRepository(SysUserMfa).delete({ userId })
    return (deleted.affected ?? 0) > 0
  }

  /**
   * 命令行应急重置（服务器本地执行，等同于数据库管理权限）：
   * 唯一管理员丢失认证器且恢复码用尽、或数据加密密钥丢失时的最后手段；审计记为无操作人、来源 cli。
   */
  async resetByUsernameFromCli(username: string): Promise<{ reset: boolean; username: string }> {
    return runInTransaction(async (manager) => {
      const query = manager.getRepository(SysUser).createQueryBuilder('user').where('user.username = :username', { username })
      if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
      const user = await query.getOne()
      if (!user) {
        throw new BizError('账号不存在', 404)
      }
      const reset = await this.deleteForUser(manager, user.id)
      if (reset) {
        await manager.getRepository(SysUserWebauthnCredential).delete({ userId: user.id, usage: 'second_factor' })
        await manager.getRepository(SysUserSession).delete({ userId: user.id })
        await auditService.record(
          {
            actionType: 'user.mfa.reset',
            actionLabel: '重置两步验证',
            targetType: 'user',
            targetId: user.id,
            targetCode: user.username,
            actor: null,
            detail: { via: 'cli' },
          },
          manager,
        )
      }
      return { reset, username: user.username }
    })
  }
}

export const adminMfaService = new AdminMfaService()
