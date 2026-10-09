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
    userHandle: string
  }
  name: string
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

  async listCredentials(userId: string) {
    const credentials = await this.credentialRepo.find({
      where: { userId }, order: { createdAt: 'DESC', id: 'DESC' },
    })
    return credentials.map((credential) => this.toSafeCredential(credential))
  }

  private toSafeCredential(credential: SysUserWebauthnCredential) {
    return {
      id: credential.id, name: credential.name, createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt, deviceType: credential.deviceType, backedUp: credential.backedUp,
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
  }, requestMeta?: RequestMeta) {
    await authService.verifyStepUpPassword(auth, input.currentPassword, requestMeta, 'auth.webauthn.delete')
    const outcome = await runInTransaction(async (manager) => {
      const user = await this.lockUser(manager, auth.userId)
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      if (!await verifyPassword(input.currentPassword.trim(), user.passwordHash)) return { kind: 'password_invalid' as const }
      const mfa = await manager.getRepository(SysUserMfa).findOneBy({ userId: user.id })
      if (mfa) {
        if (Boolean(input.code) === Boolean(input.recoveryCode)) return { kind: 'factor_missing' as const }
        const factor = await adminMfaService.verifyFactor(manager, user.id, input)
        if (!factor.ok) return { kind: 'factor_invalid' as const, reason: factor.reason }
      }
      const repo = manager.getRepository(SysUserWebauthnCredential)
      const query = repo.createQueryBuilder('credential').where('credential.id = :id AND credential.user_id = :userId', { id, userId: user.id })
      if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
      const credential = await query.getOne()
      if (!credential) throw new BizError('密钥不存在', 404)
      await repo.delete({ id: credential.id, userId: user.id })
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
      throw new BizError(outcome.kind === 'factor_missing' ? '请输入 6 位动态码或恢复码' : '身份复核未通过', 400, { reason: 'WEBAUTHN_STEP_UP_INVALID' })
    }
    customerServiceRealtimeService.disconnectByOwner('service', auth.userId)
    return true
  }

  async resetUserCredentials(targetId: string, actor: AuthUserContext, input: {
    currentPassword: string
    code?: string
    recoveryCode?: string
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
        if (Boolean(input.code) === Boolean(input.recoveryCode)) return { kind: 'factor_missing' as const }
        const factor = await adminMfaService.verifyFactor(manager, actorUser.id, input)
        if (!factor.ok) return { kind: 'factor_invalid' as const, reason: factor.reason }
      }
      const credentials = await manager.getRepository(SysUserWebauthnCredential).delete({ userId: target.id })
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
      throw new BizError(outcome.kind === 'factor_missing' ? '请输入 6 位动态码或恢复码' : '身份复核未通过', 400, { reason: 'WEBAUTHN_STEP_UP_INVALID' })
    }
    customerServiceRealtimeService.disconnectByOwner('service', targetId)
    return { revokedCount: outcome.revokedCount }
  }

  async beginRegistration(auth: AuthUserContext, input: {
    name: string
    kind: 'passkey' | 'security_key'
    currentPassword: string
    code?: string
    recoveryCode?: string
  }, origin: string, requestMeta?: RequestMeta) {
    const { rpId, rpName } = requireWebauthnEnabled()
    const name = input.name.trim()
    if (!name || name.length > 64) throw new BizError('密钥名称长度需为 1 至 64 位', 400)
    await authService.verifyStepUpPassword(auth, input.currentPassword, requestMeta, 'auth.webauthn.register')
    const outcome = await runInTransaction(async (manager) => {
      const user = await this.lockUser(manager, auth.userId)
      await this.assertSessionLiveUnderAccountLock(manager, auth)
      if (!await verifyPassword(input.currentPassword.trim(), user.passwordHash)) return { kind: 'password_invalid' as const }
      const mfa = await manager.getRepository(SysUserMfa).findOneBy({ userId: user.id })
      if (mfa) {
        if (Boolean(input.code) === Boolean(input.recoveryCode)) return { kind: 'factor_missing' as const }
        const factor = await adminMfaService.verifyFactor(manager, user.id, input)
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
      throw new BizError(outcome.kind === 'factor_missing' ? '请输入 6 位动态码或恢复码' : '身份复核未通过', 400, { reason: 'WEBAUTHN_STEP_UP_INVALID' })
    }
    const options = await generateRegistrationOptions({
      rpName, rpID: rpId, userName: outcome.username, userDisplayName: outcome.displayName,
      userID: Buffer.from(outcome.handle, 'hex'), attestationType: 'none', timeout: CHALLENGE_TTL_MS,
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      preferredAuthenticatorType: input.kind === 'security_key' ? 'securityKey' : 'localDevice',
      excludeCredentials: outcome.excludeCredentials,
    })
    const challengeId = randomBytes(32).toString('base64url')
    registerTickets.set(challengeId, {
      purpose: 'register', userId: outcome.userId, sessionDigest: hashSessionToken(auth.sessionToken),
      challenge: options.challenge, expectedOrigin: origin, expectedRpId: rpId,
      securitySnapshot: outcome.securitySnapshot, name, expiresAt: Date.now() + CHALLENGE_TTL_MS,
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
        expectedRPID: ticket.expectedRpId, requireUserVerification: true,
      })
      if (!verified.verified || !verified.registrationInfo?.userVerified || verified.registrationInfo.fmt !== 'none') {
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
        || (mfa?.enabledAt.getTime() ?? null) !== snapshot.mfaEnabledAt) {
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
        name: ticket.name, lastUsedAt: null,
      }))
      await auditService.record({
        actionType: 'auth.webauthn.register', actionLabel: '绑定通行密钥', targetType: 'user', targetId: user.id,
        targetCode: user.username, actor: auth, requestMeta,
        detail: { credentialRecordId: created.id, deviceType: created.deviceType },
      }, manager)
      return created
    })
    return this.toSafeCredential(saved)
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
        if (!credential || credential.rpId !== ticket.expectedRpId || credential.credentialIdSha256 !== digest
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
