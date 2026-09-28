/**
 * 文件说明：重型导出的并发租约池，限制同一账号与整个进程同时进行的导出数量（OWASP API4 资源消耗）。
 * 实现逻辑：按操作者计数的内存租约；导出开始前获取，响应结束或失败后在 finally 中归还；超出上限立即返回 429。
 * 维护说明：
 * - 导出必须在响应完全写完（或连接关闭）后才归还租约，否则慢速客户端读取期间可以重复叠加导出、
 *   让多个大文件同时滞留在未完成的响应里；一次性发送 Buffer 的导出用 `holdExportLeaseUntilResponseEnds` 绑定响应；
 * - 报表导出沿用 `report.service.ts` 自己的租约池，本池覆盖审计日志、库存流水与商品导出。
 */
import { BizError } from './errors.js'

export interface ExportLeasePoolOptions {
  maxPerActor: number
  maxPerProcess: number
}

export interface ExportLease {
  release: () => void
}

export class ExportLeasePool {
  private readonly activeByActor = new Map<string, number>()
  private activeCount = 0

  constructor(private readonly options: ExportLeasePoolOptions) {}

  /** SQLite 下 integer 主键在运行时是数字，这里统一转成字符串计数。 */
  acquire(actorId: string | number): ExportLease {
    const normalizedActorId = String(actorId ?? '').trim()
    if (!normalizedActorId) {
      throw new BizError('导出操作者身份缺失', 401)
    }
    const actorActive = this.activeByActor.get(normalizedActorId) ?? 0
    if (actorActive >= this.options.maxPerActor) {
      throw new BizError('当前账号已有导出任务正在进行，请等待完成后再试', 429)
    }
    if (this.activeCount >= this.options.maxPerProcess) {
      throw new BizError('当前导出任务较多，请稍后重试', 429)
    }
    this.activeByActor.set(normalizedActorId, actorActive + 1)
    this.activeCount += 1
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.activeCount = Math.max(0, this.activeCount - 1)
        const remaining = (this.activeByActor.get(normalizedActorId) ?? 1) - 1
        if (remaining > 0) {
          this.activeByActor.set(normalizedActorId, remaining)
        } else {
          this.activeByActor.delete(normalizedActorId)
        }
      },
    }
  }

  get activeExports(): number {
    return this.activeCount
  }
}

/**
 * 把租约绑定到 HTTP 响应：响应发送完毕（finish）或连接关闭（close）时才归还。
 * 归还本身幂等；生成失败时错误响应同样会触发 finish，因此无需另外在 finally 中归还。
 */
export function holdExportLeaseUntilResponseEnds(
  lease: ExportLease,
  res: { once: (event: 'finish' | 'close', listener: () => void) => unknown },
): void {
  res.once('finish', lease.release)
  res.once('close', lease.release)
}

/** 审计日志、库存流水与商品导出共用：每账号同时 1 个，每进程同时 3 个。 */
export const dataExportLeasePool = new ExportLeasePool({ maxPerActor: 1, maxPerProcess: 3 })
