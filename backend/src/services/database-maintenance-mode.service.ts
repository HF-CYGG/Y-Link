/**
 * 模块说明：backend/src/services/database-maintenance-mode.service.ts
 * 文件职责：持久化数据库迁移期间的全局只读维护状态，并持有 operation gate 冻结控制句柄。
 * 实现逻辑：
 * - 维护状态先在内存生效，再通过同目录临时文件原子替换持久化；
 * - 中间件与 worker 通过 ALS operation identity 登记，冻结后等待已准入 Promise 与显式事务结束；
 * - 治理写能力仅在 taskId 匹配的 callback 内生效，callback 结束即失效；
 * - 对外仅公开只读标志、阶段与统一提示，不公开任务 ID、文件路径或数据库连接。
 * 维护说明：
 * - 紧急回退是维护期唯一允许的治理写操作，新增例外必须经过权限与安全复核；
 * - 维护结束必须删除状态文件，避免重启后客户端持续显示过期横幅。
 */

import { appDataPaths } from '../config/app-data-paths.js'
import {
  databaseOperationGate,
  type DatabaseFreezeControl,
  type DatabaseOperationGate,
} from '../database/operation-gate.js'
import {
  inspectControlFile,
  removeControlFile,
  writeControlFile,
} from '../runtime/durable-control-file.js'

export const MAINTENANCE_READ_ONLY_CODE = 50301
export const MAINTENANCE_READ_ONLY_MESSAGE = '服务器维护中，当前为只读状态，暂时无法提交操作'

export interface DatabaseMaintenancePublicState {
  readOnly: boolean
  phase: string | null
  message: string | null
}

interface PersistedDatabaseMaintenanceState {
  version: 1
  readOnly: true
  phase: string
  message: string
  taskId: string
  startedAt: string
  updatedAt: string
}

export interface DatabaseMaintenanceModeServiceOptions {
  stateFilePath?: string
  drainTimeoutMs?: number
  operationGate?: DatabaseOperationGate
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const DATABASE_MUTATING_AUTH_PATHS = new Set([
  '/api/auth/captcha',
  '/api/client-auth/captcha',
  '/api/v1/mobile-auth/captcha',
  '/api/client-auth/capabilities',
])
function normalizeRequestPath(requestPath: string): string {
  return requestPath.split('?')[0]?.replace(/\/+$/, '') || '/'
}

export function shouldAllowWriteDuringDatabaseMaintenance(method: string, requestPath: string): boolean {
  const normalizedMethod = method.toUpperCase()
  const normalizedPath = normalizeRequestPath(requestPath)
  if (SAFE_METHODS.has(normalizedMethod)) {
    // 这些认证读取入口会经过数据库持久化限流或验证码风控，语义上属于写请求。
    // 维护期必须在进入限流器前阻断，保证 SQLite 快照窗口没有未登记写入。
    return !DATABASE_MUTATING_AUTH_PATHS.has(normalizedPath)
  }

  if (normalizedPath === '/api/data-maintenance/db-migration/rollback' && normalizedMethod === 'POST') {
    return true
  }
  return normalizedPath === '/api/data-maintenance/db-migration/runtime-override' && normalizedMethod === 'DELETE'
}

function validatePersistedState(value: unknown): PersistedDatabaseMaintenanceState | null {
  if (!value || typeof value !== 'object') return null
  const parsed = value as Partial<PersistedDatabaseMaintenanceState>
  if (
    parsed.version !== 1
    || parsed.readOnly !== true
    || typeof parsed.phase !== 'string'
    || typeof parsed.message !== 'string'
    || typeof parsed.taskId !== 'string'
    || typeof parsed.startedAt !== 'string'
    || typeof parsed.updatedAt !== 'string'
  ) {
    return null
  }
  return parsed as PersistedDatabaseMaintenanceState
}

export class DatabaseMaintenanceModeService {
  private readonly stateFilePath: string
  private readonly drainTimeoutMs: number
  private readonly operationGate: DatabaseOperationGate
  private state: PersistedDatabaseMaintenanceState | null
  private corruptedState = false
  private freezeControl: DatabaseFreezeControl | null = null

  constructor(options: DatabaseMaintenanceModeServiceOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? appDataPaths.maintenanceStateFile
    this.drainTimeoutMs = options.drainTimeoutMs ?? 30_000
    this.operationGate = options.operationGate ?? databaseOperationGate
    const inspection = inspectControlFile(this.stateFilePath, validatePersistedState)
    this.state = inspection.state === 'healthy' ? inspection.value : null
    this.corruptedState = inspection.state === 'corrupted'
    if (this.state || this.corruptedState) {
      this.freezeControl = this.operationGate.restoreFrozen()
    }
  }

  isReadOnly(): boolean {
    return this.corruptedState || this.state?.readOnly === true
  }

  getActiveTaskId(): string | null {
    return this.state?.taskId ?? null
  }

  getPublicState(): DatabaseMaintenancePublicState {
    if (this.corruptedState) {
      return {
        readOnly: true,
        phase: 'control_state_corrupted',
        message: MAINTENANCE_READ_ONLY_MESSAGE,
      }
    }
    if (!this.state) {
      return {
        readOnly: false,
        phase: null,
        message: null,
      }
    }
    return {
      readOnly: true,
      phase: this.state.phase,
      message: this.state.message,
    }
  }

  /**
   * 同步获取数据库 operation 租约。准入检查与 identity 登记之间不包含 await，
   * 因而 beginReadOnly 要么先冻结并令本次获取失败，要么等待本租约覆盖的完整 Promise。
   */
  registerInFlightWrite(): (() => void) | null {
    const lease = this.operationGate.enterOperation()
    return lease ? () => lease.release() : null
  }

  async beginReadOnly(input: { taskId: string; phase: string }): Promise<void> {
    if (this.corruptedState) {
      throw new Error('数据库维护状态文件已损坏，必须先完成受控恢复')
    }
    if (this.state && this.state.taskId !== input.taskId) {
      throw new Error('已有数据库迁移任务占用只读维护锁')
    }

    const previousState = this.state
    const timestamp = new Date().toISOString()
    const nextState: PersistedDatabaseMaintenanceState = {
      version: 1,
      readOnly: true,
      phase: input.phase,
      message: MAINTENANCE_READ_ONLY_MESSAGE,
      taskId: input.taskId,
      startedAt: previousState?.startedAt ?? timestamp,
      updatedAt: timestamp,
    }
    const hadPreviousFreeze = Boolean(this.freezeControl?.active)
    const freezeControl = this.operationGate.freeze({ excludeCurrentOperation: true })
    this.freezeControl = freezeControl
    try {
      this.state = nextState
      writeControlFile(this.stateFilePath, nextState)
      await freezeControl.drain(this.drainTimeoutMs)
    } catch (error) {
      this.state = previousState
      try {
        if (previousState) {
          writeControlFile(this.stateFilePath, previousState)
        } else {
          removeControlFile(this.stateFilePath)
        }
      } catch (restoreError) {
        this.corruptedState = true
        console.error('[database-maintenance] 回滚只读维护状态文件失败', restoreError)
      }
      if (!hadPreviousFreeze && !this.corruptedState) {
        freezeControl.release()
        this.freezeControl = null
      }
      throw error
    }
  }

  async runGovernance<T>(expectedTaskId: string, work: () => Promise<T>): Promise<T> {
    if (this.corruptedState) {
      throw new Error('数据库维护状态文件已损坏，不能授予治理写能力')
    }
    if (!this.state || this.state.taskId !== expectedTaskId) {
      throw new Error('治理任务与当前只读维护锁不匹配')
    }
    if (!this.freezeControl?.active) {
      throw new Error('数据库只读维护 gate 未持有有效冻结控制句柄')
    }
    return this.freezeControl.runGovernance(work)
  }

  async updatePhase(phase: string): Promise<void> {
    if (this.corruptedState || !this.state) {
      throw new Error('当前未处于数据库只读维护状态')
    }
    const nextState = {
      ...this.state,
      phase,
      updatedAt: new Date().toISOString(),
    }
    writeControlFile(this.stateFilePath, nextState)
    this.state = nextState
  }

  async finishReadOnly(expectedTaskId?: string): Promise<void> {
    if (this.corruptedState) {
      throw new Error('数据库维护状态文件已损坏，不能按正常流程解除只读状态')
    }
    if (expectedTaskId && this.state?.taskId !== expectedTaskId) {
      return
    }
    removeControlFile(this.stateFilePath)
    this.state = null
    this.freezeControl?.release()
    this.freezeControl = null
  }

  async shutdownAndDrain(): Promise<void> {
    await this.operationGate.shutdownAndDrain(this.drainTimeoutMs, true)
  }
}

export const databaseMaintenanceModeService = new DatabaseMaintenanceModeService()
