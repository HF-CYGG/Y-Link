import type { DataSource } from 'typeorm'

const installedDataSources = new WeakSet<DataSource>()

export function installSqliteTransactionQueue(dataSource: DataSource): void {
  if (installedDataSources.has(dataSource) || dataSource.options.type !== 'sqlite') {
    return
  }

  const originalTransaction = dataSource.transaction.bind(dataSource) as DataSource['transaction']
  let queue = Promise.resolve()

  dataSource.transaction = (async (...args: Parameters<DataSource['transaction']>) => {
    const runTransaction = () => originalTransaction(...args)
    const result = queue.then(runTransaction, runTransaction)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }) as DataSource['transaction']

  installedDataSources.add(dataSource)
}
