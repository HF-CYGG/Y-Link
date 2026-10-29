/**
 * 模块说明：backend/src/redis/redis-bus.ts
 * 文件职责：基于 Redis Pub/Sub 的跨实例消息总线，承载客服实时事件、撤权断连与缓存失效等“通知其他实例”的广播。
 * 实现逻辑：
 * - 每条消息带发送实例 ID，接收方丢弃自己发出的消息：发送方总是先在本地生效，再广播给其他实例；
 * - 订阅使用独立连接；连接恢复时重新订阅全部已注册主题，处理器在模块加载时注册即可，不依赖启动顺序；
 * - Pub/Sub 是“至多一次”投递：断线期间的消息会丢失，因此所有使用方都必须保留本地兜底（短 TTL、周期复核等）。
 * 维护说明：
 * - 消息体会经过 Redis，处理器必须把载荷当作不可信输入逐字段校验；
 * - 不要用总线传递需要可靠送达的业务数据，那类数据应落库或走通知 outbox。
 */

import { getRedisClient, getRedisInstanceId, getRedisSubscriber, isRedisEnabled, isRedisReady, recordRedisDegrade, redisKey } from './redis-client.js'

export type RedisBusHandler = (payload: unknown) => void

interface RedisBusEnvelope {
  o: string
  p: unknown
}

/** 单条消息上限：客服事件含会话快照，正常远小于该值；超限消息不广播，接收端依赖原有复核机制补齐。 */
const MAX_MESSAGE_BYTES = 256 * 1024

const handlers = new Map<string, Set<RedisBusHandler>>()
const resyncListeners = new Set<() => void>()

/** 订阅连接断开后重新就绪时回调（断开期间可能丢消息）；返回取消函数。 */
export function onRedisBusResync(listener: () => void): () => void {
  resyncListeners.add(listener)
  return () => resyncListeners.delete(listener)
}
const stats = { published: 0, received: 0, dropped: 0, handlerErrors: 0 }
let listenerAttached = false

const channelOf = (topic: string) => redisKey('bus', topic)

const subscribeChannels = async (topics: string[]) => {
  const subscriber = getRedisSubscriber()
  if (!subscriber || subscriber.status !== 'ready' || topics.length === 0) return
  try {
    await subscriber.subscribe(...topics.map(channelOf))
  } catch (error) {
    recordRedisDegrade('消息总线订阅', error)
  }
}

const dispatch = (channel: string, message: string) => {
  const topic = channel.slice(channelOf('').length)
  const topicHandlers = handlers.get(topic)
  if (!topicHandlers?.size) return
  let envelope: RedisBusEnvelope
  try {
    envelope = JSON.parse(message) as RedisBusEnvelope
  } catch {
    stats.dropped += 1
    return
  }
  if (!envelope || typeof envelope.o !== 'string' || envelope.o === getRedisInstanceId()) return
  stats.received += 1
  for (const handler of topicHandlers) {
    try {
      handler(envelope.p)
    } catch (error) {
      stats.handlerErrors += 1
      console.warn(`[redis-bus] 主题 ${topic} 的处理器执行失败`, error instanceof Error ? error.message : error)
    }
  }
}

/** 连接建立后调用一次：挂载消息监听并订阅已注册主题；订阅连接每次就绪都会重新订阅。 */
export function startRedisBus(): void {
  const subscriber = getRedisSubscriber()
  if (!subscriber || listenerAttached) return
  listenerAttached = true
  subscriber.on('message', dispatch)
  subscriber.on('ready', () => {
    // 走到这里说明订阅连接在总线启动后发生过断开：断开期间其他实例的消息已经丢失（Pub/Sub 不补发），
    // 重新订阅后通知各模块自行补齐，例如客服实时关闭本实例连接，让客户端重连回读。
    void subscribeChannels(Array.from(handlers.keys())).then(() => {
      for (const listener of resyncListeners) {
        try {
          listener()
        } catch (error) {
          console.warn('[redis-bus] 总线恢复回调执行失败', error instanceof Error ? error.message : error)
        }
      }
    })
  })
  void subscribeChannels(Array.from(handlers.keys()))
}

/** 停机时调用：清空监听状态，下次 startRedisBus 可重新挂载。 */
export function stopRedisBus(): void {
  listenerAttached = false
}

/** 注册主题处理器（只会收到其他实例发出的消息）；返回取消函数。 */
export function subscribeRedisBus(topic: string, handler: RedisBusHandler): () => void {
  let topicHandlers = handlers.get(topic)
  if (!topicHandlers) {
    topicHandlers = new Set()
    handlers.set(topic, topicHandlers)
    if (listenerAttached) void subscribeChannels([topic])
  }
  topicHandlers.add(handler)
  return () => {
    topicHandlers?.delete(handler)
  }
}

/**
 * 向其他实例广播。返回 false 表示未广播（Redis 未启用、不可用或消息过大），调用方据此决定是否告警；
 * 广播失败不抛错，本地生效已经在调用前完成。
 */
export async function publishRedisBus(topic: string, payload: unknown): Promise<boolean> {
  if (!isRedisEnabled()) return false
  const client = getRedisClient()
  if (!client || !isRedisReady()) {
    recordRedisDegrade(`消息总线广播 ${topic}`)
    return false
  }
  let message: string
  try {
    message = JSON.stringify({ o: getRedisInstanceId(), p: payload } satisfies RedisBusEnvelope)
  } catch {
    stats.dropped += 1
    return false
  }
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    stats.dropped += 1
    console.warn(`[redis-bus] 主题 ${topic} 的消息超过 ${MAX_MESSAGE_BYTES} 字节，已放弃跨实例广播`)
    return false
  }
  try {
    await client.publish(channelOf(topic), message)
    stats.published += 1
    return true
  } catch (error) {
    recordRedisDegrade(`消息总线广播 ${topic}`, error)
    return false
  }
}

export const getRedisBusSnapshot = () => ({
  topics: Array.from(handlers.keys()),
  ...stats,
})
