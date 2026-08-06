/**
 * 模块说明：backend/src/database/database-strategy.ts
 * 文件职责：根据当前数据源选择 SQLite/MySQL 基础设施策略，并统一完成启动配置与事务协调器安装。
 */

import type { DataSource } from 'typeorm'
import { env } from '../config/env.js'
import {
  resolveDatabaseCapabilities,
  type DatabaseCapabilities,
} from './database-capabilities.js'
import {
  installTransactionCoordinator,
  type TransactionCoordinator,
} from './transaction-coordinator.js'
import { MysqlDatabaseStrategy } from './strategies/mysql.strategy.js'
import { SqliteDatabaseStrategy } from './strategies/sqlite.strategy.js'

export interface DatabaseStrategy {
  readonly capabilities: DatabaseCapabilities
  configure(dataSource: DataSource): Promise<void>
}

const installationPromises = new WeakMap<DataSource, Promise<TransactionCoordinator>>()

export function createDatabaseStrategy(dataSource: DataSource): DatabaseStrategy {
  const capabilities = resolveDatabaseCapabilities(dataSource)
  if (capabilities.engine === 'sqlite') {
    return new SqliteDatabaseStrategy(capabilities, {
      synchronous: env.SQLITE_SYNCHRONOUS,
      busyTimeoutMs: env.SQLITE_BUSY_TIMEOUT_MS,
      cacheSizeKib: env.SQLITE_CACHE_SIZE_KIB,
      walAutocheckpointPages: env.SQLITE_WAL_AUTOCHECKPOINT_PAGES,
      journalSizeLimitBytes: env.SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
    })
  }
  return new MysqlDatabaseStrategy(capabilities, {
    acquireTimeoutMs: env.DB_ACQUIRE_TIMEOUT_MS,
  })
}

/**
 * 数据源 initialize 之后调用：
 * - SQLite 在任何 schema/业务写入前落实并校验 WAL/PRAGMA；
 * - MySQL 为池连接获取增加硬超时；
 * - 两种数据库都安装事务 manager 上下文复用，SQLite 额外启用单写者有界队列。
 */
export function initializeDatabaseInfrastructure(dataSource: DataSource): Promise<TransactionCoordinator> {
  const currentInstallation = installationPromises.get(dataSource)
  if (currentInstallation) {
    return currentInstallation
  }

  const installation = (async () => {
    if (!dataSource.isInitialized) {
      throw new Error('数据库基础设施必须在 DataSource.initialize() 之后安装')
    }
    const strategy = createDatabaseStrategy(dataSource)
    await strategy.configure(dataSource)
    return installTransactionCoordinator(dataSource, {
      serializeWrites: strategy.capabilities.serializesApplicationWrites,
      maxPendingWrites: env.SQLITE_WRITE_QUEUE_MAX_PENDING,
      writeQueueTimeoutMs: env.SQLITE_WRITE_QUEUE_TIMEOUT_MS,
    })
  })()

  installationPromises.set(dataSource, installation)
  installation.catch(() => {
    installationPromises.delete(dataSource)
  })
  return installation
}
