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
import { CONTINUOUS_MIGRATION_PROTOCOL, isManagedMigration, isControlledManualMigration, isMigrationRecoveryWindowClosed } from './database-migration-protocol.js'

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
  manualFailureCleanup: z.object({ sourceDigest: digestSchema, previousOverrideHash: hashSchema }).optional(),
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
type Task = Record<string, unknown> & { id: string; status: string; source: { sqlitePath: string }; mode: 'automatic' | 'manual' }
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
    return record?.id === taskId && isManagedMigration(record)
      && ['prechecked', 'queued', 'running', 'restart_pending', 'verifying', 'succeeded', 'failed', 'rolled_back'].includes(String(record.status))
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
export function prepareLocalManualDatabaseRescueCredential(taskId: string): ReturnType<typeof issueDatabaseRescueCredential> {
  taskIdSchema.parse(taskId)
  const inspected = inspectControlFile(taskPath(taskId), value => {
    const task = value as Partial<Task> | null
    return task?.id === taskId && task.mode === 'manual' && ['prechecked', 'failed'].includes(String(task.status))
      && typeof task.source?.sqlitePath === 'string' ? task as Task : null
  })
  if (inspected.state !== 'healthy') fail('RESCUE_MANUAL_PREPARATION_INVALID')
  // 仅本地CLI允许为尚未run的手动任务准备凭证；不能改写任何活动冻结会话。
  if (inspectControlFile(appDataPaths.migrationLockFile, validateMigrationLock).state !== 'absent'
    || inspectControlFile(appDataPaths.maintenanceStateFile, validateMaintenanceControl).state !== 'absent'
    || inspectControlFile(appDataPaths.migrationCutoverFile, validateCutoverControl).state !== 'absent'
    || hasPendingRecoveryIntent()) fail('RESCUE_MANUAL_PREPARATION_CONFLICT')
  sourceIdentity(path.resolve(inspected.value.source.sqlitePath))
  writeControlFile(taskPath(taskId), { ...inspected.value, controlProtocol: CONTINUOUS_MIGRATION_PROTOCOL, controlPhase: undefined })
  return issueDatabaseRescueCredential(taskId)
}

export function issueDatabaseRescueCredential(taskId: string): { taskId: string; credential: string; expiresAt: string } {
  const task = readTask(taskId)
  if (isMigrationRecoveryWindowClosed(task)) fail('RESCUE_WINDOW_CLOSED')
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

/** 手动run不得轮换并撤销调用方刚取得的救援凭证；无绑定的直接服务调用仍能使用本地CLI补签。 */
export function ensureDatabaseRescueBinding(taskId: string): void {
  const previous = inspectControlFile(bindingPath(taskId), parse(bindingSchema))
  if (previous.state === 'absent') { issueDatabaseRescueCredential(taskId); return }
  if (previous.state !== 'healthy') fail('RESCUE_BINDING_CORRUPTED')
  assertIdentity(previous.value.source)
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

/** 新的手动冻结会话只能在同任务维护已持有时撤销旧副本资格，不能沿用先前运行的摘要。 */
export function resetManualDatabaseRescueSnapshot(taskId: string): void {
  const task = readTask(taskId), binding = readBinding(taskId)
  if (!isControlledManualMigration(task) || task.controlPhase !== 'freezing') fail('RESCUE_CONTROL_OWNERSHIP_UNPROVEN')
  readOwnedControl(appDataPaths.maintenanceStateFile, taskId)
  readOwnedControl(appDataPaths.migrationLockFile, taskId)
  assertIdentity(binding.source)
  writeControlFile(bindingPath(taskId), { ...binding, snapshot: undefined, nonce: undefined, manualFailureCleanup: undefined })
}

/** 取消/切换前验证原SQLite文件身份；已有不可变快照时必须同时验证全表摘要。 */
export async function assertDatabaseRescueSourceUnchanged(taskId: string, sourcePath: string, requireSnapshot = true): Promise<void> {
  const binding = readBinding(taskId)
  if (path.resolve(sourcePath) !== binding.source.filePath) fail('RESCUE_SOURCE_IDENTITY_MISMATCH')
  assertIdentity(binding.source)
  if (!binding.snapshot) { if (requireSnapshot) fail('RESCUE_SNAPSHOT_UNAVAILABLE'); return }
  const actualHash = createHash('sha256')
  for await (const chunk of fs.createReadStream(binding.snapshot.filePath)) actualHash.update(chunk)
  if (actualHash.digest('hex') !== binding.snapshot.fileSha256) fail('RESCUE_SNAPSHOT_DIGEST_MISMATCH')
  const current = await inspectSqliteForRescue(binding.source.filePath, { taskId, baseline: binding.snapshot.digest })
  if (current.sha256 !== binding.snapshot.digest.sha256) fail('RESCUE_SOURCE_DIGEST_MISMATCH')
}

/** 失败回收的独立持久证明；必须在持有源冻结及同任务锁时生成，不能把普通failed视为可解冻。 */
export async function prepareManualFailureCleanup(taskId: string): Promise<void> {
  const task = readTask(taskId), binding = readBinding(taskId)
  if (!isControlledManualMigration(task) || task.status !== 'failed' || task.controlPhase !== 'failed') fail('MANUAL_FAILURE_STATE_INVALID')
  readOwnedControl(appDataPaths.migrationLockFile, taskId)
  readOwnedControl(appDataPaths.maintenanceStateFile, taskId)
  if (inspectControlFile(appDataPaths.migrationCutoverFile, validateCutoverControl).state !== 'absent' || hasPendingRecoveryIntent()) fail('MANUAL_FAILURE_CUTOVER_ACTIVE')
  const override = inspectDatabaseRuntimeOverride()
  if (override.state === 'corrupted') fail('MANUAL_FAILURE_OVERRIDE_UNPROVEN')
  const current = override.state === 'healthy' ? override.value : null
  if (JSON.stringify(current) !== JSON.stringify(task.controlPreviousOverride ?? null)) fail('MANUAL_FAILURE_OVERRIDE_UNPROVEN')
  await assertDatabaseRescueSourceUnchanged(taskId, task.source.sqlitePath, false)
  const sourceDigest = await inspectSqliteForRescue(binding.source.filePath)
  writeControlFile(bindingPath(taskId), { ...binding, manualFailureCleanup: { sourceDigest, previousOverrideHash: digest(JSON.stringify(current)) } })
}

/** 与救援 PREPARED 竞争同一持久控制权；两个认领入口的检查和提交之间都没有 await。 */
export function claimManualFailureCleanup(taskId: string): boolean {
  if (hasPendingRecoveryIntent()) return false
  const task = readTask(taskId), binding = readBinding(taskId)
  if (!isControlledManualMigration(task) || task.status !== 'failed' || task.controlPhase !== 'failed_cleanup'
    || !binding.manualFailureCleanup) fail('MANUAL_FAILURE_STATE_INVALID')
  readOwnedControl(appDataPaths.migrationLockFile, taskId)
  readOwnedControl(appDataPaths.maintenanceStateFile, taskId)
  if (inspectControlFile(appDataPaths.migrationCutoverFile, validateCutoverControl).state !== 'absent') fail('MANUAL_FAILURE_CUTOVER_ACTIVE')
  // 先关闭救援窗口，再由调用方清理。进程中断时使用同一持久证明续接终态。
  writeControlFile(taskPath(taskId), { ...task, controlPhase: 'failed_recovered', updatedAt: now() })
  return true
}

/** 启动前续接已证明的失败回收；不加载业务env/数据源/bootstrap，任何证明失配均留在救援。 */
export async function resumeManualFailureCleanupBeforeStartup(taskId: string): Promise<void> {
  const task = readTask(taskId), binding = readBinding(taskId), proof = binding.manualFailureCleanup
  if (!isControlledManualMigration(task) || task.status !== 'failed'
    || !['failed_cleanup', 'failed_recovered'].includes(String(task.controlPhase)) || !proof) fail('MANUAL_FAILURE_STATE_INVALID')
  if (inspectControlFile(appDataPaths.migrationCutoverFile, validateCutoverControl).state !== 'absent' || hasPendingRecoveryIntent()) fail('MANUAL_FAILURE_CUTOVER_ACTIVE')
  const maintenance = inspectControlFile(appDataPaths.maintenanceStateFile, validateMaintenanceControl)
  const lock = inspectControlFile(appDataPaths.migrationLockFile, validateMigrationLock)
  if (maintenance.state !== 'healthy' || maintenance.value.taskId !== taskId
    || lock.state === 'corrupted' || (lock.state === 'healthy' && lock.value.taskId !== taskId)) fail('RESCUE_CONTROL_OWNERSHIP_UNPROVEN')
  const override = inspectDatabaseRuntimeOverride()
  if (override.state === 'corrupted') fail('MANUAL_FAILURE_OVERRIDE_UNPROVEN')
  const current = override.state === 'healthy' ? override.value : null
  if (JSON.stringify(current) !== JSON.stringify(task.controlPreviousOverride ?? null)
    || digest(JSON.stringify(current)) !== proof.previousOverrideHash) fail('MANUAL_FAILURE_OVERRIDE_UNPROVEN')
  if (path.resolve(task.source.sqlitePath) !== binding.source.filePath) fail('RESCUE_SOURCE_IDENTITY_MISMATCH')
  assertIdentity(binding.source)
  if ((await inspectSqliteForRescue(binding.source.filePath)).sha256 !== proof.sourceDigest.sha256) fail('RESCUE_SOURCE_DIGEST_MISMATCH')
  // 先终态持久化，再删锁/维护。任一步中断可用同一证明重复执行；不删除源、override或目标数据。
  writeControlFile(taskPath(taskId), { ...task, controlPhase: 'failed_recovered', updatedAt: now() })
  if (lock.state === 'healthy') removeControlFile(appDataPaths.migrationLockFile)
  removeControlFile(appDataPaths.maintenanceStateFile)
}

function assertRollbackAllowed(taskId: string): { binding: Binding; task: Task } {
  const binding = readBinding(taskId)
  const task = readTask(taskId)
  if (isMigrationRecoveryWindowClosed(task)) fail('RESCUE_WINDOW_CLOSED')
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

/** 已认证维护入口先持久接受，再经真实worker退出及调用方完整排空边界后恢复；不建立旁路协议。 */
export async function prepareAutomaticDatabaseRescueRollback(taskId: string, beforeReplay: () => Promise<void>): Promise<DatabaseRecoveryIntent> {
  const prepared = prepareDatabaseRescueRollback(taskId)
  return beginDatabaseRescueRollback(taskId, prepared.nonce, `automatic_${randomBytes(16).toString('hex')}`, beforeReplay)
}

function checkpoint(intent: DatabaseRecoveryIntent, name: string): void {
  // 只有隔离验收 profile 能注入崩溃；没有认证绕过或生产控制参数。
  if (process.env.APP_PROFILE === 'verify-db-migration' && process.env.Y_LINK_DB_MIGRATION_E2E === 'true'
    && process.env.Y_LINK_RESCUE_TEST_INTERRUPT_AFTER === name) throw new RescueControlError('RESCUE_TEST_INTERRUPTION', 503)
  appendControlAudit(auditPath, { taskId: intent.taskId, operationId: intent.operationId, event: name })
}

export async function beginDatabaseRescueRollback(taskId: string, nonce: string, operationId: string, beforeReplay?: () => Promise<void>): Promise<DatabaseRecoveryIntent> {
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
  // 普通业务进程仍可能持有完整HTTP/治理租约；恢复写入必须晚于调用方的完整排空。
  await beforeReplay?.()
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
  if (isMigrationRecoveryWindowClosed(task) && task.status !== 'rolled_back'
    || path.resolve(task.source.sqlitePath) !== intent.source.filePath) fail('RESCUE_WINDOW_CLOSED')
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
