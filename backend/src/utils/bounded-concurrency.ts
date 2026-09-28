/**
 * 文件说明：进程内有界并发闸门，限制 CPU / libuv 线程池密集任务（密码派生、验证码渲染、商品图处理）的同时执行数与排队长度。
 * 实现逻辑：
 * - 未满并发直接执行；满并发时进入有界 FIFO 队列，队满或排队超时立即以 503 + Retry-After 快速失败，
 *   过载时快速失败优于无限排队：请求不再堆积在内存与线程池里拖慢数据库查询和正常用户；
 * - 释放槽位时直接移交给队首等待者（活跃数不变），避免“释放—抢占”间隙被新请求插队导致等待者饿死；
 * - 所有闸门在创建时登记，管理员性能接口可一次取回全部快照（活跃、排队、峰值、完成与拒绝计数）。
 * 维护说明：
 * - 闸门只做进程内限流，多实例部署时每个实例各自生效；
 * - 任务内部不得再次申请同一闸门，否则满载时外层占满槽位等待内层，形成相互等待；
 * - 闸门名称全局唯一，重复创建同名闸门会直接抛错，避免快照互相覆盖。
 */

import { BizError } from './errors.js'

export interface BoundedConcurrencyOptions {
  /** 快照与日志中使用的唯一名称。 */
  name: string
  maxConcurrent: number
  /** 允许排队的最大请求数；0 表示满并发时直接拒绝。 */
  maxQueue: number
  queueTimeoutMs: number
  /** 过载时返回给调用方的提示。 */
  busyMessage: string
  retryAfterSeconds?: number
}

export interface BoundedConcurrencySnapshot {
  name: string
  active: number
  queued: number
  maxConcurrent: number
  maxQueue: number
  queueTimeoutMs: number
  peakActive: number
  peakQueued: number
  completed: number
  rejectedQueueFull: number
  rejectedTimeout: number
}

interface GateWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  settled: boolean
}

const registeredGates = new Map<string, BoundedConcurrencyGate>()

export class BoundedConcurrencyGate {
  private active = 0
  private readonly waiters: GateWaiter[] = []
  private peakActive = 0
  private peakQueued = 0
  private completed = 0
  private rejectedQueueFull = 0
  private rejectedTimeout = 0

  constructor(private readonly options: BoundedConcurrencyOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error(`并发闸门 ${options.name} 的并发上限必须为正整数`)
    }
    if (!Number.isInteger(options.maxQueue) || options.maxQueue < 0) {
      throw new Error(`并发闸门 ${options.name} 的排队上限必须为非负整数`)
    }
    if (!(options.queueTimeoutMs > 0)) {
      throw new Error(`并发闸门 ${options.name} 的排队超时必须大于 0`)
    }
    if (registeredGates.has(options.name)) {
      throw new Error(`并发闸门 ${options.name} 重复创建`)
    }
    registeredGates.set(options.name, this)
  }

  private createBusyError(): BizError {
    return new BizError(this.options.busyMessage, 503, { retryAfterSeconds: this.options.retryAfterSeconds ?? 2 })
  }

  private acquire(): Promise<void> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1
      this.peakActive = Math.max(this.peakActive, this.active)
      return Promise.resolve()
    }
    if (this.waiters.length >= this.options.maxQueue) {
      this.rejectedQueueFull += 1
      return Promise.reject(this.createBusyError())
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: GateWaiter = {
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => {
          if (waiter.settled) return
          waiter.settled = true
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          this.rejectedTimeout += 1
          reject(this.createBusyError())
        }, this.options.queueTimeoutMs),
      }
      // 排队计时器不应阻止进程退出。
      waiter.timer.unref?.()
      this.waiters.push(waiter)
      this.peakQueued = Math.max(this.peakQueued, this.waiters.length)
    })
  }

  private release(): void {
    this.completed += 1
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!
      if (next.settled) continue
      next.settled = true
      clearTimeout(next.timer)
      // 槽位直接移交：活跃数保持不变。
      next.resolve()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  snapshot(): BoundedConcurrencySnapshot {
    return {
      name: this.options.name,
      active: this.active,
      queued: this.waiters.length,
      maxConcurrent: this.options.maxConcurrent,
      maxQueue: this.options.maxQueue,
      queueTimeoutMs: this.options.queueTimeoutMs,
      peakActive: this.peakActive,
      peakQueued: this.peakQueued,
      completed: this.completed,
      rejectedQueueFull: this.rejectedQueueFull,
      rejectedTimeout: this.rejectedTimeout,
    }
  }
}

/** 全部已登记闸门的快照，供管理员性能接口观察过载情况。 */
export function listConcurrencyGateSnapshots(): BoundedConcurrencySnapshot[] {
  return [...registeredGates.values()].map((gate) => gate.snapshot())
}
