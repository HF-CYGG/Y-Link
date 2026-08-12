/**
 * 文件说明：backend/scripts/transaction-coordinator-verify.ts
 * 文件职责：验证 SQLite 事务协调器对 DataSource 与 QueryRunner 入口的完整串行化边界。
 * 实现逻辑：
 * - 用独立内存 SQLite 数据源构造 QueryRunner 长事务，确认事务外查询必须等待提交或回滚；
 * - 并发启动两个 QueryRunner 事务，确认第二个事务在第一个释放租约前不能进入；
 * - 校验 release 会回滚未完成事务并释放租约，避免异常路径永久堵塞写队列；
 * - 拒绝通过 DataSource.query / QueryRunner.query 直接下发事务控制 SQL，消除无法识别所有者的跨语句事务。
 * 维护说明：本脚本不连接业务库，也不读取 DB_*；所有数据仅存在于当前进程的内存 SQLite 中。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import { DataSource, type QueryRunner } from 'typeorm'
import {
  installTransactionCoordinator,
  type TransactionCoordinator,
} from '../src/database/transaction-coordinator.js'

const WAIT_PROBE_MS = 40

const pass = (message: string) => {
  console.log(`✅ ${message}`)
}

const delay = (durationMs: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, durationMs)
})

const createVerifyDataSource = async (): Promise<{
  dataSource: DataSource
  coordinator: TransactionCoordinator
}> => {
  const dataSource = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [],
    synchronize: false,
    logging: false,
  })
  await dataSource.initialize()
  const coordinator = installTransactionCoordinator(dataSource, {
    serializeWrites: true,
    maxPendingWrites: 8,
    writeQueueTimeoutMs: 1_000,
  })
  await dataSource.query(`
    CREATE TABLE transaction_coordinator_probe (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL
    )
  `)
  return { dataSource, coordinator }
}

const rollbackIfActive = async (queryRunner: QueryRunner): Promise<void> => {
  if (!queryRunner.isTransactionActive) {
    return
  }
  await queryRunner.rollbackTransaction().catch(() => undefined)
}

const verifyQueryRunnerBlocksOutsideQueries = async (
  dataSource: DataSource,
  coordinator: TransactionCoordinator,
): Promise<void> => {
  const queryRunner = dataSource.createQueryRunner()
  let outsideQuerySettled = false
  let outsideQuery: Promise<number> | undefined

  try {
    await queryRunner.startTransaction()
    await queryRunner.query(
      'INSERT INTO transaction_coordinator_probe (id, label) VALUES (?, ?)',
      [1, '待回滚'],
    )

    outsideQuery = dataSource
      .query('SELECT COUNT(*) AS count FROM transaction_coordinator_probe')
      .then((rows: Array<{ count: number | string }>) => {
        outsideQuerySettled = true
        return Number(rows[0]?.count ?? -1)
      })

    await delay(WAIT_PROBE_MS)
    assert.equal(outsideQuerySettled, false, 'QueryRunner 活动事务外的查询必须等待写租约释放')
    assert.ok(coordinator.snapshot().pendingWrites >= 1, '事务外查询应进入同一有界队列')

    await queryRunner.rollbackTransaction()
    assert.equal(await outsideQuery, 0, 'QueryRunner 回滚后，事务外查询不得观察到未提交数据')
  } finally {
    await rollbackIfActive(queryRunner)
    await queryRunner.release().catch(() => undefined)
    await outsideQuery?.catch(() => undefined)
  }

  pass('QueryRunner 长事务会阻塞事务外查询，回滚后不泄露未提交数据')
}

const verifyConcurrentQueryRunnerTransactions = async (
  dataSource: DataSource,
  coordinator: TransactionCoordinator,
): Promise<void> => {
  const firstRunner = dataSource.createQueryRunner()
  const secondRunner = dataSource.createQueryRunner()
  let secondTransactionStarted = false
  let secondStart: Promise<void> | undefined

  try {
    assert.notEqual(firstRunner, secondRunner, '每次 createQueryRunner 必须返回独立的逻辑事务所有者')
    await firstRunner.startTransaction()
    secondStart = secondRunner.startTransaction().then(() => {
      secondTransactionStarted = true
    })

    await delay(WAIT_PROBE_MS)
    assert.equal(secondTransactionStarted, false, '第二个 QueryRunner 事务必须等待首个事务结束')
    assert.ok(coordinator.snapshot().pendingWrites >= 1, '第二个 QueryRunner 事务应进入写队列')

    await firstRunner.commitTransaction()
    await secondStart
    assert.equal(secondRunner.isTransactionActive, true, '首个事务提交后，第二个事务应正常启动')
    await secondRunner.rollbackTransaction()
  } finally {
    await rollbackIfActive(firstRunner)
    await secondStart?.catch(() => undefined)
    await rollbackIfActive(secondRunner)
    await firstRunner.release().catch(() => undefined)
    await secondRunner.release().catch(() => undefined)
  }

  pass('多个 QueryRunner 事务共用同一有界写队列并按租约顺序执行')
}

const verifyQueryRunnerManagerAndNestedTransaction = async (
  dataSource: DataSource,
): Promise<void> => {
  const queryRunner = dataSource.createQueryRunner()
  let outsideQuerySettled = false
  let outsideQuery: Promise<number> | undefined

  try {
    await queryRunner.startTransaction()
    await queryRunner.startTransaction()
    await queryRunner.manager.query(
      'INSERT INTO transaction_coordinator_probe (id, label) VALUES (?, ?)',
      [3, 'manager 与 QueryBuilder'],
    )

    const insideRow = await queryRunner.manager
      .createQueryBuilder()
      .select('COUNT(*)', 'count')
      .from('transaction_coordinator_probe', 'probe')
      .where('probe.id = :id', { id: 3 })
      .clone()
      .getRawOne<{ count: number | string }>()
    assert.equal(Number(insideRow?.count ?? -1), 1, 'QueryRunner manager 的 QueryBuilder 应复用当前事务租约')

    outsideQuery = dataSource
      .query('SELECT COUNT(*) AS count FROM transaction_coordinator_probe WHERE id = ?', [3])
      .then((rows: Array<{ count: number | string }>) => {
        outsideQuerySettled = true
        return Number(rows[0]?.count ?? -1)
      })

    await queryRunner.commitTransaction()
    await delay(WAIT_PROBE_MS)
    assert.equal(outsideQuerySettled, false, '提交内层 savepoint 后仍应由外层事务持有租约')

    await queryRunner.commitTransaction()
    assert.equal(await outsideQuery, 1, '提交最外层事务后，事务外查询应看到已提交数据')
  } finally {
    await rollbackIfActive(queryRunner)
    await queryRunner.release().catch(() => undefined)
    await outsideQuery?.catch(() => undefined)
  }

  pass('QueryRunner manager/QueryBuilder 与嵌套事务均复用同一长事务租约')
}

const verifyReleaseRollsBackAndReleasesLease = async (
  dataSource: DataSource,
  coordinator: TransactionCoordinator,
): Promise<void> => {
  const queryRunner = dataSource.createQueryRunner()
  await queryRunner.startTransaction()
  await queryRunner.query(
    'INSERT INTO transaction_coordinator_probe (id, label) VALUES (?, ?)',
    [2, 'release 清理'],
  )

  await queryRunner.release()
  await coordinator.waitForIdle()

  const rows = await dataSource.query(
    'SELECT COUNT(*) AS count FROM transaction_coordinator_probe WHERE id = ?',
    [2],
  ) as Array<{ count: number | string }>
  assert.equal(Number(rows[0]?.count ?? -1), 0, 'release 必须回滚未完成的 QueryRunner 事务')
  assert.equal(coordinator.snapshot().activeWrites, 0, 'release 后不得残留活动写租约')

  pass('QueryRunner.release 会回滚未完成事务并释放写租约')
}

const verifyRawTransactionSqlIsRejected = async (dataSource: DataSource): Promise<void> => {
  let dataSourceTransactionStarted = false
  try {
    await assert.rejects(
      async () => {
        await dataSource.query('/* issue #41 */ ; BEGIN IMMEDIATE')
        dataSourceTransactionStarted = true
      },
      /禁止通过 DataSource\.query 直接控制事务边界/,
    )
  } finally {
    if (dataSourceTransactionStarted) {
      await dataSource.query('ROLLBACK').catch(() => undefined)
    }
  }

  const queryRunner = dataSource.createQueryRunner()
  let queryRunnerTransactionStarted = false
  try {
    await assert.rejects(
      async () => {
        await queryRunner.query('-- issue #41\nSAVEPOINT manual_transaction')
        queryRunnerTransactionStarted = true
      },
      /禁止通过 QueryRunner\.query 直接控制事务边界/,
    )
  } finally {
    if (queryRunnerTransactionStarted) {
      await queryRunner.query('ROLLBACK').catch(() => undefined)
    }
    await queryRunner.release().catch(() => undefined)
  }

  pass('DataSource.query 与 QueryRunner.query 的原始事务控制 SQL 已被运行时拒绝')
}

const main = async () => {
  const { dataSource, coordinator } = await createVerifyDataSource()
  try {
    await verifyQueryRunnerBlocksOutsideQueries(dataSource, coordinator)
    await verifyConcurrentQueryRunnerTransactions(dataSource, coordinator)
    await verifyQueryRunnerManagerAndNestedTransaction(dataSource)
    await verifyReleaseRollsBackAndReleasesLease(dataSource, coordinator)
    await verifyRawTransactionSqlIsRejected(dataSource)
  } finally {
    await dataSource.destroy()
  }

  console.log('事务协调器 QueryRunner 覆盖回归通过')
}

main().catch((error) => {
  console.error('事务协调器 QueryRunner 覆盖回归失败：', error)
  process.exitCode = 1
})
