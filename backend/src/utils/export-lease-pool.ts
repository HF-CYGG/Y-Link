/**
 * 文件说明：重型导出的并发租约池，限制同一账号与整个进程同时进行的导出数量（OWASP API4 资源消耗）。
 * 实现逻辑：按操作者计数的内存租约；导出开始前获取，响应结束或失败后在 finally 中归还；超出上限立即返回 429。
 * 维护说明：
 * - 导出必须在“生成任务结束”与“响应写完或连接关闭”两者都满足后才归还租约：只等响应，客户端在生成期间断连
 *   会提前归还而生成仍在后台跑，反复“发起即断开”可无限叠加重型任务；只等生成，慢速客户端读取期间又可叠加导出、
 *   让多个大文件滞留在未完成的响应里。一次性发送 Buffer 的导出用 `runExportHoldingLease` 包住生成步骤；
 * - 报表导出沿用 `report.service.ts` 自己的租约池，本池覆盖审计日志、库存流水与商品导出；
 * - 路由统一使用 acquireShared：配置 Redis 后“每账号同时导出数”按集群计算，“每进程上限”仍按实例保护本进程资源。
 */
import { BizError } from './errors.js'
import { acquireClusterSlot } from '../redis/redis-lease.js'

/** 集群级导出名额的租约有效期：持有期间自动续期，实例崩溃后最长在该时间后自动释放。 */
const CLUSTER_EXPORT_SLOT_TTL_MS = 60_000

/**
 * 在本进程租约之上叠加集群级“每账号”名额。`namespace` 区分不同导出池，`busyMessage` 为被占用时的提示。
 */
export async function acquireWithClusterActorSlot(
  namespace: string,
  actorId: string | number,
  acquireLocal: () => ExportLease,
  busyMessage: string,
): Promise<ExportLease> {
  const local = acquireLocal()
  let slot: Awaited<ReturnType<typeof acquireClusterSlot>>
  try {
    slot = await acquireClusterSlot(`export:${namespace}:${String(actorId).trim()}`, CLUSTER_EXPORT_SLOT_TTL_MS)
  } catch (error) {
    local.release()
    throw error
  }
  if (slot === null) {
    local.release()
    throw new BizError(busyMessage, 429)
  }
  return {
    release: () => {
      local.release()
      if (slot !== 'local') slot.release()
    },
  }
}

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

  /**
   * 跨实例获取导出租约：先占本进程名额，再占集群级“每账号”名额（Redis 启用时），
   * 避免多实例把每账号上限放大 N 倍；Redis 不可用时只按本进程口径限制。
   */
  acquireShared(actorId: string | number): Promise<ExportLease> {
    return acquireWithClusterActorSlot('data', actorId, () => this.acquire(actorId), '当前账号已有导出任务正在进行，请等待完成后再试')
  }
}

/**
 * 在持有租约的前提下执行导出生成：租约在生成任务结束（成功或失败）且响应发送完毕（finish）或连接关闭（close）后才归还。
 * - 客户端在生成期间断连：生成任务不会被取消，租约继续占用直到它真正结束，同账号无法借“发起即断开”叠加任务；
 * - 生成完成但响应未读完：租约继续占用直到响应结束；
 * - 生成失败：错误响应写出（finish）或连接关闭后归还。归还本身幂等。
 * acquireShared 需要等待 Redis，客户端可能在拿到租约前就已断开，此时 close 事件早已发出、不会再触发；
 * 因此注册监听时还要检查响应是否已结束或连接已关闭，否则租约与集群名额会被永久占用。
 */
export async function runExportHoldingLease<T>(
  lease: ExportLease,
  res: {
    once: (event: 'finish' | 'close', listener: () => void) => unknown
    readonly writableFinished?: boolean
    readonly closed?: boolean
    readonly destroyed?: boolean
  },
  generate: () => Promise<T>,
): Promise<T> {
  let generationSettled = false
  let responseEnded = Boolean(res.writableFinished || res.closed || res.destroyed)
  const releaseWhenBothDone = () => {
    if (generationSettled && responseEnded) lease.release()
  }
  const onResponseEnded = () => {
    responseEnded = true
    releaseWhenBothDone()
  }
  res.once('finish', onResponseEnded)
  res.once('close', onResponseEnded)
  try {
    return await generate()
  } finally {
    generationSettled = true
    releaseWhenBothDone()
  }
}

/** 审计日志、库存流水与商品导出共用：每账号同时 1 个，每进程同时 3 个。 */
export const dataExportLeasePool = new ExportLeasePool({ maxPerActor: 1, maxPerProcess: 3 })
