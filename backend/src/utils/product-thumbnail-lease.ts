/**
 * 商品缩略图后台专用租约。Redis 降级时失败关闭，不能沿用 runExclusive 的失败开放语义。
 * 每次工作和发布前复核 owner；续租失败即取消本轮，已完成文件仍由原子发布保护。
 */
import { randomUUID } from 'node:crypto'
import { getRedisClient, isRedisEnabled, isRedisReady, redisKey } from '../redis/redis-client.js'
import { LEASE_RELEASE, LEASE_RENEW, runRedisScript } from '../redis/redis-scripts.js'
export async function acquireThumbnailLease(signal?: AbortSignal) {
  if (!isRedisEnabled()) return { valid: async () => !signal?.aborted, release: async () => {} }
  const client = getRedisClient()
  if (!client || !isRedisReady() || signal?.aborted) return null
  const key = redisKey('lease', 'product-thumbnail-backfill'), owner = randomUUID(), ttl = 30_000
  try { if (await client.set(key, owner, 'PX', ttl, 'NX') !== 'OK') return null } catch { return null }
  let alive = true, renewing: Promise<unknown> | null = null
  const valid = async () => {
    if (!alive || signal?.aborted || !isRedisReady()) return false
    try { alive = await client.get(key) === owner; return alive } catch { alive = false; return false }
  }
  const timer = setInterval(() => {
    if (renewing) return
    renewing = (async () => {
      try { if (!isRedisReady() || await runRedisScript<number>(client, LEASE_RENEW, [key], [owner, ttl]) !== 1) alive = false }
      catch { alive = false }
    })().finally(() => { renewing = null })
  }, ttl / 3)
  timer.unref()
  return { valid, release: async () => {
    alive = false; clearInterval(timer); await renewing
    try { if (isRedisReady()) await runRedisScript(client, LEASE_RELEASE, [key], [owner]) } catch { /* 租约到期后自动回收。 */ }
  } }
}
