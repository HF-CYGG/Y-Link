/**
 * 文件说明：进程过载监测器，按事件循环延迟与 SQLite 写队列占用判定负载等级，供削峰中间件分级拒绝请求。
 * 实现逻辑：
 * - 每秒采样一次事件循环延迟 p99（`perf_hooks.monitorEventLoopDelay`，采样后清零）与写队列占用率；
 * - 等级 normal / elevated / critical，连续 N 次越线才升级、连续 M 次回落到阈值一半以下才降级（迟滞），
 *   避免单次抖动造成反复切换；critical 只由事件循环延迟持续触发，写队列拥堵最多到 elevated；
 * - `evaluate` 为纯状态推进，测试可直接注入信号；采样器只在正式运行时启动，
 *   同一进程内直接 createApp 的回归脚本保持 normal，不受本机负载波动影响。
 * 维护说明：
 * - 等级只影响削峰中间件，不改变任何业务逻辑；关闭开关后等级恒为 normal；
 * - 调整阈值时同步更新文档 42 与 `config/load-protection-policy.ts` 的默认值说明。
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

export type OverloadLevel = 'normal' | 'elevated' | 'critical'

export interface OverloadSignals {
  eventLoopDelayP99Ms: number
  /** 0~1；非串行写入模式（MySQL）为 null。 */
  writeQueueOccupancy: number | null
}

export interface OverloadPolicy {
  enabled: boolean
  sampleIntervalMs: number
  elevatedLoopDelayMs: number
  criticalLoopDelayMs: number
  elevatedWriteQueueRatio: number
  enterSamples: number
  recoverSamples: number
}

export type OverloadShedCategory = 'anonymousAuth' | 'realtime' | 'export' | 'read'

export interface OverloadSnapshot {
  enabled: boolean
  running: boolean
  level: OverloadLevel
  levelSince: string
  lastSignals: OverloadSignals | null
  thresholds: Omit<OverloadPolicy, 'enabled'>
  shedCounts: Record<OverloadShedCategory, number>
}

export class OverloadMonitor {
  private level: OverloadLevel = 'normal'
  private levelSince = Date.now()
  private elevatedStreak = 0
  private criticalStreak = 0
  private calmStreak = 0
  private criticalCalmStreak = 0
  private lastSignals: OverloadSignals | null = null
  private histogram: IntervalHistogram | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readWriteQueueOccupancy: () => number | null = () => null
  private readonly shedCounts: Record<OverloadShedCategory, number> = { anonymousAuth: 0, realtime: 0, export: 0, read: 0 }

  constructor(private readonly policy: OverloadPolicy) {}

  getLevel(): OverloadLevel {
    return this.policy.enabled ? this.level : 'normal'
  }

  /** 纯状态推进：根据一次采样信号更新连续计数并按迟滞规则升降级，返回新等级。 */
  evaluate(signals: OverloadSignals, nowMs = Date.now()): OverloadLevel {
    this.lastSignals = signals
    const loopDelay = signals.eventLoopDelayP99Ms
    const queueRatio = signals.writeQueueOccupancy ?? 0
    const wantsCritical = loopDelay >= this.policy.criticalLoopDelayMs
    const wantsElevated = wantsCritical
      || loopDelay >= this.policy.elevatedLoopDelayMs
      || queueRatio >= this.policy.elevatedWriteQueueRatio
    this.criticalStreak = wantsCritical ? this.criticalStreak + 1 : 0
    this.elevatedStreak = wantsElevated ? this.elevatedStreak + 1 : 0
    // 回落判定取阈值的一半（写队列取 60%），形成迟滞区间。
    this.criticalCalmStreak = loopDelay < this.policy.criticalLoopDelayMs / 2 ? this.criticalCalmStreak + 1 : 0
    const calm = loopDelay < this.policy.elevatedLoopDelayMs / 2 && queueRatio < this.policy.elevatedWriteQueueRatio * 0.6
    this.calmStreak = calm ? this.calmStreak + 1 : 0

    let next = this.level
    if (this.criticalStreak >= this.policy.enterSamples) {
      next = 'critical'
    } else if (this.level === 'critical' && this.criticalCalmStreak >= this.policy.recoverSamples) {
      next = 'elevated'
    } else if (this.level === 'normal' && this.elevatedStreak >= this.policy.enterSamples) {
      next = 'elevated'
    } else if (this.level === 'elevated' && this.calmStreak >= this.policy.recoverSamples) {
      next = 'normal'
    }
    if (next !== this.level) {
      const previous = this.level
      this.level = next
      this.levelSince = nowMs
      const queueText = signals.writeQueueOccupancy === null ? '-' : `${Math.round(signals.writeQueueOccupancy * 100)}%`
      console.warn(`[overload] 负载等级 ${previous} → ${next}（事件循环延迟 p99=${Math.round(loopDelay)}ms，写队列占用=${queueText}）`)
    }
    return this.level
  }

  recordShed(category: OverloadShedCategory): void {
    this.shedCounts[category] += 1
  }

  /** 启动采样（幂等）；关闭开关时不启动。`readWriteQueueOccupancy` 返回 0~1 或 null。 */
  start(readWriteQueueOccupancy: () => number | null): void {
    if (!this.policy.enabled || this.timer) return
    this.readWriteQueueOccupancy = readWriteQueueOccupancy
    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.histogram.enable()
    this.timer = setInterval(() => this.sample(), this.policy.sampleIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.histogram?.disable()
    this.histogram = null
  }

  private sample(): void {
    const histogram = this.histogram
    if (!histogram) return
    // 直方图单位为纳秒；未采到数据时 percentile 返回 0。
    const p99Ms = histogram.percentile(99) / 1e6
    histogram.reset()
    let occupancy: number | null = null
    try {
      occupancy = this.readWriteQueueOccupancy()
    } catch {
      occupancy = null
    }
    this.evaluate({ eventLoopDelayP99Ms: Number.isFinite(p99Ms) ? p99Ms : 0, writeQueueOccupancy: occupancy })
  }

  snapshot(): OverloadSnapshot {
    const { enabled, ...thresholds } = this.policy
    return {
      enabled,
      running: this.timer !== null,
      level: this.getLevel(),
      levelSince: new Date(this.levelSince).toISOString(),
      lastSignals: this.lastSignals,
      thresholds,
      shedCounts: { ...this.shedCounts },
    }
  }
}
