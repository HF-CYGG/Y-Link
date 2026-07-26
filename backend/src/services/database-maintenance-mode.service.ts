/**
 * 模块说明：backend/src/services/database-maintenance-mode.service.ts
 * 文件职责：持久化数据库迁移期间的全局只读维护状态，并协调在途写请求排空。
 * 实现逻辑：
 * - 维护状态先在内存生效，再通过同目录临时文件原子替换持久化；
 * - 中间件为普通写请求登记在途计数，迁移任务冻结新写入后等待已有写请求结束；
 * - 对外仅公开只读标志、阶段与统一提示，不公开任务 ID、文件路径或数据库连接。
 * 维护说明：
 * - 紧急回退是维护期唯一允许的治理写操作，新增例外必须经过权限与安全复核；
 * - 维护结束必须删除状态文件，避免重启后客户端持续显示过期横幅。
 */

import fs from 'node:fs'
import path from 'node:path'
import { appDataPaths } from '../config/app-data-paths.js'

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

interface DatabaseMaintenanceModeServiceOptions {
  stateFilePath?: string
  drainTimeoutMs?: number
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
function normalizeRequestPath(requestPath: string): string {
  return requestPath.split('?')[0]?.replace(/\/+$/, '') || '/'
}

export function shouldAllowWriteDuringDatabaseMaintenance(method: string, requestPath: string): boolean {
  const normalizedMethod = method.toUpperCase()
  if (SAFE_METHODS.has(normalizedMethod)) {
    return true
  }

  const normalizedPath = normalizeRequestPath(requestPath)
  if (normalizedPath === '/api/data-maintenance/db-migration/rollback' && normalizedMethod === 'POST') {
    return true
  }
  return normalizedPath === '/api/data-maintenance/db-migration/runtime-override' && normalizedMethod === 'DELETE'
}

function readPersistedState(stateFilePath: string): PersistedDatabaseMaintenanceState | null {
  if (!fs.existsSync(stateFilePath)) {
    return null
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as Partial<PersistedDatabaseMaintenanceState>
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
  } catch {
    return null
  }
}

function writeStateAtomically(stateFilePath: string, state: PersistedDatabaseMaintenanceState): void {
  const directory = path.dirname(stateFilePath)
  fs.mkdirSync(directory, { recursive: true })
  const tempFilePath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempFilePath, JSON.stringify(state, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    fs.renameSync(tempFilePath, stateFilePath)
  } catch {
    if (fs.existsSync(stateFilePath)) {
      fs.rmSync(stateFilePath, { force: true })
    }
    fs.renameSync(tempFilePath, stateFilePath)
  }
  try {
    fs.chmodSync(stateFilePath, 0o600)
  } catch {
    // Windows 不保证支持 POSIX 权限位；onebox/Linux 会正常收紧为进程用户可读写。
  }
}

export class DatabaseMaintenanceModeService {
  private readonly stateFilePath: string
  private readonly drainTimeoutMs: number
  private state: PersistedDatabaseMaintenanceState | null
  private inFlightWrites = 0
  private drainWaiters = new Set<() => void>()

  constructor(options: DatabaseMaintenanceModeServiceOptions = {}) {
    this.stateFilePath = options.stateFilePath ?? appDataPaths.maintenanceStateFile
    this.drainTimeoutMs = options.drainTimeoutMs ?? 30_000
    this.state = readPersistedState(this.stateFilePath)
  }

  isReadOnly(): boolean {
    return this.state?.readOnly === true
  }

  getActiveTaskId(): string | null {
    return this.state?.taskId ?? null
  }

  getPublicState(): DatabaseMaintenancePublicState {
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
   * 同步获取数据库活动租约。检查维护状态与递增计数之间不包含 await，
   * 因而 beginReadOnly 要么先冻结并令本次获取失败，要么等待本租约释放。
   */
  registerInFlightWrite(): (() => void) | null {
    if (this.state?.readOnly === true) {
      return null
    }
    this.inFlightWrites += 1
    let finished = false
    return () => {
      if (finished) {
        return
      }
      finished = true
      this.inFlightWrites = Math.max(0, this.inFlightWrites - 1)
      if (this.inFlightWrites === 0) {
        for (const resolve of this.drainWaiters) {
          resolve()
        }
        this.drainWaiters.clear()
      }
    }
  }

  async beginReadOnly(input: { taskId: string; phase: string }): Promise<void> {
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
    try {
      this.state = nextState
      writeStateAtomically(this.stateFilePath, nextState)
      await this.waitForInFlightWrites()
    } catch (error) {
      this.state = previousState
      try {
        if (previousState) {
          writeStateAtomically(this.stateFilePath, previousState)
        } else if (fs.existsSync(this.stateFilePath)) {
          fs.rmSync(this.stateFilePath, { force: true })
        }
      } catch (restoreError) {
        console.error('[database-maintenance] 回滚只读维护状态文件失败', restoreError)
      }
      throw error
    }
  }

  async updatePhase(phase: string): Promise<void> {
    if (!this.state) {
      throw new Error('当前未处于数据库只读维护状态')
    }
    this.state = {
      ...this.state,
      phase,
      updatedAt: new Date().toISOString(),
    }
    writeStateAtomically(this.stateFilePath, this.state)
  }

  async finishReadOnly(expectedTaskId?: string): Promise<void> {
    if (expectedTaskId && this.state?.taskId !== expectedTaskId) {
      return
    }
    try {
      if (fs.existsSync(this.stateFilePath)) {
        fs.rmSync(this.stateFilePath, { force: true })
      }
      this.state = null
    } catch (error) {
      console.error('[database-maintenance] 删除只读维护状态文件失败', error)
    }
  }

  private async waitForInFlightWrites(): Promise<void> {
    if (this.inFlightWrites === 0) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.drainWaiters.delete(onDrained)
        reject(new Error(`等待在途写请求排空超时（${this.drainTimeoutMs}ms）`))
      }, this.drainTimeoutMs)
      timer.unref?.()

      const onDrained = () => {
        clearTimeout(timer)
        resolve()
      }
      this.drainWaiters.add(onDrained)
    })
  }
}

export const databaseMaintenanceModeService = new DatabaseMaintenanceModeService()
