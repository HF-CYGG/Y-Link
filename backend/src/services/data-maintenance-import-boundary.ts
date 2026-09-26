/**
 * 模块说明：JSON 六表回灌的物理数据边界。
 * 文件职责：在删除前识别会级联改写未备份表的真实外键和触发器，无法证明安全时拒绝导入。
 * 维护说明：MySQL 必须在 REPEATABLE READ 写事务中先锁父表完整主键范围，再做当前读检查。
 */

import type { EntityManager } from 'typeorm'
import { BizError } from '../utils/errors.js'

const IMPORT_TABLES = [
  'inventory_log',
  'o2o_preorder_item',
  'o2o_preorder',
  'client_user',
  'base_product',
  'system_configs',
] as const
const IMPORT_TABLE_SET = new Set<string>(IMPORT_TABLES)
const ATOMIC_MYSQL_TABLES = [...IMPORT_TABLES, 'business_sequence', 'sys_audit_log']
const PASSIVE_DELETE_RULES = new Set(['NO ACTION', 'RESTRICT'])
const MUTATING_DELETE_RULES = new Set(['CASCADE', 'SET NULL', 'SET DEFAULT'])
const IMPORT_BOUNDARY_MESSAGE = '导入可能改写备份范围外的数据，已拒绝操作；请先核对数据库依赖关系'

interface PhysicalForeignKey {
  childTable: string
  childColumn: string | null
  parentTable: string
  parentColumn: string | null
  constraintName: string
  deleteRule: string
  columnCount: number
}

function rejectUnsafeImport(): never {
  throw new BizError(IMPORT_BOUNDARY_MESSAGE, 409)
}

function quoteMysqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) rejectUnsafeImport()
  return `\`${value}\``
}

function quoteSqliteIdentifier(value: string): string {
  if (!value || value.includes('\0')) rejectUnsafeImport()
  return `"${value.replaceAll('"', '""')}"`
}

function assertSafeForeignKey(reference: PhysicalForeignKey): boolean {
  if (reference.columnCount !== 1 || !reference.childColumn || !reference.parentColumn) rejectUnsafeImport()
  const rule = reference.deleteRule.toUpperCase().trim()
  if (PASSIVE_DELETE_RULES.has(rule)) return false
  if (!MUTATING_DELETE_RULES.has(rule)) rejectUnsafeImport()
  return true
}

async function assertMysqlMetadataVisibility(manager: EntityManager): Promise<void> {
  const [session] = await manager.query(
    'SELECT CURRENT_USER() AS account, DATABASE() AS databaseName, @@SESSION.transaction_isolation AS isolationLevel, @@SESSION.foreign_key_checks AS foreignKeyChecks',
  ) as Array<{ account: string; databaseName: string; isolationLevel: string; foreignKeyChecks: number }>
  if (!session?.databaseName || session.isolationLevel !== 'REPEATABLE-READ' || Number(session.foreignKeyChecks) !== 1) {
    rejectUnsafeImport()
  }

  const account = String(session.account)
  const at = account.lastIndexOf('@')
  if (at < 1 || at === account.length - 1) rejectUnsafeImport()
  const grantee = `'${account.slice(0, at).replaceAll("'", "''")}'@'${account.slice(at + 1).replaceAll("'", "''")}'`
  const globalGrants = await manager.query(`SELECT 1 AS allowed FROM information_schema.USER_PRIVILEGES
    WHERE GRANTEE = ? AND PRIVILEGE_TYPE = 'TRIGGER' LIMIT 1`, [grantee]) as unknown[]
  const schemaGrants = await manager.query(`SELECT 1 AS allowed FROM information_schema.SCHEMA_PRIVILEGES
    WHERE GRANTEE = ? AND TABLE_SCHEMA = DATABASE() AND PRIVILEGE_TYPE = 'TRIGGER' LIMIT 1`, [grantee]) as unknown[]
  const tableGrants = await manager.query(`SELECT TABLE_NAME AS tableName FROM information_schema.TABLE_PRIVILEGES
    WHERE GRANTEE = ? AND TABLE_SCHEMA = DATABASE() AND PRIVILEGE_TYPE = 'TRIGGER'`, [grantee]) as Array<{ tableName: string }>
  const tableGrantSet = new Set(tableGrants.map((row) => row.tableName))
  if (globalGrants.length === 0 && schemaGrants.length === 0
    && IMPORT_TABLES.some((table) => !tableGrantSet.has(table))) {
    throw new BizError('无法核实导入表的触发器：数据库账号需具备六表的 TRIGGER 元数据可见权限', 409)
  }

  // information_schema 只展示账号有权限的对象；六表的表级 SELECT 看不到未授权外部子表外键。
  const globalSelect = await manager.query(`SELECT 1 AS allowed FROM information_schema.USER_PRIVILEGES
    WHERE GRANTEE = ? AND PRIVILEGE_TYPE = 'SELECT' LIMIT 1`, [grantee]) as unknown[]
  const schemaSelect = await manager.query(`SELECT 1 AS allowed FROM information_schema.SCHEMA_PRIVILEGES
    WHERE GRANTEE = ? AND TABLE_SCHEMA = DATABASE() AND PRIVILEGE_TYPE = 'SELECT' LIMIT 1`, [grantee]) as unknown[]
  if (globalSelect.length === 0 && schemaSelect.length === 0) {
    throw new BizError('无法核实外部外键：数据库账号需具备目标 schema 级 SELECT 元数据可见权限', 409)
  }

  const engineRows = await manager.query(`SELECT TABLE_NAME AS tableName, ENGINE AS engine, TABLE_TYPE AS tableType
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN (${ATOMIC_MYSQL_TABLES.map(() => '?').join(', ')})`, ATOMIC_MYSQL_TABLES) as Array<{
    tableName: string; engine: string | null; tableType: string
  }>
  const engines = new Map(engineRows.map((row) => [row.tableName, row]))
  if (ATOMIC_MYSQL_TABLES.some((table) => {
    const row = engines.get(table)
    return row?.tableType !== 'BASE TABLE' || row.engine?.toUpperCase() !== 'INNODB'
  })) rejectUnsafeImport()
}

/** 先锁住所有即将删除的父行及主键间隙，防止检查后插入新的父/子引用。 */
async function lockMysqlImportTables(manager: EntityManager): Promise<void> {
  for (const table of IMPORT_TABLES) {
    await manager.query(`SELECT id FROM ${quoteMysqlIdentifier(table)} ORDER BY id FOR UPDATE`)
  }
}

async function assertMysqlBoundary(manager: EntityManager): Promise<void> {
  await lockMysqlImportTables(manager)
  await assertMysqlMetadataVisibility(manager)
  const triggers = await manager.query(`SELECT TRIGGER_NAME AS triggerName
    FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = DATABASE()
      AND EVENT_OBJECT_TABLE IN (${IMPORT_TABLES.map(() => '?').join(', ')})
    LIMIT 1`, [...IMPORT_TABLES]) as unknown[]
  if (triggers.length > 0) rejectUnsafeImport()

  const rows = await manager.query(`SELECT kcu.CONSTRAINT_SCHEMA AS constraintSchema,
      kcu.TABLE_SCHEMA AS childSchema, kcu.TABLE_NAME AS childTable,
      kcu.COLUMN_NAME AS childColumn, kcu.REFERENCED_TABLE_NAME AS parentTable,
      kcu.REFERENCED_COLUMN_NAME AS parentColumn, kcu.CONSTRAINT_NAME AS constraintName,
      rc.DELETE_RULE AS deleteRule
    FROM information_schema.KEY_COLUMN_USAGE kcu
    JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
      ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
      AND rc.TABLE_NAME = kcu.TABLE_NAME AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
    WHERE kcu.REFERENCED_TABLE_SCHEMA = DATABASE()
      AND kcu.REFERENCED_TABLE_NAME IN (${IMPORT_TABLES.map(() => '?').join(', ')})
    ORDER BY kcu.CONSTRAINT_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
  [...IMPORT_TABLES]) as Array<{
    constraintSchema: string; childSchema: string; childTable: string; childColumn: string | null
    parentTable: string; parentColumn: string | null; constraintName: string; deleteRule: string
  }>
  const grouped = new Map<string, PhysicalForeignKey>()
  for (const row of rows) {
    if (row.childSchema !== manager.connection.options.database) rejectUnsafeImport()
    if (IMPORT_TABLE_SET.has(row.childTable)) continue
    const key = `${row.constraintSchema}\0${row.childTable}\0${row.constraintName}`
    const existing = grouped.get(key)
    if (existing) {
      existing.columnCount += 1
    } else {
      grouped.set(key, { ...row, columnCount: 1 })
    }
  }
  for (const reference of grouped.values()) {
    if (!assertSafeForeignKey(reference)) continue
    const query = `SELECT 1 AS referenced FROM ${quoteMysqlIdentifier(reference.childTable)} child
      INNER JOIN ${quoteMysqlIdentifier(reference.parentTable)} parent
        ON child.${quoteMysqlIdentifier(reference.childColumn!)} = parent.${quoteMysqlIdentifier(reference.parentColumn!)}
      LIMIT 1 FOR UPDATE`
    try {
      const matched = await manager.query(query) as unknown[]
      if (matched.length > 0) rejectUnsafeImport()
    } catch (error) {
      if (error instanceof BizError) throw error
      rejectUnsafeImport()
    }
  }
}

async function assertSqliteBoundary(manager: EntityManager): Promise<void> {
  const [foreignKeys] = await manager.query('PRAGMA foreign_keys') as Array<{ foreign_keys: number }>
  if (Number(foreignKeys?.foreign_keys) !== 1) rejectUnsafeImport()
  const placeholders = IMPORT_TABLES.map(() => '?').join(', ')
  const triggers = await manager.query(`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name IN (${placeholders})
    UNION ALL SELECT name FROM sqlite_temp_master
    WHERE type = 'trigger' AND tbl_name IN (${placeholders}) LIMIT 1`,
  [...IMPORT_TABLES, ...IMPORT_TABLES]) as unknown[]
  if (triggers.length > 0) rejectUnsafeImport()

  // TEMP 表可遮蔽同名 main 表；无法证明 PRAGMA 查到的是将被删除表的真实外键时拒绝。
  const tempTables = await manager.query("SELECT name FROM sqlite_temp_master WHERE type = 'table' LIMIT 1") as unknown[]
  if (tempTables.length > 0) rejectUnsafeImport()

  const tables = await manager.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") as Array<{ name: string }>
  for (const table of tables) {
    if (IMPORT_TABLE_SET.has(table.name)) continue
    const references = await manager.query(`PRAGMA main.foreign_key_list(${quoteSqliteIdentifier(table.name)})`) as Array<{
      id: number; seq: number; table: string; from: string | null; to: string | null; on_delete: string
    }>
    const grouped = new Map<number, PhysicalForeignKey>()
    for (const row of references) {
      if (!IMPORT_TABLE_SET.has(row.table)) continue
      const existing = grouped.get(Number(row.id))
      if (existing) {
        existing.columnCount += 1
      } else {
        grouped.set(Number(row.id), {
          childTable: table.name,
          childColumn: row.from,
          parentTable: row.table,
          parentColumn: row.to,
          constraintName: `${table.name}.${row.id}`,
          deleteRule: row.on_delete,
          columnCount: 1,
        })
      }
    }
    for (const reference of grouped.values()) {
      if (!assertSafeForeignKey(reference)) continue
      const query = `SELECT 1 AS referenced FROM ${quoteSqliteIdentifier(reference.childTable)} child
        INNER JOIN ${quoteSqliteIdentifier(reference.parentTable)} parent
          ON child.${quoteSqliteIdentifier(reference.childColumn!)} = parent.${quoteSqliteIdentifier(reference.parentColumn!)}
        LIMIT 1`
      try {
        const matched = await manager.query(query) as unknown[]
        if (matched.length > 0) rejectUnsafeImport()
      } catch (error) {
        if (error instanceof BizError) throw error
        rejectUnsafeImport()
      }
    }
  }
}

/** 此检查与后续六表删除必须共用同一事务，不能在路由层预览后复用结果。 */
export async function assertDataMaintenanceImportBoundary(manager: EntityManager): Promise<void> {
  if (manager.connection.options.type === 'mysql') {
    await assertMysqlBoundary(manager)
  } else if (manager.connection.options.type === 'sqlite') {
    await assertSqliteBoundary(manager)
  } else {
    rejectUnsafeImport()
  }
}
