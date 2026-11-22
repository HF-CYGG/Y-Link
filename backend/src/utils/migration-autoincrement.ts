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

/**
 * TABLES.AUTO_INCREMENT 默认可缓存一天。仅租用一条迁移校验连接读取引擎值，
 * 不能占住池中唯一连接后再走 DataSource.query，也不能把修改后的 session 交回池。
 */
export async function readMysqlGeneratedNextId(target: DataSource, table: string, assertActive?: () => void): Promise<bigint> {
  if (target.options.type !== 'mysql') throw new Error('MIGRATION_TARGET_NOT_MYSQL')
  assertActive?.()
  const runner = target.createQueryRunner('master')
  let connection: { destroy(): void } | undefined
  let previousExpiry: string | undefined, settingMayHaveChanged = false
  let nextId: bigint | undefined, primaryError: unknown, failed = false
  const cleanupErrors: unknown[] = []
  try {
    const physical = await runner.connect()
    // 当前 mysql2 池连接的 destroy 会先从池移除；恢复失败时禁止普通 release 复用它。
    if (!physical || typeof physical.destroy !== 'function') throw new Error('MIGRATION_MYSQL_CONNECTION_NOT_DISPOSABLE')
    connection = physical
    assertActive?.()
    const settings = await runner.query('SELECT CAST(@@session.information_schema_stats_expiry AS CHAR) AS expiry') as Array<{ expiry: unknown }>
    if (settings.length !== 1 || settings[0]?.expiry == null) throw new Error('MIGRATION_MYSQL_STATS_SETTING_MISSING')
    previousExpiry = parseDatabaseInteger(settings[0].expiry).toString()
    if (!Number.isSafeInteger(Number(previousExpiry))) throw new Error('MIGRATION_MYSQL_STATS_SETTING_UNSAFE')
    assertActive?.()
    settingMayHaveChanged = true // 响应失败也不能假定服务端未应用设置。
    await runner.query('SET SESSION information_schema_stats_expiry = 0')
    assertActive?.()
    const rows = await runner.query(`
      SELECT CAST(AUTO_INCREMENT AS CHAR) AS nextId
      FROM information_schema.tables WHERE table_schema = ? AND table_name = ?
    `, [target.options.database, table]) as Array<{ nextId: unknown }>
    if (rows.length !== 1) throw new Error('MIGRATION_MYSQL_SEQUENCE_MISSING')
    nextId = rows[0]?.nextId == null ? 1n : parseDatabaseInteger(rows[0].nextId)
    assertActive?.()
  } catch (error) { primaryError = error; failed = true }
  finally {
    let discard = false, destroyed = false
    if (settingMayHaveChanged) {
      try {
        await runner.query('SET SESSION information_schema_stats_expiry = ?', [Number(previousExpiry!)])
        const settings = await runner.query('SELECT CAST(@@session.information_schema_stats_expiry AS CHAR) AS expiry') as Array<{ expiry: unknown }>
        if (settings.length !== 1 || settings[0]?.expiry == null || parseDatabaseInteger(settings[0].expiry).toString() !== previousExpiry) {
          throw new Error('MIGRATION_MYSQL_STATS_RESTORE_MISMATCH')
        }
      } catch (error) { cleanupErrors.push(error); discard = true }
    }
    if (discard && connection) {
      try { connection.destroy(); destroyed = true } catch (error) { cleanupErrors.push(error) }
    }
    // destroy 失败时不把不可信 session 归还池；错误由调用方持有的 DataSource 关闭路径继续处理。
    if (!discard || destroyed) {
      try { await runner.release() }
      catch (error) {
        cleanupErrors.push(error)
        if (connection && !destroyed) try { connection.destroy() } catch (destroyError) { cleanupErrors.push(destroyError) }
      }
    }
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
    'MIGRATION_MYSQL_SEQUENCE_CONNECTION_CLEANUP_FAILED')
  if (failed) throw primaryError
  assertActive?.()
  return nextId!
}
