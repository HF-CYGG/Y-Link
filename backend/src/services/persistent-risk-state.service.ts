/**
 * 模块说明：为认证风控与 Express 入口限流提供跨实例共享的数据库状态。
 * 安全约束：桶键在落库前统一做 SHA-256，不持久化原始账号、手机号或 IP。
 * 实现要点：
 * - 行的“确保存在”与“加锁读改写”拆成两步：先在事务外用一条独立提交的
 *   `INSERT ... ON DUPLICATE KEY IGNORE` 确保桶存在，再进入事务对已存在的行 `SELECT ... FOR UPDATE`。
 *   这是为了避开 InnoDB 文档明确警示的场景——两个事务并发插入同一个尚不存在的唯一键会互相
 *   等待对方的间隙锁而死锁；拆开后，事务内命中的永远是“已存在的行”，只是普通行锁排队。
 * - consumeWindow 在已知调用方限额（maxRequests）时，一旦当前窗口已达上限就不再写入新时间戳，
 *   避免“被拒绝的请求反而比被放行的请求多消耗一次写事务”这种成本倒挂。
 * - 过期状态的清理（cleanupExpired）不再挂在请求路径上，改为独立的后台定时任务，
 *   避免个别请求承担范围删除的延迟，也避免其与请求事务竞争同一批行的加锁顺序。
 */

import { createHash } from 'node:crypto'
import { LessThanOrEqual, type EntityManager } from 'typeorm'
import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit'
import { AppDataSource } from '../config/data-source.js'
import { AuthRiskState } from '../entities/auth-risk-state.entity.js'
import { isRetryableTransactionLockError } from '../utils/database-errors.js'
import { databaseMaintenanceModeService } from './database-maintenance-mode.service.js'

export interface PersistentFailureState {
  count: number
  firstFailedAt: number
  lastFailedAt: number
  lockedUntil: number
}

const CLEANUP_INTERVAL_MS = 60 * 1000
const MAX_TIMESTAMPS_PER_BUCKET = 1000
const LOCK_RETRY_ATTEMPTS = 3
// "确保行存在 → 加锁读取"之间行被清理任务删除时的重试次数。
// 正常情况下第一次就会命中；这里留出余量只是为了兜住极端时序，不需要很大。
const STATE_ROW_LOAD_ATTEMPTS = 3

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
  private cleanupLoopTimer: ReturnType<typeof globalThis.setInterval> | null = null

  /**
   * 在事务外单独执行并立即提交，确保桶键对应的行存在且未处于"已过期"状态。
   * 不要把这一步挪回调用方所在的事务里——见文件头说明的死锁场景。
   *
   * 命中已存在行时必须顺带把 expires_at 向后延展（而不是 orIgnore 直接跳过）：
   * 后台 cleanupExpired 删除的正是 expires_at <= now 的行，若这里对一个"已存在但已过期"的桶
   * 什么都不做，清理任务就可能在调用方的加锁 SELECT 之前把它删掉，
   * 使随后的加锁查询扑空。用 GREATEST/MAX 只向后延展、不缩短，
   * 避免把 login_failure 桶中比 resetWindow 更长的锁定期提前截断。
   */
  private async ensureStateRowExists(
    bucketDigest: string,
    stateType: AuthRiskState['stateType'],
    expiresAt: Date,
  ): Promise<void> {
    const repository = AppDataSource.getRepository(AuthRiskState)
    const isMysql = AppDataSource.options.type === 'mysql'
    const initialTimestampsJson = stateType === 'rate_limit' ? '[]' : null

    if (isMysql) {
      await repository.query(
        `INSERT INTO auth_risk_state
           (bucket_digest, state_type, request_timestamps_json, failure_count, first_failed_at, last_failed_at, locked_until, expires_at)
         VALUES (?, ?, ?, 0, NULL, NULL, NULL, ?)
         ON DUPLICATE KEY UPDATE expires_at = GREATEST(expires_at, VALUES(expires_at))`,
        [bucketDigest, stateType, initialTimestampsJson, expiresAt],
      )
      return
    }

    await repository.query(
      `INSERT INTO auth_risk_state
         (bucket_digest, state_type, request_timestamps_json, failure_count, first_failed_at, last_failed_at, locked_until, expires_at)
       VALUES (?, ?, ?, 0, NULL, NULL, NULL, ?)
       ON CONFLICT(bucket_digest) DO UPDATE SET expires_at = MAX(auth_risk_state.expires_at, excluded.expires_at)`,
      [bucketDigest, stateType, initialTimestampsJson, expiresAt],
    )
  }

  /**
   * 确保行存在后再加锁读取。
   * 即便 ensureStateRowExists 已经把 expires_at 向后延展，"确保存在"与"加锁读取"仍是两条语句，
   * 极端时序下（例如清理任务恰好读到延展前的旧值）加锁查询仍可能扑空。
   * 这里对扑空做有界重试，而不是让 getOneOrFail 抛出 EntityNotFoundError——
   * 那是非锁冲突异常，runWithLockRetry 不会重试，会让登录/验证码请求直接 500。
   */
  private async loadLockedState(
    manager: EntityManager,
    bucketDigest: string,
    stateType: AuthRiskState['stateType'],
    expiresAt: Date,
  ) {
    const repository = manager.getRepository(AuthRiskState)

    for (let attempt = 1; attempt <= STATE_ROW_LOAD_ATTEMPTS; attempt += 1) {
      await this.ensureStateRowExists(bucketDigest, stateType, expiresAt)

      const query = repository
        .createQueryBuilder('state')
        .where('state.bucketDigest = :bucketDigest', { bucketDigest })
      if (AppDataSource.options.type === 'mysql') {
        query.setLock('pessimistic_write')
      }
      const state = await query.getOne()
      if (!state) {
        // 行在"确保存在"与"加锁读取"之间被清理任务删除，重新确保后再试。
        continue
      }
      if (state.stateType !== stateType) {
        throw new Error('风控状态桶类型冲突')
      }
      return state
    }

    throw new Error(`风控状态桶 ${bucketDigest} 在 ${STATE_ROW_LOAD_ATTEMPTS} 次尝试内反复被清理，无法加锁读取`)
  }

  /** 对偶发的死锁/锁等待超时做有界重试，与仓库内其它事务重试点（如 order-serial.service.ts）保持同一模式。 */
  private async runWithLockRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (attempt < LOCK_RETRY_ATTEMPTS && isRetryableTransactionLockError(error)) {
          continue
        }
        throw error
      }
    }
    throw lastError
  }

  /**
   * @param maxRequests 调用方已知的限额时传入：一旦当前窗口命中数已达到该值，直接返回“视同再命中一次”的结果，
   *   不再落库新时间戳，避免超限请求反复触发写事务。不传时保持“总是追加并写入”的旧行为。
   */
  async consumeWindow(
    bucketKey: string,
    windowMs: number,
    nowMs = Date.now(),
    maxRequests?: number,
  ): Promise<ClientRateLimitInfo> {
    return this.runWithLockRetry(() =>
      AppDataSource.transaction(async (manager) => {
        const state = await this.loadLockedState(
          manager,
          digestBucketKey(`rate_limit:${bucketKey}`),
          'rate_limit',
          new Date(nowMs + windowMs),
        )
        const activeTimestamps = parseTimestamps(state.requestTimestampsJson)
          .filter((timestamp) => nowMs - timestamp < windowMs)

        if (typeof maxRequests === 'number' && activeTimestamps.length >= maxRequests) {
          return {
            totalHits: activeTimestamps.length + 1,
            resetTime: new Date((activeTimestamps[0] ?? nowMs) + windowMs),
          }
        }

        activeTimestamps.push(nowMs)
        state.requestTimestampsJson = JSON.stringify(activeTimestamps)
        state.expiresAt = new Date(activeTimestamps[0] + windowMs)
        await manager.getRepository(AuthRiskState).save(state)
        return {
          totalHits: activeTimestamps.length,
          resetTime: new Date(activeTimestamps[0] + windowMs),
        }
      }),
    )
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
    await this.runWithLockRetry(() =>
      AppDataSource.transaction(async (manager) => {
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
      }),
    )
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
    return this.runWithLockRetry(() =>
      AppDataSource.transaction(async (manager) => {
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
      }),
    )
  }

  async resetFailure(bucketKey: string): Promise<void> {
    await AppDataSource.getRepository(AuthRiskState).delete({
      bucketDigest: digestBucketKey(`login_failure:${bucketKey}`),
    })
  }

  private async cleanupExpired(): Promise<void> {
    const releaseMaintenanceLease = databaseMaintenanceModeService.registerInFlightWrite()
    if (!releaseMaintenanceLease) {
      return
    }
    try {
      await AppDataSource.getRepository(AuthRiskState).delete({ expiresAt: LessThanOrEqual(new Date()) })
    } finally {
      releaseMaintenanceLease()
    }
  }

  /** 启动周期性过期清理：幂等，重复调用不会叠加多个定时器。 */
  startCleanupLoop(): void {
    if (this.cleanupLoopTimer !== null) {
      return
    }
    this.cleanupLoopTimer = globalThis.setInterval(() => {
      if (databaseMaintenanceModeService.isReadOnly()) {
        return
      }
      void this.cleanupExpired().catch(() => undefined)
    }, CLEANUP_INTERVAL_MS)
  }

  stopCleanupLoop(): void {
    if (this.cleanupLoopTimer !== null) {
      globalThis.clearInterval(this.cleanupLoopTimer)
      this.cleanupLoopTimer = null
    }
  }
}

export const persistentRiskStateService = new PersistentRiskStateService()

export class DatabaseRateLimitStore implements Store {
  localKeys = false
  readonly prefix: string
  private windowMs = 60 * 1000
  private limit: number | undefined

  constructor(prefix: string) {
    this.prefix = prefix
  }

  init(options: Options) {
    this.windowMs = options.windowMs
    // limit 也可能是按请求动态计算的中间件函数；仅在配置为固定数值时才能提前捕获用于“超限不写”优化，
    // 函数形式的限额退回旧行为（总是追加），不影响正确性，只是少了这一层写放大优化。
    this.limit = typeof options.limit === 'number' ? options.limit : undefined
  }

  get(key: string) {
    return persistentRiskStateService.readWindow(`${this.prefix}:${key}`, this.windowMs)
  }

  increment(key: string) {
    return persistentRiskStateService.consumeWindow(`${this.prefix}:${key}`, this.windowMs, Date.now(), this.limit)
  }

  decrement(key: string) {
    return persistentRiskStateService.decrementWindow(`${this.prefix}:${key}`, this.windowMs)
  }

  resetKey(key: string) {
    return persistentRiskStateService.resetWindow(`${this.prefix}:${key}`)
  }
}
