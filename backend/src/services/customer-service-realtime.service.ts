/**
 * 模块说明：backend/src/services/customer-service-realtime.service.ts
 * 文件职责：维护客服 SSE 连接，并在每次敏感业务事件前复核持久化会话与权限。
 * 实现逻辑：订阅表只保存令牌摘要；投递按会话批量复核，失效会话立即断开；写缓冲过载时停止累积并关闭慢消费者。
 * 跨实例：
 * - 连接对象只能留在本实例；配置 Redis 后，会话事件与撤权断连先在本实例生效，再经 Redis 总线广播给其他实例，
 *   接收方走同一套“回库复核 + 背压上限”的投递路径；Pub/Sub 至多一次送达，丢失时由 30 秒空闲复核与客户端重连回读兜底；
 * - 在线态按“本实例实时 + 其他实例每 5 秒上报”合并为集群口径，实例异常退出时其上报最长 30 秒后过期；
 * - SSE 建连频控在 Redis 启用时并入共享风控桶，避免 N 个实例把每会话配额放大 N 倍；
 * - eventId 由事件产生的实例分配，只保证同一实例内递增，前端不依赖其跨实例顺序。
 * 维护说明：Redis 未配置时行为与单实例内存实现完全一致；每进程连接上限仍按实例计算，用来保护本进程资源。
 */

import type { Response } from 'express'
import { In, MoreThan } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { resolvePermissionsByRole } from '../constants/auth-permissions.js'
import { ClientMobileSession } from '../entities/client-mobile-session.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { ClientUserSession } from '../entities/client-user-session.entity.js'
import { SysUser } from '../entities/sys-user.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import { hashSessionToken } from '../utils/session-token.js'
import { isAdminSessionIdleExpired } from '../utils/admin-session-idle.js'
import { isMobileAccessToken } from '../utils/mobile-token.js'
import { BizError } from '../utils/errors.js'
import { CUSTOMER_SERVICE_REALTIME_POLICY } from './client-feedback-security-policy.js'
import { isAccountCurrentlyDeactivated } from './account-business-guard.service.js'
import { persistentRiskStateService } from './persistent-risk-state.service.js'
import { publishRedisBus, subscribeRedisBus } from '../redis/redis-bus.js'
import { getRedisClient, getRedisInstanceId, isRedisEnabled, isRedisReady, recordRedisDegrade, redisKey } from '../redis/redis-client.js'

export interface CustomerServiceRealtimeEventPayload {
  eventType: string
  conversationId: string
  clientUserId: string
  occurredAt: string
  conversation: unknown
  message?: unknown
  detail?: Record<string, unknown>
  audience?: 'all' | 'service'
}

export type RealtimeScope = 'client' | 'service'
type ClientSessionKind = 'web' | 'mobile'

export interface CustomerServiceRealtimeRegistrationTicket {
  scope: RealtimeScope
  ownerKey: string
  globalEpoch: number
  generation: number
  sessionHash: string
  sessionGeneration: number
  expiresAtMs: number
}

interface CustomerServiceRealtimeGenerationRecord {
  generation: number
  expiresAtMs: number
}

const CUSTOMER_SERVICE_REALTIME_REGISTRATION_TICKET_TTL_MS = 5_000
const CUSTOMER_SERVICE_REALTIME_GENERATION_RECORD_RETENTION_MS = CUSTOMER_SERVICE_REALTIME_REGISTRATION_TICKET_TTL_MS
const CUSTOMER_SERVICE_REALTIME_GENERATION_RECORD_CAPACITY = 1_024

interface CustomerServiceRealtimeSubscriber {
  subscriberId: string
  scope: RealtimeScope
  clientSessionKind: ClientSessionKind | null
  ownerKey: string
  sessionHash: string
  res: Response
  heartbeatTimer: NodeJS.Timeout | null
  revalidateTimer: NodeJS.Timeout | null
  slowConsumerTimer: NodeJS.Timeout | null
  detachListeners: () => void
  drainListener: (() => void) | null
  blocked: boolean
}

export interface CustomerServiceRealtimeSessionSnapshot {
  currentConversationEventId: number
  clientConnectionCount: number
  serviceConnectionCount: number
}

export interface CustomerServiceRealtimeOpenStreamInitPayload {
  availability?: unknown
}

type CustomerServiceRealtimeInitPayloadResolver =
  | CustomerServiceRealtimeOpenStreamInitPayload
  | ((sessionSnapshot: CustomerServiceRealtimeSessionSnapshot) => CustomerServiceRealtimeOpenStreamInitPayload)

interface ConnectRateWindow {
  startedAt: number
  attempts: number
}

const REALTIME_BUS_CONVERSATION_TOPIC = 'cs:conversation'
const REALTIME_BUS_REVOKE_TOPIC = 'cs:revoke'
/** 集群在线态：每 5 秒上报并读取一次，上报有效期 30 秒（实例异常退出后最多 30 秒从在线人数中消失）。 */
const CLUSTER_PRESENCE_SYNC_INTERVAL_MS = 5_000
const CLUSTER_PRESENCE_TTL_MS = 30_000
const CLUSTER_PRESENCE_STALE_MS = 15_000

interface ClusterPresenceCache {
  /** 其他实例上报的在线客服 ownerKey（已排除本实例）。 */
  remoteServiceOwners: Set<string>
  /** 其他实例上报的客户端连接数之和（已排除本实例）。 */
  remoteClientConnections: number
  refreshedAt: number
}

const isRealtimeScope = (value: unknown): value is RealtimeScope => value === 'client' || value === 'service'

/** 跨实例事件载荷校验：总线消息视为不可信输入，字段类型不符直接丢弃。 */
const parseRemoteConversationEvent = (value: unknown): { payload: CustomerServiceRealtimeEventPayload; eventId: number } | null => {
  if (!value || typeof value !== 'object') return null
  const { payload, eventId } = value as { payload?: Partial<CustomerServiceRealtimeEventPayload>; eventId?: unknown }
  if (!payload || typeof payload !== 'object' || typeof eventId !== 'number' || !Number.isFinite(eventId)) return null
  if (typeof payload.eventType !== 'string' || typeof payload.conversationId !== 'string'
    || typeof payload.clientUserId !== 'string' || typeof payload.occurredAt !== 'string') return null
  if (payload.audience !== undefined && payload.audience !== 'all' && payload.audience !== 'service') return null
  if (payload.detail !== undefined && (payload.detail === null || typeof payload.detail !== 'object')) return null
  return { payload: payload as CustomerServiceRealtimeEventPayload, eventId }
}

class CustomerServiceRealtimeService {
  private readonly subscribers = new Map<string, CustomerServiceRealtimeSubscriber>()
  private readonly connectRateWindows = new Map<string, ConnectRateWindow>()
  private readonly generationRecords = new Map<string, CustomerServiceRealtimeGenerationRecord>()
  private globalGenerationEpoch = 0
  private subscriberSeed = 0
  private conversationEventSeed = 0
  private deliveryChain: Promise<void> = Promise.resolve()
  private pendingDeliveryMessages = 0
  private pendingDeliveryBytes = 0
  private clusterPresence: ClusterPresenceCache | null = null
  private clusterPresenceTimer: NodeJS.Timeout | null = null
  private clusterPresenceSyncing = false

  constructor() {
    // 处理器在模块加载时注册；未配置 Redis 时总线不会启动，注册本身没有副作用。
    subscribeRedisBus(REALTIME_BUS_CONVERSATION_TOPIC, (message) => {
      const parsed = parseRemoteConversationEvent(message)
      if (parsed) this.deliverConversationEvent(parsed.payload, parsed.eventId)
    })
    subscribeRedisBus(REALTIME_BUS_REVOKE_TOPIC, (message) => {
      if (!message || typeof message !== 'object') return
      const { kind, scope, key } = message as { kind?: unknown; scope?: unknown; key?: unknown }
      if (!isRealtimeScope(scope) || typeof key !== 'string' || !key || key.length > 256) return
      if (kind === 'owner') this.applyOwnerRevocation(scope, key)
      else if (kind === 'session') this.applySessionRevocation(scope, key)
    })
  }

  private buildSubscriberId(scope: RealtimeScope) {
    this.subscriberSeed += 1
    return `${scope}_${Date.now()}_${this.subscriberSeed}`
  }

  private buildOwnerGenerationKey(scope: RealtimeScope, ownerKey: string) {
    return `owner:${scope}:${ownerKey}`
  }

  private buildSessionGenerationKey(scope: RealtimeScope, sessionHash: string) {
    return `session:${scope}:${sessionHash}`
  }

  private pruneExpiredGenerationRecords(nowMs: number) {
    for (const [key, record] of this.generationRecords) {
      if (record.expiresAtMs <= nowMs) this.generationRecords.delete(key)
    }
  }

  private readGeneration(key: string, retainUntilMs?: number) {
    const record = this.generationRecords.get(key)
    if (record && retainUntilMs && record.expiresAtMs < retainUntilMs) record.expiresAtMs = retainUntilMs
    return record?.generation ?? 0
  }

  private advanceGeneration(key: string) {
    const nowMs = Date.now()
    this.pruneExpiredGenerationRecords(nowMs)
    if (!this.generationRecords.has(key) && this.generationRecords.size >= CUSTOMER_SERVICE_REALTIME_GENERATION_RECORD_CAPACITY) {
      // 清表前先推进 epoch，保证容量回收不会把旧 ticket 的 generation 重置成可再次匹配的 0。
      this.globalGenerationEpoch += 1
      this.generationRecords.clear()
    }
    const currentGeneration = this.generationRecords.get(key)?.generation ?? 0
    this.generationRecords.set(key, {
      generation: currentGeneration + 1,
      expiresAtMs: nowMs + CUSTOMER_SERVICE_REALTIME_GENERATION_RECORD_RETENTION_MS,
    })
  }

  captureOwnerGeneration(scope: RealtimeScope, ownerKey: string, sessionToken: string): CustomerServiceRealtimeRegistrationTicket {
    const nowMs = Date.now()
    this.pruneExpiredGenerationRecords(nowMs)
    const sessionHash = hashSessionToken(sessionToken)
    const expiresAtMs = nowMs + CUSTOMER_SERVICE_REALTIME_REGISTRATION_TICKET_TTL_MS
    return {
      scope,
      ownerKey,
      globalEpoch: this.globalGenerationEpoch,
      generation: this.readGeneration(this.buildOwnerGenerationKey(scope, ownerKey), expiresAtMs),
      sessionHash,
      sessionGeneration: this.readGeneration(this.buildSessionGenerationKey(scope, sessionHash), expiresAtMs),
      expiresAtMs,
    }
  }

  private assertRegistrationTicket(ticket: CustomerServiceRealtimeRegistrationTicket, scope: RealtimeScope, ownerKey: string, sessionToken: string) {
    const nowMs = Date.now()
    this.pruneExpiredGenerationRecords(nowMs)
    if (ticket.expiresAtMs <= nowMs) throw new BizError('实时连接注册 ticket 已过期，请重试', 401)
    const currentGeneration = this.readGeneration(this.buildOwnerGenerationKey(scope, ownerKey))
    const sessionHash = hashSessionToken(sessionToken)
    const currentSessionGeneration = this.readGeneration(this.buildSessionGenerationKey(scope, sessionHash))
    if (
      ticket.scope !== scope
      || ticket.ownerKey !== ownerKey
      || ticket.globalEpoch !== this.globalGenerationEpoch
      || ticket.generation !== currentGeneration
      || ticket.sessionHash !== sessionHash
      || ticket.sessionGeneration !== currentSessionGeneration
    ) {
      throw new BizError('实时连接授权状态已变化，请重新登录后重试', 401)
    }
  }

  async assertOwnerCanRegister(ticket: CustomerServiceRealtimeRegistrationTicket, sessionToken: string): Promise<void> {
    this.assertRegistrationTicket(ticket, ticket.scope, ticket.ownerKey, sessionToken)
    const now = new Date()
    const sessionHash = hashSessionToken(sessionToken)
    if (isRedisEnabled()) await this.checkClusterConnectRateLimit(ticket.scope, sessionHash)
    if (ticket.scope === 'client') {
      const sessionValid = isMobileAccessToken(sessionToken)
        ? Boolean(await AppDataSource.getRepository(ClientMobileSession)
          .createQueryBuilder('session')
          .where('session.client_user_id = :ownerKey', { ownerKey: ticket.ownerKey })
          .andWhere('session.access_token_hash = :sessionHash', { sessionHash })
          .andWhere('session.revoked_at IS NULL')
          .andWhere('session.access_expires_at > :now', { now })
          .andWhere('session.absolute_expires_at > :now', { now })
          .getOne())
        : Boolean(await AppDataSource.getRepository(ClientUserSession).findOne({
          where: { userId: ticket.ownerKey, sessionToken: sessionHash, expiresAt: MoreThan(now) },
        }))
      const user = sessionValid
        ? await AppDataSource.getRepository(ClientUser).findOne({ where: { id: ticket.ownerKey } })
        : null
      if (!sessionValid || !user || user.status !== 'enabled' || isAccountCurrentlyDeactivated(user)) {
        throw new BizError('客户端实时连接登录状态已失效', 401)
      }
      return
    }

    const activeSession = await AppDataSource.getRepository(SysUserSession).findOne({
      where: { userId: ticket.ownerKey, sessionToken: sessionHash, expiresAt: MoreThan(now) },
    })
    const session = activeSession && !isAdminSessionIdleExpired(activeSession, now) ? activeSession : null
    const user = session
      ? await AppDataSource.getRepository(SysUser).findOne({ where: { id: ticket.ownerKey } })
      : null
    if (
      !session
      || !user
      || user.status !== 'enabled'
      || isAccountCurrentlyDeactivated(user)
      || !resolvePermissionsByRole(user.role).includes('customer_service:view')
    ) {
      throw new BizError('客服实时连接登录状态已失效', 401)
    }
  }

  private writeSseEvent(subscriber: CustomerServiceRealtimeSubscriber, eventName: string, data: unknown): boolean {
    if (!this.subscribers.has(subscriber.subscriberId) || this.isResponseClosed(subscriber.res)) {
      this.closeSubscriber(subscriber.subscriberId)
      return false
    }
    if (subscriber.blocked) return false
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
    let accepted: boolean
    try {
      accepted = subscriber.res.write(payload)
    } catch {
      this.closeSubscriber(subscriber.subscriberId)
      return false
    }
    if (!this.subscribers.has(subscriber.subscriberId) || this.isResponseClosed(subscriber.res)) {
      this.closeSubscriber(subscriber.subscriberId)
      return false
    }
    // write(false) 表示数据已进入缓冲区，等待 drain；不能当作断连立即释放健康连接。
    if (!accepted || subscriber.res.writableLength > CUSTOMER_SERVICE_REALTIME_POLICY.slowConsumerMaxBufferedBytes) {
      this.pauseSlowSubscriber(subscriber)
    }
    return true
  }

  private pauseSlowSubscriber(subscriber: CustomerServiceRealtimeSubscriber) {
    if (subscriber.blocked) return
    subscriber.blocked = true
    const resume = () => {
      if (!this.subscribers.has(subscriber.subscriberId)) return
      subscriber.blocked = false
      subscriber.drainListener = null
      if (subscriber.slowConsumerTimer) clearTimeout(subscriber.slowConsumerTimer)
      subscriber.slowConsumerTimer = null
    }
    subscriber.drainListener = resume
    subscriber.res.once('drain', resume)
    subscriber.slowConsumerTimer = setTimeout(() => this.closeSubscriber(subscriber.subscriberId), CUSTOMER_SERVICE_REALTIME_POLICY.slowConsumerTimeoutMs)
    subscriber.slowConsumerTimer.unref?.()
  }

  private closeSubscriber(subscriberId: string) {
    const subscriber = this.subscribers.get(subscriberId)
    if (!subscriber) return
    this.removeSubscriber(subscriberId)
    if (!subscriber.res.writableEnded && !subscriber.res.destroyed) subscriber.res.end()
  }

  private removeSubscriber(subscriberId: string) {
    const subscriber = this.subscribers.get(subscriberId)
    if (!subscriber) return
    if (subscriber.heartbeatTimer) clearInterval(subscriber.heartbeatTimer)
    if (subscriber.revalidateTimer) clearInterval(subscriber.revalidateTimer)
    if (subscriber.slowConsumerTimer) clearTimeout(subscriber.slowConsumerTimer)
    this.subscribers.delete(subscriberId)
    if (subscriber.scope === 'service') this.requestClusterPresenceSync()
    subscriber.detachListeners()
    if (subscriber.drainListener) subscriber.res.off('drain', subscriber.drainListener)
    subscriber.drainListener = null
  }

  private isResponseClosed(res: Response) {
    return res.destroyed || res.writableEnded || res.closed || res.socket?.destroyed === true
  }

  private pruneClosedSubscribers() {
    for (const subscriber of this.subscribers.values()) {
      if (this.isResponseClosed(subscriber.res)) this.removeSubscriber(subscriber.subscriberId)
    }
  }

  private countSubscribers(predicate: (subscriber: CustomerServiceRealtimeSubscriber) => boolean) {
    let count = 0
    for (const subscriber of this.subscribers.values()) if (predicate(subscriber)) count += 1
    return count
  }

  /** Redis 启用时的建连频控：并入共享风控桶（Redis 优先、数据库兜底），多实例合并计数。 */
  private async checkClusterConnectRateLimit(scope: RealtimeScope, sessionHash: string) {
    const limit = CUSTOMER_SERVICE_REALTIME_POLICY.connectionRateLimit
    const result = await persistentRiskStateService.consumeWindow(
      `cs-sse-connect:${scope}:${sessionHash}`,
      CUSTOMER_SERVICE_REALTIME_POLICY.connectionRateWindowMs,
      Date.now(),
      limit,
    )
    if (result.totalHits > limit) throw new BizError('实时连接请求过于频繁，请稍后再试', 429)
  }

  private checkConnectRateLimit(scope: RealtimeScope, sessionHash: string) {
    const key = `${scope}:${sessionHash}`
    const now = Date.now()
    for (const [candidateKey, value] of this.connectRateWindows) {
      if (now - value.startedAt >= CUSTOMER_SERVICE_REALTIME_POLICY.connectionRateWindowMs) {
        this.connectRateWindows.delete(candidateKey)
      }
    }
    const previous = this.connectRateWindows.get(key)
    if (!previous && this.connectRateWindows.size >= CUSTOMER_SERVICE_REALTIME_POLICY.connectionRateMaxEntries) {
      throw new BizError('实时连接请求过于频繁，请稍后再试', 429)
    }
    const active = previous && now - previous.startedAt < CUSTOMER_SERVICE_REALTIME_POLICY.connectionRateWindowMs
      ? previous
      : { startedAt: now, attempts: 0 }
    active.attempts += 1
    this.connectRateWindows.set(key, active)
    if (active.attempts > CUSTOMER_SERVICE_REALTIME_POLICY.connectionRateLimit) throw new BizError('实时连接请求过于频繁，请稍后再试', 429)
  }

  private assertConnectionCapacity(scope: RealtimeScope, ownerKey: string, sessionHash: string) {
    this.pruneClosedSubscribers()
    if (this.subscribers.size >= CUSTOMER_SERVICE_REALTIME_POLICY.maxSubscribersPerProcess) throw new BizError('实时连接数量已达上限，请稍后重试', 503)
    if (this.countSubscribers((item) => item.scope === scope && item.sessionHash === sessionHash) >= CUSTOMER_SERVICE_REALTIME_POLICY.maxSubscribersPerSession) throw new BizError('当前会话已达到实时连接上限', 429)
    if (this.countSubscribers((item) => item.scope === scope && item.ownerKey === ownerKey) >= CUSTOMER_SERVICE_REALTIME_POLICY.maxSubscribersPerOwner) throw new BizError('当前账号已达到实时连接上限', 429)
  }

  private async validateSubscribers(subscribers: CustomerServiceRealtimeSubscriber[]) {
    const now = new Date()
    const validIds = new Set<string>()
    const webClientSubscribers = subscribers.filter((item) => item.scope === 'client' && item.clientSessionKind === 'web')
    const mobileClientSubscribers = subscribers.filter((item) => item.scope === 'client' && item.clientSessionKind === 'mobile')
    const serviceSubscribers = subscribers.filter((item) => item.scope === 'service')
    for (const batch of [webClientSubscribers, mobileClientSubscribers, serviceSubscribers]) {
      for (let offset = 0; offset < batch.length; offset += CUSTOMER_SERVICE_REALTIME_POLICY.validationBatchSize) {
        const slice = batch.slice(offset, offset + CUSTOMER_SERVICE_REALTIME_POLICY.validationBatchSize)
        if (!slice.length) continue
        const hashes = [...new Set(slice.map((item) => item.sessionHash))]
        if (slice[0]?.clientSessionKind === 'web') {
          const sessions = await AppDataSource.getRepository(ClientUserSession).find({ where: { sessionToken: In(hashes), expiresAt: MoreThan(now) } })
          const users = sessions.length
            ? await AppDataSource.getRepository(ClientUser).find({ where: { id: In([...new Set(sessions.map((item) => item.userId))]), status: 'enabled' } })
            : []
          const ownerByHash = new Map(sessions.map((item) => [item.sessionToken, item.userId]))
          const enabledUsers = new Set(users.filter((item) => !isAccountCurrentlyDeactivated(item)).map((item) => String(item.id)))
          for (const subscriber of slice) {
            if (String(ownerByHash.get(subscriber.sessionHash) ?? '') === String(subscriber.ownerKey) && enabledUsers.has(String(subscriber.ownerKey))) validIds.add(subscriber.subscriberId)
          }
          continue
        }
        if (slice[0]?.clientSessionKind === 'mobile') {
          const sessions = await AppDataSource.getRepository(ClientMobileSession)
            .createQueryBuilder('session')
            .addSelect('session.accessTokenHash')
            .where('session.access_token_hash IN (:...hashes)', { hashes })
            .andWhere('session.revoked_at IS NULL')
            .andWhere('session.access_expires_at > :now', { now })
            .andWhere('session.absolute_expires_at > :now', { now })
            .getMany()
          const users = sessions.length
            ? await AppDataSource.getRepository(ClientUser).find({ where: { id: In([...new Set(sessions.map((item) => item.clientUserId))]), status: 'enabled' } })
            : []
          const ownerByHash = new Map(sessions.map((item) => [item.accessTokenHash, item.clientUserId]))
          const enabledUsers = new Set(users.filter((item) => !isAccountCurrentlyDeactivated(item)).map((item) => String(item.id)))
          for (const subscriber of slice) {
            if (String(ownerByHash.get(subscriber.sessionHash) ?? '') === String(subscriber.ownerKey) && enabledUsers.has(String(subscriber.ownerKey))) validIds.add(subscriber.subscriberId)
          }
          continue
        }
        // 管理端 SSE 复核与 HTTP 鉴权共用空闲超时口径，避免 API 已失效而后台推送仍继续。
        const sessions = (await AppDataSource.getRepository(SysUserSession).find({ where: { sessionToken: In(hashes), expiresAt: MoreThan(now) } }))
          .filter((item) => !isAdminSessionIdleExpired(item, now))
        const users = sessions.length
          ? await AppDataSource.getRepository(SysUser).find({ where: { id: In([...new Set(sessions.map((item) => item.userId))]), status: 'enabled' } })
          : []
        const ownerByHash = new Map(sessions.map((item) => [item.sessionToken, item.userId]))
        const authorizedUsers = new Set(users.filter((item) => (
          !isAccountCurrentlyDeactivated(item)
          && resolvePermissionsByRole(item.role).includes('customer_service:view')
        )).map((item) => String(item.id)))
        for (const subscriber of slice) {
          if (String(ownerByHash.get(subscriber.sessionHash) ?? '') === String(subscriber.ownerKey) && authorizedUsers.has(String(subscriber.ownerKey))) validIds.add(subscriber.subscriberId)
        }
      }
    }
    return validIds
  }

  private async revalidateActiveSubscribers(subscribers = Array.from(this.subscribers.values())) {
    subscribers = subscribers.filter((subscriber) => {
      if (this.isResponseClosed(subscriber.res)) this.removeSubscriber(subscriber.subscriberId)
      return this.subscribers.has(subscriber.subscriberId)
    })
    if (!subscribers.length) return new Set<string>()
    try {
      const validIds = await this.validateSubscribers(subscribers)
      for (const subscriber of subscribers) if (!validIds.has(subscriber.subscriberId)) this.closeSubscriber(subscriber.subscriberId)
      return validIds
    } catch {
      console.warn('[customer-service-realtime] SSE 会话复核失败，已停止投递')
      // 数据库无法确认授权状态时宁可断开，不得继续发送客服会话内容。
      for (const subscriber of subscribers) this.closeSubscriber(subscriber.subscriberId)
      return new Set<string>()
    }
  }

  private scheduleIdleRevalidation(subscriberId: string) {
    const subscriber = this.subscribers.get(subscriberId)
    if (!subscriber) return
    subscriber.revalidateTimer = setInterval(() => {
      void this.revalidateActiveSubscribers([subscriber]).catch(() => undefined)
    }, CUSTOMER_SERVICE_REALTIME_POLICY.revalidateIdleMs)
    subscriber.revalidateTimer.unref?.()
  }

  private registerSubscriber(scope: RealtimeScope, ownerKey: string, sessionToken: string, res: Response, keepaliveSeconds: number, ticket: CustomerServiceRealtimeRegistrationTicket, initPayload?: CustomerServiceRealtimeInitPayloadResolver) {
    this.assertRegistrationTicket(ticket, scope, ownerKey, sessionToken)
    const subscriberId = this.buildSubscriberId(scope)
    const socket = res.socket
    let closed = false
    const detachListeners = () => {
      res.off('close', cleanup)
      res.off('error', cleanup)
      res.off('finish', cleanup)
      socket?.off('close', cleanup)
    }
    const cleanup = () => {
      closed = true
      this.removeSubscriber(subscriberId)
      detachListeners()
    }
    // 配置/账号校验有异步窗口；必须先监听再检查，且先于headers、入表和首次写入。
    res.on('close', cleanup)
    res.on('error', cleanup)
    res.on('finish', cleanup)
    socket?.on('close', cleanup)
    if (this.isResponseClosed(res)) { cleanup(); return }
    try {
      const sessionHash = hashSessionToken(sessionToken)
      const clientSessionKind: ClientSessionKind | null = scope === 'client'
        ? (isMobileAccessToken(sessionToken) ? 'mobile' : 'web')
        : null
      this.assertConnectionCapacity(scope, ownerKey, sessionHash)
      // Redis 启用时频控已在 assertOwnerCanRegister 中按集群口径完成，这里只保留单实例的进程内频控。
      if (!isRedisEnabled()) this.checkConnectRateLimit(scope, sessionHash)
      res.status(200)
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
      if (closed || this.isResponseClosed(res)) { cleanup(); return }
      const subscriber: CustomerServiceRealtimeSubscriber = { subscriberId, scope, clientSessionKind, ownerKey, sessionHash, res, heartbeatTimer: null, revalidateTimer: null, slowConsumerTimer: null, detachListeners, drainListener: null, blocked: false }
      this.subscribers.set(subscriberId, subscriber)
      // 客服上线立即上报集群在线态，避免其他实例最长 5 秒才看到新客服。
      if (scope === 'service') this.requestClusterPresenceSync()
      const sessionSnapshot = this.buildServiceSessionSnapshot()
      const resolvedInitPayload = typeof initPayload === 'function' ? initPayload(sessionSnapshot) : initPayload
      if (!this.writeSseEvent(subscriber, 'connected', { eventType: 'connected', availability: resolvedInitPayload?.availability })) { cleanup(); return }
      subscriber.heartbeatTimer = setInterval(() => {
        if (this.isResponseClosed(res)) { cleanup(); return }
        // 正常背压由既有慢消费者超时处理；心跳不得把一次 write(false) 误作断连。
        if (!subscriber.blocked) this.writeSseEvent(subscriber, 'ping', { eventType: 'ping' })
      }, Math.max(5, keepaliveSeconds) * 1000)
      subscriber.heartbeatTimer.unref?.()
      this.scheduleIdleRevalidation(subscriberId)
    } catch (error) { cleanup(); throw error }
  }

  openClientStream(clientUserId: string, sessionToken: string, res: Response, keepaliveSeconds: number, ticket: CustomerServiceRealtimeRegistrationTicket, initPayload?: CustomerServiceRealtimeInitPayloadResolver) {
    this.registerSubscriber('client', clientUserId, sessionToken, res, keepaliveSeconds, ticket, initPayload)
  }

  openServiceStream(serviceUserId: string, sessionToken: string, res: Response, keepaliveSeconds: number, ticket: CustomerServiceRealtimeRegistrationTicket, initPayload?: CustomerServiceRealtimeInitPayloadResolver) {
    this.registerSubscriber('service', serviceUserId, sessionToken, res, keepaliveSeconds, ticket, initPayload)
  }

  /** 撤销某会话的实时连接：先在本实例推进代际并断开，再广播给其他实例。 */
  disconnectBySessionHash(scope: RealtimeScope, tokenHash: string): void {
    this.applySessionRevocation(scope, tokenHash)
    void publishRedisBus(REALTIME_BUS_REVOKE_TOPIC, { kind: 'session', scope, key: tokenHash })
  }

  /** 撤销某账号的全部实时连接：先在本实例推进代际并断开，再广播给其他实例。 */
  disconnectByOwner(scope: RealtimeScope, ownerKey: string): void {
    this.applyOwnerRevocation(scope, ownerKey)
    void publishRedisBus(REALTIME_BUS_REVOKE_TOPIC, { kind: 'owner', scope, key: ownerKey })
  }

  private applySessionRevocation(scope: RealtimeScope, tokenHash: string): void {
    this.advanceGeneration(this.buildSessionGenerationKey(scope, tokenHash))
    for (const subscriber of this.subscribers.values()) if (subscriber.scope === scope && subscriber.sessionHash === tokenHash) this.closeSubscriber(subscriber.subscriberId)
  }

  private applyOwnerRevocation(scope: RealtimeScope, ownerKey: string): void {
    this.advanceGeneration(this.buildOwnerGenerationKey(scope, ownerKey))
    for (const subscriber of this.subscribers.values()) if (subscriber.scope === scope && subscriber.ownerKey === ownerKey) this.closeSubscriber(subscriber.subscriberId)
  }

  buildGenerationBarrierSnapshot() {
    this.pruneExpiredGenerationRecords(Date.now())
    return {
      globalEpoch: this.globalGenerationEpoch,
      generationRecordCount: this.generationRecords.size,
      generationRecordCapacity: CUSTOMER_SERVICE_REALTIME_GENERATION_RECORD_CAPACITY,
      registrationTicketTtlMs: CUSTOMER_SERVICE_REALTIME_REGISTRATION_TICKET_TTL_MS,
      generationRecordRetentionMs: CUSTOMER_SERVICE_REALTIME_GENERATION_RECORD_RETENTION_MS,
    }
  }

  /**
   * 在线态快照：本实例连接实时计算；集群缓存新鲜（15 秒内）时再合并其他实例的上报，
   * 客服按 ownerKey 去重（同一客服在多个实例都有连接只算一人）。
   */
  buildServiceSessionSnapshot(): CustomerServiceRealtimeSessionSnapshot {
    this.pruneClosedSubscribers()
    const connections = Array.from(this.subscribers.values())
    const serviceOwners = new Set(connections.filter((item) => item.scope === 'service').map((item) => item.ownerKey))
    let clientConnectionCount = connections.filter((item) => item.scope === 'client').length
    const cluster = this.clusterPresence
    if (cluster && Date.now() - cluster.refreshedAt <= CLUSTER_PRESENCE_STALE_MS) {
      for (const ownerKey of cluster.remoteServiceOwners) serviceOwners.add(ownerKey)
      clientConnectionCount += cluster.remoteClientConnections
    }
    return {
      currentConversationEventId: this.conversationEventSeed,
      clientConnectionCount,
      serviceConnectionCount: serviceOwners.size,
    }
  }

  /** 集群在线态调试快照，供管理员性能接口观察。 */
  buildClusterPresenceSnapshot() {
    const cluster = this.clusterPresence
    return {
      enabled: isRedisEnabled(),
      refreshedAt: cluster ? new Date(cluster.refreshedAt).toISOString() : null,
      remoteServiceOwnerCount: cluster?.remoteServiceOwners.size ?? 0,
      remoteClientConnections: cluster?.remoteClientConnections ?? 0,
    }
  }

  private presenceKeys() {
    return { service: redisKey('cs', 'presence', 'service'), clients: redisKey('cs', 'presence', 'clients') }
  }

  private requestClusterPresenceSync() {
    if (!this.clusterPresenceTimer) return
    void this.syncClusterPresence()
  }

  /**
   * 上报本实例在线态并读取其他实例的上报：
   * - 客服：ZSET 成员为 ownerKey|instanceId，分值为过期时刻；本实例先删旧成员再写当前成员，下线即时生效；
   * - 客户端连接数：HASH 字段为 instanceId，值为 "连接数:过期时刻"。
   */
  private async syncClusterPresence(): Promise<void> {
    if (this.clusterPresenceSyncing) return
    const client = getRedisClient()
    if (!client || !isRedisReady()) return
    this.clusterPresenceSyncing = true
    try {
      this.pruneClosedSubscribers()
      const nowMs = Date.now()
      const expiresAt = nowMs + CLUSTER_PRESENCE_TTL_MS
      const instanceId = getRedisInstanceId()
      const memberSuffix = `|${instanceId}`
      const keys = this.presenceKeys()
      const connections = Array.from(this.subscribers.values())
      const localOwners = [...new Set(connections.filter((item) => item.scope === 'service').map((item) => item.ownerKey))]
      const localClients = connections.filter((item) => item.scope === 'client').length
      const existing = await client.zrange(keys.service, 0, -1)
      const pipeline = client.multi()
      const staleOwnMembers = existing.filter((member) => member.endsWith(memberSuffix))
      if (staleOwnMembers.length) pipeline.zrem(keys.service, ...staleOwnMembers)
      for (const ownerKey of localOwners) pipeline.zadd(keys.service, expiresAt, `${ownerKey}${memberSuffix}`)
      pipeline.zremrangebyscore(keys.service, '-inf', nowMs)
      pipeline.pexpire(keys.service, CLUSTER_PRESENCE_TTL_MS * 2)
      pipeline.hset(keys.clients, instanceId, `${localClients}:${expiresAt}`)
      pipeline.pexpire(keys.clients, CLUSTER_PRESENCE_TTL_MS * 2)
      pipeline.zrangebyscore(keys.service, nowMs, '+inf')
      pipeline.hgetall(keys.clients)
      const results = await pipeline.exec()
      const failed = results?.find(([error]) => error)
      if (!results || failed) throw failed?.[0] ?? new Error('在线态同步事务被中止')
      const activeMembers = (results[results.length - 2]?.[1] ?? []) as string[]
      const clientCounts = (results[results.length - 1]?.[1] ?? {}) as Record<string, string>
      const remoteServiceOwners = new Set<string>()
      for (const member of activeMembers) {
        const separator = member.lastIndexOf('|')
        if (separator <= 0 || member.slice(separator + 1) === instanceId) continue
        remoteServiceOwners.add(member.slice(0, separator))
      }
      let remoteClientConnections = 0
      const expiredFields: string[] = []
      for (const [field, value] of Object.entries(clientCounts)) {
        if (field === instanceId) continue
        const [countText, expiresText] = value.split(':')
        if (Number(expiresText) > nowMs) remoteClientConnections += Math.max(0, Number(countText) || 0)
        else expiredFields.push(field)
      }
      if (expiredFields.length) await client.hdel(keys.clients, ...expiredFields)
      this.clusterPresence = { remoteServiceOwners, remoteClientConnections, refreshedAt: Date.now() }
    } catch (error) {
      recordRedisDegrade('客服在线态同步', error)
    } finally {
      this.clusterPresenceSyncing = false
    }
  }

  /** Redis 启用时启动集群在线态同步；幂等。 */
  startClusterPresenceSync(): void {
    if (!isRedisEnabled() || this.clusterPresenceTimer) return
    this.clusterPresenceTimer = setInterval(() => {
      void this.syncClusterPresence()
    }, CLUSTER_PRESENCE_SYNC_INTERVAL_MS)
    this.clusterPresenceTimer.unref?.()
    void this.syncClusterPresence()
  }

  /** 停机时撤下本实例的在线上报，其他实例无需等待 30 秒过期。 */
  async stopClusterPresenceSync(): Promise<void> {
    if (this.clusterPresenceTimer) clearInterval(this.clusterPresenceTimer)
    this.clusterPresenceTimer = null
    this.clusterPresence = null
    const client = getRedisClient()
    if (!client || !isRedisReady()) return
    try {
      const keys = this.presenceKeys()
      const instanceId = getRedisInstanceId()
      const members = (await client.zrange(keys.service, 0, -1)).filter((member) => member.endsWith(`|${instanceId}`))
      const pipeline = client.multi().hdel(keys.clients, instanceId)
      if (members.length) pipeline.zrem(keys.service, ...members)
      await pipeline.exec()
    } catch (error) {
      recordRedisDegrade('客服在线态下线', error)
    }
  }

  private isSubscriberTargetedByEvent(
    subscriber: CustomerServiceRealtimeSubscriber,
    payload: CustomerServiceRealtimeEventPayload,
  ): boolean {
    if (subscriber.scope === 'service') return true
    return payload.audience !== 'service' && subscriber.ownerKey === payload.clientUserId
  }

  private closeSubscribersTargetedByEvent(payload: CustomerServiceRealtimeEventPayload): void {
    for (const subscriber of this.subscribers.values()) {
      if (this.isSubscriberTargetedByEvent(subscriber, payload)) {
        this.closeSubscriber(subscriber.subscriberId)
      }
    }
  }

  /** 发布会话事件：先投递给本实例连接，再经 Redis 总线广播给其他实例（未配置 Redis 时只做本地投递）。 */
  publishConversationEvent(payload: CustomerServiceRealtimeEventPayload) {
    this.conversationEventSeed += 1
    const eventId = this.conversationEventSeed
    this.deliverConversationEvent(payload, eventId)
    void publishRedisBus(REALTIME_BUS_CONVERSATION_TOPIC, { payload, eventId })
  }

  private deliverConversationEvent(payload: CustomerServiceRealtimeEventPayload, eventId: number) {
    const { audience: _audience, ...wirePayload } = payload
    const enrichedPayload = { ...wirePayload, eventId }
    let payloadBytes: number
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(enrichedPayload), 'utf8')
    } catch {
      console.warn('[customer-service-realtime] SSE 事件序列化失败，已关闭相关连接以便重新同步')
      this.closeSubscribersTargetedByEvent(payload)
      return
    }
    if (
      this.pendingDeliveryMessages + 1 > CUSTOMER_SERVICE_REALTIME_POLICY.maxPendingMessages
      || this.pendingDeliveryBytes + payloadBytes > CUSTOMER_SERVICE_REALTIME_POLICY.maxPendingBytes
    ) {
      console.warn('[customer-service-realtime] SSE 事件队列达到安全上限，已关闭相关连接以便重新同步')
      this.closeSubscribersTargetedByEvent(payload)
      return
    }
    this.pendingDeliveryMessages += 1
    this.pendingDeliveryBytes += payloadBytes
    const delivery = this.deliveryChain.catch(() => undefined).then(async () => {
      const subscribers = Array.from(this.subscribers.values())
      const validIds = await this.revalidateActiveSubscribers(subscribers)
      for (const subscriber of subscribers) {
        if (!validIds.has(subscriber.subscriberId)) continue
        if (!this.isSubscriberTargetedByEvent(subscriber, payload)) continue
        // 当前业务事件若遇到尚未恢复的背压，不能静默跳过后继续保持连接；
        // 关闭该连接让客户端重连并回读权威状态，避免留下无法感知的消息缺口。
        if (!this.writeSseEvent(subscriber, 'conversation', enrichedPayload)) {
          this.closeSubscriber(subscriber.subscriberId)
        }
      }
    })
    this.deliveryChain = delivery.finally(() => {
      this.pendingDeliveryMessages = Math.max(0, this.pendingDeliveryMessages - 1)
      this.pendingDeliveryBytes = Math.max(0, this.pendingDeliveryBytes - payloadBytes)
    }).catch(() => undefined)
  }
}

export const customerServiceRealtimeService = new CustomerServiceRealtimeService()
