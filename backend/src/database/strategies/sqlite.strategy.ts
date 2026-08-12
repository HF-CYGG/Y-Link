/**
 * 模块说明：backend/src/database/strategies/sqlite.strategy.ts
 * 文件职责：配置 Onebox SQLite 的 WAL、耐久性、等待与缓存参数，并校验配置真实生效。
 */

import type { DataSource } from 'typeorm'
import type { DatabaseCapabilities } from '../database-capabilities.js'
import type { DatabaseStrategy } from '../database-strategy.js'

interface SqliteStrategyOptions {
  synchronous: 'FULL' | 'NORMAL'
  busyTimeoutMs: number
  cacheSizeKib: number
  walAutocheckpointPages: number
  journalSizeLimitBytes: number
}

function normalizePragmaValue(value: unknown, key: string): string | undefined {
  if (!Array.isArray(value) || !value.length || !value[0] || typeof value[0] !== 'object') {
    return undefined
  }
  const record = value[0] as Record<string, unknown>
  const rawValue = record[key] ?? Object.values(record)[0]
  return rawValue === undefined || rawValue === null ? undefined : String(rawValue)
}

export class SqliteDatabaseStrategy implements DatabaseStrategy {
  constructor(
    readonly capabilities: DatabaseCapabilities,
    private readonly options: SqliteStrategyOptions,
  ) {}

  async configure(dataSource: DataSource): Promise<void> {
    if (dataSource.options.type !== 'sqlite') {
      throw new Error('SQLite 策略不能用于非 SQLite 数据源')
    }

    await dataSource.query('PRAGMA foreign_keys = ON')
    const journalModeRows = await dataSource.query('PRAGMA journal_mode = WAL')
    const journalMode = normalizePragmaValue(journalModeRows, 'journal_mode')?.toLowerCase()
    const databasePath = String(dataSource.options.database)
    const isMemoryDatabase = databasePath === ':memory:' || databasePath.startsWith('file::memory:')
    if (journalMode !== 'wal' && !isMemoryDatabase) {
      throw new Error(`SQLite WAL 未能生效（实际 journal_mode=${journalMode ?? 'unknown'}）`)
    }

    await dataSource.query(`PRAGMA synchronous = ${this.options.synchronous}`)
    await dataSource.query(`PRAGMA busy_timeout = ${this.options.busyTimeoutMs}`)
    await dataSource.query(`PRAGMA cache_size = -${this.options.cacheSizeKib}`)
    await dataSource.query('PRAGMA temp_store = MEMORY')
    await dataSource.query(`PRAGMA wal_autocheckpoint = ${this.options.walAutocheckpointPages}`)
    await dataSource.query(`PRAGMA journal_size_limit = ${this.options.journalSizeLimitBytes}`)
    await dataSource.query('PRAGMA optimize=0x10002')

    const foreignKeys = normalizePragmaValue(await dataSource.query('PRAGMA foreign_keys'), 'foreign_keys')
    const busyTimeout = normalizePragmaValue(await dataSource.query('PRAGMA busy_timeout'), 'timeout')
    if (foreignKeys !== '1') {
      throw new Error('SQLite foreign_keys 未能生效，已拒绝继续启动')
    }
    if (busyTimeout !== String(this.options.busyTimeoutMs)) {
      throw new Error(`SQLite busy_timeout 未能生效（实际 ${busyTimeout ?? 'unknown'}ms）`)
    }
  }
}
