/**
 * 模块说明：backend/src/redis/redis-scripts.ts
 * 文件职责：集中维护需要原子执行的 Redis Lua 脚本：滑动窗口限流、登录失败计数与锁定、票据错误次数、租约续期与释放。
 * 实现逻辑：
 * - 首次执行时用 SCRIPT LOAD 取得服务端返回的脚本摘要，之后走 EVALSHA；服务端缓存缺失（NOSCRIPT，例如 Redis 重启）时回退 EVAL 并重新缓存；
 * - 脚本摘要只作 Redis 协议标识、由服务端计算，本地不做任何哈希运算；
 * - 所有时间戳由调用方以毫秒传入，脚本内不读取 Redis 时钟，保证与数据库实现的窗口口径一致；
 * - 返回值统一为整数数组，Lua 中的数字在回复时被截断为整数，毫秒时间戳不会丢失精度。
 * 维护说明：
 * - 修改脚本语义时必须同步核对 persistent-risk-state.service.ts 中数据库实现的对应分支，两条路径的判定口径必须一致；
 * - 每个脚本只能操作 KEYS 中声明的键，保证将来切换到 Redis Cluster 时仍可按 hash tag 部署。
 */

import type { Redis } from 'ioredis'

interface RedisScript {
  lua: string
  /** 服务端 SCRIPT LOAD 返回的摘要；同一脚本在任何 Redis 上摘要相同，首次加载后进程内复用。 */
  sha: string | null
}

const defineScript = (lua: string): RedisScript => ({ lua, sha: null })

/** 执行脚本：首次 SCRIPT LOAD 取摘要，之后优先 EVALSHA，NOSCRIPT 时回退 EVAL。 */
export async function runRedisScript<T>(client: Redis, script: RedisScript, keys: string[], args: Array<string | number>): Promise<T> {
  try {
    script.sha ??= String(await client.script('LOAD', script.lua))
    return await client.evalsha(script.sha, keys.length, ...keys, ...args) as T
  } catch (error) {
    if (error instanceof Error && error.message.includes('NOSCRIPT')) {
      return await client.eval(script.lua, keys.length, ...keys, ...args) as T
    }
    throw error
  }
}

/** 单个限流桶最多保留的时间戳条数，与数据库实现的 MAX_TIMESTAMPS_PER_BUCKET 一致。 */
export const REDIS_WINDOW_MAX_ENTRIES = 1000

/**
 * 滑动窗口消费。KEYS[1]=ZSET；ARGV=now, windowMs, limit(-1 表示不限), member, maxEntries。
 * 返回 {totalHits, resetAtMs, denied}：已达上限时不写入新时间戳（与数据库实现“超限不写”一致）。
 */
export const SLIDING_WINDOW_CONSUME = defineScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local maxEntries = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local oldest = now
local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if first[2] then oldest = tonumber(first[2]) end
if limit >= 0 and count >= limit then
  return {count + 1, oldest + window, 1}
end
if count >= maxEntries then
  redis.call('ZREMRANGEBYRANK', key, 0, count - maxEntries)
  count = maxEntries - 1
  first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if first[2] then oldest = tonumber(first[2]) end
end
redis.call('ZADD', key, now, ARGV[4])
if count == 0 then oldest = now end
redis.call('PEXPIRE', key, window)
return {count + 1, oldest + window, 0}
`)

/** 滑动窗口只读。KEYS[1]=ZSET；ARGV=now, windowMs。返回 {totalHits, resetAtMs}，空窗口返回 {0, 0} 并删除键。 */
export const SLIDING_WINDOW_READ = defineScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count == 0 then
  redis.call('DEL', key)
  return {0, 0}
end
local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {count, tonumber(first[2]) + window}
`)

/** 滑动窗口回退最新一次命中。KEYS[1]=ZSET；ARGV=now, windowMs。 */
export const SLIDING_WINDOW_DECREMENT = defineScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
redis.call('ZPOPMAX', key)
if redis.call('ZCARD', key) == 0 then redis.call('DEL', key) end
return 1
`)

/**
 * 记录一次登录失败。KEYS[1]=HASH；ARGV=now, resetWindowMs, lockThreshold, lockMs。
 * 判定口径与数据库实现 recordFailure 一致：距上次失败超过重置窗口且未处于锁定期时从 1 重新计数。
 * 返回 {count, firstFailedAt, lastFailedAt, lockedUntil}。
 */
export const FAILURE_RECORD = defineScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local resetWindow = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
local lockMs = tonumber(ARGV[4])
local state = redis.call('HMGET', key, 'count', 'first', 'last', 'locked')
local count = tonumber(state[1]) or 0
local first = tonumber(state[2]) or 0
local last = tonumber(state[3]) or 0
local locked = tonumber(state[4]) or 0
if last == 0 or (now - last >= resetWindow and locked <= now) then
  count = 1
  first = now
else
  count = count + 1
  if first == 0 then first = now end
end
last = now
if count >= threshold then locked = now + lockMs end
redis.call('HSET', key, 'count', count, 'first', first, 'last', last, 'locked', locked)
local expireAt = math.max(now + resetWindow, locked)
redis.call('PEXPIRE', key, expireAt - now)
return {count, first, last, locked}
`)

/**
 * 读取登录失败状态。KEYS[1]=HASH；ARGV=now, resetWindowMs。
 * 已过重置窗口且未锁定时删除并返回 {0}；否则返回 {count, firstFailedAt, lastFailedAt, lockedUntil}。
 */
export const FAILURE_READ = defineScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local resetWindow = tonumber(ARGV[2])
local state = redis.call('HMGET', key, 'count', 'first', 'last', 'locked')
local last = tonumber(state[3]) or 0
if last == 0 then return {0} end
local locked = tonumber(state[4]) or 0
if now - last >= resetWindow and locked <= now then
  redis.call('DEL', key)
  return {0}
end
local count = tonumber(state[1]) or 0
local first = tonumber(state[2]) or last
return {count, first, last, locked}
`)

/**
 * 票据错误次数原子递增。KEYS[1]=票据键，KEYS[2]=计数键；ARGV=maxAttempts。
 * 票据不存在返回 -1；计数达到上限时同时删除票据与计数键；计数键与票据共享剩余有效期。
 */
export const TICKET_RECORD_FAILED_ATTEMPT = defineScript(`
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('DEL', KEYS[2])
  return -1
end
local attempts = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ttl)
if attempts >= tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1], KEYS[2])
end
return attempts
`)

/** 租约续期：仅 owner 一致时延长。KEYS[1]=租约键；ARGV=owner, ttlMs。返回 1 表示续期成功。 */
export const LEASE_RENEW = defineScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`)

/** 租约释放：仅 owner 一致时删除，避免误删已被其他实例接管的租约。KEYS[1]=租约键；ARGV=owner。 */
export const LEASE_RELEASE = defineScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`)
