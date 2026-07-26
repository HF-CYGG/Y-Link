/**
 * 模块说明：backend/src/commands/seed-database-migration-e2e.ts
 * 文件职责：为 SQLite -> MySQL 隔离端到端验收生成覆盖全部应用实体表的确定性夹具。
 * 实现逻辑：
 * - 仅允许在 verify-db-migration + 显式 E2E 开关下运行，防止误写开发库或生产库；
 * - 按实体外键依赖排序，为每张空表插入一条包含中文、emoji、金额、日期、空值与 JSON 的合法记录；
 * - 插入完成后再次统计全部实体表，任一表仍为空即以失败退出，避免“空表也校验通过”的伪覆盖。
 * 维护说明：
 * - 新增实体无需手工维护表清单，命令直接读取 AppDataSource.entityMetadatas；
 * - 新增数据库 CHECK 约束时，应同步扩展特殊字段取值，确保夹具仍满足真实结构约束。
 */

import crypto from 'node:crypto'
import type { EntityMetadata, QueryRunner } from 'typeorm'
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata.js'
import { AppDataSource } from '../config/data-source.js'
import { env } from '../config/env.js'

type QueryRow = Record<string, unknown>

const quoteIdentifier = (identifier: string) => `\`${identifier.replaceAll('`', '``')}\``

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

function buildFixtureValue(metadata: EntityMetadata, column: ColumnMetadata): unknown {
  const columnName = column.databaseName.toLowerCase()
  const columnType = resolveColumnType(column)
  const marker = `${metadata.tableName}_${columnName}`

  if (column.enum?.length) {
    return column.enum[0]
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
    return '2026-07-25 12:34:56.789'
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

async function seedEmptyTable(
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
  for (const foreignKey of metadata.foreignKeys) {
    const referencedRow = firstRows.get(foreignKey.referencedEntityMetadata.tableName)
    if (!referencedRow) {
      throw new Error(
        `实体表 ${metadata.tableName} 缺少外键夹具依赖 ${foreignKey.referencedEntityMetadata.tableName}`,
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
    if (column.isCreateDate || column.isUpdateDate) {
      row[column.databaseName] = '2026-07-25 12:34:56.789'
      continue
    }
    if (column.isNullable) {
      row[column.databaseName] = null
      continue
    }
    if (column.default !== undefined) {
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

await main()
