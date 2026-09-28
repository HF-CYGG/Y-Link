/**
 * 文件说明：安全拦截类审计的写入节流工具，按键在时间窗内只放行第一次，防止攻击流量把审计表灌满。
 * 实现逻辑：进程内有界 Map 记录每个键最近一次放行的时刻；窗口内重复命中直接跳过，容量满时按插入顺序淘汰最早的键。
 * 维护说明：
 * - 只用于“同一来源反复触发同一拦截”的安全事件（跨站拦截、频控拒绝、锁定拒绝等）；
 * - 业务写操作与认证成败审计不得节流，否则会丢失可追溯性。
 */

export interface AuditThrottleOptions {
  windowMs: number
  maxKeys: number
}

export class AuditThrottle {
  private readonly lastRecordedAt = new Map<string, number>()

  constructor(private readonly options: AuditThrottleOptions) {}

  /** 返回 true 表示本次应写审计；同一键在窗口内的后续命中返回 false。 */
  shouldRecord(key: string, now = Date.now()): boolean {
    const lastRecordedAt = this.lastRecordedAt.get(key)
    if (lastRecordedAt !== undefined && now - lastRecordedAt < this.options.windowMs) {
      return false
    }
    // 先删除再写入，让最近放行的键移到插入顺序末尾，淘汰时优先清掉长期不活跃的键。
    this.lastRecordedAt.delete(key)
    while (this.lastRecordedAt.size >= this.options.maxKeys) {
      const oldestKey = this.lastRecordedAt.keys().next().value
      if (oldestKey === undefined) break
      this.lastRecordedAt.delete(oldestKey)
    }
    this.lastRecordedAt.set(key, now)
    return true
  }
}
