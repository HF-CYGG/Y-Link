/** 管理端 WebAuthn 的一次性挑战与凭据事务入口。票据为单进程短期状态。 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { webauthnConfig } from '../config/webauthn.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { SysUserMfa } from '../entities/sys-user-mfa.entity.js'
import { SysUserWebauthnCredential } from '../entities/sys-user-webauthn-credential.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { EphemeralTicketStore } from '../utils/ephemeral-ticket-store.js'
import { BizError } from '../utils/errors.js'
import { hashSessionToken } from '../utils/session-token.js'
import { isAdminSessionIdleExpired } from '../utils/admin-session-idle.js'
import { verifyPassword } from '../utils/password.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { isAccountCurrentlyDeactivated, lockSysAccountsInStableOrder } from './account-business-guard.service.js'
import { authService } from './auth.service.js'
import { authSecurityService } from './auth-security.service.js'
import { adminMfaService, type AdminMfaFactorInput } from './admin-mfa.service.js'
import { auditService } from './audit.service.js'
import { customerServiceRealtimeService } from './customer-service-realtime.service.js'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
interface LoginTicket {
  purpose: 'login'
  challenge: string
  nonceDigest: string
  expectedOrigin: string
  expectedRpId: string
  expiresAt: number
}
const loginTickets = new EphemeralTicketStore<LoginTicket>({ maxSize: 5000, resolveExpiresAt: (ticket) => ticket.expiresAt })

export const ADMIN_STEP_UP_ACTIONS = [
  'webauthn.register', 'webauthn.delete', 'mfa.totp.enroll', 'mfa.totp.disable',
  'mfa.disable_all', 'mfa.recovery_codes', 'mfa.webauthn.enable',
  'user.mfa.reset', 'user.webauthn.reset',
] as const
export type AdminStepUpAction = typeof ADMIN_STEP_UP_ACTIONS[number]
interface AccountSecuritySnapshot {
  passwordHash: string
  role: SysUser['role']
  status: SysUser['status']
  deactivatedAt: number
  restoredAt: number
  mfaId: string | null
  mfaRevision: number | null
}
interface BoundChallenge extends AccountSecuritySnapshot {
  userId: string
  sessionDigest: string
  action: AdminStepUpAction
  targetId: string | null
  challenge: string
  expectedOrigin: string
  expectedRpId: string
  allowedIds: string[]
  verifiedUsage?: 'passwordless' | 'second_factor'
  expiresAt: number
}
interface MfaChallenge {
  userId: string
  mfaTicketDigest: string
  nonceDigest: string
  challenge: string
  expectedOrigin: string
  expectedRpId: string
  allowedIds: string[]
  expiresAt: number
}
const mfaChallenges = new EphemeralTicketStore<MfaChallenge>({ maxSize: 5000, resolveExpiresAt: (ticket) => ticket.expiresAt })
const stepUpChallenges = new EphemeralTicketStore<BoundChallenge>({ maxSize: 5000, resolveExpiresAt: (ticket) => ticket.expiresAt })
const stepUpProofs = new EphemeralTicketStore<BoundChallenge>({ maxSize: 5000, resolveExpiresAt: (ticket) => ticket.expiresAt })

interface RegisterTicket {
  purpose: 'register'
  userId: string
  sessionDigest: string
  challenge: string
  expectedOrigin: string
  expectedRpId: string
  securitySnapshot: {
    passwordHash: string
    role: SysUser['role']
    status: SysUser['status']
    deactivatedAt: number
    restoredAt: number
    mfaId: string | null
    mfaEnabledAt: number | null
    mfaRevision: number | null
    userHandle: string
  }
  name: string
  usage: 'passwordless' | 'second_factor'
  expiresAt: number
}
const registerTickets = new EphemeralTicketStore<RegisterTicket>({ maxSize: 5000, resolveExpiresAt: (ticket) => ticket.expiresAt })

export function requireWebauthnEnabled(): { rpId: string; rpName: string; allowedOrigins: string[] } {
  if (!webauthnConfig.enabled || !webauthnConfig.rpId || !webauthnConfig.rpName) {
    throw new BizError('当前未开启通行密钥登录', 403, { reason: 'WEBAUTHN_FEATURE_DISABLED' })
  }
  return { rpId: webauthnConfig.rpId, rpName: webauthnConfig.rpName, allowedOrigins: webauthnConfig.allowedOrigins }
}

export function assertWebauthnOrigin(origin: string | undefined): string {
  const config = requireWebauthnEnabled()
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new BizError('WebAuthn 请求来源不受信任', 403, { reason: 'WEBAUTHN_ORIGIN_DENIED' })
  }
  return origin
}

const nonceDigest = (nonce: string) => createHash('sha256').update('admin-webauthn-nonce.v1\u0000').update(nonce).digest('hex')
const sameHex = (a: string, b: string) => {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

export class AdminWebauthnService {
  private readonly credentialRepo = AppDataSource.getRepository(SysUserWebauthnCredential)

  private async lockUser(manager: EntityManager, userId: string): Promise<SysUser> {
    const query = manager.getRepository(SysUser).createQueryBuilder('user')
      .addSelect(['user.passwordHash', 'user.webauthnUserHandle'])
      .where('user.id = :userId', { userId })
    if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
    const user = await query.getOne()
    if (!user || user.status !== 'enabled' || isAccountCurrentlyDeactivated(user)) {
      throw new BizError('当前账号已停用或已注销', 403)
    }
    return user
  }

  /** 账号锁之后确认绑定会话仍有效；管理员并发撤销必须使已取得 challenge 的旧请求失效。 */
  private async assertSessionLiveUnderAccountLock(manager: EntityManager, auth: AuthUserContext): Promise<void> {
    const session = await manager.getRepository(SysUserSession).findOneBy({
      userId: auth.userId, sessionToken: hashSessionToken(auth.sessionToken),
    })
    const now = new Date()
    if (!session || session.expiresAt <= now || isAdminSessionIdleExpired(session, now)) {
      throw new BizError('登录状态已失效，请重新登录', 401, { reason: 'WEBAUTHN_CHALLENGE_EXPIRED' })
    }
  }

  private snapshot(user: SysUser, mfa: SysUserMfa | null): AccountSecuritySnapshot {
    return { passwordHash: user.passwordHash, role: user.role, status: user.status,
      deactivatedAt: user.deactivatedAt?.getTime() ?? 0, restoredAt: user.restoredAt?.getTime() ?? 0,
      mfaId: mfa?.id ?? null, mfaRevision: mfa?.factorRevision ?? null }
  }

  private async assertSnapshot(manager: EntityManager, user: SysUser, snapshot: AccountSecuritySnapshot): Promise<void> {
    const mfa = await manager.getRepository(SysUserMfa).findOneBy({ userId: user.id })
    const current = this.snapshot(user, mfa)
    if (Object.keys(current).some((key) => current[key as keyof AccountSecuritySnapshot] !== snapshot[key as keyof AccountSecuritySnapshot])) {
      throw new BizError('账号安全设置已变化，请重新验证', 409, { reason: 'WEBAUTHN_CHALLENGE_EXPIRED' })
    }
  }

  private parseCredentialId(response: AuthenticationResponseJSON): { bytes: Buffer; digest: string } {
    const rawId = response.rawId
    const bytes = typeof rawId === 'string' ? Buffer.from(rawId, 'base64url') : Buffer.alloc(0)
    if (!bytes.length || bytes.length > 1024 || bytes.toString('base64url') !== rawId || response.id !== rawId) {
      throw new BizError('通行密钥凭据无效', 401, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
    }
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }
  }

  private async verifyCredentialForUser(manager: EntityManager, user: SysUser, response: AuthenticationResponseJSON,
    challenge: { challenge: string; expectedOrigin: string; expectedRpId: string; allowedIds: string[] }): Promise<false | 'passwordless' | 'second_factor'> {
    const { bytes, digest } = this.parseCredentialId(response)
    if (!challenge.allowedIds.includes(digest)) return false
    const query = manager.getRepository(SysUserWebauthnCredential).createQueryBuilder('credential')
      .addSelect(['credential.credentialId', 'credential.publicKey'])
      .where('credential.user_id = :userId AND credential.rp_id = :rpId AND credential.credential_id_sha256 = :digest',
        { userId: user.id, rpId: challenge.expectedRpId, digest })
    if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
    const credential = await query.getOne()
    if (!credential || !Buffer.from(credential.credentialId).equals(bytes)) return false
    const handle = response.response.userHandle
    if (handle) {
      if (!user.webauthnUserHandle) return false
      const bytesHandle = Buffer.from(handle, 'base64url')
      const expectedHandle = Buffer.from(user.webauthnUserHandle, 'hex')
      if (bytesHandle.toString('base64url') !== handle || bytesHandle.length !== expectedHandle.length
        || !timingSafeEqual(bytesHandle, expectedHandle)) return false
    }
    const requireUV = credential.usage === 'passwordless'
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      verification = await verifyAuthenticationResponse({ response,
        expectedChallenge: challenge.challenge, expectedOrigin: challenge.expectedOrigin,
        expectedRPID: challenge.expectedRpId, requireUserVerification: requireUV,
        credential: { id: bytes.toString('base64url'), publicKey: new Uint8Array(credential.publicKey),
          counter: Number(credential.counter),
          transports: credential.transportsJson ? JSON.parse(credential.transportsJson) as string[] : undefined } })
    } catch { return false }
    // SDK 默认 WebAuthn 路径已强制 UP；第二因素仅放宽 UV。
    if (!verification.verified || (requireUV && !verification.authenticationInfo.userVerified)
      || verification.authenticationInfo.credentialID !== bytes.toString('base64url')) return false
    credential.counter = String(verification.authenticationInfo.newCounter)
    credential.deviceType = verification.authenticationInfo.credentialDeviceType
    credential.backedUp = verification.authenticationInfo.credentialBackedUp
    credential.lastUsedAt = new Date()
    await manager.getRepository(SysUserWebauthnCredential).save(credential)
    return credential.usage
  }

  async listCredentials(userId: string) {
    const credentials = await this.credentialRepo.find({
      where: { userId }, order: { createdAt: 'DESC', id: 'DESC' },
    })
    return credentials.map((credential) => this.toSafeCredential(credential))
  }

  private toSafeCredential(credential: SysUserWebauthnCredential) {
    return {
      id: String(credential.id), name: credential.name, createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt, deviceType: credential.deviceType, backedUp: credential.backedUp,
      usage: credential.usage,
    }
  }

  async renameCredential(auth: AuthUserContext, id: string, nameInput: string, requestMeta?: RequestMeta) {
    const name = nameInput.trim()
    if (!name || name.length > 64) throw new BizError('密钥名称长度需为 1 至 64 位', 400)
    return runInTransaction(async (manager) => {
      const user = await this.lockUser(manager, auth.userId)
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      const repo = manager.getRepository(SysUserWebauthnCredential)
      const query = repo.createQueryBuilder('credential').where('credential.id = :id AND credential.user_id = :userId', { id, userId: user.id })
      if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
      const credential = await query.getOne()
      if (!credential) throw new BizError('密钥不存在', 404)
      credential.name = name
      const saved = await repo.save(credential)
      await auditService.record({
        actionType: 'auth.webauthn.rename', actionLabel: '修改通行密钥名称', targetType: 'user', targetId: user.id,
        targetCode: user.username, actor: auth, requestMeta, detail: { credentialRecordId: saved.id },
      }, manager)
      return this.toSafeCredential(saved)
    })
  }

  async deleteCredential(auth: AuthUserContext, id: string, input: {
    currentPassword: string
    code?: string
    recoveryCode?: string
    stepUpProof?: string
  }, requestMeta?: RequestMeta) {
    await authService.verifyStepUpPassword(auth, input.currentPassword, requestMeta, 'auth.webauthn.delete')
    const outcome = await runInTransaction(async (manager) => {
      const user = await this.lockUser(manager, auth.userId)
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      if (!await verifyPassword(input.currentPassword.trim(), user.passwordHash)) return { kind: 'password_invalid' as const }
      const mfa = await manager.getRepository(SysUserMfa).createQueryBuilder('mfa')
        .addSelect('mfa.totpSecretSealed').where('mfa.user_id = :userId', { userId: user.id }).getOne()
      if (mfa) {
        const factor = await adminMfaService.verifyFactorOrProof(manager, auth, input, 'webauthn.delete', id)
        if (!factor.ok) return { kind: 'factor_invalid' as const, reason: factor.reason }
      }
      const repo = manager.getRepository(SysUserWebauthnCredential)
      const query = repo.createQueryBuilder('credential').where('credential.id = :id AND credential.user_id = :userId', { id, userId: user.id })
      if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
      const credential = await query.getOne()
      if (!credential) throw new BizError('密钥不存在', 404)
      if (mfa && !mfa.totpSecretSealed && credential.rpId === webauthnConfig.rpId
        && (credential.usage === 'passwordless' || credential.usage === 'second_factor')
        && await adminMfaService.countUsableWebauthnCredentials(manager, user.id) <= 1) {
        throw new BizError('不能删除最后一个常规验证方式，请使用明确停用全部两步验证', 409)
      }
      await repo.delete({ id: credential.id, userId: user.id })
      if (mfa) await adminMfaService.bumpFactorRevision(manager, user.id)
      const revokedSessions = await manager.getRepository(SysUserSession).delete({ userId: user.id })
      await auditService.record({
        actionType: 'auth.webauthn.delete', actionLabel: '删除通行密钥', targetType: 'user', targetId: user.id,
        targetCode: user.username, actor: auth, requestMeta,
        detail: { credentialRecordId: credential.id, revokedSessions: revokedSessions.affected ?? 0 },
      }, manager)
      return { kind: 'deleted' as const }
    })
    if (outcome.kind !== 'deleted') {
      if (outcome.kind === 'password_invalid' || (outcome.kind === 'factor_invalid' && outcome.reason === 'code_mismatch')) {
        await authSecurityService.recordAdminLoginFailure(requestMeta, auth.username)
      }
      await auditService.safeRecord({
        actionType: 'auth.webauthn.delete', actionLabel: '删除通行密钥', targetType: 'user',
        targetId: auth.userId, actor: auth, requestMeta, resultStatus: 'failed',
        detail: { reason: outcome.kind === 'factor_invalid' ? outcome.reason : outcome.kind },
      })
      throw new BizError('身份复核未通过', 400, { reason: 'WEBAUTHN_STEP_UP_INVALID' })
    }
    customerServiceRealtimeService.disconnectByOwner('service', auth.userId)
    return true
  }

  async resetUserCredentials(targetId: string, actor: AuthUserContext, input: {
    currentPassword: string
    code?: string
    recoveryCode?: string
    stepUpProof?: string
    reason: string
  }, requestMeta?: RequestMeta): Promise<{ revokedCount: number }> {
    const reason = input.reason.trim()
    if (!reason || reason.length > 500) throw new BizError('请输入 1 至 500 字的撤销原因', 400)
    if (String(actor.userId) === String(targetId)) throw new BizError('不能从管理员入口撤销自己的密钥', 400)
    if (actor.role !== 'admin' || !actor.permissions.includes('users:reset_password')) throw new BizError('无权撤销他人密钥', 403)
    await authService.verifyStepUpPassword(actor, input.currentPassword, requestMeta, 'user.webauthn.reset')
    const outcome = await runInTransaction(async (manager) => {
      const accounts = await lockSysAccountsInStableOrder(manager, [actor.userId, targetId])
      const actorUser = accounts.get(String(actor.userId))
      const target = accounts.get(String(targetId))
      if (!actorUser || !target) throw new BizError('目标账号不存在', 404)
      if (actorUser.status !== 'enabled' || isAccountCurrentlyDeactivated(actorUser) || actorUser.role !== 'admin') {
        throw new BizError('操作者账号无效', 403)
      }
      await this.assertSessionLiveUnderAccountLock(manager, actor)
      const actorSecret = await manager.getRepository(SysUser).createQueryBuilder('user')
        .addSelect('user.passwordHash').where('user.id = :id', { id: actorUser.id }).getOneOrFail()
      if (!await verifyPassword(input.currentPassword.trim(), actorSecret.passwordHash)) return { kind: 'password_invalid' as const }
      const mfa = await manager.getRepository(SysUserMfa).findOneBy({ userId: actorUser.id })
      if (mfa) {
        const factor = await adminMfaService.verifyFactorOrProof(manager, actor, input, 'user.webauthn.reset', targetId)
        if (!factor.ok) return { kind: 'factor_invalid' as const, reason: factor.reason }
      }
      const credentials = await manager.getRepository(SysUserWebauthnCredential).delete({ userId: target.id })
      if ((credentials.affected ?? 0) > 0) await adminMfaService.bumpFactorRevision(manager, target.id)
      const sessions = await manager.getRepository(SysUserSession).delete({ userId: target.id })
      await auditService.record({
        actionType: 'user.webauthn.reset', actionLabel: '管理员撤销通行密钥', targetType: 'user', targetId: target.id,
        targetCode: target.username, actor, requestMeta,
        detail: { reason, revokedCount: credentials.affected ?? 0, revokedSessions: sessions.affected ?? 0 },
      }, manager)
      return { kind: 'reset' as const, revokedCount: credentials.affected ?? 0 }
    })
    if (outcome.kind !== 'reset') {
      if (outcome.kind === 'password_invalid' || (outcome.kind === 'factor_invalid' && outcome.reason === 'code_mismatch')) {
        await authSecurityService.recordAdminLoginFailure(requestMeta, actor.username)
      }
      await auditService.safeRecord({
        actionType: 'user.webauthn.reset', actionLabel: '管理员撤销通行密钥', targetType: 'user',
        targetId, actor, requestMeta, resultStatus: 'failed',
        detail: { reason: outcome.kind === 'factor_invalid' ? outcome.reason : outcome.kind },
      })
      throw new BizError('身份复核未通过', 400, { reason: 'WEBAUTHN_STEP_UP_INVALID' })
    }
    customerServiceRealtimeService.disconnectByOwner('service', targetId)
    return { revokedCount: outcome.revokedCount }
  }

  async beginRegistration(auth: AuthUserContext, input: {
    name: string
    kind: 'passkey' | 'security_key'
    usage?: 'passwordless' | 'second_factor'
    currentPassword: string
    code?: string
    recoveryCode?: string
    stepUpProof?: string
  }, origin: string, requestMeta?: RequestMeta) {
    const { rpId, rpName } = requireWebauthnEnabled()
    const name = input.name.trim()
    if (!name || name.length > 64) throw new BizError('密钥名称长度需为 1 至 64 位', 400)
    if (input.usage === 'second_factor' && input.kind !== 'security_key') {
      throw new BizError('第二因素须选择安全密钥注册方式', 400)
    }
    await authService.verifyStepUpPassword(auth, input.currentPassword, requestMeta, 'auth.webauthn.register')
    const outcome = await runInTransaction(async (manager) => {
      const user = await this.lockUser(manager, auth.userId)
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      if (!await verifyPassword(input.currentPassword.trim(), user.passwordHash)) return { kind: 'password_invalid' as const }
      const mfa = await manager.getRepository(SysUserMfa).findOneBy({ userId: user.id })
      if (mfa) {
        const factor = await adminMfaService.verifyFactorOrProof(manager, auth, input, 'webauthn.register')
        if (!factor.ok) return { kind: 'factor_invalid' as const, reason: factor.reason }
      }
      const credentials = await manager.getRepository(SysUserWebauthnCredential)
        .createQueryBuilder('credential')
        .addSelect('credential.credentialId')
        .where('credential.user_id = :userId', { userId: user.id })
        .getMany()
      if (credentials.length >= 10) throw new BizError('每个账号最多绑定 10 把密钥', 409, { reason: 'WEBAUTHN_LIMIT_REACHED' })
      if (!user.webauthnUserHandle) {
        user.webauthnUserHandle = randomBytes(32).toString('hex')
        await manager.getRepository(SysUser).save(user)
      }
      return {
        kind: 'ready' as const,
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        handle: user.webauthnUserHandle,
        excludeCredentials: credentials.map((credential) => ({
          id: Buffer.from(credential.credentialId).toString('base64url'),
          transports: credential.transportsJson ? JSON.parse(credential.transportsJson) as string[] : undefined,
        })),
        securitySnapshot: {
          passwordHash: user.passwordHash, role: user.role, status: user.status,
          deactivatedAt: user.deactivatedAt?.getTime() ?? 0,
          restoredAt: user.restoredAt?.getTime() ?? 0,
          mfaId: mfa?.id ?? null, mfaEnabledAt: mfa?.enabledAt.getTime() ?? null,
          mfaRevision: mfa?.factorRevision ?? null,
          userHandle: user.webauthnUserHandle,
        },
      }
    })
    if (outcome.kind !== 'ready') {
      if (outcome.kind === 'password_invalid' || (outcome.kind === 'factor_invalid' && outcome.reason === 'code_mismatch')) {
        await authSecurityService.recordAdminLoginFailure(requestMeta, auth.username)
      }
      await auditService.safeRecord({
        actionType: 'auth.webauthn.register', actionLabel: '绑定通行密钥', targetType: 'user',
        targetId: auth.userId, targetCode: auth.username, actor: auth, requestMeta, resultStatus: 'failed',
        detail: { reason: outcome.kind === 'factor_invalid' ? outcome.reason : outcome.kind },
      })
      throw new BizError('身份复核未通过', 400, { reason: 'WEBAUTHN_STEP_UP_INVALID' })
    }
    const options = await generateRegistrationOptions({
      rpName, rpID: rpId, userName: outcome.username, userDisplayName: outcome.displayName,
      userID: Buffer.from(outcome.handle, 'hex'), attestationType: 'none', timeout: CHALLENGE_TTL_MS,
      authenticatorSelection: input.usage === 'second_factor'
        ? { residentKey: 'discouraged', requireResidentKey: false, userVerification: 'discouraged' }
        : { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      ...(input.kind === 'security_key' ? { preferredAuthenticatorType: 'securityKey' as const } : {}),
      excludeCredentials: outcome.excludeCredentials,
    })
    const challengeId = randomBytes(32).toString('base64url')
    registerTickets.set(challengeId, {
      purpose: 'register', userId: outcome.userId, sessionDigest: hashSessionToken(auth.sessionToken),
      challenge: options.challenge, expectedOrigin: origin, expectedRpId: rpId,
      securitySnapshot: outcome.securitySnapshot, name,
      usage: input.usage ?? 'passwordless',
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    })
    return { challengeId, options, expiresInSeconds: CHALLENGE_TTL_MS / 1000 }
  }

  async completeRegistration(auth: AuthUserContext, challengeId: string, response: RegistrationResponseJSON, origin: string, requestMeta?: RequestMeta) {
    requireWebauthnEnabled()
    const ticket = registerTickets.take(challengeId)
    if (!ticket || ticket.purpose !== 'register' || ticket.userId !== auth.userId
      || ticket.sessionDigest !== hashSessionToken(auth.sessionToken)
      || ticket.expectedOrigin !== origin || ticket.expectedRpId !== webauthnConfig.rpId) {
      throw new BizError('绑定挑战已过期，请重新开始', 401, { reason: 'WEBAUTHN_CHALLENGE_EXPIRED' })
    }
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>
    try {
      verified = await verifyRegistrationResponse({
        response, expectedChallenge: ticket.challenge, expectedOrigin: ticket.expectedOrigin,
        expectedRPID: ticket.expectedRpId, requireUserVerification: ticket.usage === 'passwordless',
      })
      if (!verified.verified || !verified.registrationInfo
        || (ticket.usage === 'passwordless' && (!verified.registrationInfo.userVerified || !verified.registrationInfo.credentialDeviceType))) {
        throw new Error('registration_unverified')
      }
    } catch {
      await auditService.safeRecord({
        actionType: 'auth.webauthn.register', actionLabel: '绑定通行密钥', targetType: 'user', targetId: auth.userId,
        actor: auth, requestMeta, resultStatus: 'failed', detail: { reason: 'attestation_invalid' },
      })
      throw new BizError('通行密钥验证失败，请重新绑定', 400, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
    }
    const credential = verified.registrationInfo.credential
    const credentialIdBytes = Buffer.from(credential.id, 'base64url')
    if (!credentialIdBytes.length || credentialIdBytes.length > 1024
      || credentialIdBytes.toString('base64url') !== credential.id
      || credential.id !== response.rawId || credential.id !== response.id) {
      throw new BizError('凭据格式不正确', 400, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
    }
    const idSha256 = createHash('sha256').update(credentialIdBytes).digest('hex')
    const saved = await runInTransaction(async (manager) => {
      const user = await this.lockUser(manager, auth.userId)
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      const snapshot = ticket.securitySnapshot
      const mfa = await manager.getRepository(SysUserMfa).findOneBy({ userId: user.id })
      if (user.passwordHash !== snapshot.passwordHash || user.role !== snapshot.role || user.status !== snapshot.status
        || (user.deactivatedAt?.getTime() ?? 0) !== snapshot.deactivatedAt
        || (user.restoredAt?.getTime() ?? 0) !== snapshot.restoredAt
        || user.webauthnUserHandle !== snapshot.userHandle
        || (mfa?.id ?? null) !== snapshot.mfaId
        || (mfa?.enabledAt.getTime() ?? null) !== snapshot.mfaEnabledAt
        || (mfa?.factorRevision ?? null) !== snapshot.mfaRevision) {
        throw new BizError('账号安全设置已变化，请重新绑定', 409, { reason: 'WEBAUTHN_CHALLENGE_EXPIRED' })
      }
      const repo = manager.getRepository(SysUserWebauthnCredential)
      if (await repo.count({ where: { userId: user.id } }) >= 10) {
        throw new BizError('每个账号最多绑定 10 把密钥', 409, { reason: 'WEBAUTHN_LIMIT_REACHED' })
      }
      const existing = await repo.createQueryBuilder('credential')
        .addSelect('credential.credentialId')
        .where('credential.rp_id = :rpId AND credential.credential_id_sha256 = :idSha256', { rpId: ticket.expectedRpId, idSha256 })
        .getOne()
      if (existing) {
        // MySQL 默认不区分大小写排序规则不能用来比较 base64url；真实字节与 digest 均在此核对。
        if (!Buffer.from(existing.credentialId).equals(credentialIdBytes)) {
          throw new BizError('凭据标识冲突', 409, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
        }
        throw new BizError('这把密钥已绑定', 409, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
      }
      const transports = response.response.transports?.filter((item) =>
        ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(item)) ?? []
      const created = await repo.save(repo.create({
        userId: user.id, rpId: ticket.expectedRpId, credentialIdSha256: idSha256,
        credentialId: credentialIdBytes, publicKey: Buffer.from(credential.publicKey),
        counter: String(credential.counter), transportsJson: transports.length ? JSON.stringify(transports) : null,
        deviceType: verified.registrationInfo.credentialDeviceType,
        backedUp: verified.registrationInfo.credentialBackedUp,
        name: ticket.name, usage: ticket.usage, lastUsedAt: null,
      }))
      const recoveryCodes = !mfa && ticket.usage === 'second_factor'
        ? await adminMfaService.enableWithWebauthnInTransaction(manager, user.id)
        : []
      if (mfa) await adminMfaService.bumpFactorRevision(manager, user.id)
      await auditService.record({
        actionType: 'auth.webauthn.register', actionLabel: '绑定通行密钥', targetType: 'user', targetId: user.id,
        targetCode: user.username, actor: auth, requestMeta,
        detail: { credentialRecordId: created.id, deviceType: created.deviceType, usage: created.usage },
      }, manager)
      return { credential: created, recoveryCodes }
    })
    return { ...this.toSafeCredential(saved.credential),
      ...(saved.recoveryCodes.length ? { recoveryCodes: saved.recoveryCodes } : {}) }
  }

  async beginMfaLogin(mfaTicket: string, origin: string, requestMeta?: RequestMeta) {
    const { rpId } = requireWebauthnEnabled()
    const ticket = authService.inspectMfaLoginTicket(mfaTicket)
    await authSecurityService.guardAdminMfaLoginRequest(requestMeta, ticket.username)
    const credentials = await this.credentialRepo.createQueryBuilder('credential')
        .addSelect('credential.credentialId').where('credential.user_id = :userId AND credential.rp_id = :rpId',
          { userId: ticket.userId, rpId })
        .andWhere('credential.usage IN (:...usages)', { usages: ['passwordless', 'second_factor'] }).getMany()
    if (!credentials.length) throw new BizError('当前账号没有可用的通行密钥', 409)
    const allowCredentials = credentials.map((item) => ({ id: Buffer.from(item.credentialId).toString('base64url'),
      transports: item.transportsJson ? JSON.parse(item.transportsJson) as string[] : undefined }))
    const options = await generateAuthenticationOptions({ rpID: rpId,
      userVerification: credentials.every((item) => item.usage === 'passwordless') ? 'required' : 'preferred',
      allowCredentials, timeout: CHALLENGE_TTL_MS })
    const challengeId = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const expiresAt = Math.min(Date.now() + CHALLENGE_TTL_MS, ticket.expiresAt)
    mfaChallenges.set(challengeId, { userId: ticket.userId, mfaTicketDigest: hashSessionToken(mfaTicket),
      nonceDigest: nonceDigest(nonce),
      challenge: options.challenge, expectedOrigin: origin, expectedRpId: rpId,
      allowedIds: credentials.map((item) => item.credentialIdSha256), expiresAt })
    return { challengeId, options, expiresInSeconds: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)), nonce }
  }

  async completeMfaLogin(mfaTicket: string, challengeId: string, response: AuthenticationResponseJSON,
    nonce: string | undefined, origin: string, requestMeta?: RequestMeta) {
    requireWebauthnEnabled()
    const challenge = mfaChallenges.take(challengeId)
    if (!challenge || !nonce || !sameHex(challenge.nonceDigest, nonceDigest(nonce))
      || challenge.mfaTicketDigest !== hashSessionToken(mfaTicket)
      || challenge.expectedOrigin !== origin || challenge.expectedRpId !== webauthnConfig.rpId) {
      throw new BizError('安全密钥挑战已过期，请重试', 401, { reason: 'WEBAUTHN_CHALLENGE_EXPIRED' })
    }
    return authService.completeMfaLoginWithWebauthn(mfaTicket, async (manager, user) => {
      if (String(user.id) !== challenge.userId) return false
      return Boolean(await this.verifyCredentialForUser(manager, user, response, challenge))
    }, requestMeta)
  }

  async beginStepUp(auth: AuthUserContext, input: {
    currentPassword: string; action: AdminStepUpAction; targetId?: string
  }, origin: string, requestMeta?: RequestMeta) {
    const { rpId } = requireWebauthnEnabled()
    const targetId = input.targetId ?? null
    if ((input.action.startsWith('user.') || input.action === 'webauthn.delete') !== Boolean(targetId)) {
      throw new BizError('身份复核目标不正确', 400)
    }
    await authService.verifyStepUpPassword(auth, input.currentPassword, requestMeta, `auth.webauthn.step_up.${input.action}`)
    const prepared = await runInTransaction(async (manager) => {
      const user = await this.lockUser(manager, auth.userId)
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      if (!await verifyPassword(input.currentPassword.trim(), user.passwordHash)) throw new BizError('当前密码错误', 400)
      const mfa = await manager.getRepository(SysUserMfa).findOneBy({ userId: user.id })
      const credentials = await manager.getRepository(SysUserWebauthnCredential).createQueryBuilder('credential')
        .addSelect('credential.credentialId').where('credential.user_id = :userId AND credential.rp_id = :rpId',
          { userId: user.id, rpId })
        .andWhere('credential.usage IN (:...usages)', { usages: ['passwordless', 'second_factor'] }).getMany()
      if (!credentials.length) throw new BizError('当前账号没有可用的通行密钥', 409)
      return { snapshot: this.snapshot(user, mfa), credentials }
    })
    const allowCredentials = prepared.credentials.map((item) => ({ id: Buffer.from(item.credentialId).toString('base64url'),
      transports: item.transportsJson ? JSON.parse(item.transportsJson) as string[] : undefined }))
    const options = await generateAuthenticationOptions({ rpID: rpId,
      userVerification: prepared.credentials.every((item) => item.usage === 'passwordless') ? 'required' : 'preferred',
      allowCredentials, timeout: CHALLENGE_TTL_MS })
    const challengeId = randomBytes(32).toString('base64url')
    stepUpChallenges.set(challengeId, { ...prepared.snapshot, userId: String(auth.userId),
      sessionDigest: hashSessionToken(auth.sessionToken), action: input.action, targetId,
      challenge: options.challenge, expectedOrigin: origin, expectedRpId: rpId,
      allowedIds: prepared.credentials.map((item) => item.credentialIdSha256), expiresAt: Date.now() + CHALLENGE_TTL_MS })
    return { challengeId, options, expiresInSeconds: CHALLENGE_TTL_MS / 1000 }
  }

  async completeStepUp(auth: AuthUserContext, challengeId: string, response: AuthenticationResponseJSON, origin: string) {
    requireWebauthnEnabled()
    const challenge = stepUpChallenges.take(challengeId)
    if (!challenge || challenge.userId !== String(auth.userId)
      || challenge.sessionDigest !== hashSessionToken(auth.sessionToken)
      || challenge.expectedOrigin !== origin || challenge.expectedRpId !== webauthnConfig.rpId) {
      throw new BizError('身份复核挑战已过期，请重试', 401, { reason: 'WEBAUTHN_CHALLENGE_EXPIRED' })
    }
    const verifiedUsage = await runInTransaction(async (manager) => {
      const user = await this.lockUser(manager, auth.userId)
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      await this.assertSnapshot(manager, user, challenge)
      const usage = await this.verifyCredentialForUser(manager, user, response, challenge)
      if (!usage) {
        throw new BizError('安全密钥验证失败', 401, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
      }
      await auditService.record({ actionType: 'auth.webauthn.step_up', actionLabel: '安全密钥身份复核',
        targetType: 'user', targetId: user.id, targetCode: user.username, actor: auth,
        detail: { action: challenge.action, targetId: challenge.targetId, usage } }, manager)
      return usage
    })
    const stepUpProof = randomBytes(32).toString('base64url')
    stepUpProofs.set(stepUpProof, { ...challenge, verifiedUsage, expiresAt: Date.now() + CHALLENGE_TTL_MS })
    return { stepUpProof, expiresInSeconds: CHALLENGE_TTL_MS / 1000 }
  }

  async consumeStepUpProofInTransaction(manager: EntityManager, auth: AuthUserContext,
    stepUpProof: string, action: AdminStepUpAction, targetId?: string): Promise<void> {
    const proof = stepUpProofs.take(stepUpProof)
    if (!proof || proof.action !== action || proof.targetId !== (targetId ?? null)
      || proof.userId !== String(auth.userId) || proof.sessionDigest !== hashSessionToken(auth.sessionToken)) {
      throw new BizError('身份复核证明已过期，请重新验证', 409, { reason: 'WEBAUTHN_STEP_UP_EXPIRED' })
    }
    if (action === 'mfa.webauthn.enable' && proof.verifiedUsage !== 'passwordless') {
      throw new BizError('须使用已绑定的强凭据开启密码两步验证', 403)
    }
    const user = await this.lockUser(manager, auth.userId)
    await this.assertSessionLiveUnderAccountLock(manager, auth)
    await this.assertSnapshot(manager, user, proof)
  }

  async enablePasswordMfa(auth: AuthUserContext, input: { currentPassword: string; stepUpProof: string }, requestMeta?: RequestMeta) {
    requireWebauthnEnabled()
    await authService.verifyStepUpPassword(auth, input.currentPassword, requestMeta, 'auth.mfa.webauthn.enable')
    return runInTransaction(async (manager) => {
      const user = await this.lockUser(manager, auth.userId)
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      if (!await verifyPassword(input.currentPassword.trim(), user.passwordHash)) throw new BizError('当前密码错误', 400)
      await this.consumeStepUpProofInTransaction(manager, auth, input.stepUpProof, 'mfa.webauthn.enable')
      if (await manager.getRepository(SysUserMfa).countBy({ userId: user.id })) throw new BizError('密码两步验证已开启', 409)
      if (!await adminMfaService.countUsableWebauthnCredentials(manager, user.id, 'passwordless')) {
        throw new BizError('当前账号没有已绑定的强凭据', 409)
      }
      const recoveryCodes = await adminMfaService.enableWithWebauthnInTransaction(manager, user.id)
      await auditService.record({ actionType: 'auth.mfa.enable', actionLabel: '使用已有强凭据开启密码两步验证',
        targetType: 'user', targetId: user.id, targetCode: user.username, actor: auth, requestMeta,
        detail: { method: 'webauthn', recoveryCodeCount: recoveryCodes.length } }, manager)
      return { recoveryCodes }
    })
  }

  async beginLogin(origin: string) {
    const { rpId } = requireWebauthnEnabled()
    const nonce = randomBytes(32).toString('base64url')
    const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'required', timeout: CHALLENGE_TTL_MS })
    const challengeId = randomBytes(32).toString('base64url')
    loginTickets.set(challengeId, {
      purpose: 'login', challenge: options.challenge, nonceDigest: nonceDigest(nonce),
      expectedOrigin: origin, expectedRpId: rpId, expiresAt: Date.now() + CHALLENGE_TTL_MS,
    })
    return { challengeId, options, expiresInSeconds: CHALLENGE_TTL_MS / 1000, nonce }
  }

  async completeLogin(challengeId: string, response: AuthenticationResponseJSON, nonce: string | undefined, origin: string, requestMeta?: RequestMeta) {
    const ticket = this.takeLoginTicket(challengeId, nonce, origin)
    const rawId = response.rawId
    const credentialIdBytes = typeof rawId === 'string' ? Buffer.from(rawId, 'base64url') : Buffer.alloc(0)
    if (!credentialIdBytes.length || credentialIdBytes.length > 1024
      || credentialIdBytes.toString('base64url') !== rawId || response.id !== rawId) {
      throw new BizError('通行密钥凭据无效', 401, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
    }
    const digest = createHash('sha256').update(credentialIdBytes).digest('hex')
    const candidate = await this.credentialRepo.findOneBy({ rpId: ticket.expectedRpId, credentialIdSha256: digest })
    const user = candidate ? await AppDataSource.getRepository(SysUser).findOneBy({ id: candidate.userId }) : null
    if (!candidate || !user) {
      await authSecurityService.recordAdminLoginFailure(requestMeta, 'webauthn-unknown', { subjectResolved: false })
      throw new BizError('通行密钥凭据无效', 401, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
    }
    await authSecurityService.guardAdminMfaLoginRequest(requestMeta, user.username)
    try {
      const session = await runInTransaction(async (manager) => {
        const lockedUser = await this.lockUser(manager, user.id)
        const query = manager.getRepository(SysUserWebauthnCredential).createQueryBuilder('credential')
          .addSelect(['credential.credentialId', 'credential.publicKey'])
          .where('credential.id = :id AND credential.user_id = :userId', { id: candidate.id, userId: lockedUser.id })
        if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
        const credential = await query.getOne()
        if (!credential || credential.usage !== 'passwordless' || credential.rpId !== ticket.expectedRpId || credential.credentialIdSha256 !== digest
          || !Buffer.from(credential.credentialId).equals(credentialIdBytes)
          || !lockedUser.webauthnUserHandle) {
          throw new BizError('通行密钥凭据无效', 401, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
        }
        const handle = response.response.userHandle
        const handleBytes = typeof handle === 'string' ? Buffer.from(handle, 'base64url') : Buffer.alloc(0)
        const expectedHandle = Buffer.from(lockedUser.webauthnUserHandle, 'hex')
        if (handleBytes.length !== 32 || handleBytes.toString('base64url') !== handle
          || !timingSafeEqual(handleBytes, expectedHandle)) {
          throw new BizError('通行密钥身份不匹配', 401, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
        }
        let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
        try {
          verification = await verifyAuthenticationResponse({
            response, expectedChallenge: ticket.challenge, expectedOrigin: ticket.expectedOrigin,
            expectedRPID: ticket.expectedRpId, requireUserVerification: true,
            credential: {
              id: credentialIdBytes.toString('base64url'), publicKey: new Uint8Array(credential.publicKey),
              counter: Number(credential.counter),
              transports: credential.transportsJson ? JSON.parse(credential.transportsJson) as string[] : undefined,
            },
          })
        } catch {
          throw new BizError('通行密钥签名验证失败', 401, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
        }
        if (!verification.verified || !verification.authenticationInfo.userVerified
          || verification.authenticationInfo.credentialID !== credentialIdBytes.toString('base64url')) {
          throw new BizError('通行密钥签名验证失败', 401, { reason: 'WEBAUTHN_CREDENTIAL_INVALID' })
        }
        credential.counter = String(verification.authenticationInfo.newCounter)
        credential.deviceType = verification.authenticationInfo.credentialDeviceType
        credential.backedUp = verification.authenticationInfo.credentialBackedUp
        credential.lastUsedAt = new Date()
        await manager.getRepository(SysUserWebauthnCredential).save(credential)
        return authService.createVerifiedWebauthnSessionInTransaction(manager, lockedUser, requestMeta)
      })
      await authSecurityService.clearAdminLoginFailures(requestMeta, user.username)
      return session
    } catch (error) {
      if (error instanceof BizError && error.data && typeof error.data === 'object'
        && 'reason' in error.data && error.data.reason === 'WEBAUTHN_CREDENTIAL_INVALID') {
        await authSecurityService.recordAdminLoginFailure(requestMeta, user.username)
      }
      await auditService.safeRecord({
        actionType: 'auth.login', actionLabel: '通行密钥登录失败', targetType: 'user', targetId: user.id,
        targetCode: user.username, requestMeta, resultStatus: 'failed',
        detail: { reason: error instanceof BizError ? 'webauthn_rejected' : 'verification_error' },
      })
      throw error
    }
  }

  takeLoginTicket(challengeId: string, nonce: string | undefined, origin: string): LoginTicket {
    const ticket = loginTickets.take(challengeId)
    if (!ticket || !nonce || !sameHex(ticket.nonceDigest, nonceDigest(nonce))
      || ticket.expectedOrigin !== origin || ticket.expectedRpId !== webauthnConfig.rpId) {
      throw new BizError('通行密钥登录挑战已过期，请重试', 401, { reason: 'WEBAUTHN_CHALLENGE_EXPIRED' })
    }
    return ticket
  }
}

export const adminWebauthnService = new AdminWebauthnService()
