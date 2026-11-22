/**
 * 模块说明：backend/src/redis/redis-cache.ts
 * 文件职责：为读多写少的查询结果提供跨实例共享的短时缓存（Redis 二级缓存），供商城目录快照、报表与工作台统计使用。
 * 实现逻辑：
 * - 未配置 Redis 时，有代际的查询使用带容量上限的本地短时缓存；已配置 Redis 但故障时合并同代际回源；
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
const MAX_LOCAL_CACHE_ENTRIES = 128
const MAX_LOCAL_CACHE_BYTES = 8 * 1024 * 1024

interface LocalCacheEntry {
  serialized: string
  bytes: number
  expiresAt: number
}

interface CacheGeneration {
  local: number
  confirmed: number
  pending: number
}

const inFlight = new Map<string, Promise<unknown>>()
const localCache = new Map<string, LocalCacheEntry>()
const generations = new Map<string, CacheGeneration>()
let localCacheBytes = 0
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

async function singleFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key) as Promise<T> | undefined
  if (pending) return pending
  const task = Promise.resolve().then(load)
  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

/** 读穿 Redis 缓存；连接不可用时，同键请求仍合并为一次回源。 */
export function getOrLoadShared<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  return singleFlight(key, async () => {
    if (!readyClient()) return loader()
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
  })
}

/**
 * 缓存代际（全集群递增的版本号）：写入成功后递增，读取方把当前代际编入键名，
 * 写入之后的查询一定落到新键上，不会读到写入前的缓存结果。
 */
const generationKey = (name: string) => sharedCacheKey('generation', name)

function getGeneration(name: string): CacheGeneration {
  let state = generations.get(name)
  if (!state) {
    state = { local: 0, confirmed: 0, pending: 0 }
    generations.set(name, state)
  }
  return state
}

async function syncGeneration(name: string, state: CacheGeneration, timeoutMs: number): Promise<void> {
  const client = readyClient()
  if (!client) return
  const target = state.local
  state.pending += 1
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      client.incr(generationKey(name)).then(() => {
        state.confirmed = Math.max(state.confirmed, target)
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('递增缓存代际超时')), timeoutMs)
      }),
    ])
  } catch (error) {
    stats.errors += 1
    recordRedisDegrade('共享缓存代际', error)
  } finally {
    state.pending -= 1
    if (timer) clearTimeout(timer)
  }
}

/** 同步递增本地代际，将 Redis 确认交给调用方按部署模式等待。 */
export function bumpSharedCacheGeneration(name: string, timeoutMs = 200): Promise<void> {
  const state = getGeneration(name)
  state.local += 1
  return syncGeneration(name, state, timeoutMs)
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

async function getOrLoadLocal<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  generationIsCurrent: () => boolean,
): Promise<T> {
  const cached = localCache.get(key)
  if (cached) {
    localCache.delete(key)
    if (cached.expiresAt > Date.now()) {
      localCache.set(key, cached)
      stats.hits += 1
      return JSON.parse(cached.serialized) as T
    }
    localCacheBytes -= cached.bytes
  }
  const result = await singleFlight(key, async () => {
    stats.misses += 1
    const value = await loader()
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return { value }
    const bytes = Buffer.byteLength(serialized)
    if (bytes > MAX_CACHE_VALUE_BYTES) {
      stats.skippedOversize += 1
      return { value }
    }
    if (generationIsCurrent()) {
      for (const [oldKey, oldEntry] of localCache) {
        if (localCache.size < MAX_LOCAL_CACHE_ENTRIES && localCacheBytes + bytes <= MAX_LOCAL_CACHE_BYTES) break
        localCache.delete(oldKey)
        localCacheBytes -= oldEntry.bytes
      }
      localCache.set(key, { serialized, bytes, expiresAt: Date.now() + ttlMs })
      localCacheBytes += bytes
    }
    return { serialized }
  })
  // 等待同一加载的请求也有独立对象，调用方修改不会污染下次命中。
  return result.serialized === undefined ? result.value as T : JSON.parse(result.serialized) as T
}

/** 已配置的 Redis 故障时只合并回源；写入实例在补递增成功前跳过可能过期的 Redis 结果。 */
export async function getOrLoadSharedVersioned<T>(
  generation: string,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const state = getGeneration(generation)
  const local = state.local
  const fallbackKey = () => key + ':local:' + generation + ':' + state.local
  if (!isRedisEnabled()) {
    return getOrLoadLocal(fallbackKey(), ttlMs, loader, () => state.local === local)
  }
  if (state.confirmed < local) {
    if (state.pending === 0) void syncGeneration(generation, state, 1_000)
    return singleFlight(fallbackKey(), loader)
  }
  const current = await readSharedCacheGeneration(generation)
  if (current === null || state.local !== local) return singleFlight(fallbackKey(), loader)
  return getOrLoadShared(`${key}:g${current}`, ttlMs, loader)
}

export const getSharedCacheSnapshot = () => ({ ...stats, inFlight: inFlight.size, localEntries: localCache.size, localBytes: localCacheBytes })
