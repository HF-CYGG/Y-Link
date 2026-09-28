/**
 * 文件说明：短期票据存储工具，统一承接验证码、重置密码凭证等进程内短时有效票据的过期清理与容量治理。
 * 实现逻辑：
 * - 使用 Map 维护内存态票据（Map 按插入顺序迭代），容量达到上限时按插入顺序淘汰最旧数据；
 * - 过期清理为增量式：从最旧的票据开始，遇到第一张未过期的即停止，且单次最多清理固定条数，
 *   读写的摊销成本为 O(1)，不再像早期实现那样每次读写都全表扫描（验证码洪水时会退化为 O(n)）；
 * - 覆盖写入时先删除再写入，让被覆盖的票据移到队尾，保持“越靠前越早写入”的顺序；
 * - 个别票据的有效期与插入顺序不一致时，靠后的过期票据可能暂留，但读取时仍逐张校验有效期，
 *   且总量受容量上限约束，不影响正确性。
 * 维护重点：若部署升级为多实例或需要跨进程共享票据，应把这里替换为 Redis 等集中式存储实现。
 */
interface EphemeralTicketStoreOptions<TTicket> {
  maxSize: number
  resolveExpiresAt: (ticket: TTicket) => number
}

/** 单次增量清理的最大条数：把清理成本摊到多次读写上，避免个别请求承担整表扫描。 */
const SWEEP_BATCH_LIMIT = 64

/**
 * 短期票据存储：
 * - 适用于验证码、重置凭证等“短 TTL、单次消费、允许进程重启丢失”的场景；
 * - 不负责序列化、持久化与分布式同步，只治理容量和过期生命周期。
 */
export class EphemeralTicketStore<TTicket> {
  private readonly store = new Map<string, TTicket>()

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
      this.store.delete(key)
      removed += 1
    }
    return this.store.size
  }

  /**
   * 写入票据：
   * - 若 key 已存在则先删除再写入，保留最新票据并移到队尾（保持插入顺序与写入时间一致）；
   * - 若容量已满则先淘汰最旧票据，再写入新值，防止 Map 无限增长。
   */
  set(key: string, ticket: TTicket) {
    this.sweepExpired()
    this.store.delete(key)

    while (this.store.size >= this.options.maxSize) {
      const oldestKey = this.store.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      this.store.delete(oldestKey)
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
      this.store.delete(key)
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
    if (!ticket || this.options.resolveExpiresAt(ticket) <= now) {
      this.store.delete(key)
      return undefined
    }
    this.store.delete(key)
    return ticket
  }

  /**
   * 删除票据：
   * - 用于验证码核验成功、重置密码完成等“单次消费即作废”的场景。
   */
  delete(key: string) {
    this.store.delete(key)
  }

  /**
   * 返回当前有效票据数量：
   * - 调试或健康检查时可用于观察内存态票据规模；这里做一次完整清理以返回准确值，不在请求热路径上调用。
   */
  size(now = Date.now()) {
    this.sweepExpired(now, Number.POSITIVE_INFINITY)
    for (const [key, ticket] of this.store) {
      if (this.options.resolveExpiresAt(ticket) <= now) {
        this.store.delete(key)
      }
    }
    return this.store.size
  }
}
