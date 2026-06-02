/**
 * 文件说明：短期票据存储工具，统一承接验证码、重置密码凭证等进程内短时有效票据的过期清理与容量治理。
 * 实现逻辑：使用 Map 维护内存态票据，在每次读写前清理过期项，并在容量达到上限时按插入顺序淘汰最旧数据。
 * 维护重点：若部署升级为多实例或需要跨进程共享票据，应把这里替换为 Redis 等集中式存储实现。
 */
interface EphemeralTicketStoreOptions<TTicket> {
  maxSize: number
  resolveExpiresAt: (ticket: TTicket) => number
}

/**
 * 短期票据存储：
 * - 适用于验证码、重置凭证等“短 TTL、单次消费、允许进程重启丢失”的场景；
 * - 不负责序列化、持久化与分布式同步，只治理容量和过期生命周期。
 */
export class EphemeralTicketStore<TTicket> {
  private readonly store = new Map<string, TTicket>()

  constructor(private readonly options: EphemeralTicketStoreOptions<TTicket>) {}

  /**
   * 清理所有已过期票据：
   * - 每次读写前调用，保证常驻进程不会持续累积历史垃圾数据；
   * - 返回当前清理后剩余的票据数量，便于调试时观察容量变化。
   */
  sweepExpired(now = Date.now()) {
    for (const [key, ticket] of this.store) {
      if (this.options.resolveExpiresAt(ticket) <= now) {
        this.store.delete(key)
      }
    }
    return this.store.size
  }

  /**
   * 写入票据：
   * - 若 key 已存在则直接覆盖，保留最新票据；
   * - 若容量已满则先淘汰最旧票据，再写入新值，防止 Map 无限增长。
   */
  set(key: string, ticket: TTicket) {
    this.sweepExpired()

    if (!this.store.has(key)) {
      while (this.store.size >= this.options.maxSize) {
        const oldestKey = this.store.keys().next().value
        if (!oldestKey) {
          break
        }
        this.store.delete(oldestKey)
      }
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
   * 删除票据：
   * - 用于验证码核验成功、重置密码完成等“单次消费即作废”的场景。
   */
  delete(key: string) {
    this.store.delete(key)
  }

  /**
   * 返回当前有效票据数量：
   * - 调试或健康检查时可用于观察内存态票据规模。
   */
  size(now = Date.now()) {
    this.sweepExpired(now)
    return this.store.size
  }
}
