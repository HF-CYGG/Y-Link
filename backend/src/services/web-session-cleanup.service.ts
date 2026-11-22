/**
 * 定期回收管理端及客户端已超过绝对有效期的 Web 会话。
 * 每批间可暂停领取，停机或数据库维护等待当前事务完成后排空。
 */
import type { EntityTarget } from 'typeorm'
import { runInTransaction } from '../config/transaction-runner.js'
import { databaseOperationGate, DatabaseWriteFrozenError } from '../database/operation-gate.js'
import { ClientUserSession } from '../entities/client-user-session.entity.js'
import { SysUserSession } from '../entities/sys-user-session.entity.js'
import { toSafeErrorLog } from '../utils/safe-error-log.js'

const CLEANUP_INTERVAL_MS = 10 * 60_000
const CLEANUP_BATCH_SIZE = 200
const MAX_BATCHES_PER_TABLE = 8

type SessionExpiry = Pick<SysUserSession, 'id' | 'expiresAt'>
const SESSION_TABLES = [SysUserSession, ClientUserSession] as const
let desired = false
let timer: ReturnType<typeof setInterval> | undefined
let running: Promise<void> | undefined

function cleanupExpiredBatch(entity: EntityTarget<SessionExpiry>, cutoff: Date): Promise<number> {
  return databaseOperationGate.runOperation(() => runInTransaction(async (manager) => {
    const repository = manager.getRepository(entity)
    const sqlite = manager.connection.options.type === 'sqlite'
    const idTextType = sqlite ? 'TEXT' : 'CHAR'
    const idNumberType = sqlite ? 'INTEGER' : 'UNSIGNED'
    const expired = await repository.createQueryBuilder('session')
      .select(`CAST(session.id AS ${idTextType})`, 'id')
      .where('session.expiresAt < :cutoff', { cutoff })
      .orderBy('session.expiresAt', 'ASC')
      .addOrderBy('session.id', 'ASC')
      .limit(CLEANUP_BATCH_SIZE)
      .getRawMany<{ id: string }>()
    if (expired.length) {
      // 主键始终按文本传递，由数据库精确转回整数，并在删除时重验有效期。
      const parameters = Object.fromEntries(expired.map(({ id }, index) => [`id${index}`, id]))
      const idSql = Object.keys(parameters).map((key) => `CAST(:${key} AS ${idNumberType})`).join(', ')
      await repository.createQueryBuilder().delete()
        .where(`id IN (${idSql})`, parameters)
        .andWhere('expires_at < :cutoff', { cutoff })
        .execute()
    }
    return expired.length
  }))
}

async function runCleanupCycle(): Promise<void> {
  const cutoff = new Date()
  let pending: readonly EntityTarget<SessionExpiry>[] = SESSION_TABLES
  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE && pending.length; batch += 1) {
    const next: EntityTarget<SessionExpiry>[] = []
    for (const entity of pending) {
      if (!timer || databaseOperationGate.isFrozen()) return
      if (await cleanupExpiredBatch(entity, cutoff) === CLEANUP_BATCH_SIZE) next.push(entity)
    }
    pending = next
  }
}

function armCleanupTimer(): void {
  if (timer || databaseOperationGate.isFrozen()) return
  timer = setInterval(() => {
    if (running) return
    running = runCleanupCycle().catch((error: unknown) => {
      if (!(error instanceof DatabaseWriteFrozenError)) {
        console.warn('[web-session-cleanup] 过期会话回收失败', toSafeErrorLog(error))
      }
    }).finally(() => { running = undefined })
  }, CLEANUP_INTERVAL_MS)
  timer.unref()
}

function pauseCleanupTimer(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

async function drainCleanup(): Promise<void> {
  await running
}

databaseOperationGate.registerWorker({
  name: 'web-session-cleanup',
  pause: pauseCleanupTimer,
  drain: drainCleanup,
  resume: () => { if (desired) armCleanupTimer() },
})

export function startWebSessionCleanup(): void {
  desired = true
  armCleanupTimer()
}

export async function stopWebSessionCleanup(): Promise<void> {
  desired = false
  pauseCleanupTimer()
  await drainCleanup()
}
