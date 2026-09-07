/**
 * 模块说明：backend/src/database/operation-gate.ts
 * 文件职责：提供与数据库驱动无关的写操作准入、冻结排空和瞬时治理能力。
 * 实现逻辑：
 * - AsyncLocalStorage 保存真实 operation identity；冻结前已准入的根操作可完成完整 Promise；
 * - operation 结束会使 identity 失效，继承旧 ALS 的 detached 任务必须重新准入；
 * - 冻结控制句柄显式持有到维护结束，治理写仅能在句柄 callback 的有效期内执行；
 * - Worker 在关闭准入后同步暂停领取，再与活动 operation 一起排空。
 * 维护说明：本模块不得导入 env、data-source 或业务服务，避免数据库启动与维护状态形成循环依赖。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { BizError } from '../utils/errors.js'

type GateMode = 'open' | 'frozen' | 'shutdown'
type OperationKind = 'normal' | 'governance'

interface OperationIdentity {
  readonly id: symbol
  readonly kind: OperationKind
  valid: boolean
  references: number
  counted: boolean
  outstandingIndependentLeases: number
}

export interface DatabaseOperationLease {
  readonly active: boolean
  release(): void
}

export interface DatabaseWorkerController {
  readonly name: string
  /** 必须同步停止领取新任务；耗时清理由 drain 完成。 */
  pause(): void
  drain(): Promise<void>
  resume(): void
}

export interface DatabaseFreezeOptions {
  /** 治理 HTTP 请求开始冻结时应排除自身，避免等待自己的请求级租约。 */
  excludeCurrentOperation?: boolean
}

export interface DatabaseFreezeControl {
  readonly active: boolean
  drain(timeoutMs: number): Promise<void>
  runGovernance<T>(work: () => Promise<T>): Promise<T>
  release(): void
}

export interface DatabaseOperationGateSnapshot {
  mode: GateMode
  activeOperations: number
  registeredWorkers: number
}

export class DatabaseWriteFrozenError extends BizError {
  readonly code = 50301
  readonly reason: 'maintenance_read_only' | 'shutdown'

  constructor(reason: DatabaseWriteFrozenError['reason'] = 'maintenance_read_only') {
    super(
      reason === 'shutdown'
        ? '服务正在关闭，暂时无法提交数据库操作'
        : '服务器维护中，当前为只读状态，暂时无法提交操作',
      503,
      { code: 50301, reason },
    )
    this.name = 'DatabaseWriteFrozenError'
    this.reason = reason
  }
}

class OperationLease implements DatabaseOperationLease {
  private released = false

  constructor(
    private readonly identity: OperationIdentity,
    private readonly onRelease: (identity: OperationIdentity) => void,
    private readonly parentIdentity?: OperationIdentity,
  ) {}

  get active(): boolean {
    return !this.released
      && this.identity.valid
      && (!this.parentIdentity || this.parentIdentity.valid)
  }

  release(): void {
    if (this.released) {
      return
    }
    this.released = true
    this.onRelease(this.identity)
  }
}

class FreezeControl implements DatabaseFreezeControl {
  private released = false

  constructor(
    private readonly gate: DatabaseOperationGate,
    readonly controlId: symbol,
  ) {}

  get active(): boolean {
    return !this.released && this.gate.isFreezeControlActive(this.controlId)
  }

  drain(timeoutMs: number): Promise<void> {
    this.assertActive()
    return this.gate.drain(this.controlId, timeoutMs)
  }

  runGovernance<T>(work: () => Promise<T>): Promise<T> {
    this.assertActive()
    return this.gate.runGovernance(this.controlId, work)
  }

  release(): void {
    if (this.released) {
      return
    }
    this.released = true
    this.gate.releaseFreeze(this.controlId)
  }

  private assertActive(): void {
    if (!this.active) {
      throw new Error('数据库冻结控制句柄已失效')
    }
  }
}

export class DatabaseOperationGate {
  private readonly contextStorage = new AsyncLocalStorage<OperationIdentity>()
  private readonly activeOperations = new Set<OperationIdentity>()
  private readonly drainWaiters = new Set<() => void>()
  private readonly workerControllers = new Set<DatabaseWorkerController>()
  private mode: GateMode = 'open'
  private freezeControlId: symbol | null = null
  private freezeControl: FreezeControl | null = null

  snapshot(): DatabaseOperationGateSnapshot {
    return {
      mode: this.mode,
      activeOperations: this.activeOperations.size,
      registeredWorkers: this.workerControllers.size,
    }
  }

  isFrozen(): boolean {
    return this.mode !== 'open'
  }

  /**
   * 为 HTTP middleware 或兼容旧 worker 同步登记并进入 operation 上下文。
   * 返回 null 表示冻结已先发生；release 必须在真实异步工作完成后调用。
   */
  enterOperation(): DatabaseOperationLease | null {
    const current = this.contextStorage.getStore()
    if (this.isUsableNormalIdentity(current)) {
      current.references += 1
      return new OperationLease(current, (identity) => this.releaseIdentityReference(identity))
    }
    if (this.isUsableGovernanceIdentity(current)) {
      current.references += 1
      return new OperationLease(current, (identity) => this.releaseIdentityReference(identity))
    }
    if (this.mode !== 'open') {
      return null
    }

    const identity = this.createCountedIdentity('normal')
    this.contextStorage.enterWith(identity)
    return new OperationLease(identity, (releasedIdentity) => this.releaseIdentityReference(releasedIdentity))
  }

  /** 运行一个新的或嵌套的已计数 operation，并覆盖 work 的完整 Promise。 */
  async runOperation<T>(work: () => Promise<T>): Promise<T> {
    const current = this.contextStorage.getStore()
    if (this.isUsableNormalIdentity(current)) {
      current.references += 1
      try {
        return await work()
      } finally {
        this.releaseIdentityReference(current)
      }
    }
    if (this.isUsableGovernanceIdentity(current)) {
      return work()
    }
    this.assertAdmissionOpen()

    const identity = this.createCountedIdentity('normal')
    return this.contextStorage.run(identity, async () => {
      try {
        return await work()
      } finally {
        this.releaseIdentityReference(identity)
      }
    })
  }

  /**
   * asyncHandler 使用：已有 middleware identity 时延长到 handler Promise；
   * 冻结期允许无 identity 的只读 handler 继续运行，真正写入仍由 runWrite 拦截。
   */
  async retainCurrentOperation<T>(work: () => Promise<T>): Promise<T> {
    const current = this.contextStorage.getStore()
    if (!this.isUsableNormalIdentity(current)) {
      return work()
    }
    current.references += 1
    try {
      return await work()
    } finally {
      this.releaseIdentityReference(current)
    }
  }

  /** 所有数据库写入口统一调用；有效旧 operation 在冻结后仍可完成。 */
  async runWrite<T>(work: () => Promise<T>): Promise<T> {
    const current = this.contextStorage.getStore()
    if (this.isUsableNormalIdentity(current) || this.isUsableGovernanceIdentity(current)) {
      return work()
    }
    return this.runOperation(work)
  }

  /**
   * QueryRunner 根事务使用独立 identity。它不依赖 HTTP 请求是否结束，
   * freeze 必须一直等待到 commit/rollback/release 才能完成。
   */
  acquireIndependentOperation(): DatabaseOperationLease {
    const parent = this.contextStorage.getStore()
    if (this.mode !== 'open' && !this.isUsableNormalIdentity(parent) && !this.isUsableGovernanceIdentity(parent)) {
      throw this.createAdmissionError()
    }

    const kind: OperationKind = this.isUsableGovernanceIdentity(parent) ? 'governance' : 'normal'
    const identity = kind === 'normal'
      ? this.createCountedIdentity(kind)
      : {
          id: Symbol('database-governance-transaction'),
          kind,
          valid: true,
          references: 1,
          counted: false,
          outstandingIndependentLeases: 0,
        }
    if (kind === 'governance' && parent) {
      parent.outstandingIndependentLeases += 1
    }
    return new OperationLease(
      identity,
      (releasedIdentity) => {
        this.releaseIdentityReference(releasedIdentity)
        if (kind === 'governance' && parent) {
          parent.outstandingIndependentLeases = Math.max(0, parent.outstandingIndependentLeases - 1)
        }
      },
      kind === 'governance' ? parent : undefined,
    )
  }

  assertLeaseActive(lease: DatabaseOperationLease): void {
    if (!lease.active) {
      throw this.createAdmissionError()
    }
  }

  /** 同步关闭新准入并暂停所有已注册 worker；返回显式持有的冻结控制句柄。 */
  freeze(options: DatabaseFreezeOptions = {}): DatabaseFreezeControl {
    if (this.mode === 'shutdown') {
      throw new Error('数据库操作 gate 已进入 shutdown，不能恢复为维护冻结')
    }
    if (this.freezeControl?.active) {
      if (options.excludeCurrentOperation) {
        this.excludeCurrentOperationFromDrain()
      }
      return this.freezeControl
    }

    this.mode = 'frozen'
    const controlId = Symbol('database-freeze-control')
    const control = new FreezeControl(this, controlId)
    this.freezeControlId = controlId
    this.freezeControl = control
    if (options.excludeCurrentOperation) {
      this.excludeCurrentOperationFromDrain()
    }
    for (const controller of this.workerControllers) {
      controller.pause()
    }
    return control
  }

  /** 进程启动发现持久维护 marker 时，在任何数据库写入前恢复 fail-closed 冻结。 */
  restoreFrozen(): DatabaseFreezeControl {
    return this.freeze({ excludeCurrentOperation: false })
  }

  registerWorker(controller: DatabaseWorkerController): () => void {
    this.workerControllers.add(controller)
    if (this.mode !== 'open') {
      controller.pause()
    }
    return () => {
      this.workerControllers.delete(controller)
    }
  }

  async shutdownAndDrain(timeoutMs: number, excludeCurrentOperation = true): Promise<void> {
    if (this.mode === 'open') {
      this.mode = 'shutdown'
      this.freezeControlId = null
      this.freezeControl = null
      if (excludeCurrentOperation) {
        this.excludeCurrentOperationFromDrain()
      }
      for (const controller of this.workerControllers) {
        controller.pause()
      }
    } else if (this.mode === 'frozen') {
      this.mode = 'shutdown'
      this.freezeControlId = null
      this.freezeControl = null
      if (excludeCurrentOperation) {
        this.excludeCurrentOperationFromDrain()
      }
    }
    await this.waitForDrain(timeoutMs)
  }

  isFreezeControlActive(controlId: symbol): boolean {
    return this.mode === 'frozen' && this.freezeControlId === controlId
  }

  async drain(controlId: symbol, timeoutMs: number): Promise<void> {
    if (!this.isFreezeControlActive(controlId)) {
      throw new Error('数据库冻结控制句柄已失效')
    }
    await this.waitForDrain(timeoutMs)
  }

  async runGovernance<T>(controlId: symbol, work: () => Promise<T>): Promise<T> {
    if (!this.isFreezeControlActive(controlId)) {
      throw new Error('数据库冻结控制句柄已失效')
    }
    const identity: OperationIdentity = {
      id: Symbol('database-governance-operation'),
      kind: 'governance',
      valid: true,
      references: 1,
      counted: true,
      outstandingIndependentLeases: 0,
    }
    // 治理写发生在首次 freeze.drain 之后，但 shutdown 或后续 drain 仍必须等待它完成。
    this.activeOperations.add(identity)
    return this.contextStorage.run(identity, async () => {
      try {
        return await work()
      } finally {
        const outstandingIndependentLeases = identity.outstandingIndependentLeases
        // callback 是能力边界；即使内部旧短租约漏 release，也必须在此强制失效并退出排空计数。
        identity.references = 1
        this.releaseIdentityReference(identity)
        if (outstandingIndependentLeases > 0) {
          throw new Error(
            `治理 callback 结束时仍有 ${outstandingIndependentLeases} 个显式事务未结束`,
          )
        }
      }
    })
  }

  releaseFreeze(controlId: symbol): void {
    if (!this.isFreezeControlActive(controlId)) {
      return
    }
    this.freezeControlId = null
    this.freezeControl = null
    this.mode = 'open'
    for (const controller of this.workerControllers) {
      controller.resume()
    }
  }

  private createCountedIdentity(kind: 'normal'): OperationIdentity {
    const identity: OperationIdentity = {
      id: Symbol('database-operation'),
      kind,
      valid: true,
      references: 1,
      counted: true,
      outstandingIndependentLeases: 0,
    }
    this.activeOperations.add(identity)
    return identity
  }

  private releaseIdentityReference(identity: OperationIdentity): void {
    if (identity.references <= 0) {
      return
    }
    identity.references -= 1
    if (identity.references > 0) {
      return
    }
    identity.valid = false
    if (identity.counted) {
      identity.counted = false
      this.activeOperations.delete(identity)
      this.notifyDrainWaitersIfIdle()
    }
  }

  private excludeCurrentOperationFromDrain(): void {
    const current = this.contextStorage.getStore()
    if (!this.isUsableNormalIdentity(current)) {
      return
    }
    current.valid = false
    current.references = 0
    if (current.counted) {
      current.counted = false
      this.activeOperations.delete(current)
      this.notifyDrainWaitersIfIdle()
    }
  }

  private async waitForDrain(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('数据库操作排空超时必须为正整数')
    }

    let cancelActiveWait: () => void = () => undefined
    const activeWait = this.activeOperations.size === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const onDrained = () => resolve()
          this.drainWaiters.add(onDrained)
          cancelActiveWait = () => {
            this.drainWaiters.delete(onDrained)
          }
        })
    const workerWait = Promise.all(
      [...this.workerControllers].map((controller) => controller.drain()),
    ).then(() => undefined)

    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.all([activeWait, workerWait]).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`等待数据库操作排空超时（${Math.floor(timeoutMs)}ms）`))
          }, timeoutMs)
          timeout.unref?.()
        }),
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
      cancelActiveWait()
    }
  }

  private notifyDrainWaitersIfIdle(): void {
    if (this.activeOperations.size !== 0) {
      return
    }
    for (const resolve of this.drainWaiters) {
      resolve()
    }
    this.drainWaiters.clear()
  }

  private isUsableNormalIdentity(
    identity: OperationIdentity | undefined,
  ): identity is OperationIdentity & { kind: 'normal' } {
    return Boolean(identity?.valid && identity.kind === 'normal' && identity.references > 0)
  }

  private isUsableGovernanceIdentity(
    identity: OperationIdentity | undefined,
  ): identity is OperationIdentity & { kind: 'governance' } {
    return Boolean(identity?.valid && identity.kind === 'governance')
  }

  private assertAdmissionOpen(): void {
    if (this.mode !== 'open') {
      throw this.createAdmissionError()
    }
  }

  private createAdmissionError(): DatabaseWriteFrozenError {
    return new DatabaseWriteFrozenError(this.mode === 'shutdown' ? 'shutdown' : 'maintenance_read_only')
  }
}

export const databaseOperationGate = new DatabaseOperationGate()
