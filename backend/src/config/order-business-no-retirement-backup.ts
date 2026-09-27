/**
 * 模块说明：backend/src/config/order-business-no-retirement-backup.ts
 * 文件职责：在 056 清退历史业务号永久占用结构前，生成仅含两张目标表的版本化、可校验 JSON 备份。
 * 实现逻辑：
 * - 表名由固定 allowlist 控制，分别读取 SQLite/MySQL 原始 CREATE SQL 与完整行数据；
 * - 数据库原始值先编码为 JSON 安全值，再以稳定键序计算 payload SHA-256；
 * - 文件经 0600 临时文件写入、fsync、回读校验后，以同目录排他硬链接原子发布到迁移备份目录。
 * 维护说明：
 * - 本模块不提供 HTTP 下载、自动清理或自动恢复能力；恢复必须走受控离线流程；
 * - 备份内容含历史业务号等敏感数据，调用方日志不得输出行内容或绝对路径。
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appDataPaths } from './app-data-paths.js'

export const ORDER_BUSINESS_NO_RETIREMENT_TABLES = [
  'order_business_no_occupancy',
  'order_business_no_reuse_event',
] as const

export const ORDER_BUSINESS_NO_RETIREMENT_MIGRATION =
  '056_disable_order_business_no_permanent_occupancy.sql' as const

const BACKUP_KIND = 'y-link.order-business-no-retirement' as const
const BACKUP_VERSION = 1 as const
const PUBLICATION_CLEANUP_REQUIRED_MARKER = 'YLINK_RETIREMENT_BACKUP_CLEANUP_REQUIRED' as const

export type RetirementTableName = typeof ORDER_BUSINESS_NO_RETIREMENT_TABLES[number]
export type RetirementBackupDialect = 'sqlite' | 'mysql'

type EncodedScalar = string | number | boolean | null
export type EncodedBackupValue =
  | EncodedScalar
  | { $ylinkType: 'bigint'; value: string }
  | { $ylinkType: 'date'; value: string }
  | { $ylinkType: 'buffer'; encoding: 'base64'; value: string }
  | { $ylinkType: 'undefined' }
  | EncodedBackupValue[]
  | { [key: string]: EncodedBackupValue }

export interface OrderBusinessNoRetirementBackupTable {
  name: RetirementTableName
  createSql: string
  rowCount: number
  rows: Array<Record<string, EncodedBackupValue>>
}

export interface OrderBusinessNoRetirementBackupPayload {
  version: typeof BACKUP_VERSION
  kind: typeof BACKUP_KIND
  dialect: RetirementBackupDialect
  migration: typeof ORDER_BUSINESS_NO_RETIREMENT_MIGRATION
  createdAt: string
  tables: OrderBusinessNoRetirementBackupTable[]
}

export interface OrderBusinessNoRetirementBackupBundle extends OrderBusinessNoRetirementBackupPayload {
  payloadSha256: string
}

interface QueryExecutor {
  (sql: string, parameters?: unknown[]): Promise<unknown>
}

export type BackupFileSystem = Pick<
  typeof fs,
  'mkdir' | 'chmod' | 'link' | 'open' | 'readFile' | 'rename' | 'rm'
>

export interface BackupOrderBusinessNoRetirementTablesOptions {
  dialect: RetirementBackupDialect
  query: QueryExecutor
  backupDir?: string
  now?: () => Date
  createId?: () => string
  fileSystem?: BackupFileSystem
}

export type OrderBusinessNoRetirementBackupPublishOptions = Omit<
  BackupOrderBusinessNoRetirementTablesOptions,
  'dialect' | 'query'
>

interface MysqlColumnMetadataRow {
  COLUMN_NAME: unknown
  DATA_TYPE: unknown
  COLUMN_TYPE: unknown
  ORDINAL_POSITION: unknown
}

interface MysqlColumnMetadata {
  columnName: string
  dataType: string
  columnType: string
  ordinalPosition: number
}

const MYSQL_SUPPORTED_DATA_TYPES = new Set([
  'bigint', 'binary', 'bit', 'blob', 'char', 'date', 'datetime', 'decimal', 'double',
  'enum', 'float', 'geometry', 'geometrycollection', 'int', 'integer', 'json', 'linestring',
  'longblob', 'longtext', 'mediumblob', 'mediumint', 'mediumtext', 'multilinestring',
  'multipoint', 'multipolygon', 'numeric', 'point', 'polygon', 'real', 'set', 'smallint',
  'text', 'time', 'timestamp', 'tinyblob', 'tinyint', 'tinytext', 'varbinary', 'varchar', 'year',
])
const MYSQL_EXACT_STRING_TYPES = new Set([
  'bigint', 'decimal', 'numeric', 'date', 'datetime', 'time', 'timestamp',
])
const MYSQL_BINARY_TYPES = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob',
])

export type BackupOrderBusinessNoRetirementTablesResult =
  | { status: 'skipped' }
  | {
      status: 'created'
      fileName: string
      tables: Array<{ name: RetirementTableName; rowCount: number }>
    }

function isAllowedTableName(value: unknown): value is RetirementTableName {
  return typeof value === 'string'
    && (ORDER_BUSINESS_NO_RETIREMENT_TABLES as readonly string[]).includes(value)
}

export function encodeRetirementBackupValue(value: unknown): EncodedBackupValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('业务号历史表包含无法安全写入 JSON 的非有限数值')
    }
    return value
  }
  if (typeof value === 'bigint') return { $ylinkType: 'bigint', value: value.toString(10) }
  if (typeof value === 'undefined') return { $ylinkType: 'undefined' }
  if (value instanceof Date) return { $ylinkType: 'date', value: value.toISOString() }
  if (Buffer.isBuffer(value)) {
    return { $ylinkType: 'buffer', encoding: 'base64', value: value.toString('base64') }
  }
  if (value instanceof Uint8Array) {
    return {
      $ylinkType: 'buffer',
      encoding: 'base64',
      value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    }
  }
  if (Array.isArray(value)) return value.map((item) => encodeRetirementBackupValue(item))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareRetirementBackupCodeUnits(left, right))
        .map(([key, item]) => [key, encodeRetirementBackupValue(item)]),
    )
  }
  throw new Error(`业务号历史表包含不支持的数据库值类型：${typeof value}`)
}

/** 与 ICU/系统 locale 无关的 UTF-16 代码单元顺序。 */
export function compareRetirementBackupCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableNormalize(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareRetirementBackupCodeUnits(left, right))
        .map(([key, item]) => [key, stableNormalize(item)]),
    )
  }
  return value
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value))
}

export function calculateOrderBusinessNoRetirementPayloadSha256(
  payload: OrderBusinessNoRetirementBackupPayload,
): string {
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertCreateSqlMatches(
  dialect: RetirementBackupDialect,
  tableName: RetirementTableName,
  createSql: string,
): void {
  const createMatch = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|'((?:''|[^'])+)'|([A-Za-z_][A-Za-z0-9_]*))\s*\(/i.exec(createSql)
  const declaredTableName = createMatch
    ? (createMatch[1] ?? createMatch[2] ?? createMatch[3] ?? createMatch[4]?.replaceAll("''", "'") ?? createMatch[5])
    : undefined
  if (!createMatch || declaredTableName !== tableName) {
    throw new Error(`业务号历史表备份的 ${tableName} CREATE SQL 表名不合法`)
  }

  const openingParenthesis = createMatch[0].lastIndexOf('(')
  let depth = 0
  let quote: "'" | '"' | '`' | ']' | null = null
  let closingParenthesis = -1
  const unquotedSemicolons: number[] = []
  for (let index = openingParenthesis; index < createSql.length; index += 1) {
    const char = createSql[index]
    const next = createSql[index + 1]
    if (quote) {
      const closingQuote = quote === ']' ? ']' : quote
      if (char === closingQuote) {
        if (next === closingQuote && quote !== ']') index += 1
        else quote = null
      } else if (char === '\\' && quote !== ']' && quote !== '`') {
        index += 1
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '[') {
      quote = ']'
      continue
    }
    if (char === ';') unquotedSemicolons.push(index)
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) {
        closingParenthesis = index
        break
      }
      if (depth < 0) break
    }
  }
  if (closingParenthesis < 0 || depth !== 0 || quote !== null) {
    throw new Error(`业务号历史表备份的 ${tableName} CREATE SQL 结构不合法`)
  }

  let tail = createSql.slice(closingParenthesis + 1).trim()
  if (tail.endsWith(';')) tail = tail.slice(0, -1).trim()
  if (tail.includes(';') || unquotedSemicolons.some((index) => index < createSql.trimEnd().length - 1)) {
    throw new Error(`业务号历史表备份的 ${tableName} CREATE SQL 必须是单条语句`)
  }
  const tailWithoutQuotedContent = tail.replace(/'(?:''|\\.|[^'])*'|"(?:""|\\.|[^"])*"/g, "''")
  if (/\b(?:ALTER|CALL|CREATE|DELETE|DO|DROP|GRANT|INSERT|REPLACE|REVOKE|SELECT|TRUNCATE|UPDATE)\b/i.test(tailWithoutQuotedContent)) {
    throw new Error(`业务号历史表备份的 ${tableName} CREATE SQL 包含危险追加内容`)
  }
  if (dialect === 'sqlite') {
    if (tail && !/^(?:WITHOUT\s+ROWID(?:\s*,?\s*STRICT)?|STRICT(?:\s*,?\s*WITHOUT\s+ROWID)?)$/i.test(tail)) {
      throw new Error(`业务号历史表备份的 ${tableName} CREATE SQL 尾部不合法`)
    }
  } else if (tail && !/^ENGINE\s*=/i.test(tail)) {
    throw new Error(`业务号历史表备份的 ${tableName} CREATE SQL 尾部不合法`)
  }
}

function validateEncodedValue(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value !== 'number' || Number.isFinite(value)
  }
  if (Array.isArray(value)) return value.every((item) => validateEncodedValue(item))
  if (!isRecord(value)) return false

  if ('$ylinkType' in value) {
    if (value.$ylinkType === 'undefined') return Object.keys(value).length === 1
    if (value.$ylinkType === 'bigint') {
      return Object.keys(value).length === 2 && typeof value.value === 'string' && /^-?\d+$/.test(value.value)
    }
    if (value.$ylinkType === 'date') {
      return Object.keys(value).length === 2
        && typeof value.value === 'string'
        && Number.isFinite(Date.parse(value.value))
    }
    if (value.$ylinkType === 'buffer') {
      return Object.keys(value).length === 3
        && value.encoding === 'base64'
        && typeof value.value === 'string'
        && Buffer.from(value.value, 'base64').toString('base64') === value.value
    }
    return false
  }
  return Object.values(value).every((item) => validateEncodedValue(item))
}

export function parseAndVerifyOrderBusinessNoRetirementBundle(
  raw: string,
): OrderBusinessNoRetirementBackupBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error('业务号历史表备份不是合法 JSON')
  }
  if (!isRecord(parsed)) throw new Error('业务号历史表备份根节点格式不合法')
  const rootKeys = Object.keys(parsed).sort()
  const expectedRootKeys = [
    'createdAt',
    'dialect',
    'kind',
    'migration',
    'payloadSha256',
    'tables',
    'version',
  ].sort()
  if (rootKeys.length !== expectedRootKeys.length || rootKeys.some((key, index) => key !== expectedRootKeys[index])) {
    throw new Error('业务号历史表备份根节点字段不合法')
  }
  if (parsed.version !== BACKUP_VERSION || parsed.kind !== BACKUP_KIND) {
    throw new Error('业务号历史表备份版本或类型不受支持')
  }
  if (parsed.dialect !== 'sqlite' && parsed.dialect !== 'mysql') {
    throw new Error('业务号历史表备份数据库类型不合法')
  }
  if (parsed.migration !== ORDER_BUSINESS_NO_RETIREMENT_MIGRATION) {
    throw new Error('业务号历史表备份迁移标识不合法')
  }
  if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) {
    throw new Error('业务号历史表备份创建时间不合法')
  }
  if (
    !Array.isArray(parsed.tables)
    || parsed.tables.length === 0
    || parsed.tables.length > ORDER_BUSINESS_NO_RETIREMENT_TABLES.length
  ) {
    throw new Error('业务号历史表备份表清单不合法')
  }

  const seen = new Set<RetirementTableName>()
  for (const table of parsed.tables) {
    if (!isRecord(table) || !isAllowedTableName(table.name) || seen.has(table.name)) {
      throw new Error('业务号历史表备份包含未授权或重复表名')
    }
    const tableKeys = Object.keys(table).sort()
    const expectedTableKeys = ['createSql', 'name', 'rowCount', 'rows'].sort()
    if (
      tableKeys.length !== expectedTableKeys.length
      || tableKeys.some((key, index) => key !== expectedTableKeys[index])
    ) {
      throw new Error('业务号历史表备份表节点字段不合法')
    }
    seen.add(table.name)
    if (typeof table.createSql !== 'string' || table.createSql.trim().length === 0) {
      throw new Error(`业务号历史表备份缺少 ${table.name} 的 CREATE SQL`)
    }
    assertCreateSqlMatches(parsed.dialect, table.name, table.createSql)
    if (!Number.isSafeInteger(table.rowCount) || Number(table.rowCount) < 0 || !Array.isArray(table.rows)) {
      throw new Error(`业务号历史表备份的 ${table.name} 行数不合法`)
    }
    if (Number(table.rowCount) !== table.rows.length) {
      throw new Error(`业务号历史表备份的 ${table.name} 行数校验失败`)
    }
    if (!table.rows.every((row) => isRecord(row) && validateEncodedValue(row))) {
      throw new Error(`业务号历史表备份的 ${table.name} 行数据编码不合法`)
    }
  }

  const tableOrder = parsed.tables.map((table) => (table as Record<string, unknown>).name)
  const expectedOrder = ORDER_BUSINESS_NO_RETIREMENT_TABLES.filter((name) => seen.has(name))
  if (tableOrder.some((name, index) => name !== expectedOrder[index])) {
    throw new Error('业务号历史表备份表顺序不合法')
  }
  if (typeof parsed.payloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.payloadSha256)) {
    throw new Error('业务号历史表备份 SHA-256 格式不合法')
  }

  const payload: OrderBusinessNoRetirementBackupPayload = {
    version: BACKUP_VERSION,
    kind: BACKUP_KIND,
    dialect: parsed.dialect,
    migration: ORDER_BUSINESS_NO_RETIREMENT_MIGRATION,
    createdAt: parsed.createdAt,
    tables: parsed.tables as unknown as OrderBusinessNoRetirementBackupTable[],
  }
  const expectedSha256 = calculateOrderBusinessNoRetirementPayloadSha256(payload)
  if (parsed.payloadSha256 !== expectedSha256) {
    throw new Error('业务号历史表备份 SHA-256 校验失败')
  }
  return { ...payload, payloadSha256: parsed.payloadSha256 }
}

function toRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('数据库未返回预期的行集合')
  return value.map((row) => {
    if (!isRecord(row)) throw new Error('数据库返回了非法行结构')
    return row
  })
}

function quoteAllowedTableName(dialect: RetirementBackupDialect, tableName: RetirementTableName): string {
  if (!isAllowedTableName(tableName)) throw new Error('拒绝读取未授权的备份表')
  return dialect === 'mysql' ? `\`${tableName}\`` : `"${tableName}"`
}

async function loadTable(
  dialect: RetirementBackupDialect,
  query: QueryExecutor,
  tableName: RetirementTableName,
): Promise<OrderBusinessNoRetirementBackupTable | null> {
  let createSql: string | undefined
  if (dialect === 'sqlite') {
    const schemaRows = toRows(await query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [tableName],
    ))
    createSql = typeof schemaRows[0]?.sql === 'string' ? schemaRows[0].sql : undefined
  } else {
    const existenceRows = toRows(await query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tableName],
    ))
    if (existenceRows.length === 0) return null
    const createRows = toRows(await query(`SHOW CREATE TABLE ${quoteAllowedTableName(dialect, tableName)}`))
    createSql = typeof createRows[0]?.['Create Table'] === 'string'
      ? createRows[0]['Create Table'] as string
      : undefined
  }
  if (!createSql) return null

  let rows: Array<Record<string, EncodedBackupValue>>
  if (dialect === 'mysql') {
    const metadataRows = toRows(await query(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, ORDINAL_POSITION
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [tableName],
    )) as unknown as MysqlColumnMetadataRow[]
    const seenNames = new Set<string>()
    const seenPositions = new Set<number>()
    const columns: MysqlColumnMetadata[] = metadataRows.map((row) => {
      const columnName = typeof row.COLUMN_NAME === 'string' ? row.COLUMN_NAME : ''
      const dataType = typeof row.DATA_TYPE === 'string' ? row.DATA_TYPE.toLowerCase() : ''
      const columnType = typeof row.COLUMN_TYPE === 'string' ? row.COLUMN_TYPE : ''
      const ordinalPosition = Number(row.ORDINAL_POSITION)
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(columnName)
        || seenNames.has(columnName)
        || !MYSQL_SUPPORTED_DATA_TYPES.has(dataType)
        || !columnType
        || !Number.isSafeInteger(ordinalPosition)
        || ordinalPosition < 1
        || seenPositions.has(ordinalPosition)
      ) {
        throw new Error(`业务号历史表 ${tableName} 的 MySQL 列元数据不合法`)
      }
      seenNames.add(columnName)
      seenPositions.add(ordinalPosition)
      return { columnName, dataType, columnType, ordinalPosition }
    })
    if (columns.length === 0 || columns.some((column, index) => column.ordinalPosition !== index + 1)) {
      throw new Error(`业务号历史表 ${tableName} 的 MySQL 列顺序不连续`)
    }
    const projection = columns.map((column) => {
      const quotedColumn = `\`${column.columnName}\``
      if (MYSQL_EXACT_STRING_TYPES.has(column.dataType)) {
        return `CAST(${quotedColumn} AS CHAR CHARACTER SET utf8mb4) AS ${quotedColumn}`
      }
      if (MYSQL_BINARY_TYPES.has(column.dataType)) {
        return `HEX(${quotedColumn}) AS ${quotedColumn}`
      }
      return quotedColumn
    }).join(', ')
    const projectedRows = toRows(await query(
      `SELECT ${projection} FROM ${quoteAllowedTableName(dialect, tableName)}`,
    ))
    rows = projectedRows.map((row) => Object.fromEntries(columns.map((column) => {
      const value = row[column.columnName]
      if (value === null) return [column.columnName, null]
      if (MYSQL_EXACT_STRING_TYPES.has(column.dataType)) {
        if (typeof value !== 'string') {
          throw new Error(`业务号历史表 ${tableName}.${column.columnName} 无法无损读取为十进制或时间字符串`)
        }
        return [column.columnName, value]
      }
      if (MYSQL_BINARY_TYPES.has(column.dataType)) {
        if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[a-fA-F0-9]*$/.test(value)) {
          throw new Error(`业务号历史表 ${tableName}.${column.columnName} 的二进制投影不合法`)
        }
        return [column.columnName, encodeRetirementBackupValue(Buffer.from(value, 'hex'))]
      }
      return [column.columnName, encodeRetirementBackupValue(value)]
    })))
  } else {
    const rawRows = toRows(await query(`SELECT * FROM ${quoteAllowedTableName(dialect, tableName)}`))
    rows = rawRows.map((row) => encodeRetirementBackupValue(row) as Record<string, EncodedBackupValue>)
  }
  rows.sort((left, right) => compareRetirementBackupCodeUnits(stableStringify(left), stableStringify(right)))
  return {
    name: tableName,
    createSql,
    rowCount: rows.length,
    rows,
  }
}

async function enforceMode(
  fileSystem: BackupFileSystem,
  targetPath: string,
  mode: number,
): Promise<void> {
  try {
    await fileSystem.chmod(targetPath, mode)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(code)) throw error
  }
}

async function syncDirectory(fileSystem: BackupFileSystem, directory: string): Promise<void> {
  let handle: Awaited<ReturnType<BackupFileSystem['open']>> | undefined
  try {
    handle = await fileSystem.open(directory, 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes(code)) throw error
  } finally {
    await handle?.close()
  }
}

function safeFileSystemErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN'
}

export async function backupOrderBusinessNoRetirementTables(
  options: BackupOrderBusinessNoRetirementTablesOptions,
): Promise<BackupOrderBusinessNoRetirementTablesResult> {
  const tables: OrderBusinessNoRetirementBackupTable[] = []
  for (const tableName of ORDER_BUSINESS_NO_RETIREMENT_TABLES) {
    const table = await loadTable(options.dialect, options.query, tableName)
    if (table) tables.push(table)
  }
  if (tables.length === 0) return { status: 'skipped' }

  const createdAt = (options.now ?? (() => new Date()))().toISOString()
  const payload: OrderBusinessNoRetirementBackupPayload = {
    version: BACKUP_VERSION,
    kind: BACKUP_KIND,
    dialect: options.dialect,
    migration: ORDER_BUSINESS_NO_RETIREMENT_MIGRATION,
    createdAt,
    tables,
  }
  const bundle: OrderBusinessNoRetirementBackupBundle = {
    ...payload,
    payloadSha256: calculateOrderBusinessNoRetirementPayloadSha256(payload),
  }
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`
  const fileSystem = options.fileSystem ?? fs
  const backupDir = path.resolve(options.backupDir ?? appDataPaths.migrationBackupDir)
  const timestamp = createdAt.replaceAll(/[:.]/g, '-')
  const uniqueId = (options.createId ?? randomUUID)().replaceAll(/[^a-zA-Z0-9-]/g, '').slice(0, 36)
  const fileName = `order-business-no-retirement-056-${options.dialect}-${timestamp}-${uniqueId}.json`
  const finalPath = path.join(backupDir, fileName)
  const temporaryPath = path.join(backupDir, `.${fileName}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<BackupFileSystem['open']>> | undefined
  let finalPublicationMayExist = false
  try {
    await fileSystem.mkdir(backupDir, { recursive: true, mode: 0o700 })
    await enforceMode(fileSystem, backupDir, 0o700)
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined

    const verified = parseAndVerifyOrderBusinessNoRetirementBundle(
      await fileSystem.readFile(temporaryPath, 'utf8'),
    )
    if (verified.dialect !== options.dialect || verified.tables.length !== tables.length) {
      throw new Error('业务号历史表备份回读内容与本次快照不一致')
    }
    // 同目录 hard link 既保持已 fsync inode 的内容，又以 EEXIST 原子拒绝覆盖既有目标；
    // 禁止用 exists + rename 代替，否则检查与发布之间存在 TOCTOU，且 rename 可能覆盖目标。
    await fileSystem.link(temporaryPath, finalPath)
    finalPublicationMayExist = true
    await fileSystem.rm(temporaryPath, { force: true })
    await enforceMode(fileSystem, finalPath, 0o600)
    const publishedBundle = parseAndVerifyOrderBusinessNoRetirementBundle(
      await fileSystem.readFile(finalPath, 'utf8'),
    )
    if (publishedBundle.payloadSha256 !== bundle.payloadSha256) {
      throw new Error('业务号历史表备份发布后的内容与已验证临时文件不一致')
    }
    await syncDirectory(fileSystem, backupDir)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined)
    let manualCleanup: { removeCode: string; quarantineCode: string } | undefined
    if (finalPublicationMayExist) {
      try {
        await fileSystem.rm(finalPath, { force: true })
      } catch (removeError) {
        const quarantinePath = path.join(backupDir, `.${fileName}.failed-${randomUUID()}`)
        try {
          await fileSystem.rename(finalPath, quarantinePath)
        } catch (quarantineError) {
          manualCleanup = {
            removeCode: safeFileSystemErrorCode(removeError),
            quarantineCode: safeFileSystemErrorCode(quarantineError),
          }
        }
      }
    }
    const errorCode = safeFileSystemErrorCode(error)
    const safeReason = errorCode
      && errorCode !== 'UNKNOWN'
      ? `文件系统错误 ${errorCode}`
      : error instanceof Error && error.message.startsWith('业务号历史表备份')
        ? error.message
        : '文件写入或回读校验失败'
    const manualCleanupSuffix = manualCleanup
      ? `；人工处置标记=${PUBLICATION_CLEANUP_REQUIRED_MARKER}`
        + `；fileName=${fileName}`
        + `；removeCode=${manualCleanup.removeCode}`
        + `；quarantineCode=${manualCleanup.quarantineCode}`
      : ''
    throw new Error(`业务号历史表备份失败，056 已阻止执行：${safeReason}${manualCleanupSuffix}`)
  }

  return {
    status: 'created',
    fileName,
    tables: tables.map((table) => ({ name: table.name, rowCount: table.rowCount })),
  }
}
