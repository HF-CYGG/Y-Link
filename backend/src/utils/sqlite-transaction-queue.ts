/**
 * 文件说明：SQLite 事务串行队列工具，用于避免单连接环境下事务并发开启导致的重入报错。
 * 实现逻辑：仅在 SQLite 方言下接管 `DataSource.transaction`，把每次事务按顺序排队执行而不改变业务层调用方式。
 * 维护重点：若调整数据库方言支持或数据源包装方式，需要同步验证非 SQLite 场景不受影响且事务串行仍然可靠。
 */

import type { DataSource } from 'typeorm'

const installedDataSources = new WeakSet<DataSource>()

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
    const runTransaction = async () => originalTransaction(...args)
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
