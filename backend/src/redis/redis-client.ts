/**
 * 模块说明：backend/src/redis/redis-client.ts
 * 文件职责：管理独立部署 Redis 的连接生命周期，向票据、限流、实时广播与后台租约提供统一的命令连接与订阅连接。
 * 实现逻辑：
 * - Redis 是可选增强：未配置 REDIS_URL 时状态恒为 disabled，所有调用方保持单实例现状；
 * - 命令连接关闭离线队列、每条命令设超时，Redis 抖动时快速失败，由调用方按“分级降级”策略回落；
 * - 断线后按退避持续重连，恢复后状态自动回到 ready，不需要重启进程；
 * - 键名统一经 redisKey() 拼接前缀，不使用 ioredis 的 keyPrefix（它不作用于发布订阅频道，口径不一致）；
 * - ioredis 只在配置了 REDIS_URL 时动态加载，未启用 Redis 的部署不承担其模块加载与冷启动开销。
 * 维护说明：
 * - 日志与快照只输出主机、端口与库号，绝不输出 URL、用户名或密码；
 * - 新增调用方必须先判断 isRedisReady()，并为 Redis 不可用时设计明确的降级或拒绝语义。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import type { Redis, RedisOptions } from 'ioredis'
import { env } from '../config/env.js'

export type RedisHealthStatus = 'disabled' | 'connecting' | 'ready' | 'degraded'

export interface RedisRuntimeSnapshot {
  status: RedisHealthStatus
  target: string | null
  instanceId: string
  multiInstance: boolean
  degradeEvents: number
  lastErrorAt: string | null
}

/** 每个进程启动时生成一次，用于消息总线去回环与租约 owner 标识。 */
const instanceId = `${hostname().slice(0, 32)}:${process.pid}:${randomUUID().slice(0, 8)}`

let commandClient: Redis | null = null
let subscriberClient: Redis | null = null
let status: RedisHealthStatus = env.REDIS_URL ? 'connecting' : 'disabled'
let degradeEvents = 0
let lastErrorAt: number | null = null
let lastErrorLoggedAt = 0
const ERROR_LOG_THROTTLE_MS = 30_000
const readyListeners = new Set<() => void>()

export const isRedisEnabled = (): boolean => Boolean(env.REDIS_URL)

export const isRedisReady = (): boolean => status === 'ready' && commandClient?.status === 'ready'

export const getRedisInstanceId = (): string => instanceId

export const getRedisHealthStatus = (): RedisHealthStatus => status

/** 拼接带部署前缀的键名或频道名；各段不得包含原始手机号、IP 等敏感值，调用方需先做摘要。 */
export const redisKey = (...parts: Array<string | number>): string => `${env.REDIS_KEY_PREFIX}${parts.join(':')}`

/** 只返回 host:port/db，供日志与管理员快照使用。 */
export const describeRedisTarget = (): string | null => {
  if (!env.REDIS_URL) return null
  try {
    const parsed = new URL(env.REDIS_URL)
    const db = env.REDIS_DB ?? (Number(parsed.pathname.replace('/', '')) || 0)
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '6379'}/${db}`
  } catch {
    return '(无法解析的 REDIS_URL)'
  }
}

/** Redis 不可用时调用方记录一次降级，供管理员快照观察；日志按 30 秒节流，避免故障期刷屏。 */
export const recordRedisDegrade = (scope: string, error?: unknown): void => {
  degradeEvents += 1
  lastErrorAt = Date.now()
  if (lastErrorAt - lastErrorLoggedAt < ERROR_LOG_THROTTLE_MS) return
  lastErrorLoggedAt = lastErrorAt
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : '连接不可用'
  console.warn(`[redis] ${scope} 已降级（${reason}），目标 ${describeRedisTarget() ?? '-'}`)
}

export const getRedisRuntimeSnapshot = (): RedisRuntimeSnapshot => ({
  status,
  target: describeRedisTarget(),
  instanceId,
  multiInstance: env.Y_LINK_MULTI_INSTANCE,
  degradeEvents,
  lastErrorAt: lastErrorAt ? new Date(lastErrorAt).toISOString() : null,
})

/** 连接恢复到 ready 时回调（例如重新订阅、刷新在线态）；返回取消函数。 */
export const onRedisReady = (listener: () => void): (() => void) => {
  readyListeners.add(listener)
  return () => readyListeners.delete(listener)
}

const buildRedisOptions = (): RedisOptions => {
  const url = new URL(env.REDIS_URL as string)
  const useTls = env.REDIS_TLS || url.protocol === 'rediss:'
  return {
    lazyConnect: true,
    // 离线时直接拒绝命令，而不是排队等待重连：调用方据此立即降级。
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    // 断线后持续重连，间隔从 200ms 退避到 5s 封顶；进程存活期间不放弃。
    retryStrategy: (times) => Math.min(times * 200, 5000),
    connectionName: `ylink:${instanceId}`,
    ...(env.REDIS_USERNAME ? { username: env.REDIS_USERNAME } : {}),
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
    ...(env.REDIS_DB !== undefined ? { db: env.REDIS_DB } : {}),
    ...(useTls
      ? { tls: { servername: url.hostname, ...(env.REDIS_TLS_CA ? { ca: readFileSync(env.REDIS_TLS_CA) } : {}) } }
      : {}),
  }
}

const logConnectionError = (role: string, error: Error) => {
  lastErrorAt = Date.now()
  if (lastErrorAt - lastErrorLoggedAt < ERROR_LOG_THROTTLE_MS) return
  lastErrorLoggedAt = lastErrorAt
  console.warn(`[redis] ${role} 连接异常：${error.name}: ${error.message}（目标 ${describeRedisTarget() ?? '-'}）`)
}

const PROBE_RETRY_MS = 5_000
let probeTimer: NodeJS.Timeout | null = null

/** 版本探测：依赖 GETDEL 与 SET KEEPTTL，低于 6.2 直接视为不可用。 */
async function probeServer(client: Redis): Promise<void> {
  const info = await client.info('server')
  const version = /redis_version:(\S+)/.exec(info)?.[1] ?? '0'
  const [major = 0, minor = 0] = version.split('.').map((part) => Number(part))
  if (major < 6 || (major === 6 && minor < 2)) {
    throw new Error(`Redis 版本 ${version} 过低，至少需要 6.2（依赖 GETDEL 与 SET KEEPTTL）`)
  }
}

/**
 * 探测通过才把状态置为 ready。探测失败（例如 INFO 短暂超时）时连接本身可能仍是 ready，
 * 不会再触发 ready 事件，所以必须自行定时重试，否则一次抖动会让票据等能力持续 503。
 */
function scheduleProbe(client: Redis): void {
  if (probeTimer) return
  probeTimer = setTimeout(() => {
    probeTimer = null
    void verifyAndMarkReady(client).catch(() => undefined)
  }, PROBE_RETRY_MS)
  probeTimer.unref()
}

async function verifyAndMarkReady(client: Redis): Promise<void> {
  if (client !== commandClient) return
  try {
    await probeServer(client)
  } catch (error) {
    if (client !== commandClient) return
    status = 'degraded'
    scheduleProbe(client)
    throw error
  }
  if (client !== commandClient) return
  const recovered = status === 'degraded'
  status = 'ready'
  if (recovered) console.log(`[redis] 连接已恢复：${describeRedisTarget()}`)
  for (const listener of readyListeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[redis] ready 回调执行失败', error instanceof Error ? error.message : error)
    }
  }
}

const attachLifecycle = (client: Redis, role: 'command' | 'subscriber') => {
  client.on('error', (error: Error) => logConnectionError(role, error))
  if (role !== 'command') return
  client.on('ready', () => {
    // 启动期由 connectRedis 自己探测；之后每次（重）连就绪都重新探测再恢复 ready。
    if (status === 'connecting') return
    void verifyAndMarkReady(client).catch((error: unknown) => {
      logConnectionError(role, error instanceof Error ? error : new Error(String(error)))
    })
  })
  const markDegraded = () => {
    if (status === 'ready') {
      degradeEvents += 1
      console.warn(`[redis] 连接中断，相关能力进入降级：${describeRedisTarget()}`)
    }
    if (status !== 'disabled') status = 'degraded'
  }
  client.on('close', markDegraded)
  client.on('end', markDegraded)
}

/** 命令连接；未启用 Redis 时为 null。调用方仍需先判断 isRedisReady()。 */
export const getRedisClient = (): Redis | null => commandClient

/** 订阅专用连接（进入订阅模式后不能再执行普通命令）；未启用时为 null。 */
export const getRedisSubscriber = (): Redis | null => subscriberClient

/**
 * 启动期建立连接：
 * - 未配置 Redis 直接返回；
 * - 多实例模式下首连失败视为致命错误（拒绝启动，避免实例间状态分裂）；
 * - 单实例模式下首连失败只告警，后台继续重连，期间各能力按降级策略运行。
 */
export async function connectRedis(): Promise<void> {
  if (!isRedisEnabled() || commandClient) return
  const options = buildRedisOptions()
  const { Redis } = await import('ioredis')
  commandClient = new Redis(env.REDIS_URL as string, options)
  subscriberClient = new Redis(env.REDIS_URL as string, { ...options, connectionName: `ylink:${instanceId}:sub` })
  attachLifecycle(commandClient, 'command')
  attachLifecycle(subscriberClient, 'subscriber')
  try {
    await Promise.all([commandClient.connect(), subscriberClient.connect()])
    await verifyAndMarkReady(commandClient)
  } catch (error) {
    status = 'degraded'
    const message = error instanceof Error ? error.message : String(error)
    if (env.Y_LINK_MULTI_INSTANCE || /版本 .* 过低/.test(message)) {
      await closeRedis()
      throw new Error(`Redis 连接失败（${describeRedisTarget()}）：${message}`)
    }
    console.warn(`[redis] 启动期连接失败，进入降级并在后台重连：${message}（目标 ${describeRedisTarget()}）`)
    // 失败可能发生在探测之前（例如命令连接已就绪、订阅连接首连失败）：命令连接的首次 ready
    // 已在 connecting 阶段被忽略，不会再触发，必须主动安排探测重试，否则状态会一直停在降级。
    if (commandClient) scheduleProbe(commandClient)
  }
}

/** 停机时关闭连接；先尝试 QUIT，超时后强制断开。 */
export async function closeRedis(): Promise<void> {
  const clients = [subscriberClient, commandClient].filter((client): client is Redis => client !== null)
  if (probeTimer) clearTimeout(probeTimer)
  probeTimer = null
  subscriberClient = null
  commandClient = null
  if (status !== 'disabled') status = 'degraded'
  await Promise.all(clients.map(async (client) => {
    try {
      await Promise.race([client.quit(), new Promise((resolve) => setTimeout(resolve, 1000))])
    } catch {
      // QUIT 失败说明连接已断，直接强制断开即可。
    } finally {
      client.disconnect()
    }
  }))
}

/**
 * 多实例部署前置条件：任何一项缺失都会让实例间出现票据失效、限流放大或密文无法互读，因此直接拒绝启动。
 */
export function assertMultiInstancePrerequisites(dbType: string): void {
  if (!env.Y_LINK_MULTI_INSTANCE) return
  const problems: string[] = []
  if (dbType !== 'mysql') problems.push('DB_TYPE 必须为 mysql（SQLite 只能单进程写入）')
  if (!isRedisEnabled()) problems.push('必须配置 REDIS_URL（共享票据、限流、实时广播与后台任务租约）')
  if (!process.env.Y_LINK_DATA_ENCRYPTION_KEY?.trim()) {
    problems.push('必须通过 Y_LINK_DATA_ENCRYPTION_KEY 为所有实例注入同一把数据加密密钥')
  }
  if (problems.length) {
    throw new Error(`Y_LINK_MULTI_INSTANCE=true 但多实例前置条件不满足：\n- ${problems.join('\n- ')}`)
  }
}
