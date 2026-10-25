/**
 * 模块说明：backend/src/commands/seed-database-migration-e2e.ts
 * 文件职责：为 SQLite -> MySQL 隔离端到端验收生成覆盖全部应用实体表的确定性夹具。
 * 实现逻辑：
 * - 仅允许在 verify-db-migration + 显式 E2E 开关下运行，防止误写开发库或生产库；
 * - 按实体外键依赖排序，为每张空表插入一条包含中文、emoji、金额、日期、空值与 JSON 的合法记录；
 * - 插入完成后再次统计全部实体表，任一表仍为空即以失败退出，避免“空表也校验通过”的伪覆盖。
 * 维护说明：
 * - 新增实体无需手工维护表清单，命令直接读取 AppDataSource.entityMetadatas；
 * - `列 IN (...)` 形式的 CHECK 约束会自动取第一个允许值；其它形式的新 CHECK 约束仍需同步扩展特殊字段取值，
 *   确保夹具满足真实结构约束。
 */

import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { EntityMetadata, QueryRunner } from 'typeorm'
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata.js'
import { AppDataSource } from '../config/data-source.js'
import { env } from '../config/env.js'

type QueryRow = Record<string, unknown>

const quoteIdentifier = (identifier: string) => `\`${identifier.replaceAll('`', '``')}\``

/**
 * 夹具时间取“当前时间 + 1 天”（保留毫秒）：验证码、会话、风控等后台清理任务会删除过期或超过保留期的记录，
 * 写死历史日期会让夹具在回退复核前被清理而误报“未覆盖表”；同一次运行内取值固定，仍满足快照比对。
 */
const FIXTURE_TIMESTAMP = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 23)

function toRows(value: unknown): QueryRow[] {
  return Array.isArray(value)
    ? value.filter((item): item is QueryRow => typeof item === 'object' && item !== null)
    : []
}

function toNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function resolveMetadataOrder(metadatas: EntityMetadata[]): EntityMetadata[] {
  const metadataSet = new Set(metadatas)
  const visiting = new Set<EntityMetadata>()
  const visited = new Set<EntityMetadata>()
  const ordered: EntityMetadata[] = []

  const visit = (metadata: EntityMetadata) => {
    if (visited.has(metadata)) {
      return
    }
    if (visiting.has(metadata)) {
      throw new Error(`验收夹具实体存在循环外键依赖：${metadata.tableName}`)
    }
    visiting.add(metadata)
    for (const foreignKey of metadata.foreignKeys) {
      if (metadataSet.has(foreignKey.referencedEntityMetadata)) {
        visit(foreignKey.referencedEntityMetadata)
      }
    }
    visiting.delete(metadata)
    visited.add(metadata)
    ordered.push(metadata)
  }

  metadatas.forEach(visit)
  return ordered
}

function resolveColumnType(column: ColumnMetadata): string {
  return typeof column.type === 'function'
    ? column.type.name.toLowerCase()
    : String(column.type).toLowerCase()
}

function truncateText(value: string, column: ColumnMetadata): string {
  const configuredLength = Number(column.length)
  if (!Number.isSafeInteger(configuredLength) || configuredLength <= 0) {
    return value
  }
  return value.slice(0, configuredLength)
}

/**
 * 从实体 CHECK 约束中找出 `列 IN ('a', 'b', ...)` 的允许取值，夹具取第一个，
 * 避免通用字符串违反状态、类型等枚举约束导致 SQLite 拒绝写入。
 */
function resolveCheckInListValue(metadata: EntityMetadata, columnName: string): string | undefined {
  for (const check of metadata.checks) {
    if (typeof check.expression !== 'string') {
      continue
    }
    for (const match of check.expression.matchAll(/`?([A-Za-z_][A-Za-z0-9_]*)`?\s+IN\s*\(([^)]*)\)/giu)) {
      if (match[1].toLowerCase() !== columnName) {
        continue
      }
      const firstValue = /'((?:[^']|'')*)'/u.exec(match[2])
      if (firstValue) {
        return firstValue[1].replaceAll("''", "'")
      }
    }
  }
  return undefined
}

function buildFixtureValue(metadata: EntityMetadata, column: ColumnMetadata): unknown {
  const columnName = column.databaseName.toLowerCase()
  const columnType = resolveColumnType(column)
  const marker = `${metadata.tableName}_${columnName}`

  if (
    (metadata.tableName === 'biz_outbound_order'
      || metadata.tableName === 'order_revision')
    && columnName === 'order_uuid'
  ) {
    return '00000000-0000-4000-8000-000000000072'
  }
  if (metadata.tableName === 'biz_outbound_order' && columnName === 'order_type') {
    return 'department'
  }
  if (metadata.tableName === 'biz_outbound_order' && columnName === 'inventory_mode') {
    return 'manual_applied'
  }
  if (
    metadata.tableName === 'biz_outbound_order'
    && columnName === 'business_no'
  ) {
    return 'hyyzjd900001'
  }
  if (column.enum?.length) {
    return column.enum[0]
  }
  const checkInListValue = resolveCheckInListValue(metadata, columnName)
  if (checkInListValue !== undefined) {
    return checkInListValue
  }
  if (columnName === 'order_uuid' || columnName.endsWith('_uuid')) {
    return crypto.randomUUID()
  }
  if (columnName.includes('json')) {
    if (columnName.includes('_ids_') || columnName.startsWith('recipient_') || columnName.startsWith('watched_')) {
      return '[]'
    }
    return JSON.stringify({
      fixture: '迁移夹具😀',
      amount: '12.34',
      nullable: null,
    })
  }
  if (columnName === 'password_hash') {
    return 'e2e-fixture-password-hash-not-a-real-secret'
  }
  if (columnName.includes('email')) {
    return truncateText(`migration-${metadata.tableName}@example.invalid`, column)
  }
  if (columnName.includes('mobile')) {
    return '19900000001'
  }
  if (columnName.includes('ip_address')) {
    return '127.0.0.1'
  }
  if (columnName.includes('url')) {
    return 'https://example.invalid/migration-fixture'
  }
  if (columnName.includes('token')) {
    return truncateText(`e2e-token-${crypto.createHash('sha256').update(marker).digest('hex')}`, column)
  }
  if (columnName === 'channel') {
    return 'email'
  }
  if (columnName.includes('discount_rate')) {
    return '8.8'
  }
  if (
    columnName.includes('price')
    || columnName.includes('amount')
    || columnType.includes('decimal')
    || columnType.includes('numeric')
  ) {
    return '12.34'
  }
  if (
    columnType.includes('date')
    || columnType.includes('time')
    || columnName.endsWith('_at')
  ) {
    return FIXTURE_TIMESTAMP
  }
  if (
    columnType.includes('int')
    || columnType.includes('number')
    || columnType.includes('float')
    || columnType.includes('double')
  ) {
    return 1
  }
  if (columnType.includes('bool')) {
    return 1
  }
  if (columnType.includes('blob') || columnType.includes('binary')) {
    return Buffer.from('Y-Link迁移夹具😀', 'utf8')
  }
  return truncateText(`迁移夹具😀-${marker}`, column)
}

async function readFirstRow(queryRunner: QueryRunner, metadata: EntityMetadata): Promise<QueryRow> {
  const primaryColumn = metadata.primaryColumns[0]
  if (!primaryColumn) {
    throw new Error(`实体表 ${metadata.tableName} 缺少主键，无法生成验收夹具`)
  }
  const rows = toRows(await queryRunner.query(
    `SELECT * FROM ${quoteIdentifier(metadata.tableName)}
     ORDER BY ${quoteIdentifier(primaryColumn.databaseName)} ASC LIMIT 1`,
  ))
  if (!rows[0]) {
    throw new Error(`实体表 ${metadata.tableName} 插入验收夹具后仍为空`)
  }
  return rows[0]
}

/** 复制首行并覆盖唯一列，插入同表第二条夹具记录后读回（按主键倒序取最新一行）。 */
async function insertClonedFixtureRow(
  queryRunner: QueryRunner,
  metadata: EntityMetadata,
  firstRow: QueryRow,
  overrides: QueryRow,
): Promise<QueryRow> {
  const row: QueryRow = {}
  for (const column of metadata.columns) {
    if (column.isGenerated) continue
    row[column.databaseName] = firstRow[column.databaseName]
  }
  Object.assign(row, overrides)

  const columnNames = Object.keys(row)
  await queryRunner.query(
    `INSERT INTO ${quoteIdentifier(metadata.tableName)}
     (${columnNames.map(quoteIdentifier).join(', ')})
     VALUES (${columnNames.map(() => '?').join(', ')})`,
    columnNames.map((columnName) => row[columnName]),
  )
  const primaryColumn = metadata.primaryColumns[0]
  if (!primaryColumn) throw new Error(`${metadata.tableName} 缺少主键，无法生成第二条夹具记录`)
  const rows = toRows(await queryRunner.query(
    `SELECT * FROM ${quoteIdentifier(metadata.tableName)}
     ORDER BY ${quoteIdentifier(primaryColumn.databaseName)} DESC LIMIT 1`,
  ))
  if (!rows[0]) throw new Error(`未能读取 ${metadata.tableName} 的第二条夹具记录`)
  return rows[0]
}

async function createDistinctOutboundOrderFixture(
  queryRunner: QueryRunner,
  metadata: EntityMetadata,
  firstRow: QueryRow,
): Promise<QueryRow> {
  return insertClonedFixtureRow(queryRunner, metadata, firstRow, {
    order_uuid: crypto.randomUUID(),
    show_no: 'hyyzjd900002',
    business_no: 'hyyzjd900002',
    idempotency_key: 'migration-e2e-order-merge-source',
  })
}

/**
 * 两步验证策略只要存在一行就会让该账号密码登录进入第二步；夹具不能挂到验收管理员身上，
 * 否则迁移后的管理员登录只拿到 MFA 票据。这里复制一个独立的夹具用户承载 MFA 记录。
 */
async function createDistinctMfaUserFixture(
  queryRunner: QueryRunner,
  metadata: EntityMetadata,
  firstRow: QueryRow,
): Promise<QueryRow> {
  return insertClonedFixtureRow(queryRunner, metadata, firstRow, {
    username: 'migration_e2e_mfa_user',
    email: null,
    webauthn_user_handle: null,
  })
}

export async function seedEmptyTable(
  queryRunner: QueryRunner,
  metadata: EntityMetadata,
  firstRows: Map<string, QueryRow>,
): Promise<void> {
  const countRows = toRows(await queryRunner.query(
    `SELECT COUNT(1) AS total FROM ${quoteIdentifier(metadata.tableName)}`,
  ))
  if (toNumber(countRows[0]?.total) > 0) {
    firstRows.set(metadata.tableName, await readFirstRow(queryRunner, metadata))
    return
  }

  const foreignKeyValues = new Map<string, unknown>()
  let distinctOutboundOrderRow: QueryRow | null = null
  for (const foreignKey of metadata.foreignKeys) {
    const referencedTableName = foreignKey.referencedEntityMetadata.tableName
    const firstReferencedRow = firstRows.get(referencedTableName)
    if (
      metadata.tableName === 'order_merge_relation'
      && referencedTableName === 'biz_outbound_order'
      && foreignKey.columnNames.some((columnName) => columnName === 'source_order_id' || columnName === 'sourceOrderId')
      && firstReferencedRow
    ) {
      distinctOutboundOrderRow ??= await createDistinctOutboundOrderFixture(
        queryRunner,
        foreignKey.referencedEntityMetadata,
        firstReferencedRow,
      )
    }
    const usesDistinctSourceOrder = foreignKey.columnNames.some(
      (columnName) => columnName === 'source_order_id' || columnName === 'sourceOrderId',
    )
    const usesDistinctMfaUser = metadata.tableName === 'sys_user_mfa' && referencedTableName === 'sys_user'
    const referencedRow = usesDistinctMfaUser && firstReferencedRow
      ? await createDistinctMfaUserFixture(queryRunner, foreignKey.referencedEntityMetadata, firstReferencedRow)
      : distinctOutboundOrderRow && usesDistinctSourceOrder
        ? distinctOutboundOrderRow
        : firstReferencedRow
    if (!referencedRow) {
      throw new Error(
        `实体表 ${metadata.tableName} 缺少外键夹具依赖 ${referencedTableName}`,
      )
    }
    foreignKey.columnNames.forEach((columnName, index) => {
      const referencedColumnName = foreignKey.referencedColumnNames[index]
      foreignKeyValues.set(columnName, referencedRow[referencedColumnName])
    })
  }

  const row: QueryRow = {}
  for (const column of metadata.columns) {
    if (column.isGenerated) {
      continue
    }
    if (foreignKeyValues.has(column.databaseName)) {
      row[column.databaseName] = foreignKeyValues.get(column.databaseName)
      continue
    }
    if (metadata.tableName === 'order_merge_relation' && distinctOutboundOrderRow) {
      if (column.databaseName === 'source_order_uuid') {
        row[column.databaseName] = distinctOutboundOrderRow.order_uuid
        continue
      }
      if (column.databaseName === 'source_business_no_snapshot') {
        row[column.databaseName] = distinctOutboundOrderRow.business_no
        continue
      }
      const parentOrderRow = firstRows.get('biz_outbound_order')
      if (column.databaseName === 'parent_order_uuid') {
        row[column.databaseName] = parentOrderRow?.order_uuid
        continue
      }
      if (column.databaseName === 'parent_business_no_snapshot') {
        row[column.databaseName] = parentOrderRow?.business_no
        continue
      }
    }
    if (column.isCreateDate || column.isUpdateDate) {
      row[column.databaseName] = FIXTURE_TIMESTAMP
      continue
    }
    if (column.isNullable) {
      row[column.databaseName] = null
      continue
    }
    if (
      column.default !== undefined
      && !(metadata.tableName === 'biz_outbound_order' && column.databaseName === 'order_type')
    ) {
      continue
    }
    row[column.databaseName] = buildFixtureValue(metadata, column)
  }

  const columnNames = Object.keys(row)
  if (columnNames.length === 0) {
    await queryRunner.query(`INSERT INTO ${quoteIdentifier(metadata.tableName)} DEFAULT VALUES`)
  } else {
    await queryRunner.query(
      `INSERT INTO ${quoteIdentifier(metadata.tableName)}
       (${columnNames.map(quoteIdentifier).join(', ')})
       VALUES (${columnNames.map(() => '?').join(', ')})`,
      columnNames.map((columnName) => row[columnName]),
    )
  }
  firstRows.set(metadata.tableName, await readFirstRow(queryRunner, metadata))
}

async function main(): Promise<void> {
  if (
    env.APP_PROFILE !== 'verify-db-migration'
    || process.env.Y_LINK_DB_MIGRATION_E2E !== 'true'
    || env.DB_TYPE !== 'sqlite'
  ) {
    throw new Error('全实体迁移夹具命令仅允许在 verify-db-migration SQLite 隔离验收环境运行')
  }

  await AppDataSource.initialize()
  const queryRunner = AppDataSource.createQueryRunner()
  await queryRunner.connect()
  await queryRunner.query('PRAGMA busy_timeout = 10000')
  await queryRunner.query('PRAGMA foreign_keys = ON')
  const orderedMetadatas = resolveMetadataOrder(AppDataSource.entityMetadatas)
  const firstRows = new Map<string, QueryRow>()
  const tableCounts: Record<string, number> = {}
  const verifyOnly = process.env.Y_LINK_DB_MIGRATION_E2E_FIXTURE_MODE === 'verify'

  await queryRunner.startTransaction()
  try {
    if (!verifyOnly) {
      for (const metadata of orderedMetadatas) {
        await seedEmptyTable(queryRunner, metadata, firstRows)
      }
      // 模拟历史高位记录删除后的序列空洞，迁移不能把自增状态退回 MAX(id)。
      await queryRunner.query('UPDATE sqlite_sequence SET seq = seq + 17')
    }
    for (const metadata of orderedMetadatas) {
      const countRows = toRows(await queryRunner.query(
        `SELECT COUNT(1) AS total FROM ${quoteIdentifier(metadata.tableName)}`,
      ))
      const rowCount = toNumber(countRows[0]?.total)
      if (!Number.isSafeInteger(rowCount) || rowCount <= 0) {
        throw new Error(`全实体迁移夹具未覆盖表 ${metadata.tableName}`)
      }
      tableCounts[metadata.tableName] = rowCount
    }
    await queryRunner.commitTransaction()
  } catch (error) {
    await queryRunner.rollbackTransaction()
    throw error
  } finally {
    await queryRunner.release()
    await AppDataSource.destroy()
  }

  console.log(JSON.stringify({
    fixture: verifyOnly ? 'sqlite-to-mysql-full-entity-v1-verified' : 'sqlite-to-mysql-full-entity-v1',
    tableCount: orderedMetadatas.length,
    tableCounts,
    dataTypes: ['中文', 'emoji', '金额', '日期', '空值', 'JSON', '账号会话', '实体关系'],
  }))
}

const invokedAsCommand = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]!).href

if (invokedAsCommand) {
  await main()
}
