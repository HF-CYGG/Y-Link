/**
 * 模块说明：backend/src/redis/redis-lease.ts
 * 文件职责：基于 Redis 的跨实例互斥租约，供后台周期任务“同一时刻只由一个实例执行”和启动期建表/补数串行化使用。
 * 实现逻辑：
 * - 获取：SET key owner PX ttl NX；持有期间按 ttl/3 周期续期，续期与释放都先比较 owner（Lua 原子执行）；
 * - 周期任务：抢不到租约的实例直接跳过本轮，下一轮再抢；
 * - Redis 未启用或处于降级时直接执行任务：这些任务本身已有数据库行锁、SKIP LOCKED 或幂等条件兜底，
 *   降级只会退回“各实例各跑一遍”的现状，不会破坏正确性。
 * 维护说明：租约只用于“减少重复执行”，不能替代业务事务里的行锁；新增任务前先确认其多实例重复执行是安全的。
 */

import { setTimeout as delay } from 'node:timers/promises'
import { getRedisClient, getRedisInstanceId, isRedisEnabled, isRedisReady, recordRedisDegrade, redisKey } from './redis-client.js'
import { LEASE_RELEASE, LEASE_RENEW, runRedisScript } from './redis-scripts.js'

export interface LeaseRunResult<T> {
  ran: boolean
  value?: T
}

const buildOwner = () => `${getRedisInstanceId()}:${Date.now().toString(36)}`

async function tryAcquire(key: string, owner: string, ttlMs: number): Promise<boolean> {
  const client = getRedisClient()
  if (!client) return false
  const result = await client.set(key, owner, 'PX', ttlMs, 'NX')
  return result === 'OK'
}

async function holdWhile<T>(key: string, owner: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const renewTimer = setInterval(() => {
    const client = getRedisClient()
    if (!client || !isRedisReady()) return
    void runRedisScript<number>(client, LEASE_RENEW, [key], [owner, ttlMs]).catch((error) => recordRedisDegrade('租约续期', error))
  }, Math.max(1000, Math.floor(ttlMs / 3)))
  renewTimer.unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(renewTimer)
    const client = getRedisClient()
    if (client && isRedisReady()) {
      await runRedisScript<number>(client, LEASE_RELEASE, [key], [owner]).catch((error) => recordRedisDegrade('租约释放', error))
    }
  }
}

/**
 * 互斥执行一轮后台任务：抢到租约才执行，抢不到返回 { ran: false }。
 * @param name 租约名，例如 job:o2o-timeout-recycle
 * @param ttlMs 租约有效期；进程崩溃时最长在该时间后由其他实例接管
 */
export async function runExclusive<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<LeaseRunResult<T>> {
  if (!isRedisEnabled()) return { ran: true, value: await fn() }
  if (!isRedisReady()) {
    recordRedisDegrade(`后台任务租约 ${name}`)
    return { ran: true, value: await fn() }
  }
  const key = redisKey('lease', name)
  const owner = buildOwner()
  let acquired: boolean
  try {
    acquired = await tryAcquire(key, owner, ttlMs)
  } catch (error) {
    recordRedisDegrade(`后台任务租约 ${name}`, error)
    return { ran: true, value: await fn() }
  }
  if (!acquired) return { ran: false }
  return { ran: true, value: await holdWhile(key, owner, ttlMs, fn) }
}

export interface ClusterSlot {
  release: () => void
}

/**
 * 跨实例独占名额（例如“每账号同时只能有一个导出”）：抢到返回带 release 的句柄，被占用返回 null。
 * 持有期间自动续期；Redis 未启用或不可用时返回 'local'，调用方只按本实例口径限制（降级为现状）。
 */
export async function acquireClusterSlot(name: string, ttlMs: number): Promise<ClusterSlot | null | 'local'> {
  if (!isRedisEnabled()) return 'local'
  if (!isRedisReady()) {
    recordRedisDegrade(`跨实例名额 ${name}`)
    return 'local'
  }
  const key = redisKey('slot', name)
  const owner = buildOwner()
  try {
    if (!(await tryAcquire(key, owner, ttlMs))) return null
  } catch (error) {
    recordRedisDegrade(`跨实例名额 ${name}`, error)
    return 'local'
  }
  const renewTimer = setInterval(() => {
    const client = getRedisClient()
    if (!client || !isRedisReady()) return
    void runRedisScript<number>(client, LEASE_RENEW, [key], [owner, ttlMs]).catch((error) => recordRedisDegrade('跨实例名额续期', error))
  }, Math.max(1000, Math.floor(ttlMs / 3)))
  renewTimer.unref?.()
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      clearInterval(renewTimer)
      const client = getRedisClient()
      if (!client || !isRedisReady()) return
      void runRedisScript<number>(client, LEASE_RELEASE, [key], [owner]).catch((error) => recordRedisDegrade('跨实例名额释放', error))
    },
  }
}

const STARTUP_LOCK_TTL_MS = 60_000
const STARTUP_LOCK_WAIT_MS = 15 * 60_000
const STARTUP_LOCK_POLL_MS = 1000

/**
 * 启动期串行化：多实例同时启动时，建表、补列与默认数据写入只允许一个实例执行，其余实例排队等待后再执行
 * （届时结构已就绪，各步骤按幂等逻辑快速跳过）。Redis 未启用或不可用时直接执行，保持单实例现状。
 */
export async function withStartupLock<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T> {
  if (!isRedisEnabled() || !isRedisReady()) return fn()
  const key = redisKey('lease', 'startup-bootstrap')
  const owner = buildOwner()
  const deadline = Date.now() + STARTUP_LOCK_WAIT_MS
  let notified = false
  while (!(await tryAcquire(key, owner, STARTUP_LOCK_TTL_MS))) {
    if (Date.now() > deadline) {
      throw new Error('等待其他实例完成启动期建表与补数超时（15 分钟），请检查是否有实例卡在启动阶段')
    }
    if (!notified) {
      notified = true
      onWait?.()
    }
    await delay(STARTUP_LOCK_POLL_MS)
  }
  return holdWhile(key, owner, STARTUP_LOCK_TTL_MS, fn)
}
