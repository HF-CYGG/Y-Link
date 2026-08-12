/**
 * 模块说明：backend/src/database/strategies/mysql.strategy.ts
 * 文件职责：为 TypeORM/mysql2 连接池增加连接获取超时与过载错误收敛，防止请求无限等待池连接。
 */

import type { DataSource } from 'typeorm'
import type { DatabaseCapabilities } from '../database-capabilities.js'
import { DatabaseOverloadedError } from '../database-errors.js'
import type { DatabaseStrategy } from '../database-strategy.js'

interface MysqlStrategyOptions {
  acquireTimeoutMs: number
}

interface PoolConnectionLike {
  release?: () => void
  query?: (sql: string, callback: (error: Error | null) => void) => void
}

type PoolCallback = (error: Error | null, connection?: PoolConnectionLike) => void

interface MysqlPoolLike {
  getConnection: (callback: PoolCallback) => void
}

const configuredPools = new WeakSet<object>()
const utcConfiguredConnections = new WeakSet<object>()
const MYSQL_UTC_SESSION_SQL = "SET SESSION time_zone = '+00:00'"

function mapPoolError(error: Error): Error {
  if (/queue limit/i.test(error.message)) {
    return new DatabaseOverloadedError('MySQL 连接池等待队列已满，请稍后重试', 'pool_queue_full')
  }
  return error
}

export class MysqlDatabaseStrategy implements DatabaseStrategy {
  constructor(
    readonly capabilities: DatabaseCapabilities,
    private readonly options: MysqlStrategyOptions,
  ) {}

  async configure(dataSource: DataSource): Promise<void> {
    if (dataSource.options.type !== 'mysql') {
      throw new Error('MySQL 策略不能用于非 MySQL 数据源')
    }

    const driver = dataSource.driver as unknown as { pool?: MysqlPoolLike }
    const pool = driver.pool
    if (!pool) {
      throw new Error('MySQL 连接池尚未初始化，无法安装连接获取超时保护')
    }
    if (configuredPools.has(pool as object)) {
      return
    }

    const originalGetConnection = pool.getConnection.bind(pool)
    pool.getConnection = (callback: PoolCallback): void => {
      let settled = false
      const finish = (error: Error | null, connection?: PoolConnectionLike): void => {
        if (settled) {
          connection?.release?.()
          return
        }
        settled = true
        clearTimeout(timeout)
        callback(error ? mapPoolError(error) : null, connection)
      }
      const timeout = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        callback(new DatabaseOverloadedError('等待 MySQL 连接超时，请稍后重试', 'pool_timeout'))
      }, this.options.acquireTimeoutMs)

      try {
        originalGetConnection((error, connection) => {
          if (error || !connection) {
            finish(error ?? new Error('MySQL 连接池返回了空连接'))
            return
          }
          if (utcConfiguredConnections.has(connection as object)) {
            finish(null, connection)
            return
          }
          if (typeof connection.query !== 'function') {
            connection.release?.()
            finish(new Error('MySQL 池连接不支持会话时区初始化'))
            return
          }
          // mysql2 的 timezone 选项只控制 DATETIME 的 JS 序列化/解析，不会修改
          // MySQL 会话时区。实体的 CURRENT_TIMESTAMP 由数据库生成，因此每条新池连接
          // 都必须先固定为 UTC，且初始化完成前不能交给 TypeORM 使用。
          connection.query(MYSQL_UTC_SESSION_SQL, (sessionError) => {
            if (sessionError) {
              connection.release?.()
              finish(sessionError)
              return
            }
            utcConfiguredConnections.add(connection as object)
            finish(null, connection)
          })
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    configuredPools.add(pool as object)

    try {
      const rows = await dataSource.query('SELECT @@session.time_zone AS timeZone') as Array<{ timeZone?: string }>
      if (rows[0]?.timeZone !== '+00:00') {
        throw new Error(`MySQL 会话时区初始化失败：expected=+00:00 actual=${String(rows[0]?.timeZone ?? 'unknown')}`)
      }
    } catch (error) {
      configuredPools.delete(pool as object)
      throw error
    }
  }
}
