/**
 * 模块说明：backend/src/database/database-capabilities.ts
 * 文件职责：集中描述 SQLite 与 MySQL 的能力差异，业务层无需继续散落数据库类型判断。
 */

import type { DataSource } from 'typeorm'

export type ApplicationDatabaseEngine = 'sqlite' | 'mysql'
export type RecommendedTransactionIsolation = 'SERIALIZABLE' | 'READ COMMITTED'

export interface DatabaseCapabilities {
  engine: ApplicationDatabaseEngine
  supportsRowWriteLock: boolean
  supportsSkipLocked: boolean
  supportsConcurrentWriters: boolean
  supportsMultipleApiInstances: boolean
  maxBindParameters: number
  recommendedIsolation: RecommendedTransactionIsolation
  serializesApplicationWrites: boolean
}

const SQLITE_CAPABILITIES: DatabaseCapabilities = Object.freeze({
  engine: 'sqlite',
  supportsRowWriteLock: false,
  supportsSkipLocked: false,
  supportsConcurrentWriters: false,
  supportsMultipleApiInstances: false,
  // 保守使用所有受支持 SQLite 版本均可工作的参数上限，批处理层可据此安全切块。
  maxBindParameters: 999,
  recommendedIsolation: 'SERIALIZABLE',
  serializesApplicationWrites: true,
})

const MYSQL_CAPABILITIES: DatabaseCapabilities = Object.freeze({
  engine: 'mysql',
  supportsRowWriteLock: true,
  supportsSkipLocked: true,
  supportsConcurrentWriters: true,
  supportsMultipleApiInstances: true,
  maxBindParameters: 65_535,
  recommendedIsolation: 'READ COMMITTED',
  serializesApplicationWrites: false,
})

export function resolveApplicationDatabaseEngine(type: DataSource['options']['type']): ApplicationDatabaseEngine {
  if (type === 'sqlite' || type === 'mysql') {
    return type
  }
  throw new Error(`Y-Link 不支持数据库类型：${type}`)
}

export function resolveDatabaseCapabilities(
  dataSourceOrType: DataSource | DataSource['options']['type'],
): DatabaseCapabilities {
  const type = typeof dataSourceOrType === 'string'
    ? dataSourceOrType
    : dataSourceOrType.options.type
  return resolveApplicationDatabaseEngine(type) === 'sqlite'
    ? SQLITE_CAPABILITIES
    : MYSQL_CAPABILITIES
}
