/**
 * 文件说明：短期票据存储工具，统一承接验证码、重置密码凭证等短时有效票据的过期清理与容量治理。
 * 实现逻辑：
 * - 使用 Map 维护内存态票据（Map 按插入顺序迭代），容量达到上限时按插入顺序淘汰最旧数据；
 * - 过期清理为增量式：从最旧的票据开始，遇到第一张未过期的即停止，且单次最多清理固定条数，
 *   读写的摊销成本为 O(1)，不再像早期实现那样每次读写都全表扫描（验证码洪水时会退化为 O(n)）；
 * - 覆盖写入时先删除再写入，让被覆盖的票据移到队尾，保持“越靠前越早写入”的顺序；
 * - 个别票据的有效期与插入顺序不一致时，靠后的过期票据可能暂留，但读取时仍逐张校验有效期，
 *   且总量受容量上限约束，不影响正确性；
 * - 配置独立 Redis 后，业务票据统一经 createTicketStore() 切换到 RedisTicketStore，多实例间共享；
 *   内存实现继续服务单实例部署与进程内回归脚本。
 * 维护重点：
 * - 调用方一律按异步接口 TicketStore 使用（await），不得依赖内存实现的同步特性；
 * - Redis 实现中票据值整体加密、键名做 SHA-256 摘要，Redis 中不出现验证码、手机号、TOTP 秘钥或密码哈希明文；
 * - Redis 已配置但不可用时，票据读写抛出 503：安全票据宁可拒绝，也不能回落到实例本地而造成“跨实例失效”或放行。
 */
import { createHash } from 'node:crypto'
import { getRedisClient, isRedisEnabled, isRedisReady, recordRedisDegrade, redisKey } from '../redis/redis-client.js'
import { runRedisScript, TICKET_RECORD_FAILED_ATTEMPT } from '../redis/redis-scripts.js'
import { openSensitiveValue, sealSensitiveValue } from './data-encryption.js'
import { BizError } from './errors.js'

type MaybePromise<T> = T | Promise<T>

/**
 * 短期票据存储的统一接口：内存实现同步返回，Redis 实现返回 Promise，调用方一律 await。
 */
export interface TicketStore<TTicket> {
  set(key: string, ticket: TTicket): MaybePromise<void>
  get(key: string): MaybePromise<TTicket | undefined>
  /** 原子读取并删除：并发消费同一票据时只有一个调用方能拿到。 */
  take(key: string): MaybePromise<TTicket | undefined>
  delete(key: string): MaybePromise<void>
  /**
   * 原子记录一次错误尝试，返回累计错误次数；达到上限时票据随之作废。票据不存在返回 null。
   * 重新 set 同一键会清零错误次数。
   */
  recordFailedAttempt(key: string, maxAttempts: number): MaybePromise<number | null>
}

interface EphemeralTicketStoreOptions<TTicket> {
  maxSize: number
  resolveExpiresAt: (ticket: TTicket) => number
}

/** 单次增量清理的最大条数：把清理成本摊到多次读写上，避免个别请求承担整表扫描。 */
const SWEEP_BATCH_LIMIT = 64

/**
 * 短期票据存储（进程内存实现）：
 * - 适用于验证码、重置凭证等“短 TTL、单次消费、允许进程重启丢失”的场景；
 * - 不负责序列化、持久化与分布式同步，只治理容量和过期生命周期。
 */
export class EphemeralTicketStore<TTicket> implements TicketStore<TTicket> {
  private readonly store = new Map<string, TTicket>()
  private readonly attempts = new Map<string, number>()

  constructor(private readonly options: EphemeralTicketStoreOptions<TTicket>) {}

  /**
   * 增量清理已过期票据：
   * - 每次读写前调用；从最旧的票据开始，遇到第一张未过期的即停止，单次最多清理 `limit` 条；
   * - 返回当前剩余的票据数量，便于调试时观察容量变化。
   */
  sweepExpired(now = Date.now(), limit = SWEEP_BATCH_LIMIT) {
    let removed = 0
    for (const [key, ticket] of this.store) {
      // 过期判定沿用 `<= now`：解析不出有效期的票据（NaN/undefined）不视为过期，与读取时的判定一致。
      if (removed >= limit || !(this.options.resolveExpiresAt(ticket) <= now)) {
        break
      }
      this.delete(key)
      removed += 1
    }
    return this.store.size
  }

  /**
   * 写入票据：
   * - 若 key 已存在则先删除再写入，保留最新票据并移到队尾（保持插入顺序与写入时间一致），错误次数随之清零；
   * - 若容量已满则先淘汰最旧票据，再写入新值，防止 Map 无限增长。
   */
  set(key: string, ticket: TTicket) {
    this.sweepExpired()
    this.delete(key)

    while (this.store.size >= this.options.maxSize) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      this.delete(oldestKey)
    }

    this.store.set(key, ticket)
  }

  /**
   * 读取票据：
   * - 命中前会先清理过期数据；
   * - 若目标票据已过期，会在返回前立即删除并视为不存在。
   */
  get(key: string, now = Date.now()) {
    this.sweepExpired(now)
    const ticket = this.store.get(key)
    if (!ticket) {
      return undefined
    }

    if (this.options.resolveExpiresAt(ticket) <= now) {
      this.delete(key)
      return undefined
    }

    return ticket
  }

  /**
   * 同步读取并删除单次票据：
   * - JavaScript 单线程事件循环内不会在 get/delete 之间让出执行权；
   * - 用于重置凭证等即使后续业务失败也不能归还的敏感票据。
   */
  take(key: string, now = Date.now()) {
    this.sweepExpired(now)
    const ticket = this.store.get(key)
    this.delete(key)
    if (!ticket || this.options.resolveExpiresAt(ticket) <= now) {
      return undefined
    }
    return ticket
  }

  /**
   * 删除票据：
   * - 用于验证码核验成功、重置密码完成等“单次消费即作废”的场景。
   */
  delete(key: string) {
    this.store.delete(key)
    this.attempts.delete(key)
  }

  /** 记录一次错误尝试；达到上限即删除票据。单线程事件循环内读改写不会被打断。 */
  recordFailedAttempt(key: string, maxAttempts: number, now = Date.now()) {
    if (!this.get(key, now)) {
      return null
    }
    const attempts = (this.attempts.get(key) ?? 0) + 1
    if (attempts >= maxAttempts) {
      this.delete(key)
    } else {
      this.attempts.set(key, attempts)
    }
    return attempts
  }

  /**
   * 返回当前有效票据数量：
   * - 调试或健康检查时可用于观察内存态票据规模；这里做一次完整清理以返回准确值，不在请求热路径上调用。
   */
  size(now = Date.now()) {
    this.sweepExpired(now, Number.POSITIVE_INFINITY)
    for (const [key, ticket] of this.store) {
      if (this.options.resolveExpiresAt(ticket) <= now) {
        this.delete(key)
      }
    }
    return this.store.size
  }
}

const TICKET_UNAVAILABLE_MESSAGE = '安全票据服务暂不可用，请稍后重试'

/**
 * Redis 票据存储：
 * - 键：<前缀>ticket:<namespace>:<sha256(业务键)>，错误计数键在其后追加 :attempts；
 * - 值：JSON 经 AES-256-GCM 加密（AAD 绑定 namespace），多实例需注入同一把 Y_LINK_DATA_ENCRYPTION_KEY；
 * - 有效期：按票据自身的过期时刻换算 PX，Redis 到期自动删除，读取时仍复核过期时刻以容忍实例间时钟偏差。
 */
export class RedisTicketStore<TTicket> implements TicketStore<TTicket> {
  private readonly encryptionContext: string

  constructor(
    private readonly namespace: string,
    private readonly resolveExpiresAt: (ticket: TTicket) => number,
  ) {
    this.encryptionContext = `redis-ticket:${namespace}`
  }

  private keysOf(key: string): [string, string] {
    const digest = createHash('sha256').update(key).digest('hex')
    const ticketKey = redisKey('ticket', this.namespace, digest)
    return [ticketKey, `${ticketKey}:attempts`]
  }

  private requireClient() {
    const client = getRedisClient()
    if (!client || !isRedisReady()) {
      recordRedisDegrade(`票据存储 ${this.namespace}`)
      throw new BizError(TICKET_UNAVAILABLE_MESSAGE, 503)
    }
    return client
  }

  private async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof BizError) throw error
      recordRedisDegrade(`票据存储 ${this.namespace} ${operation}`, error)
      throw new BizError(TICKET_UNAVAILABLE_MESSAGE, 503)
    }
  }

  private decode(raw: string | null, now: number): TTicket | undefined {
    if (!raw) return undefined
    const opened = openSensitiveValue(this.encryptionContext, raw)
    // 只接受密文：明文或无法解密（密钥不一致）的值一律视为不存在，伪造写入的票据不能被放行。
    if (opened.state !== 'sealed') return undefined
    try {
      const ticket = JSON.parse(opened.value) as TTicket
      return this.resolveExpiresAt(ticket) <= now ? undefined : ticket
    } catch {
      return undefined
    }
  }

  async set(key: string, ticket: TTicket): Promise<void> {
    const client = this.requireClient()
    const [ticketKey, attemptsKey] = this.keysOf(key)
    const ttlMs = Math.floor(this.resolveExpiresAt(ticket) - Date.now())
    await this.run('写入', async () => {
      if (!(ttlMs > 0)) {
        await client.del(ticketKey, attemptsKey)
        return
      }
      const sealed = sealSensitiveValue(this.encryptionContext, JSON.stringify(ticket))
      const results = await client.multi().set(ticketKey, sealed, 'PX', ttlMs).del(attemptsKey).exec()
      const failed = results?.find(([error]) => error)
      if (!results || failed) throw failed?.[0] ?? new Error('票据写入事务被中止')
    })
  }

  async get(key: string): Promise<TTicket | undefined> {
    const client = this.requireClient()
    const [ticketKey] = this.keysOf(key)
    return this.run('读取', async () => this.decode(await client.get(ticketKey), Date.now()))
  }

  async take(key: string): Promise<TTicket | undefined> {
    const client = this.requireClient()
    const [ticketKey, attemptsKey] = this.keysOf(key)
    return this.run('消费', async () => {
      const results = await client.multi().getdel(ticketKey).del(attemptsKey).exec()
      const failed = results?.find(([error]) => error)
      if (!results || failed) throw failed?.[0] ?? new Error('票据消费事务被中止')
      const raw = results[0]?.[1]
      return this.decode(typeof raw === 'string' ? raw : null, Date.now())
    })
  }

  async delete(key: string): Promise<void> {
    const client = this.requireClient()
    await this.run('删除', async () => {
      await client.del(...this.keysOf(key))
    })
  }

  async recordFailedAttempt(key: string, maxAttempts: number): Promise<number | null> {
    const client = this.requireClient()
    const [ticketKey, attemptsKey] = this.keysOf(key)
    return this.run('记录错误次数', async () => {
      const attempts = await runRedisScript<number>(client, TICKET_RECORD_FAILED_ATTEMPT, [ticketKey, attemptsKey], [maxAttempts])
      return attempts < 0 ? null : attempts
    })
  }
}

/**
 * 业务票据统一入口：配置了 REDIS_URL 时使用 Redis（多实例共享），否则使用进程内存（单实例现状）。
 * @param namespace 票据类别，参与 Redis 键名与加密 AAD，不同类别不得复用
 */
export function createTicketStore<TTicket>(
  options: EphemeralTicketStoreOptions<TTicket> & { namespace: string },
): TicketStore<TTicket> {
  if (isRedisEnabled()) {
    return new RedisTicketStore<TTicket>(options.namespace, options.resolveExpiresAt)
  }
  return new EphemeralTicketStore<TTicket>({ maxSize: options.maxSize, resolveExpiresAt: options.resolveExpiresAt })
}
