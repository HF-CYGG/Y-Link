/** 只读 SQLite 验收，不加载实体、业务配置或 bootstrap；逐行摘要避免把全库装入内存。 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

// sqlite3 是可选原生驱动；MySQL 构建阶段可能不安装它，救援 HTTP 也不能静态加载它。
interface ReadonlySqliteDatabase {
  all(sql: string, callback: (error: Error | null, rows: unknown[]) => void): void
  each(sql: string, row: (error: Error | null, row: Record<string, string>) => void, done: (error: Error | null) => void): void
  close(callback: (error: Error | null) => void): void
}
interface SqliteDriver {
  OPEN_READONLY: number
  Database: new (filePath: string, flags: number, ready: (error: Error | null) => void) => ReadonlySqliteDatabase
}
const require = createRequire(import.meta.url)

export interface SqliteRescueDigest {
  tables: Array<{ name: string; count: number; sha256: string }>
  sha256: string
  auditSequence?: string
  auditSequencePresent?: boolean
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

export async function inspectSqliteForRescue(filePath: string, recovery?: { taskId: string; baseline: SqliteRescueDigest }): Promise<SqliteRescueDigest> {
  const sqlite3 = require('sqlite3') as SqliteDriver
  const db = await new Promise<ReadonlySqliteDatabase>((resolve, reject) => {
    const connection = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (error) => error ? reject(error) : resolve(connection))
  })
  const all = <T>(sql: string) => new Promise<T[]>((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows as T[])))
  try {
    await all('PRAGMA query_only = ON')
    await all('BEGIN')
    const integrity = await all<Record<string, unknown>>('PRAGMA integrity_check')
    if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== 'ok') throw new Error('SOURCE_SQLITE_INTEGRITY_FAILED')
    if ((await all('PRAGMA foreign_key_check')).length) throw new Error('SOURCE_SQLITE_RELATION_FAILED')
    const names = await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    if (!names.length) throw new Error('SOURCE_SQLITE_EMPTY')
    const tables: SqliteRescueDigest['tables'] = []
    let excludedAuditId: string | undefined
    if (recovery?.baseline.auditSequence && names.some((item) => item.name === 'sys_audit_log')) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(recovery.taskId) || !/^\d+$/.test(recovery.baseline.auditSequence)) throw new Error('RESCUE_AUDIT_BASELINE_INVALID')
      const id = (BigInt(recovery.baseline.auditSequence) + 1n).toString()
      const rows = await all<Record<string, unknown>>(`SELECT * FROM sys_audit_log WHERE id >= ${id}`)
      if (rows.length) {
        const row = rows[0]!
        const detail = JSON.parse(String(row.detail_json)) as Record<string, unknown>
        if (rows.length !== 1 || String(row.id) !== id || row.action_type !== 'database_migration.automatic_rolled_back'
          || row.target_id !== recovery.taskId || row.target_code !== recovery.taskId || row.target_type !== 'database_migration'
          || row.actor_user_id !== null || row.actor_username !== 'system' || row.actor_display_name !== '数据库自动迁移程序'
          || row.action_label !== 'SQLite 一键自动迁移已紧急回退'
          || row.result_status !== 'failed' || row.ip_address !== null || row.user_agent !== null
          || !Number.isFinite(Date.parse(String(row.created_at)))
          || detail.mysqlStartupAttempts !== 2 || detail.taskStatePersisted !== true
          || detail.message !== '管理员已取消自动迁移，原 SQLite 已恢复并完成启动自检'
          || Object.keys(detail).sort().join(',') !== 'message,mysqlStartupAttempts,taskStatePersisted') throw new Error('RESCUE_UNEXPECTED_AUDIT_INCREMENT')
        excludedAuditId = id
      }
    }
    for (const { name } of names) {
      const columns = await all<{ name: string; pk: number }>(`PRAGMA table_info(${quote(name)})`)
      if (!columns.length) throw new Error('SOURCE_SQLITE_SCHEMA_INVALID')
      const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)
      const sort = (primary.length ? primary : columns).map((column) => quote(column.name)).join(',')
      const hash = createHash('sha256')
      let count = 0
      // 数字保留 int64 文本；文本/二进制用十六进制，避免 SQLite quote() 截断 NUL 后内容。
      const select = columns.map((column, index) => {
        const name = quote(column.name)
        return `CASE typeof(${name}) WHEN 'text' THEN 't:' || hex(CAST(${name} AS BLOB)) WHEN 'blob' THEN 'b:' || hex(${name}) ELSE typeof(${name}) || ':' || quote(${name}) END AS c${index}`
      }).join(',')
      await new Promise<void>((resolve, reject) => {
        const filter = name === 'sys_audit_log' && excludedAuditId ? ` WHERE id <> ${excludedAuditId}` : ''
        db.each(`SELECT ${select} FROM ${quote(name)}${filter} ORDER BY ${sort}`, (error: Error | null, row: Record<string, string>) => {
          if (error) { reject(error); return }
          count += 1
          hash.update(`${JSON.stringify(columns.map((_, index) => row[`c${index}`]))}\n`)
        }, (error) => error ? reject(error) : resolve())
      })
      tables.push({ name, count, sha256: hash.digest('hex') })
    }
    // 自增序列必须一并比较，不能只证明当前记录相同。
    const sequenceExists = await all("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'")
    const sequences = sequenceExists.length ? await all<{ name: string; seq: string }>('SELECT name, quote(seq) AS seq FROM sqlite_sequence ORDER BY name') : []
    const audit = sequences.find((item) => item.name === 'sys_audit_log')
    const hasAuditTable = names.some((item) => item.name === 'sys_audit_log')
    const auditSequence = hasAuditTable ? audit?.seq ?? '0' : undefined
    const auditSequencePresent = Boolean(audit)
    if (excludedAuditId) {
      if (!audit || audit.seq !== excludedAuditId) throw new Error('RESCUE_UNEXPECTED_AUDIT_SEQUENCE')
      audit.seq = recovery!.baseline.auditSequence!
      if (recovery!.baseline.auditSequencePresent === false) sequences.splice(sequences.indexOf(audit), 1)
    }
    const schema = await all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    return { tables, auditSequence, auditSequencePresent, sha256: createHash('sha256').update(JSON.stringify({ schema, tables, sequences })).digest('hex') }
  } finally {
    await all('ROLLBACK').catch(() => undefined)
    await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()))
  }
}
