/**
 * 模块说明：为认证风控与 Express 入口限流提供跨实例共享的数据库状态。
 * 安全约束：桶键在落库前统一做 SHA-256，不持久化原始账号、手机号或 IP。
 */

import { createHash } from 'node:crypto'
import { LessThanOrEqual, type EntityManager } from 'typeorm'
import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit'
import { AppDataSource } from '../config/data-source.js'
import { AuthRiskState } from '../entities/auth-risk-state.entity.js'

export interface PersistentFailureState {
  count: number
  firstFailedAt: number
  lastFailedAt: number
  lockedUntil: number
}

const CLEANUP_INTERVAL_MS = 60 * 1000
const MAX_TIMESTAMPS_PER_BUCKET = 1000

let lastCleanupAt = 0

const digestBucketKey = (bucketKey: string) => createHash('sha256').update(bucketKey).digest('hex')

const parseTimestamps = (value: string | null): number[] => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
      .slice(-MAX_TIMESTAMPS_PER_BUCKET)
  } catch {
    return []
  }
}

class PersistentRiskStateService {
  private async cleanupExpired(now: Date) {
    if (now.getTime() - lastCleanupAt < CLEANUP_INTERVAL_MS) return
    lastCleanupAt = now.getTime()
    await AppDataSource.getRepository(AuthRiskState).delete({ expiresAt: LessThanOrEqual(now) })
  }

  private async loadLockedState(
    manager: EntityManager,
    bucketDigest: string,
    stateType: AuthRiskState['stateType'],
    expiresAt: Date,
  ) {
    const repository = manager.getRepository(AuthRiskState)
    await repository
      .createQueryBuilder()
      .insert()
      .values({
        bucketDigest,
        stateType,
        requestTimestampsJson: stateType === 'rate_limit' ? '[]' : null,
        failureCount: 0,
        firstFailedAt: null,
        lastFailedAt: null,
        lockedUntil: null,
        expiresAt,
      })
      .orIgnore()
      .execute()

    const query = repository
      .createQueryBuilder('state')
      .where('state.bucketDigest = :bucketDigest', { bucketDigest })
    if (AppDataSource.options.type === 'mysql') {
      query.setLock('pessimistic_write')
    }
    const state = await query.getOneOrFail()
    if (state.stateType !== stateType) {
      throw new Error('风控状态桶类型冲突')
    }
    return state
  }

  async consumeWindow(bucketKey: string, windowMs: number, nowMs = Date.now()): Promise<ClientRateLimitInfo> {
    const now = new Date(nowMs)
    await this.cleanupExpired(now)
    return AppDataSource.transaction(async (manager) => {
      const state = await this.loadLockedState(
        manager,
        digestBucketKey(`rate_limit:${bucketKey}`),
        'rate_limit',
        new Date(nowMs + windowMs),
      )
      const activeTimestamps = parseTimestamps(state.requestTimestampsJson)
        .filter((timestamp) => nowMs - timestamp < windowMs)
      activeTimestamps.push(nowMs)
      state.requestTimestampsJson = JSON.stringify(activeTimestamps)
      state.expiresAt = new Date(activeTimestamps[0] + windowMs)
      await manager.getRepository(AuthRiskState).save(state)
      return {
        totalHits: activeTimestamps.length,
        resetTime: new Date(activeTimestamps[0] + windowMs),
      }
    })
  }

  async readWindow(bucketKey: string, windowMs: number, nowMs = Date.now()): Promise<ClientRateLimitInfo | undefined> {
    const repository = AppDataSource.getRepository(AuthRiskState)
    const bucketDigest = digestBucketKey(`rate_limit:${bucketKey}`)
    const state = await repository.findOne({ where: { bucketDigest, stateType: 'rate_limit' } })
    if (!state) return undefined
    const activeTimestamps = parseTimestamps(state.requestTimestampsJson)
      .filter((timestamp) => nowMs - timestamp < windowMs)
    if (!activeTimestamps.length) {
      await repository.delete({ bucketDigest })
      return undefined
    }
    return {
      totalHits: activeTimestamps.length,
      resetTime: new Date(activeTimestamps[0] + windowMs),
    }
  }

  async decrementWindow(bucketKey: string, windowMs: number, nowMs = Date.now()): Promise<void> {
    const bucketDigest = digestBucketKey(`rate_limit:${bucketKey}`)
    await AppDataSource.transaction(async (manager) => {
      const repository = manager.getRepository(AuthRiskState)
      const query = repository.createQueryBuilder('state').where('state.bucketDigest = :bucketDigest', { bucketDigest })
      if (AppDataSource.options.type === 'mysql') query.setLock('pessimistic_write')
      const state = await query.getOne()
      if (!state || state.stateType !== 'rate_limit') return
      const activeTimestamps = parseTimestamps(state.requestTimestampsJson)
        .filter((timestamp) => nowMs - timestamp < windowMs)
      activeTimestamps.pop()
      if (!activeTimestamps.length) {
        await repository.delete({ bucketDigest })
        return
      }
      state.requestTimestampsJson = JSON.stringify(activeTimestamps)
      state.expiresAt = new Date(activeTimestamps[0] + windowMs)
      await repository.save(state)
    })
  }

  async resetWindow(bucketKey: string): Promise<void> {
    await AppDataSource.getRepository(AuthRiskState).delete({ bucketDigest: digestBucketKey(`rate_limit:${bucketKey}`) })
  }

  async readFailure(bucketKey: string, resetWindowMs: number, nowMs = Date.now()): Promise<PersistentFailureState | null> {
    const repository = AppDataSource.getRepository(AuthRiskState)
    const bucketDigest = digestBucketKey(`login_failure:${bucketKey}`)
    const state = await repository.findOne({ where: { bucketDigest, stateType: 'login_failure' } })
    if (!state?.lastFailedAt) return null
    const lockedUntil = state.lockedUntil?.getTime() ?? 0
    if (nowMs - state.lastFailedAt.getTime() >= resetWindowMs && lockedUntil <= nowMs) {
      await repository.delete({ bucketDigest })
      return null
    }
    return {
      count: state.failureCount,
      firstFailedAt: state.firstFailedAt?.getTime() ?? state.lastFailedAt.getTime(),
      lastFailedAt: state.lastFailedAt.getTime(),
      lockedUntil,
    }
  }

  async recordFailure(
    bucketKey: string,
    resetWindowMs: number,
    lockThreshold: number,
    lockMs: number,
    nowMs = Date.now(),
  ): Promise<PersistentFailureState> {
    const now = new Date(nowMs)
    await this.cleanupExpired(now)
    return AppDataSource.transaction(async (manager) => {
      const state = await this.loadLockedState(
        manager,
        digestBucketKey(`login_failure:${bucketKey}`),
        'login_failure',
        new Date(nowMs + resetWindowMs),
      )
      const previousLastFailedAt = state.lastFailedAt?.getTime() ?? 0
      const previousLockedUntil = state.lockedUntil?.getTime() ?? 0
      const shouldReset = previousLastFailedAt === 0
        || (nowMs - previousLastFailedAt >= resetWindowMs && previousLockedUntil <= nowMs)
      state.failureCount = shouldReset ? 1 : state.failureCount + 1
      state.firstFailedAt = shouldReset ? now : (state.firstFailedAt ?? now)
      state.lastFailedAt = now
      if (state.failureCount >= lockThreshold) {
        state.lockedUntil = new Date(nowMs + lockMs)
      }
      state.expiresAt = new Date(Math.max(nowMs + resetWindowMs, state.lockedUntil?.getTime() ?? 0))
      await manager.getRepository(AuthRiskState).save(state)
      return {
        count: state.failureCount,
        firstFailedAt: state.firstFailedAt.getTime(),
        lastFailedAt: nowMs,
        lockedUntil: state.lockedUntil?.getTime() ?? 0,
      }
    })
  }

  async resetFailure(bucketKey: string): Promise<void> {
    await AppDataSource.getRepository(AuthRiskState).delete({
      bucketDigest: digestBucketKey(`login_failure:${bucketKey}`),
    })
  }
}

export const persistentRiskStateService = new PersistentRiskStateService()

export class DatabaseRateLimitStore implements Store {
  localKeys = false
  readonly prefix: string
  private windowMs = 60 * 1000

  constructor(prefix: string) {
    this.prefix = prefix
  }

  init(options: Options) {
    this.windowMs = options.windowMs
  }

  get(key: string) {
    return persistentRiskStateService.readWindow(`${this.prefix}:${key}`, this.windowMs)
  }

  increment(key: string) {
    return persistentRiskStateService.consumeWindow(`${this.prefix}:${key}`, this.windowMs)
  }

  decrement(key: string) {
    return persistentRiskStateService.decrementWindow(`${this.prefix}:${key}`, this.windowMs)
  }

  resetKey(key: string) {
    return persistentRiskStateService.resetWindow(`${this.prefix}:${key}`)
  }
}
