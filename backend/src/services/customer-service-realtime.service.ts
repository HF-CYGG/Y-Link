/**
 * 模块说明：backend/src/services/customer-service-realtime.service.ts
 * 文件职责：提供客服中心最小可行实时通信能力，基于 SSE 向客户端与客服端推送会话变化事件。
 * 实现逻辑：
 * - 使用进程内订阅表维护当前活跃连接，避免为 MVP 额外引入 WebSocket 服务或消息中间件；
 * - 客户端流只接收属于自己的反馈事件，客服流接收全部客服中心事件；
 * - 通过定时心跳保持连接活性，并向前端暴露标准 SSE 事件名便于渐进接入。
 * 维护说明：
 * - 当前实现仅覆盖单实例部署；若后续接入多实例或容器横向扩容，需要改造成 Redis/PubSub 广播；
 * - 若前端需要按会话维度订阅，可在订阅结构上补 conversationId 过滤条件，不必重写协议层。
 */

import type { Response } from 'express'

export interface CustomerServiceRealtimeEventPayload {
  eventType: string
  conversationId: string
  clientUserId: string
  occurredAt: string
  conversation: unknown
  message?: unknown
  detail?: Record<string, unknown>
}

interface CustomerServiceRealtimeSubscriber {
  subscriberId: string
  scope: 'client' | 'service'
  ownerKey: string
  res: Response
  connectedAt: string
  heartbeatTimer: NodeJS.Timeout | null
}

export interface CustomerServiceRealtimeConnectionMeta {
  subscriberId: string
  scope: 'client' | 'service'
  ownerKey: string
  connectedAt: string
}

export interface CustomerServiceRealtimeSessionSnapshot {
  currentConversationEventId: number
  clientConnectionCount: number
  serviceConnectionCount: number
  recentConnections: CustomerServiceRealtimeConnectionMeta[]
}

export interface CustomerServiceRealtimeOpenStreamInitPayload {
  availability?: unknown
}

type CustomerServiceRealtimeInitPayloadResolver =
  | CustomerServiceRealtimeOpenStreamInitPayload
  | ((sessionSnapshot: CustomerServiceRealtimeSessionSnapshot) => CustomerServiceRealtimeOpenStreamInitPayload)

class CustomerServiceRealtimeService {
  private readonly subscribers = new Map<string, CustomerServiceRealtimeSubscriber>()

  private subscriberSeed = 0

  private conversationEventSeed = 0

  private buildSubscriberId(scope: CustomerServiceRealtimeSubscriber['scope']) {
    this.subscriberSeed += 1
    return `${scope}_${Date.now()}_${this.subscriberSeed}`
  }

  /**
   * SSE 输出统一收口到此方法，确保事件名、JSON 序列化和换行协议一致。
   */
  private writeSseEvent(res: Response, eventName: string, data: unknown) {
    res.write(`event: ${eventName}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  private removeSubscriber(subscriberId: string) {
    const subscriber = this.subscribers.get(subscriberId)
    if (!subscriber) {
      return
    }
    if (subscriber.heartbeatTimer) {
      clearInterval(subscriber.heartbeatTimer)
    }
    this.subscribers.delete(subscriberId)
  }

  /**
   * 客服在线态按客服账号去重计算，避免同一客服因重复进入、缓存页续接或多次重连导致在线数被重复叠加。
   */
  private countDistinctOwners(scope: CustomerServiceRealtimeSubscriber['scope'], connections: CustomerServiceRealtimeSubscriber[]) {
    return new Set(
      connections
        .filter((item) => item.scope === scope)
        .map((item) => item.ownerKey),
    ).size
  }

  private registerSubscriber(
    scope: CustomerServiceRealtimeSubscriber['scope'],
    ownerKey: string,
    res: Response,
    keepaliveSeconds: number,
    initPayload?: CustomerServiceRealtimeInitPayloadResolver,
  ) {
    const subscriberId = this.buildSubscriberId(scope)
    const heartbeatIntervalMs = Math.max(5, keepaliveSeconds) * 1000
    const connectedAt = new Date().toISOString()

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const subscriber: CustomerServiceRealtimeSubscriber = {
      subscriberId,
      scope,
      ownerKey,
      res,
      connectedAt,
      heartbeatTimer: setInterval(() => {
        this.writeSseEvent(res, 'ping', {
          eventType: 'ping',
          occurredAt: new Date().toISOString(),
        })
      }, heartbeatIntervalMs),
    }

    this.subscribers.set(subscriberId, subscriber)
    const sessionSnapshot = this.buildServiceSessionSnapshot()
    const resolvedInitPayload = typeof initPayload === 'function'
      ? initPayload(sessionSnapshot)
      : initPayload
    this.writeSseEvent(res, 'connected', {
      eventType: 'connected',
      scope,
      subscriberId,
      occurredAt: connectedAt,
      session: sessionSnapshot,
      availability: resolvedInitPayload?.availability,
    })

    const cleanup = () => {
      this.removeSubscriber(subscriberId)
    }
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  openClientStream(
    clientUserId: string,
    res: Response,
    keepaliveSeconds: number,
    initPayload?: CustomerServiceRealtimeInitPayloadResolver,
  ) {
    this.registerSubscriber('client', clientUserId, res, keepaliveSeconds, initPayload)
  }

  openServiceStream(
    serviceUserId: string,
    res: Response,
    keepaliveSeconds: number,
    initPayload?: CustomerServiceRealtimeInitPayloadResolver,
  ) {
    this.registerSubscriber('service', serviceUserId, res, keepaliveSeconds, initPayload)
  }

  buildServiceSessionSnapshot(): CustomerServiceRealtimeSessionSnapshot {
    const connections = Array.from(this.subscribers.values())
    const recentConnections = connections
      .map((subscriber) => ({
        subscriberId: subscriber.subscriberId,
        scope: subscriber.scope,
        ownerKey: subscriber.ownerKey,
        connectedAt: subscriber.connectedAt,
      }))
      .sort((left, right) => right.connectedAt.localeCompare(left.connectedAt))
      .slice(0, 20)
    return {
      currentConversationEventId: this.conversationEventSeed,
      clientConnectionCount: connections.filter((item) => item.scope === 'client').length,
      serviceConnectionCount: this.countDistinctOwners('service', connections),
      recentConnections,
    }
  }

  publishConversationEvent(payload: CustomerServiceRealtimeEventPayload) {
    this.conversationEventSeed += 1
    const enrichedPayload = {
      ...payload,
      eventId: this.conversationEventSeed,
    }
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.scope === 'client' && subscriber.ownerKey !== payload.clientUserId) {
        continue
      }
      this.writeSseEvent(subscriber.res, 'conversation', enrichedPayload)
    }
  }
}

export const customerServiceRealtimeService = new CustomerServiceRealtimeService()
