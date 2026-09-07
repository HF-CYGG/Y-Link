/**
 * 模块说明：backend/src/services/customer-service-realtime.service.ts
 * 文件职责：维护客服 SSE 连接，并在每次敏感业务事件前复核持久化会话与权限。
 * 实现逻辑：订阅表只保存令牌摘要；投递按会话批量复核，失效会话立即断开；写缓冲过载时停止累积并关闭慢消费者。
 * 维护说明：当前为单实例内存实现；多实例部署前需要把连接路由与撤权广播迁移到可信消息总线。
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
import { isMobileAccessToken } from '../utils/mobile-token.js'
import { BizError } from '../utils/errors.js'
import { CUSTOMER_SERVICE_REALTIME_POLICY } from './client-feedback-security-policy.js'

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

type RealtimeScope = 'client' | 'service'
type ClientSessionKind = 'web' | 'mobile'

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

class CustomerServiceRealtimeService {
  private readonly subscribers = new Map<string, CustomerServiceRealtimeSubscriber>()
  private readonly connectRateWindows = new Map<string, ConnectRateWindow>()
  private subscriberSeed = 0
  private conversationEventSeed = 0
  private deliveryChain: Promise<void> = Promise.resolve()
  private pendingDeliveryMessages = 0
  private pendingDeliveryBytes = 0

  private buildSubscriberId(scope: RealtimeScope) {
    this.subscriberSeed += 1
    return `${scope}_${Date.now()}_${this.subscriberSeed}`
  }

  private writeSseEvent(subscriber: CustomerServiceRealtimeSubscriber, eventName: string, data: unknown): boolean {
    if (subscriber.blocked || subscriber.res.writableEnded || subscriber.res.destroyed) return false
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
    const accepted = subscriber.res.write(payload)
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
      if (subscriber.slowConsumerTimer) clearTimeout(subscriber.slowConsumerTimer)
      subscriber.slowConsumerTimer = null
    }
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
  }

  private countSubscribers(predicate: (subscriber: CustomerServiceRealtimeSubscriber) => boolean) {
    let count = 0
    for (const subscriber of this.subscribers.values()) if (predicate(subscriber)) count += 1
    return count
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
          const enabledUsers = new Set(users.map((item) => String(item.id)))
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
          const enabledUsers = new Set(users.map((item) => String(item.id)))
          for (const subscriber of slice) {
            if (String(ownerByHash.get(subscriber.sessionHash) ?? '') === String(subscriber.ownerKey) && enabledUsers.has(String(subscriber.ownerKey))) validIds.add(subscriber.subscriberId)
          }
          continue
        }
        const sessions = await AppDataSource.getRepository(SysUserSession).find({ where: { sessionToken: In(hashes), expiresAt: MoreThan(now) } })
        const users = sessions.length
          ? await AppDataSource.getRepository(SysUser).find({ where: { id: In([...new Set(sessions.map((item) => item.userId))]), status: 'enabled' } })
          : []
        const ownerByHash = new Map(sessions.map((item) => [item.sessionToken, item.userId]))
        const authorizedUsers = new Set(users.filter((item) => resolvePermissionsByRole(item.role).includes('customer_service:view')).map((item) => String(item.id)))
        for (const subscriber of slice) {
          if (String(ownerByHash.get(subscriber.sessionHash) ?? '') === String(subscriber.ownerKey) && authorizedUsers.has(String(subscriber.ownerKey))) validIds.add(subscriber.subscriberId)
        }
      }
    }
    return validIds
  }

  private async revalidateActiveSubscribers(subscribers = Array.from(this.subscribers.values())) {
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

  private registerSubscriber(scope: RealtimeScope, ownerKey: string, sessionToken: string, res: Response, keepaliveSeconds: number, initPayload?: CustomerServiceRealtimeInitPayloadResolver) {
    const sessionHash = hashSessionToken(sessionToken)
    const clientSessionKind: ClientSessionKind | null = scope === 'client'
      ? (isMobileAccessToken(sessionToken) ? 'mobile' : 'web')
      : null
    this.assertConnectionCapacity(scope, ownerKey, sessionHash)
    this.checkConnectRateLimit(scope, sessionHash)
    const subscriberId = this.buildSubscriberId(scope)
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const subscriber: CustomerServiceRealtimeSubscriber = { subscriberId, scope, clientSessionKind, ownerKey, sessionHash, res, heartbeatTimer: null, revalidateTimer: null, slowConsumerTimer: null, blocked: false }
    this.subscribers.set(subscriberId, subscriber)
    const sessionSnapshot = this.buildServiceSessionSnapshot()
    const resolvedInitPayload = typeof initPayload === 'function' ? initPayload(sessionSnapshot) : initPayload
    this.writeSseEvent(subscriber, 'connected', { eventType: 'connected', availability: resolvedInitPayload?.availability })
    subscriber.heartbeatTimer = setInterval(() => this.writeSseEvent(subscriber, 'ping', { eventType: 'ping' }), Math.max(5, keepaliveSeconds) * 1000)
    subscriber.heartbeatTimer.unref?.()
    this.scheduleIdleRevalidation(subscriberId)
    const cleanup = () => this.removeSubscriber(subscriberId)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  openClientStream(clientUserId: string, sessionToken: string, res: Response, keepaliveSeconds: number, initPayload?: CustomerServiceRealtimeInitPayloadResolver) {
    this.registerSubscriber('client', clientUserId, sessionToken, res, keepaliveSeconds, initPayload)
  }

  openServiceStream(serviceUserId: string, sessionToken: string, res: Response, keepaliveSeconds: number, initPayload?: CustomerServiceRealtimeInitPayloadResolver) {
    this.registerSubscriber('service', serviceUserId, sessionToken, res, keepaliveSeconds, initPayload)
  }

  disconnectBySessionHash(scope: RealtimeScope, tokenHash: string): void {
    for (const subscriber of this.subscribers.values()) if (subscriber.scope === scope && subscriber.sessionHash === tokenHash) this.closeSubscriber(subscriber.subscriberId)
  }

  disconnectByOwner(scope: RealtimeScope, ownerKey: string): void {
    for (const subscriber of this.subscribers.values()) if (subscriber.scope === scope && subscriber.ownerKey === ownerKey) this.closeSubscriber(subscriber.subscriberId)
  }

  buildServiceSessionSnapshot(): CustomerServiceRealtimeSessionSnapshot {
    const connections = Array.from(this.subscribers.values())
    return {
      currentConversationEventId: this.conversationEventSeed,
      clientConnectionCount: connections.filter((item) => item.scope === 'client').length,
      serviceConnectionCount: new Set(connections.filter((item) => item.scope === 'service').map((item) => item.ownerKey)).size,
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

  publishConversationEvent(payload: CustomerServiceRealtimeEventPayload) {
    this.conversationEventSeed += 1
    const { audience: _audience, ...wirePayload } = payload
    const enrichedPayload = { ...wirePayload, eventId: this.conversationEventSeed }
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
