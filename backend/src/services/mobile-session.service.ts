/**
 * 模块说明：backend/src/services/mobile-session.service.ts
 * 文件职责：实现 Native Mobile 独立会话的签发、Access 解析、Refresh 原子轮换、撤销与清理。
 * 实现逻辑：
 * - MySQL 在 refresh 判定阶段对会话行加 `pessimistic_write` 行锁，SQLite 复用统一单写队列；
 * - CUR/PREV/grace/generation 通过一条数据库端自增 CAS UPDATE 一次性迁移；
 * - previous 超出 grace 或 rotation 突发超阈值会撤销整条会话并写安全审计。
 * 维护说明：严禁在日志、审计或错误中记录 token 明文/完整 hash；deviceId 仅是展示标签，不参与认证。
 */
import { Brackets, IsNull, LessThanOrEqual, MoreThan, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { env } from '../config/env.js'
import { runInTransaction } from '../config/transaction-runner.js'
import {
  ClientMobileSession,
  type MobileSessionRevokeReason,
} from '../entities/client-mobile-session.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import type { MobileAuthContext, MobileDeviceInput } from '../types/mobile-auth.js'
import { isRetryableTransactionLockError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import {
  generateMobileAccessToken,
  generateMobileRefreshToken,
  hashMobileToken,
  isMobileAccessToken,
  isMobileRefreshToken,
} from '../utils/mobile-token.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { authSecurityService } from './auth-security.service.js'
import { clientAuthService } from './client-auth.service.js'
import { persistentRiskStateService } from './persistent-risk-state.service.js'
import { notificationService } from './notification.service.js'

const ACCESS_ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const CLEANUP_BATCH_SIZE = 200
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const LOCK_RETRY_ATTEMPTS = 3

export const MOBILE_DEVICE_ID_PATTERN = /^[0-9a-fA-F-]{32,64}$/

export interface MobileSessionCredentials {
  accessToken: string
  accessExpiresAt: Date
  refreshToken: string
  refreshExpiresAt: Date
  absoluteExpiresAt: Date
  generation: number
  session: ReturnType<MobileSessionService['toSessionSummary']>
  user: ReturnType<typeof clientAuthService.toClientProfile>
}

type RefreshTerminalResult =
  | { kind: 'candidate'; sessionId: string }
  | { kind: 'error'; error: BizError; replayAlertSessionId?: string }

class MobileRefreshCasConflictError extends Error {}

interface MobileSessionContractVerificationHooks {
  afterRefreshPreflight?: (sessionId: string) => Promise<void> | void
  onRefreshLockAcquired?: (sessionId: string) => Promise<void> | void
  forceRefreshCasConflict?: (sessionId: string) => Promise<boolean> | boolean
  afterRefreshCas?: (sessionId: string) => Promise<void> | void
}

let contractVerificationHooks: MobileSessionContractVerificationHooks | null = null

/** 仅供认证契约测试做事务插桩；生产环境不可启用。 */
export const configureMobileSessionContractVerificationHooks = (
  hooks: MobileSessionContractVerificationHooks | null,
) => {
  if (env.NODE_ENV !== 'test') {
    throw new Error('Mobile session contract verification hooks 仅允许在 test 环境启用')
  }
  contractVerificationHooks = hooks
}

const addMilliseconds = (value: Date, milliseconds: number) => new Date(value.getTime() + milliseconds)
const minimumDate = (left: Date, right: Date) => left <= right ? left : right

const mobileError = (message: string, statusCode: number, code: number, data: unknown = null) => (
  new BizError(message, statusCode, { code, data })
)

const normalizeOptionalText = (value: string | null | undefined, maxLength: number) => {
  const normalized = value?.trim() ?? ''
  return normalized ? normalized.slice(0, maxLength) : null
}

const maskIpAddress = (value: string | null) => {
  if (!value) return null
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.*.*`
  const segments = value.split(':').filter(Boolean)
  return segments.length > 1 ? `${segments.slice(0, 2).join(':')}:*` : '[已隐藏]'
}

const auditActorFromClientUser = (user: ClientUser) => ({
  userId: user.id,
  username: user.email ?? user.mobile ?? user.realName,
  displayName: user.realName,
})

export class MobileSessionService {
  private cleanupLoopTimer: ReturnType<typeof globalThis.setInterval> | null = null

  validateDevice(device: MobileDeviceInput): MobileDeviceInput {
    const deviceId = device.deviceId?.trim() ?? ''
    if (!MOBILE_DEVICE_ID_PATTERN.test(deviceId)) {
      throw new BizError('deviceId 格式不正确', 400)
    }
    return {
      deviceId,
      deviceName: normalizeOptionalText(device.deviceName, 64) ?? undefined,
      platform: device.platform,
      appVersion: normalizeOptionalText(device.appVersion, 32) ?? undefined,
    }
  }

  toSessionSummary(session: ClientMobileSession, currentSessionId?: string, includeIp = false) {
    return {
      id: session.id,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      platform: session.platform,
      appVersion: session.appVersion,
      ...(includeIp ? { lastIp: session.id === currentSessionId ? session.lastIp : maskIpAddress(session.lastIp) } : {}),
      lastAccessAt: session.lastAccessAt,
      createdAt: session.createdAt,
      ...(currentSessionId ? { isCurrent: session.id === currentSessionId } : {}),
    }
  }

  private buildCredentials(
    session: ClientMobileSession,
    user: ClientUser,
    accessToken: string,
    refreshToken: string,
  ): MobileSessionCredentials {
    return {
      accessToken,
      accessExpiresAt: session.accessExpiresAt,
      refreshToken,
      refreshExpiresAt: session.refreshExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      generation: session.refreshGeneration,
      session: this.toSessionSummary(session),
      user: clientAuthService.toClientProfile(user),
    }
  }

  private async runWithLockRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        const retryable = error instanceof MobileRefreshCasConflictError || isRetryableTransactionLockError(error)
        if (attempt < LOCK_RETRY_ATTEMPTS && retryable) continue
        if (error instanceof MobileRefreshCasConflictError) {
          throw mobileError('刷新凭证状态已变化，请重试', 401, 40110)
        }
        throw error
      }
    }
    throw lastError
  }

  async createForUser(
    user: ClientUser,
    deviceInput: MobileDeviceInput,
    requestMeta?: RequestMeta,
    actionType: 'mobile_login' | 'mobile_register' | 'password_changed' = 'mobile_login',
    transactionManager?: EntityManager,
  ): Promise<MobileSessionCredentials> {
    const device = this.validateDevice(deviceInput)
    const now = new Date()
    const absoluteExpiresAt = addMilliseconds(now, env.MOBILE_SESSION_ABSOLUTE_TTL_DAYS * 24 * 60 * 60 * 1000)
    const accessExpiresAt = minimumDate(
      addMilliseconds(now, env.MOBILE_ACCESS_TTL_MINUTES * 60 * 1000),
      absoluteExpiresAt,
    )
    const refreshExpiresAt = minimumDate(
      addMilliseconds(now, env.MOBILE_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
      absoluteExpiresAt,
    )
    const accessToken = generateMobileAccessToken()
    const refreshToken = generateMobileRefreshToken()

    const createSession = async (manager: EntityManager) => {
      const userQuery = manager.getRepository(ClientUser)
        .createQueryBuilder('user')
        .where('user.id = :userId', { userId: user.id })
      if (AppDataSource.options.type === 'mysql') userQuery.setLock('pessimistic_write')
      const lockedUser = await userQuery.getOne()
      if (!lockedUser || lockedUser.status !== 'enabled') {
        throw mobileError('当前账号已停用', 403, 40300)
      }

      const repository = manager.getRepository(ClientMobileSession)
      const sameDeviceSessions = await repository.find({
        where: { clientUserId: lockedUser.id, deviceId: device.deviceId, revokedAt: IsNull() },
      })
      if (sameDeviceSessions.length > 0) {
        await repository.createQueryBuilder()
          .update(ClientMobileSession)
          .set({ revokedAt: now, revokeReason: 'user_revoke_device' })
          .where('client_user_id = :userId AND device_id = :deviceId AND revoked_at IS NULL', {
            userId: lockedUser.id,
            deviceId: device.deviceId,
          })
          .execute()
      }

      const activeSessions = await repository.find({
        where: {
          clientUserId: lockedUser.id,
          revokedAt: IsNull(),
          absoluteExpiresAt: MoreThan(now),
        },
        order: { lastAccessAt: 'ASC', id: 'ASC' },
      })
      const evictCount = Math.max(0, activeSessions.length - env.MOBILE_MAX_ACTIVE_SESSIONS + 1)
      const evictedSessions = activeSessions.slice(0, evictCount)
      if (evictedSessions.length > 0) {
        await repository.createQueryBuilder()
          .update(ClientMobileSession)
          .set({ revokedAt: now, revokeReason: 'session_limit_evicted' })
          .whereInIds(evictedSessions.map((item) => item.id))
          .execute()
      }

      const session = await repository.save(repository.create({
        clientUserId: lockedUser.id,
        deviceId: device.deviceId,
        deviceName: device.deviceName ?? null,
        platform: device.platform,
        appVersion: device.appVersion ?? null,
        accessTokenHash: hashMobileToken(accessToken),
        accessExpiresAt,
        refreshTokenHash: hashMobileToken(refreshToken),
        refreshExpiresAt,
        previousRefreshTokenHash: null,
        previousRefreshGraceUntil: null,
        refreshGeneration: 0,
        absoluteExpiresAt,
        lastIp: requestMeta?.ipAddress ?? null,
        lastAccessAt: now,
        revokedAt: null,
        revokeReason: null,
      }))
      await manager.getRepository(ClientUser).update(lockedUser.id, { lastLoginAt: now })
      lockedUser.lastLoginAt = now
      if (actionType !== 'password_changed') {
        await auditService.record({
          actionType,
          actionLabel: actionType === 'mobile_register' ? 'Mobile 注册' : 'Mobile 登录',
          targetType: 'client_mobile_session',
          targetId: session.id,
          actor: auditActorFromClientUser(lockedUser),
          requestMeta,
          detail: {
            deviceId: device.deviceId,
            deviceName: device.deviceName ?? null,
            platform: device.platform,
            appVersion: device.appVersion ?? null,
            evictedSessionId: evictedSessions[0]?.id ?? null,
          },
        }, manager)
      }
      return { session, user: lockedUser }
    }
    const result = transactionManager
      ? await createSession(transactionManager)
      : await runInTransaction(createSession)

    return this.buildCredentials(result.session, result.user, accessToken, refreshToken)
  }

  private buildRefreshLookup(manager: EntityManager, refreshHash: string, lock: boolean) {
    const query = manager.getRepository(ClientMobileSession)
      .createQueryBuilder('session')
      .addSelect([
        'session.accessTokenHash',
        'session.refreshTokenHash',
        'session.previousRefreshTokenHash',
      ])
      .leftJoinAndSelect('session.user', 'user')
      .where(new Brackets((where) => {
        where.where('session.refreshTokenHash = :refreshHash', { refreshHash })
          .orWhere('session.previousRefreshTokenHash = :refreshHash', { refreshHash })
      }))
    if (lock && AppDataSource.options.type === 'mysql') query.setLock('pessimistic_write')
    return query
  }

  private buildSessionIdLookup(manager: EntityManager, sessionId: string, lock: boolean) {
    const query = manager.getRepository(ClientMobileSession)
      .createQueryBuilder('session')
      .addSelect([
        'session.accessTokenHash',
        'session.refreshTokenHash',
        'session.previousRefreshTokenHash',
      ])
      .leftJoinAndSelect('session.user', 'user')
      .where('session.id = :sessionId', { sessionId })
    if (lock && AppDataSource.options.type === 'mysql') query.setLock('pessimistic_write')
    return query
  }

  private async revokeLockedSession(
    manager: EntityManager,
    session: ClientMobileSession,
    reason: MobileSessionRevokeReason,
    now: Date,
  ) {
    if (!session.revokedAt) {
      session.revokedAt = now
      session.revokeReason = reason
      await manager.getRepository(ClientMobileSession).save(session)
    }
  }

  private async revokeExpiredLockedSession(
    manager: EntityManager,
    session: ClientMobileSession,
    now: Date,
    expiryKind: 'absolute' | 'refresh',
    requestMeta?: RequestMeta,
  ) {
    const shouldAudit = !session.revokedAt
    await this.revokeLockedSession(manager, session, 'expired_cleanup', now)
    if (!shouldAudit) return
    await auditService.record({
      actionType: 'mobile_session_revoked',
      actionLabel: 'Mobile 会话过期撤销',
      targetType: 'client_mobile_session',
      targetId: session.id,
      actor: session.user ? auditActorFromClientUser(session.user) : null,
      requestMeta,
      detail: { revokeReason: 'expired_cleanup', initiatedBy: 'refresh', expiryKind },
    }, manager)
  }

  private async classifyLockedRefresh(
    manager: EntityManager,
    refreshHash: string,
    now: Date,
    requestMeta?: RequestMeta,
  ): Promise<RefreshTerminalResult> {
    const session = await this.buildRefreshLookup(manager, refreshHash, true).getOne()
    if (!session || !session.user) {
      return { kind: 'error', error: mobileError('刷新凭证无效', 401, 40110) }
    }
    if (session.user.status !== 'enabled') {
      await this.revokeSessionsForUser(manager, session.clientUserId, 'account_disabled')
      await auditService.record({
        actionType: 'account_disabled_session_rejected',
        actionLabel: '停用账号会话拒绝',
        targetType: 'client_mobile_session',
        targetId: session.id,
        actor: auditActorFromClientUser(session.user),
        resultStatus: 'failed',
        requestMeta,
        detail: { attemptedEndpoint: 'refresh' },
      }, manager)
      return { kind: 'error', error: mobileError('当前账号已停用', 403, 40300) }
    }
    if (session.revokedAt) {
      return { kind: 'error', error: mobileError('刷新凭证无效', 401, 40110) }
    }
    if (session.absoluteExpiresAt <= now) {
      await this.revokeExpiredLockedSession(manager, session, now, 'absolute', requestMeta)
      return { kind: 'error', error: mobileError('会话已达绝对过期时间', 401, 40112) }
    }
    if (session.refreshExpiresAt <= now) {
      await this.revokeExpiredLockedSession(manager, session, now, 'refresh', requestMeta)
      return { kind: 'error', error: mobileError('刷新凭证已过期', 401, 40111) }
    }
    const matchesPrevious = session.previousRefreshTokenHash === refreshHash
    if (matchesPrevious && (!session.previousRefreshGraceUntil || session.previousRefreshGraceUntil <= now)) {
      await this.revokeLockedSession(manager, session, 'refresh_replay_detected', now)
      const graceExpiredBySeconds = session.previousRefreshGraceUntil
        ? Math.max(0, Math.floor((now.getTime() - session.previousRefreshGraceUntil.getTime()) / 1000))
        : null
      await auditService.record({
        actionType: 'refresh_replay_detected',
        actionLabel: '检测到刷新令牌重放',
        targetType: 'client_mobile_session',
        targetId: session.id,
        actor: auditActorFromClientUser(session.user),
        resultStatus: 'failed',
        requestMeta,
        detail: { generation: session.refreshGeneration, graceExpiredBySeconds, trigger: 'prev_expired' },
      }, manager)
      await notificationService.emitEvent({
        eventType: 'mobile_refresh_replay_detected',
        sourceType: 'client_mobile_session',
        sourceId: session.id,
        payload: { generation: session.refreshGeneration, trigger: 'prev_expired' },
        requestMeta,
      }, manager)
      return {
        kind: 'error',
        error: mobileError('出于安全考虑，您的登录已被重置，请重新登录', 401, 40113),
        replayAlertSessionId: session.id,
      }
    }
    return { kind: 'candidate', sessionId: session.id }
  }

  private async classifyRefresh(refreshHash: string, now: Date, requestMeta?: RequestMeta) {
    return this.runWithLockRetry(() => runInTransaction((manager) => (
      this.classifyLockedRefresh(manager, refreshHash, now, requestMeta)
    )))
  }

  private throwTerminalRefresh(result: RefreshTerminalResult): asserts result is Extract<RefreshTerminalResult, { kind: 'candidate' }> {
    if (result.kind === 'error') throw result.error
  }

  async refresh(
    refreshToken: string,
    deviceInput: Pick<MobileDeviceInput, 'deviceId' | 'appVersion'>,
    requestMeta?: RequestMeta,
  ): Promise<MobileSessionCredentials> {
    const token = refreshToken?.trim() ?? ''
    if (!isMobileRefreshToken(token)) {
      await authSecurityService.guardMobileRefreshRequest(requestMeta)
      throw mobileError('刷新凭证无效', 401, 40110)
    }
    const deviceId = deviceInput.deviceId?.trim() ?? ''
    if (!MOBILE_DEVICE_ID_PATTERN.test(deviceId)) {
      throw new BizError('deviceId 格式不正确', 400)
    }
    const device = {
      deviceId,
      appVersion: normalizeOptionalText(deviceInput.appVersion, 32) ?? undefined,
    }
    const refreshHash = hashMobileToken(token)
    const now = new Date()

    // 预检只用于定位候选 session 与区分完全未知 token，不授予任何 admission。
    // refresh 是否有效只取决于随后真正获得数据库锁时的 CUR/PREV 状态。
    const preflight = await this.buildRefreshLookup(AppDataSource.manager, refreshHash, false).getOne()
    if (!preflight) {
      await authSecurityService.guardMobileRefreshRequest(requestMeta)
      throw mobileError('刷新凭证无效', 401, 40110)
    }
    await contractVerificationHooks?.afterRefreshPreflight?.(preflight.id)
    const preflightMatchesExpiredPrevious = preflight.previousRefreshTokenHash === refreshHash
      && (!preflight.previousRefreshGraceUntil || preflight.previousRefreshGraceUntil <= now)
    let classified: RefreshTerminalResult
    if (
      preflightMatchesExpiredPrevious
      || preflight.revokedAt
      || !preflight.user
      || preflight.user.status !== 'enabled'
      || preflight.absoluteExpiresAt <= now
      || preflight.refreshExpiresAt <= now
    ) {
      // 重放/停用/过期必须在限流之前进入加锁事务并提交撤销。
      classified = await this.classifyRefresh(refreshHash, now, requestMeta)
      this.throwTerminalRefresh(classified)
    } else {
      classified = { kind: 'candidate', sessionId: preflight.id }
    }

    await authSecurityService.prepareMobileRefreshRequest(classified.sessionId)

    const accessToken = generateMobileAccessToken()
    const nextRefreshToken = generateMobileRefreshToken()
    const rotated = await this.runWithLockRetry(() => runInTransaction(async (manager) => {
      const session = await this.buildSessionIdLookup(manager, classified.sessionId, true).getOne()
      if (!session?.user) return { kind: 'error', error: mobileError('刷新凭证无效', 401, 40110) } as const
      await contractVerificationHooks?.onRefreshLockAcquired?.(session.id)

      const rotationNow = new Date()
      if (session.revokedAt) return { kind: 'error', error: mobileError('刷新凭证无效', 401, 40110) } as const
      if (session.user.status !== 'enabled') {
        await this.revokeSessionsForUser(manager, session.clientUserId, 'account_disabled')
        await auditService.record({
          actionType: 'account_disabled_session_rejected',
          actionLabel: '停用账号会话拒绝',
          targetType: 'client_mobile_session',
          targetId: session.id,
          actor: auditActorFromClientUser(session.user),
          resultStatus: 'failed',
          requestMeta,
          detail: { attemptedEndpoint: 'refresh' },
        }, manager)
        return { kind: 'error', error: mobileError('当前账号已停用', 403, 40300) } as const
      }
      if (session.absoluteExpiresAt <= rotationNow) {
        await this.revokeExpiredLockedSession(manager, session, rotationNow, 'absolute', requestMeta)
        return { kind: 'error', error: mobileError('会话已达绝对过期时间', 401, 40112) } as const
      }
      if (session.refreshExpiresAt <= rotationNow) {
        await this.revokeExpiredLockedSession(manager, session, rotationNow, 'refresh', requestMeta)
        return { kind: 'error', error: mobileError('刷新凭证已过期', 401, 40111) } as const
      }
      const matchesCurrent = session.refreshTokenHash === refreshHash
      const matchesPrevious = session.previousRefreshTokenHash === refreshHash
      if (matchesPrevious && (!session.previousRefreshGraceUntil || session.previousRefreshGraceUntil <= rotationNow)) {
        await this.revokeLockedSession(manager, session, 'refresh_replay_detected', rotationNow)
        const graceExpiredBySeconds = session.previousRefreshGraceUntil
          ? Math.max(0, Math.floor((rotationNow.getTime() - session.previousRefreshGraceUntil.getTime()) / 1000))
          : null
        await auditService.record({
          actionType: 'refresh_replay_detected',
          actionLabel: '检测到刷新令牌重放',
          targetType: 'client_mobile_session',
          targetId: session.id,
          actor: auditActorFromClientUser(session.user),
          resultStatus: 'failed',
          requestMeta,
          detail: { generation: session.refreshGeneration, graceExpiredBySeconds, trigger: 'prev_expired' },
        }, manager)
        await notificationService.emitEvent({
          eventType: 'mobile_refresh_replay_detected',
          sourceType: 'client_mobile_session',
          sourceId: session.id,
          payload: { generation: session.refreshGeneration, trigger: 'prev_expired' },
          requestMeta,
        }, manager)
        return {
          kind: 'error',
          error: mobileError('出于安全考虑，您的登录已被重置，请重新登录', 401, 40113),
        } as const
      }
      if (!matchesCurrent && !matchesPrevious) {
        return { kind: 'error', error: mobileError('刷新凭证无效', 401, 40110) } as const
      }
      try {
        await authSecurityService.guardMobileRefreshRequest(requestMeta, session.id, manager)
      } catch (error) {
        // 限流审计需要与桶状态一起提交；将明确的 429 转为事务结果，避免 throw 触发整体回滚。
        if (error instanceof BizError && error.code === 42900) {
          return { kind: 'error', error } as const
        }
        throw error
      }
      const viaGrace = matchesPrevious
      const accessExpiresAt = minimumDate(
        addMilliseconds(rotationNow, env.MOBILE_ACCESS_TTL_MINUTES * 60 * 1000),
        session.absoluteExpiresAt,
      )
      const refreshExpiresAt = minimumDate(
        addMilliseconds(rotationNow, env.MOBILE_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
        session.absoluteExpiresAt,
      )
      const graceUntil = addMilliseconds(rotationNow, env.MOBILE_REFRESH_GRACE_SECONDS * 1000)
      const forceCasConflict = await contractVerificationHooks?.forceRefreshCasConflict?.(session.id) ?? false
      const updateResult = await manager.getRepository(ClientMobileSession)
        .createQueryBuilder()
        .update(ClientMobileSession)
        .set({
          previousRefreshTokenHash: () => 'refresh_token_hash',
          refreshTokenHash: hashMobileToken(nextRefreshToken),
          previousRefreshGraceUntil: graceUntil,
          refreshGeneration: () => 'refresh_generation + 1',
          accessTokenHash: hashMobileToken(accessToken),
          accessExpiresAt,
          refreshExpiresAt,
          appVersion: device.appVersion ?? session.appVersion,
          lastIp: requestMeta?.ipAddress ?? session.lastIp,
          lastAccessAt: rotationNow,
        })
        .where('id = :id AND revoked_at IS NULL AND refresh_generation = :generation AND refresh_token_hash = :lockedCurrentHash', {
          id: session.id,
          generation: session.refreshGeneration + (forceCasConflict ? 1 : 0),
          lockedCurrentHash: session.refreshTokenHash,
        })
        .execute()
      if (updateResult.affected !== 1) {
        throw new MobileRefreshCasConflictError('Mobile refresh CAS 并发冲突')
      }
      await contractVerificationHooks?.afterRefreshCas?.(session.id)

      session.previousRefreshTokenHash = session.refreshTokenHash
      session.refreshTokenHash = hashMobileToken(nextRefreshToken)
      session.previousRefreshGraceUntil = graceUntil
      session.refreshGeneration += 1
      session.accessTokenHash = hashMobileToken(accessToken)
      session.accessExpiresAt = accessExpiresAt
      session.refreshExpiresAt = refreshExpiresAt
      session.appVersion = device.appVersion ?? session.appVersion
      session.lastIp = requestMeta?.ipAddress ?? session.lastIp
      session.lastAccessAt = rotationNow
      await auditService.record({
        actionType: 'mobile_refresh',
        actionLabel: 'Mobile 刷新令牌',
        targetType: 'client_mobile_session',
        targetId: session.id,
        actor: auditActorFromClientUser(session.user),
        requestMeta,
        detail: {
          generation: session.refreshGeneration,
          viaGrace,
          deviceIdMismatch: device.deviceId !== session.deviceId,
        },
      }, manager)
      return { kind: 'success', session, user: session.user } as const
    }))

    if (rotated.kind === 'error') throw rotated.error
    const rotationObservedAt = new Date()
    const rotationWindow = await persistentRiskStateService.consumeWindow(
      `mobile-refresh-rotation:${classified.sessionId}`,
      env.MOBILE_REFRESH_ROTATION_RATE_WINDOW_SECONDS * 1000,
      rotationObservedAt.getTime(),
      env.MOBILE_REFRESH_ROTATION_RATE_LIMIT,
    )
    if (rotationWindow.totalHits > env.MOBILE_REFRESH_ROTATION_RATE_LIMIT) {
      await runInTransaction(async (manager) => {
        const session = await this.buildSessionIdLookup(manager, classified.sessionId, true).getOne()
        if (!session || session.revokedAt) return
        await this.revokeLockedSession(manager, session, 'refresh_replay_detected', rotationObservedAt)
        await auditService.record({
          actionType: 'refresh_replay_detected',
          actionLabel: '检测到刷新令牌重放',
          targetType: 'client_mobile_session',
          targetId: session.id,
          actor: session.user ? auditActorFromClientUser(session.user) : null,
          resultStatus: 'failed',
          requestMeta,
          detail: { generation: session.refreshGeneration, trigger: 'burst' },
        }, manager)
        await notificationService.emitEvent({
          eventType: 'mobile_refresh_replay_detected',
          sourceType: 'client_mobile_session',
          sourceId: session.id,
          payload: { generation: session.refreshGeneration, trigger: 'burst' },
          requestMeta,
        }, manager)
      })
      throw mobileError('出于安全考虑，您的登录已被重置，请重新登录', 401, 40113)
    }
    return this.buildCredentials(rotated.session, rotated.user, accessToken, nextRefreshToken)
  }

  async resolveAccess(
    accessToken: string,
    attemptedEndpoint = 'unknown',
    requestMeta?: RequestMeta,
  ): Promise<MobileAuthContext> {
    const token = accessToken?.trim() ?? ''
    if (!isMobileAccessToken(token)) throw mobileError('Access Token 缺失或格式非法', 401, 40100)
    const now = new Date()
    const session = await AppDataSource.getRepository(ClientMobileSession).findOne({
      where: { accessTokenHash: hashMobileToken(token) },
      relations: { user: true },
    })
    if (!session?.user) throw mobileError('Access Token 无效或已撤销', 401, 40101)
    if (session.user.status !== 'enabled') {
      const actor = auditActorFromClientUser(session.user)
      await runInTransaction(async (manager) => {
        await this.revokeSessionsForUser(manager, session.clientUserId, 'account_disabled')
        await auditService.record({
          actionType: 'account_disabled_session_rejected',
          actionLabel: '停用账号会话拒绝',
          targetType: 'client_mobile_session',
          targetId: session.id,
          actor,
          resultStatus: 'failed',
          requestMeta,
          detail: { attemptedEndpoint },
        }, manager)
      })
      throw mobileError('当前账号已停用', 403, 40300)
    }
    if (session.revokedAt) throw mobileError('Access Token 无效或已撤销', 401, 40101)
    if (session.accessExpiresAt <= now || session.absoluteExpiresAt <= now) {
      throw mobileError('Access Token 已过期', 401, 40102)
    }

    if (session.lastAccessAt < addMilliseconds(now, -ACCESS_ACTIVITY_WRITE_INTERVAL_MS)) {
      await runInTransaction(async (manager) => {
        await manager.getRepository(ClientMobileSession).createQueryBuilder()
          .update(ClientMobileSession)
          .set({ lastAccessAt: now })
          .where('id = :id AND last_access_at < :threshold', {
            id: session.id,
            threshold: addMilliseconds(now, -ACCESS_ACTIVITY_WRITE_INTERVAL_MS),
          })
          .execute()
      })
      session.lastAccessAt = now
    }
    return { userId: session.clientUserId, sessionId: session.id, accessToken: token, user: session.user, session }
  }

  async revokeCurrent(auth: MobileAuthContext, requestMeta?: RequestMeta) {
    await runInTransaction(async (manager) => {
      const result = await manager.getRepository(ClientMobileSession).createQueryBuilder()
        .update(ClientMobileSession)
        .set({ revokedAt: new Date(), revokeReason: 'user_logout' })
        .where('id = :id AND client_user_id = :userId AND revoked_at IS NULL', {
          id: auth.sessionId,
          userId: auth.userId,
        })
        .execute()
      await auditService.record({
        actionType: 'mobile_logout',
        actionLabel: 'Mobile 登出',
        targetType: 'client_mobile_session',
        targetId: auth.sessionId,
        actor: auditActorFromClientUser(auth.user),
        requestMeta,
        detail: { deviceId: auth.session.deviceId, revoked: (result.affected ?? 0) > 0 },
      }, manager)
    })
    return { revoked: true as const }
  }

  /** Logout 专用解析允许同一已撤销 access token 重试，只能再次确认撤销其原所属 session。 */
  async revokeByAccessToken(accessToken: string, requestMeta?: RequestMeta) {
    const token = accessToken?.trim() ?? ''
    if (!isMobileAccessToken(token)) throw mobileError('Access Token 缺失或格式非法', 401, 40100)
    const accessHash = hashMobileToken(token)
    return runInTransaction(async (manager) => {
      const session = await manager.getRepository(ClientMobileSession).findOne({
        where: { accessTokenHash: accessHash },
        relations: { user: true },
      })
      if (!session) throw mobileError('Access Token 无效或已撤销', 401, 40101)
      if (!session.revokedAt) {
        session.revokedAt = new Date()
        session.revokeReason = 'user_logout'
        await manager.getRepository(ClientMobileSession).save(session)
        await auditService.record({
          actionType: 'mobile_logout',
          actionLabel: 'Mobile 登出',
          targetType: 'client_mobile_session',
          targetId: session.id,
          actor: session.user ? auditActorFromClientUser(session.user) : null,
          requestMeta,
          detail: { deviceId: session.deviceId, revoked: true },
        }, manager)
      }
      return { revoked: true as const }
    })
  }

  async revokeSessionsForUser(
    manager: EntityManager,
    userId: string,
    reason: MobileSessionRevokeReason,
    excludeSessionId?: string,
  ): Promise<number> {
    const query = manager.getRepository(ClientMobileSession).createQueryBuilder()
      .update(ClientMobileSession)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where('client_user_id = :userId AND revoked_at IS NULL', { userId })
    if (excludeSessionId) query.andWhere('id <> :excludeSessionId', { excludeSessionId })
    const result = await query.execute()
    return result.affected ?? 0
  }

  async logoutAll(auth: MobileAuthContext, scope: 'all' | 'others', requestMeta?: RequestMeta) {
    const result = await runInTransaction(async (manager) => {
      const revokedCount = await this.revokeSessionsForUser(
        manager,
        auth.userId,
        scope === 'all' ? 'user_logout_all' : 'user_revoke_device',
        scope === 'others' ? auth.sessionId : undefined,
      )
      await auditService.record({
        actionType: 'mobile_logout_all',
        actionLabel: 'Mobile 全部登出',
        targetType: 'client_user',
        targetId: auth.userId,
        actor: auditActorFromClientUser(auth.user),
        requestMeta,
        detail: { scope, revokedCount },
      }, manager)
      return { revokedCount, currentSessionRevoked: scope === 'all' }
    })
    return result
  }

  async listSessions(auth: MobileAuthContext) {
    const now = new Date()
    const sessions = await AppDataSource.getRepository(ClientMobileSession).find({
      where: {
        clientUserId: auth.userId,
        revokedAt: IsNull(),
        absoluteExpiresAt: MoreThan(now),
        refreshExpiresAt: MoreThan(now),
      },
      order: { lastAccessAt: 'DESC', id: 'DESC' },
    })
    return {
      sessions: sessions.map((session) => this.toSessionSummary(session, auth.sessionId, true)),
      maxActiveSessions: env.MOBILE_MAX_ACTIVE_SESSIONS,
    }
  }

  async revokeOwnedSession(auth: MobileAuthContext, targetSessionId: string, requestMeta?: RequestMeta) {
    await runInTransaction(async (manager) => {
      const target = await manager.getRepository(ClientMobileSession).findOne({
        where: { id: targetSessionId, clientUserId: auth.userId },
      })
      if (!target) throw new BizError('会话不存在', 404)
      if (!target.revokedAt) {
        target.revokedAt = new Date()
        target.revokeReason = 'user_revoke_device'
        await manager.getRepository(ClientMobileSession).save(target)
      }
      await auditService.record({
        actionType: 'mobile_session_revoked',
        actionLabel: 'Mobile 会话撤销',
        targetType: 'client_mobile_session',
        targetId: target.id,
        actor: auditActorFromClientUser(auth.user),
        requestMeta,
        detail: { revokeReason: 'user_revoke_device', initiatedBy: auth.sessionId },
      }, manager)
    })
    return { revoked: true as const }
  }

  async cleanupExpiredBatch(): Promise<number> {
    const now = new Date()
    return runInTransaction(async (manager) => {
      const repository = manager.getRepository(ClientMobileSession)
      const retentionCutoff = addMilliseconds(now, -RETENTION_MS)
      const staleCandidates = await repository.find({
        where: [
          { revokedAt: LessThanOrEqual(retentionCutoff) },
          { absoluteExpiresAt: LessThanOrEqual(retentionCutoff) },
        ],
        order: { id: 'ASC' },
        take: CLEANUP_BATCH_SIZE,
      })
      if (staleCandidates.length > 0) {
        const result = await repository.delete(staleCandidates.map((item) => item.id))
        return result.affected ?? 0
      }

      const candidates = await repository.find({
        where: [
          { absoluteExpiresAt: LessThanOrEqual(now), revokedAt: IsNull() },
          { refreshExpiresAt: LessThanOrEqual(now), revokedAt: IsNull() },
        ],
        order: { id: 'ASC' },
        take: CLEANUP_BATCH_SIZE,
      })
      if (candidates.length === 0) return 0
      const result = await repository.createQueryBuilder()
        .update(ClientMobileSession)
        .set({ revokedAt: now, revokeReason: 'expired_cleanup' })
        .whereInIds(candidates.map((item) => item.id))
        .andWhere('revoked_at IS NULL')
        .execute()
      return result.affected ?? 0
    })
  }

  private async runCleanupCycle() {
    let processed = 0
    do {
      processed = await this.cleanupExpiredBatch()
      if (processed === CLEANUP_BATCH_SIZE) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
      }
    } while (processed === CLEANUP_BATCH_SIZE)
  }

  startCleanupLoop() {
    if (this.cleanupLoopTimer) return
    this.cleanupLoopTimer = globalThis.setInterval(() => {
      void this.runCleanupCycle().catch(() => undefined)
    }, CLEANUP_INTERVAL_MS)
  }

  stopCleanupLoop() {
    if (!this.cleanupLoopTimer) return
    globalThis.clearInterval(this.cleanupLoopTimer)
    this.cleanupLoopTimer = null
  }
}

export const mobileSessionService = new MobileSessionService()
