/**
 * 模块说明：backend/src/utils/sqlite-transaction-queue.ts
 * 文件职责：为 SQLite 数据源安装事务串行队列，避免高并发下多个事务同时开启触发 "cannot start a transaction within a transaction"。
 * 实现逻辑：
 * - 仅在 sqlite 方言下接管 `DataSource.transaction`；
 * - 把每次事务执行串到上一笔事务完成之后再继续；
 * - 不改业务层调用方式，只在数据源层统一顺序化事务入口。
 */

import type { DataSource } from 'typeorm'
import { isRetryableSqliteLockError } from './database-errors.js'

const installedDataSources = new WeakSet<DataSource>()
const SQLITE_TRANSACTION_MAX_RETRY = 3
const SQLITE_TRANSACTION_RETRY_DELAY_MS = 60

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 为 SQLite 数据源安装事务串行执行队列。
 * - SQLite 单连接在高并发事务场景下容易因重入开启事务而报错；
 * - 非 SQLite 数据源直接跳过，避免影响 MySQL 等具备并发事务能力的方言；
 * - 安装过的数据源不重复包裹，避免形成多层 Promise 链。
 */
export function installSqliteTransactionQueue(dataSource: DataSource): void {
  if (installedDataSources.has(dataSource) || dataSource.options.type !== 'sqlite') {
    return
  }

  const originalTransaction = dataSource.transaction.bind(dataSource) as DataSource['transaction']
  let queue = Promise.resolve<void>(undefined)

  dataSource.transaction = (async (...args: Parameters<DataSource['transaction']>) => {
    const runTransaction = async () => {
      let lastError: unknown
      for (let attempt = 1; attempt <= SQLITE_TRANSACTION_MAX_RETRY; attempt += 1) {
        try {
          return await originalTransaction(...args)
        } catch (error) {
          lastError = error
          if (attempt >= SQLITE_TRANSACTION_MAX_RETRY || !isRetryableSqliteLockError(error)) {
            throw error
          }
          await sleep(SQLITE_TRANSACTION_RETRY_DELAY_MS * attempt)
        }
      }

      throw lastError
    }
    const result = queue.then(runTransaction, runTransaction)

    // 无论本次事务成功还是失败，都要释放队列，避免后续事务永久阻塞。
    queue = result.then(
      () => undefined,
      () => undefined,
    )

    return result
  }) as DataSource['transaction']

  installedDataSources.add(dataSource)
}
