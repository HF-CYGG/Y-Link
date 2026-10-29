/**
 * 模块说明：backend/src/redis/redis-cache.ts
 * 文件职责：为读多写少的查询结果提供跨实例共享的短时缓存（Redis 二级缓存），供商城目录快照、报表与工作台统计使用。
 * 实现逻辑：
 * - 未配置 Redis 或 Redis 不可用时直接执行加载函数，行为与未接入缓存时完全一致（只读缓存可以安全降级）；
 * - 命中时返回 JSON 反序列化结果；未命中时执行加载函数，并在后台写回，写回失败不影响本次响应；
 * - 同一进程内相同键的并发未命中只执行一次加载函数（单飞），避免缓存过期瞬间多个请求同时回源数据库；
 * - 单条缓存超过上限时不写入，防止异常大的结果占满 Redis 内存。
 * 维护说明：
 * - 只用于可以接受短暂不一致的只读结果；下单、结算、库存扣减等必须回源数据库的链路禁止使用；
 * - 缓存值经过 JSON 往返，Date 会变成字符串，只能在“结果直接作为 HTTP JSON 返回”的位置使用；
 * - 键名中的查询条件必须先做摘要，且凡是影响结果的身份差异（例如是否管理员视角）都必须编入键名。
 */

import { createHash } from 'node:crypto'
import { getRedisClient, isRedisEnabled, isRedisReady, recordRedisDegrade, redisKey } from './redis-client.js'

/** 单条缓存值上限（序列化后字节数）。 */
const MAX_CACHE_VALUE_BYTES = 4 * 1024 * 1024

const inFlight = new Map<string, Promise<unknown>>()
const stats = { hits: 0, misses: 0, writes: 0, skippedOversize: 0, errors: 0 }

/** 把任意查询条件压成固定长度摘要，避免原始筛选值（关键字、客户名等）出现在键名里。 */
export const digestCacheInput = (input: unknown): string =>
  createHash('sha256').update(JSON.stringify(input ?? null)).digest('base64url').slice(0, 32)

/** 共享缓存的完整键名：cache:<namespace>:<parts...>。 */
export const sharedCacheKey = (namespace: string, ...parts: Array<string | number>): string =>
  redisKey('cache', namespace, ...parts)

const readyClient = () => {
  if (!isRedisEnabled()) return null
  const client = getRedisClient()
  if (!client || !isRedisReady()) return null
  return client
}

/** 读取原始字符串；Redis 不可用或读取失败时返回 null。 */
export async function readSharedCacheRaw(key: string): Promise<string | null> {
  const client = readyClient()
  if (!client) return null
  try {
    return await client.get(key)
  } catch (error) {
    stats.errors += 1
    recordRedisDegrade('共享缓存读取', error)
    return null
  }
}

/** 写入原始字符串（带过期时间）；超限或失败时静默跳过。 */
export async function writeSharedCacheRaw(key: string, value: string, ttlMs: number): Promise<void> {
  const client = readyClient()
  if (!client) return
  if (Buffer.byteLength(value) > MAX_CACHE_VALUE_BYTES) {
    stats.skippedOversize += 1
    return
  }
  try {
    await client.set(key, value, 'PX', Math.max(1, Math.round(ttlMs)))
    stats.writes += 1
  } catch (error) {
    stats.errors += 1
    recordRedisDegrade('共享缓存写入', error)
  }
}

/**
 * 读穿缓存：命中直接返回，未命中执行 loader 并写回。
 * 未启用或 Redis 不可用时等价于直接调用 loader。
 */
export async function getOrLoadShared<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  if (!readyClient()) return loader()
  const pending = inFlight.get(key) as Promise<T> | undefined
  if (pending) return pending
  const task = (async () => {
    const cached = await readSharedCacheRaw(key)
    if (cached !== null) {
      try {
        const value = JSON.parse(cached) as T
        stats.hits += 1
        return value
      } catch {
        // 损坏的缓存值按未命中处理，下面重新加载并覆盖。
      }
    }
    stats.misses += 1
    const value = await loader()
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) void writeSharedCacheRaw(key, serialized, ttlMs)
    return value
  })()
  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

/**
 * 缓存代际（全集群递增的版本号）：写入成功后递增，读取方把当前代际编入键名，
 * 写入之后的查询一定落到新键上，不会读到写入前的缓存结果。
 */
const generationKey = (name: string) => sharedCacheKey('generation', name)

/**
 * 递增代际并等待 Redis 确认（带超时）。写请求在返回响应前调用，保证调用方随后在任意实例上的查询都能读到新代际；
 * 超时或失败时只记录降级，旧缓存最多在其有效期后自然过期。
 */
export async function bumpSharedCacheGeneration(name: string, timeoutMs = 200): Promise<void> {
  const client = readyClient()
  if (!client) return
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      client.incr(generationKey(name)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('递增缓存代际超时')), timeoutMs)
      }),
    ])
  } catch (error) {
    stats.errors += 1
    recordRedisDegrade('共享缓存代际', error)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 不等待结果地递增代际：命令按序进入同一连接，适合提交后紧跟广播或后台任务等无需阻塞响应的场景。 */
export function bumpSharedCacheGenerationInBackground(name: string): void {
  void bumpSharedCacheGeneration(name, 1_000)
}

/** 读取当前代际；Redis 不可用时返回 null（调用方应跳过缓存），从未递增过按 0 处理。 */
export async function readSharedCacheGeneration(name: string): Promise<string | null> {
  const client = readyClient()
  if (!client) return null
  try {
    return (await client.get(generationKey(name))) ?? '0'
  } catch (error) {
    stats.errors += 1
    recordRedisDegrade('共享缓存代际', error)
    return null
  }
}

/** 带代际的读穿缓存：键名末尾追加当前代际，代际读取失败时直接回源。 */
export async function getOrLoadSharedVersioned<T>(
  generation: string,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const current = await readSharedCacheGeneration(generation)
  if (current === null) return loader()
  return getOrLoadShared(`${key}:g${current}`, ttlMs, loader)
}

export const getSharedCacheSnapshot = () => ({ ...stats, inFlight: inFlight.size })
