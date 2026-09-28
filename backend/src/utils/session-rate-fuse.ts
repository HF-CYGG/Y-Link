/**
 * 文件说明：按会话的请求速率保险丝（令牌桶），防止单个已登录会话（被盗用的会话、失控脚本、前端死循环）持续高频请求拖垮服务。
 * 实现逻辑：
 * - 每个会话一个令牌桶：容量为允许的瞬时突发量，按固定速率补充；耗尽时拒绝并给出等待秒数；
 * - 以会话令牌哈希为键（不在内存中保存令牌原文），按会话而不是按账号计数，部门共享账号的多个会话互不影响；
 * - 进程内有界 Map：容量满时按最近使用顺序淘汰最久未活动的会话桶（被淘汰的桶重新计满，只会更宽松）；
 * - 在鉴权查库之前判定，被熔断的请求不再产生会话查询。
 * 维护说明：多实例部署时每个实例各自计数；阈值默认对正常页面加载（并行十余个接口）留足余量，调整见 `config/load-protection-policy.ts`。
 */

import { SESSION_RATE_FUSE_POLICY } from '../config/load-protection-policy.js'
import { BizError } from './errors.js'
import { hashSessionToken } from './session-token.js'

export interface SessionRateFuseOptions {
  capacity: number
  refillPerSecond: number
  maxSessions: number
}

interface TokenBucket {
  tokens: number
  updatedAt: number
}

export class SessionRateFuse {
  private readonly buckets = new Map<string, TokenBucket>()

  constructor(private readonly options: SessionRateFuseOptions) {}

  /** 消耗一个令牌；返回是否放行以及被拒绝时的建议等待秒数。 */
  consume(sessionKey: string, nowMs = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const existing = this.buckets.get(sessionKey)
    let bucket: TokenBucket
    if (existing) {
      const elapsedSeconds = Math.max(0, nowMs - existing.updatedAt) / 1000
      bucket = {
        tokens: Math.min(this.options.capacity, existing.tokens + elapsedSeconds * this.options.refillPerSecond),
        updatedAt: nowMs,
      }
      // 先删后写，让活跃会话移到插入顺序末尾，淘汰时优先清理长期不活跃的会话。
      this.buckets.delete(sessionKey)
    } else {
      while (this.buckets.size >= this.options.maxSessions) {
        const oldestKey = this.buckets.keys().next().value
        if (oldestKey === undefined) break
        this.buckets.delete(oldestKey)
      }
      bucket = { tokens: this.options.capacity, updatedAt: nowMs }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      this.buckets.set(sessionKey, bucket)
      return { allowed: true, retryAfterSeconds: 0 }
    }
    this.buckets.set(sessionKey, bucket)
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.options.refillPerSecond)),
    }
  }

  get size(): number {
    return this.buckets.size
  }
}

/** 管理端与 Web 客户端共用的会话保险丝（键带端前缀，互不串用）。 */
export const sessionRateFuse = new SessionRateFuse(SESSION_RATE_FUSE_POLICY)

/** 鉴权查库前调用：超出速率时抛出 429（带 Retry-After），键为会话令牌哈希。 */
export function assertSessionRateAllowed(scope: 'admin' | 'client', sessionToken: string): void {
  const result = sessionRateFuse.consume(`${scope}:${hashSessionToken(sessionToken)}`)
  if (!result.allowed) {
    throw new BizError('请求过于频繁，请稍后再试', 429, {
      data: { reason: 'SESSION_RATE_LIMITED' },
      retryAfterSeconds: result.retryAfterSeconds,
    })
  }
}
