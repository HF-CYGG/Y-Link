/**
 * 模块说明：backend/src/config/transaction-runner.ts
 * 文件职责：为全库写事务提供统一入口，并在 SQLite 方言下把并发写事务串行化。
 * 实现逻辑：
 * - TypeORM 的 sqlite 驱动只持有**一条**连接，`AppDataSource.transaction()` 的 BEGIN/COMMIT 也走这条连接。
 *   Node 的异步调度会让两个事务的语句交错，于是后进入的 `BEGIN TRANSACTION` 撞上尚未提交的事务，
 *   直接抛 `SQLITE_ERROR: cannot start a transaction within a transaction`；
 *   即便绕过这一步（TypeORM 检测到活跃事务后改用 SAVEPOINT），交错也会让 savepoint 栈的
 *   进出顺序错乱而抛 `no such savepoint`。这类错误无法靠重试自愈——一旦交错发生，栈本身已经乱了，
 *   因此唯一可靠的解法是让写事务排队，一次只跑一个。
 * - MySQL 走连接池，每个事务独占一条连接，本就不存在该问题，因此这里直接透传，不引入任何额外排队。
 * 维护说明：
 * - **新增写事务一律用 `runInTransaction`，不要直接调用 `AppDataSource.transaction`**，
 *   否则该事务会绕过闸门，重新引入上述并发失败；
 * - 闸门带重入放行（见 `transactionDepth`）：事务体内若再次进入本函数，直接执行而不排队，
 *   避免"外层持锁、内层排队"造成自死锁。现有代码遵循"事务内调用下游方法时透传 manager"的约定、
 *   实测无嵌套，这里的重入放行是给未来新代码兜底的，不是常规路径。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { EntityManager } from 'typeorm'
import { AppDataSource } from './data-source.js'

/** 记录当前异步上下文所处的事务嵌套深度，用于重入放行判断。 */
const transactionDepth = new AsyncLocalStorage<number>()

/**
 * SQLite 串行化队列：始终指向"最后一个入队任务"的 promise。
 * 新任务挂在它后面，从而保证同一时刻只有一个写事务在跑。
 * 两个分支都用 `() => run()`（成功和失败都继续），避免前一个事务失败后整条链被永久拒绝。
 */
let sqliteWriteQueue: Promise<unknown> = Promise.resolve()

const isSqlite = (): boolean => AppDataSource.options.type === 'sqlite'

/**
 * 统一的写事务入口。
 *
 * @param runInManager 事务体，收到的 `manager` 必须透传给所有下游调用，
 *                     不要在其中直接使用 `AppDataSource.getRepository(...)`——那会走另一条连接、
 *                     读不到本事务未提交的数据。
 */
export async function runInTransaction<T>(
  runInManager: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const execute = () => AppDataSource.transaction(runInManager)

  if (!isSqlite()) {
    return execute()
  }

  const depth = transactionDepth.getStore() ?? 0
  if (depth > 0) {
    // 已经在闸门内：再排队会等一个永远不会结束的自己。
    return execute()
  }

  const runWithDepth = () => transactionDepth.run(depth + 1, execute)
  const scheduled = sqliteWriteQueue.then(runWithDepth, runWithDepth)
  // 队列本身只用于排序，必须吞掉结果与异常，否则一次失败会毒化后续所有事务。
  sqliteWriteQueue = scheduled.then(() => undefined, () => undefined)
  return scheduled
}

/**
 * 仅供测试与诊断：等待当前排队中的 SQLite 写事务全部结束。
 * 业务代码不需要调用它。
 */
export async function waitForPendingWriteTransactions(): Promise<void> {
  await sqliteWriteQueue
}
