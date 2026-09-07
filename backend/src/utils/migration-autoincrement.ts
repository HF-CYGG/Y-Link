/** 保留 SQLite AUTOINCREMENT 的历史高水位，所有计算使用精确整数。 */
import type { DataSource } from 'typeorm'

export function parseDatabaseInteger(value: unknown): bigint {
  if (value === null || value === undefined) return 0n
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('MIGRATION_INTEGER_PRECISION_LOST')
  const text = String(value)
  if (!/^\d+$/.test(text)) throw new Error('MIGRATION_SEQUENCE_INVALID')
  return BigInt(text)
}

export async function readSqliteGeneratedNextId(source: DataSource, table: string, primaryKey: string): Promise<bigint> {
  if (source.options.type !== 'sqlite') throw new Error('MIGRATION_SOURCE_NOT_SQLITE')
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  const rows = await source.query(`SELECT CAST(MAX(${quote(primaryKey)}) AS TEXT) AS value FROM ${quote(table)}`) as Array<{ value: unknown }>
  const sequences = await source.query('SELECT CAST(seq AS TEXT) AS value FROM sqlite_sequence WHERE name = ?', [table]) as Array<{ value: unknown }>
  const maximum = parseDatabaseInteger(rows[0]?.value)
  const sequence = parseDatabaseInteger(sequences[0]?.value)
  return (maximum > sequence ? maximum : sequence) + 1n
}
