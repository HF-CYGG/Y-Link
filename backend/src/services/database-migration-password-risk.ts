/** 冻结阶段的密码复核计数与审计存入控制目录，保持源数据库和快照只读。 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { appDataPaths } from '../config/app-data-paths.js'
import { appendControlAudit, inspectControlFile, writeControlFile } from '../runtime/durable-control-file.js'
import { BizError } from '../utils/errors.js'
import type { PersistentFailureState } from './persistent-risk-state.service.js'

const MAX_BUCKETS = 1024
const failureFile = path.join(appDataPaths.runtimeDir, 'database-migration-password-risk.json')
const failureAudit = path.join(appDataPaths.runtimeDir, 'database-rescue', 'events.jsonl')
const bucket = z.object({
  count: z.number().int().nonnegative(), firstFailedAt: z.number().int().positive(),
  lastFailedAt: z.number().int().positive(), lockedUntil: z.number().int().nonnegative(),
})
const schema = z.object({ version: z.literal(1), buckets: z.record(z.string().regex(/^[a-f0-9]{64}$/), bucket) })

const digest = (key: string) => createHash('sha256').update(key).digest('hex')

function readBuckets(now: number, resetWindowMs: number): Record<string, PersistentFailureState> {
  const control = inspectControlFile(failureFile, value => {
    const parsed = schema.safeParse(value)
    return parsed.success && Object.keys(parsed.data.buckets).length <= MAX_BUCKETS ? parsed.data.buckets : null
  })
  if (control.state === 'corrupted') throw new BizError('迁移身份复核状态不可用，请检查服务端控制目录', 503)
  if (control.state === 'absent') return {}
  return Object.fromEntries(Object.entries(control.value).filter(([, state]) =>
    state.lockedUntil > now || now - state.lastFailedAt < resetWindowMs,
  ))
}

export function readMigrationPasswordFailures(keys: string[], now: number, resetWindowMs: number) {
  const buckets = readBuckets(now, resetWindowMs)
  return keys.map(key => buckets[digest(key)])
}

export function recordMigrationPasswordFailure(
  entries: { key: string; persisted: PersistentFailureState | null }[],
  policy: { resetWindowMs: number; threshold: number; lockMs: number },
  purpose?: string,
): PersistentFailureState[] {
  const now = Date.now()
  // 一旦接管某个键，文件内即为该键完整有效状态。常规计数与登录成功清理共用串行入口。
  const buckets = readBuckets(now, policy.resetWindowMs)
  const states = entries.map(({ key, persisted }) => {
    const hash = digest(key)
    const previous = buckets[hash] ?? persisted
    const count = (previous?.count ?? 0) + 1
    buckets[hash] = {
      count,
      firstFailedAt: previous?.count ? previous.firstFailedAt : now,
      lastFailedAt: now,
      lockedUntil: count >= policy.threshold ? now + policy.lockMs : 0,
    }
    return buckets[hash]
  })
  if (Object.keys(buckets).length > MAX_BUCKETS) throw new BizError('迁移身份复核请求过于频繁，请稍后重试', 429)
  writeControlFile(failureFile, { version: 1, buckets })
  if (purpose) appendControlAudit(failureAudit, { event: 'migration_password_mismatch', purpose, accountDigest: digest(entries[1].key) })
  return states
}

export function clearMigrationPasswordFailures(keys: string[], now: number, resetWindowMs: number): void {
  const buckets = readBuckets(now, resetWindowMs)
  const changed = keys.map(digest).filter(key => buckets[key]?.count > 0)
  if (!changed.length) return
  // 保留短期已清零状态，避免 Redis 重连后重新读到接管前的旧桶；过期后恢复常规存储。
  for (const key of changed) buckets[key] = { count: 0, firstFailedAt: now, lastFailedAt: now, lockedUntil: 0 }
  writeControlFile(failureFile, { version: 1, buckets })
}
