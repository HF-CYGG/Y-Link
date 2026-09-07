/**
 * 数据库外救援控制面：任务专用凭证、源文件身份、一次性操作与多文件恢复日志。
 * 只读写固定控制目录；不接受 SQL、shell、路径或数据库连接参数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { appDataPaths } from '../config/app-data-paths.js'
import { inspectDatabaseRuntimeOverride, writeDatabaseRuntimeOverride } from '../config/database-runtime-override.js'
import { appendControlAudit, inspectControlFile, removeControlFile, writeControlFile } from './durable-control-file.js'
import { inspectSqliteForRescue, type SqliteRescueDigest } from './sqlite-rescue-inspection.js'
import { validateCutoverControl, validateMigrationLock, validateMaintenanceControl } from './database-control-validation.js'

const taskIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const iso = z.string().datetime()
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const identitySchema = z.object({ filePath: z.string().min(1).max(1000), dev: z.string(), ino: z.string(), birthMs: z.number() })
const digestSchema = z.object({ sha256: hashSchema, auditSequence: z.string().regex(/^\d+$/).optional(), auditSequencePresent: z.boolean().optional(), tables: z.array(z.object({ name: z.string(), count: z.number().int().nonnegative(), sha256: hashSchema })) })
const bindingSchema = z.object({
  version: z.literal(1), taskId: taskIdSchema, source: identitySchema,
  credentialFormat: z.literal('separate-v1').optional(),
  credentialHash: hashSchema.optional(), expiresAt: iso.optional(), issuedAt: iso.optional(),
  snapshot: z.object({ filePath: z.string(), fileSha256: hashSchema, digest: digestSchema }).optional(),
  nonce: z.object({ hash: hashSchema, expiresAt: iso }).optional(),
})
const credentialSchema = z.object({ version: z.literal(1), taskId: taskIdSchema, credentialHash: hashSchema, issuedAt: iso, expiresAt: iso })
const intentSchema = z.object({
  version: z.literal(1), taskId: taskIdSchema, operationId: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
  phase: z.enum(['PREPARED', 'RESTART_READY', 'VERIFYING', 'FINALIZING', 'COMPLETED']),
  source: identitySchema, sourceDigest: digestSchema,
  createdAt: iso, updatedAt: iso, sqliteRestartAttempts: z.number().int().min(0).max(2),
})
type Binding = z.infer<typeof bindingSchema>
export type DatabaseRecoveryIntent = z.infer<typeof intentSchema>
type Task = Record<string, unknown> & { id: string; status: string; source: { sqlitePath: string }; mode: 'automatic' }
const rescueDir = path.join(appDataPaths.runtimeDir, 'database-rescue')
export const recoveryIntentPath = path.join(appDataPaths.runtimeDir, 'database-recovery-intent.json')
const auditPath = path.join(rescueDir, 'events.jsonl')
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const parse = <T>(schema: z.ZodType<T>) => (value: unknown): T | null => { const result = schema.safeParse(value); return result.success ? result.data : null }
const bindingPath = (taskId: string) => path.join(rescueDir, `${taskIdSchema.parse(taskId)}.json`)
const credentialPath = (taskId: string) => path.join(rescueDir, `${taskIdSchema.parse(taskId)}.credential.json`)
const taskPath = (taskId: string) => path.join(appDataPaths.migrationTaskDir, `${taskIdSchema.parse(taskId)}.json`)
const now = () => new Date().toISOString()
let quiesceRuntime: ((taskId: string) => Promise<void>) | null = null
export function registerDatabaseRescueQuiesce(handler: (taskId: string) => Promise<void>): void { quiesceRuntime = handler }
const equalHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

export class RescueControlError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code) }
}
function fail(code: string, status = 409): never { throw new RescueControlError(code, status) }
function readBinding(taskId: string): Binding {
  const result = inspectControlFile(bindingPath(taskId), parse(bindingSchema))
  return result.state === 'healthy' && result.value.taskId === taskId ? result.value : fail('RESCUE_BINDING_UNAVAILABLE')
}
function readTask(taskId: string): Task {
  const result = inspectControlFile(taskPath(taskId), (value): Task | null => {
    const record = value as Partial<Task> | null
    return record?.id === taskId && record.mode === 'automatic'
      && ['queued', 'running', 'restart_pending', 'verifying', 'succeeded', 'failed', 'rolled_back'].includes(String(record.status))
      && typeof record.source?.sqlitePath === 'string' ? record as Task : null
  })
  return result.state === 'healthy' ? result.value : fail('RESCUE_TASK_UNAVAILABLE')
}
function sourceIdentity(filePath: string): Binding['source'] {
  try {
    const resolved = fs.realpathSync(filePath)
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size < 100) return fail('RESCUE_SOURCE_UNAVAILABLE')
    return { filePath: resolved, dev: String(stat.dev), ino: String(stat.ino), birthMs: stat.birthtimeMs }
  } catch { return fail('RESCUE_SOURCE_UNAVAILABLE') }
}
function assertIdentity(source: Binding['source']): void {
  const actual = sourceIdentity(source.filePath)
  if (actual.filePath !== source.filePath || actual.dev !== source.dev || actual.ino !== source.ino || actual.birthMs !== source.birthMs) fail('RESCUE_SOURCE_IDENTITY_MISMATCH')
}
function readOwnedControl(filePath: string, taskId: string): Record<string, unknown> {
  const validate = filePath === appDataPaths.migrationLockFile ? validateMigrationLock
    : filePath === appDataPaths.maintenanceStateFile ? validateMaintenanceControl : validateCutoverControl
  const state = inspectControlFile(filePath, validate)
  if (state.state !== 'healthy' || state.value.taskId !== taskId) return fail('RESCUE_CONTROL_OWNERSHIP_UNPROVEN')
  return state.value
}
export function inspectRecoveryIntent() { return inspectControlFile(recoveryIntentPath, parse(intentSchema)) }
export function hasPendingRecoveryIntent(): boolean {
  const state = inspectRecoveryIntent()
  return state.state === 'corrupted' || (state.state === 'healthy' && state.value.phase !== 'COMPLETED')
}

/** 由正常管理员已鉴权/CSRF 路由或容器本地 CLI 调用；明文只返回，不落任务记录。 */
export function issueDatabaseRescueCredential(taskId: string): { taskId: string; credential: string; expiresAt: string } {
  const task = readTask(taskId)
  if (['succeeded', 'rolled_back'].includes(task.status)) fail('RESCUE_WINDOW_CLOSED')
  const previous = inspectControlFile(bindingPath(taskId), parse(bindingSchema))
  if (previous.state === 'corrupted') fail('RESCUE_BINDING_CORRUPTED')
  if (previous.state === 'healthy' && previous.value.taskId !== taskId) fail('RESCUE_BINDING_CORRUPTED')
  const source = previous.state === 'healthy' ? previous.value.source : sourceIdentity(path.resolve(task.source.sqlitePath))
  assertIdentity(source)
  const credential = `${taskId}.${randomBytes(32).toString('base64url')}`
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  if (previous.state !== 'healthy' || previous.value.credentialFormat !== 'separate-v1') {
    writeControlFile(bindingPath(taskId), {
      ...(previous.state === 'healthy' ? previous.value : {}), version: 1, taskId, source,
      credentialFormat: 'separate-v1', credentialHash: undefined, issuedAt: undefined, expiresAt: undefined, nonce: undefined,
    } satisfies Binding)
  }
  // 凭证有独立权威文件，快照/nonce 的异步更新不能写回旧散列而撤销一次轮换。
  writeControlFile(credentialPath(taskId), { version: 1, taskId, credentialHash: digest(credential), issuedAt: now(), expiresAt })
  appendControlAudit(auditPath, { taskId, event: 'credential_rotated' })
  return { taskId, credential, expiresAt }
}

export function authenticateDatabaseRescueCredential(credential: string): string {
  const match = /^([a-zA-Z0-9_-]{1,100})\.([a-zA-Z0-9_-]{43})$/.exec(credential)
  if (!match) return fail('RESCUE_UNAUTHORIZED', 401)
  try {
    const binding = readBinding(match[1]!)
    const current = inspectControlFile(credentialPath(binding.taskId), parse(credentialSchema))
    const authority = binding.credentialFormat === 'separate-v1'
      ? current.state === 'healthy' && current.value.taskId === binding.taskId ? current.value : null
      : current.state === 'absent' ? binding : current.state === 'healthy' && current.value.taskId === binding.taskId ? current.value : null
    if (!authority?.expiresAt || !authority.credentialHash || Date.parse(authority.expiresAt) <= Date.now()
      || !equalHash(digest(credential), authority.credentialHash)) return fail('RESCUE_UNAUTHORIZED', 401)
    return binding.taskId
  } catch { return fail('RESCUE_UNAUTHORIZED', 401) }
}

/** 冻结且完整排空后，从已生成的不可变快照取全表摘要，禁止在创建任务时采集活动数据。 */
export async function bindDatabaseRescueSnapshot(taskId: string, snapshotPath: string): Promise<void> {
  const binding = readBinding(taskId)
  const relative = path.relative(appDataPaths.migrationSnapshotDir, snapshotPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('RESCUE_SNAPSHOT_INVALID')
  assertIdentity(binding.source)
  const realSnapshot = fs.realpathSync(snapshotPath)
  if (realSnapshot !== path.resolve(snapshotPath)) fail('RESCUE_SNAPSHOT_INVALID')
  const sourceDigest = await inspectSqliteForRescue(realSnapshot)
  const snapshotHash = createHash('sha256')
  for await (const chunk of fs.createReadStream(realSnapshot)) snapshotHash.update(chunk)
  const latestBinding = readBinding(taskId)
  if (JSON.stringify(latestBinding.source) !== JSON.stringify(binding.source)) fail('RESCUE_SOURCE_IDENTITY_MISMATCH')
  writeControlFile(bindingPath(taskId), { ...latestBinding, snapshot: {
    filePath: realSnapshot, fileSha256: snapshotHash.digest('hex'), digest: sourceDigest,
  } })
}

function assertRollbackAllowed(taskId: string): { binding: Binding; task: Task } {
  const binding = readBinding(taskId)
  const task = readTask(taskId)
  if (['succeeded', 'rolled_back'].includes(task.status)) fail('RESCUE_WINDOW_CLOSED')
  if (!binding.snapshot) fail('RESCUE_SNAPSHOT_UNAVAILABLE')
  if (path.resolve(task.source.sqlitePath) !== binding.source.filePath) fail('RESCUE_SOURCE_IDENTITY_MISMATCH')
  assertIdentity(binding.source)
  const maintenance = readOwnedControl(appDataPaths.maintenanceStateFile, taskId)
  if (maintenance.readOnly !== true) fail('RESCUE_WINDOW_CLOSED')
  readOwnedControl(appDataPaths.migrationLockFile, taskId)
  const marker = inspectControlFile(appDataPaths.migrationCutoverFile, validateCutoverControl)
  if (marker.state === 'healthy' && (marker.value.taskId !== taskId || path.resolve(String(marker.value.sourceSqlitePath)) !== binding.source.filePath)) fail('RESCUE_CONTROL_OWNERSHIP_UNPROVEN')
  // marker 损坏/缺失时仍要求任务、维护锁、源身份、快照四方证据；不猜测恢复对象。
  const override = inspectDatabaseRuntimeOverride()
  if (override.state === 'healthy' && override.value.sourceTaskId !== taskId) fail('RESCUE_CONTROL_OWNERSHIP_UNPROVEN')
  return { binding, task }
}

export function databaseRescueStatus(taskId: string) {
  const intent = inspectRecoveryIntent()
  let allowedActions: string[] = []
  let reason = 'RESCUE_READY'
  try { assertRollbackAllowed(taskId); allowedActions = ['prepare_rollback'] } catch (error) { reason = error instanceof RescueControlError ? error.code : 'RESCUE_CONTROL_UNAVAILABLE' }
  if (intent.state === 'corrupted') { allowedActions = []; reason = 'RESCUE_INTENT_CORRUPTED' }
  if (intent.state === 'healthy' && intent.value.taskId === taskId) {
    allowedActions = intent.value.phase === 'COMPLETED' || intent.value.sqliteRestartAttempts >= 2 ? [] : ['resume_rollback']
    if (intent.value.sqliteRestartAttempts >= 2 && intent.value.phase !== 'COMPLETED') reason = 'RESCUE_RESTART_LIMIT'
  }
  return { taskId, status: 'RESCUE', reason, allowedActions,
    recovery: intent.state === 'healthy' && intent.value.taskId === taskId
      ? { phase: intent.value.phase, operationId: intent.value.operationId, restartAttempts: intent.value.sqliteRestartAttempts } : null }
}

export function prepareDatabaseRescueRollback(taskId: string) {
  const { binding } = assertRollbackAllowed(taskId)
  const existing = inspectRecoveryIntent()
  if (existing.state !== 'absent' && !(existing.state === 'healthy' && existing.value.phase === 'COMPLETED')) fail('RESCUE_OPERATION_EXISTS')
  const nonce = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  writeControlFile(bindingPath(taskId), { ...binding, nonce: { hash: digest(nonce), expiresAt } })
  return { taskId, nonce, expiresAt }
}

/** 仅由启动失败协调器调用；仍使用同一 nonce、任务归属和恢复日志，不建立旁路恢复。 */
export async function prepareAutomaticDatabaseRescueRollback(taskId: string): Promise<DatabaseRecoveryIntent> {
  const prepared = prepareDatabaseRescueRollback(taskId)
  return beginDatabaseRescueRollback(taskId, prepared.nonce, `automatic_${randomBytes(16).toString('hex')}`)
}

function checkpoint(intent: DatabaseRecoveryIntent, name: string): void {
  // 只有隔离验收 profile 能注入崩溃；没有认证绕过或生产控制参数。
  if (process.env.APP_PROFILE === 'verify-db-migration' && process.env.Y_LINK_DB_MIGRATION_E2E === 'true'
    && process.env.Y_LINK_RESCUE_TEST_INTERRUPT_AFTER === name) throw new RescueControlError('RESCUE_TEST_INTERRUPTION', 503)
  appendControlAudit(auditPath, { taskId: intent.taskId, operationId: intent.operationId, event: name })
}

export async function beginDatabaseRescueRollback(taskId: string, nonce: string, operationId: string): Promise<DatabaseRecoveryIntent> {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(operationId)) fail('RESCUE_IDEMPOTENCY_REQUIRED', 400)
  const existing = inspectRecoveryIntent()
  if (existing.state === 'corrupted') fail('RESCUE_INTENT_CORRUPTED')
  if (existing.state === 'healthy' && existing.value.phase !== 'COMPLETED') {
    if (existing.value.taskId !== taskId || existing.value.operationId !== operationId) fail('RESCUE_OPERATION_EXISTS')
    return existing.value // 重放只读旧状态，重启时统一重放日志，不重复执行回退。
  }
  if (existing.state === 'healthy' && existing.value.taskId === taskId && existing.value.operationId === operationId) return existing.value
  const { binding } = assertRollbackAllowed(taskId)
  if (!binding.nonce || Date.parse(binding.nonce.expiresAt) <= Date.now() || !equalHash(binding.nonce.hash, digest(nonce))) fail('RESCUE_NONCE_INVALID', 403)
  const timestamp = now()
  const intent: DatabaseRecoveryIntent = { version: 1, taskId, operationId, phase: 'PREPARED', source: binding.source,
    sourceDigest: binding.snapshot!.digest, createdAt: timestamp, updatedAt: timestamp, sqliteRestartAttempts: 0 }
  // 无 await：nonce 校验与写入恢复意图之间不会有并发请求取得同一操作。
  writeControlFile(recoveryIntentPath, intent)
  checkpoint(intent, 'PREPARED')
  writeControlFile(bindingPath(taskId), { ...binding, nonce: undefined })
  await quiesceRuntime?.(taskId)
  return replayDatabaseRecoveryIntent()
}

/** 单文件日志是唯一恢复入口；每一步可重复，最后才标记可重启。 */
export async function replayDatabaseRecoveryIntent(): Promise<DatabaseRecoveryIntent> {
  const state = inspectRecoveryIntent()
  if (state.state !== 'healthy') return fail('RESCUE_INTENT_UNAVAILABLE')
  const intent = state.value
  if (intent.phase === 'COMPLETED') return intent
  assertIdentity(intent.source)
  const task = readTask(intent.taskId)
  if (task.status === 'succeeded' || path.resolve(task.source.sqlitePath) !== intent.source.filePath) fail('RESCUE_WINDOW_CLOSED')
  // 不覆盖其他任务的维护状态或锁；已完成终态只允许继续本任务收尾。
  if (task.status !== 'rolled_back') {
    readOwnedControl(appDataPaths.maintenanceStateFile, intent.taskId)
    readOwnedControl(appDataPaths.migrationLockFile, intent.taskId)
  }
  if (task.status !== 'rolled_back') {
    // 隔离容器验证：恢复意图已经落盘，但第一次任务取消写盘失败；重启重放必须仍可推进。
    if (process.env.APP_PROFILE === 'verify-db-migration' && process.env.Y_LINK_DB_MIGRATION_E2E === 'true'
      && process.env.Y_LINK_DB_MIGRATION_E2E_FAIL_CANCEL_TASK_WRITE === 'true') {
      const injected = path.join(rescueDir, `cancel-write-interrupted-${intent.operationId}.json`)
      if (!fs.existsSync(injected)) {
        writeControlFile(injected, { version: 1, taskId: intent.taskId })
        throw new Error('RESCUE_TEST_CANCEL_WRITE_INTERRUPTED')
      }
    }
    writeControlFile(taskPath(intent.taskId), { ...task, status: 'restart_pending', cancelRequestedAt: task.cancelRequestedAt ?? intent.createdAt,
      updatedAt: now(), progress: { ...(task.progress as object), currentStage: '救援回退已持久化，等待恢复原 SQLite' } })
  } else {
    readOwnedControl(appDataPaths.maintenanceStateFile, intent.taskId)
  }
  checkpoint(intent, 'TASK_CANCELLED')
  await writeDatabaseRuntimeOverride({ version: 1, updatedAt: now(), reason: '数据库救援受控回退', sourceTaskId: intent.taskId,
    config: { DB_TYPE: 'sqlite', SQLITE_DB_PATH: intent.source.filePath, DB_SYNC: false },
    rollbackConfig: { DB_TYPE: 'sqlite', SQLITE_DB_PATH: intent.source.filePath, DB_SYNC: false } })
  checkpoint(intent, 'SQLITE_OVERRIDE')
  const markerState = inspectControlFile(appDataPaths.migrationCutoverFile, validateCutoverControl)
  if (markerState.state === 'healthy' && markerState.value.taskId !== intent.taskId) fail('RESCUE_CONTROL_OWNERSHIP_UNPROVEN')
  if (markerState.state === 'corrupted') {
    const forensic = path.join(rescueDir, `marker-${intent.operationId}.corrupted`)
    if (!fs.existsSync(forensic)) fs.copyFileSync(appDataPaths.migrationCutoverFile, forensic, fs.constants.COPYFILE_EXCL)
  }
  writeControlFile(appDataPaths.migrationCutoverFile, { version: 1, taskId: intent.taskId, sourceSqlitePath: intent.source.filePath,
    attempts: 2, status: 'rollback_pending', createdAt: intent.createdAt, lastError: 'RESCUE_ROLLBACK_REQUESTED' })
  checkpoint(intent, 'ROLLBACK_MARKER')
  const override = inspectDatabaseRuntimeOverride()
  const marker = readOwnedControl(appDataPaths.migrationCutoverFile, intent.taskId)
  const updatedTask = readTask(intent.taskId)
  const updatedMaintenance = readOwnedControl(appDataPaths.maintenanceStateFile, intent.taskId)
  if (updatedTask.status !== 'rolled_back') readOwnedControl(appDataPaths.migrationLockFile, intent.taskId)
  if (override.state !== 'healthy' || override.value.sourceTaskId !== intent.taskId || override.value.config.DB_TYPE !== 'sqlite'
    || override.value.config.SQLITE_DB_PATH !== intent.source.filePath || marker.status !== 'rollback_pending'
    || updatedMaintenance.readOnly !== true
    || !['restart_pending', 'rolled_back'].includes(updatedTask.status)) fail('RESCUE_READBACK_FAILED')
  const next = { ...intent, phase: intent.phase === 'FINALIZING' ? 'FINALIZING' as const : 'RESTART_READY' as const, updatedAt: now() }
  writeControlFile(recoveryIntentPath, next)
  checkpoint(next, 'RESTART_READY')
  return next
}

let resumedOperation: Promise<DatabaseRecoveryIntent> | null = null
/** 为现有操作恢复未完成步骤；不创建第二项操作，HTTP 重放仍先返回原操作状态。 */
export function resumeDatabaseRecoveryOperation(taskId: string, operationId: string): Promise<DatabaseRecoveryIntent> {
  if (resumedOperation) return resumedOperation
  resumedOperation = (async () => {
    const state = inspectRecoveryIntent()
    if (state.state !== 'healthy' || state.value.taskId !== taskId || state.value.operationId !== operationId) fail('RESCUE_OPERATION_EXISTS')
    if (state.value.sqliteRestartAttempts >= 2) fail('RESCUE_RESTART_LIMIT')
    await quiesceRuntime?.(taskId)
    return replayDatabaseRecoveryIntent()
  })().finally(() => { resumedOperation = null })
  return resumedOperation
}

/** 业务模块加载之前只读验证，次数落盘后最多自动重试一次 SQLite 启动。 */
export async function prepareRecoveryStartup(): Promise<DatabaseRecoveryIntent | null> {
  const state = inspectRecoveryIntent()
  if (state.state === 'absent' || (state.state === 'healthy' && state.value.phase === 'COMPLETED')) return null
  if (state.state !== 'healthy') fail('RESCUE_INTENT_CORRUPTED')
  if (state.value.phase === 'FINALIZING') {
    const task = readTask(state.value.taskId)
    if (task.status !== 'rolled_back') fail('RESCUE_FINALIZATION_UNPROVEN')
    const intent = await replayDatabaseRecoveryIntent()
    // 摘要和最终审计已经验收；补数可能已提交，此后只重复完整性检查及幂等收尾。
    await inspectSqliteForRescue(intent.source.filePath)
    return intent
  }
  if (state.value.sqliteRestartAttempts >= 2) fail('RESCUE_RESTART_LIMIT')
  const intent = await replayDatabaseRecoveryIntent()
  const next = { ...intent, phase: 'VERIFYING' as const, sqliteRestartAttempts: intent.sqliteRestartAttempts + 1, updatedAt: now() }
  writeControlFile(recoveryIntentPath, next)
  const current = await inspectSqliteForRescue(next.source.filePath, { taskId: next.taskId, baseline: next.sourceDigest })
  if (current.sha256 !== next.sourceDigest.sha256) fail('RESCUE_SOURCE_DIGEST_MISMATCH')
  return next
}

/** 最终审计已提交后记录收尾阶段，重启只重复启动补数，不重新比较补数前的摘要。 */
export function markRecoveryFinalizing(taskId: string): void {
  const state = inspectRecoveryIntent()
  if (state.state === 'absent') return // 兼容升级前的 v1 marker。
  if (state.state !== 'healthy' || state.value.taskId !== taskId) fail('RESCUE_INTENT_UNAVAILABLE')
  if (state.value.phase === 'COMPLETED') return
  if (!['VERIFYING', 'FINALIZING'].includes(state.value.phase) || readTask(taskId).status !== 'rolled_back') fail('RESCUE_FINALIZATION_UNPROVEN')
  assertIdentity(state.value.source)
  readOwnedControl(appDataPaths.maintenanceStateFile, taskId)
  writeControlFile(recoveryIntentPath, { ...state.value, phase: 'FINALIZING', updatedAt: now() })
}

/** 数据与启动补数均成功、marker 已收尾后调用；维护文件最后移除。 */
export function completeRecoveryIntent(taskId: string): void {
  const state = inspectRecoveryIntent()
  if (state.state === 'absent') return
  if (state.state !== 'healthy' || state.value.taskId !== taskId) fail('RESCUE_INTENT_UNAVAILABLE')
  if (!['FINALIZING', 'COMPLETED'].includes(state.value.phase)) fail('RESCUE_FINALIZATION_UNPROVEN')
  writeControlFile(recoveryIntentPath, { ...state.value, phase: 'COMPLETED', updatedAt: now() })
  const binding = readBinding(taskId)
  writeControlFile(bindingPath(taskId), { ...binding, nonce: undefined })
  appendControlAudit(auditPath, { taskId, operationId: state.value.operationId, event: 'RECOVERY_COMPLETED' })
}
