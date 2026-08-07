/**
 * 模块说明：backend/src/config/transaction-runner.ts
 * 文件职责：为服务层提供统一写事务入口，并兼容调用数据库基础设施中的事务协调器。
 * 实现逻辑：
 * - 每次事务前幂等初始化数据库基础设施，验证 SQLite WAL/PRAGMA 或安装 MySQL 池保护；
 * - SQLite 统一复用有界单写队列，避免再叠加一条无界 Promise 队列而绕过过载保护；
 * - MySQL 仍由 TypeORM 连接池并发执行，事务协调器只负责 manager 上下文透传。
 * 维护说明：
 * - 新增服务层写事务优先使用 `runInTransaction`，事务回调内继续逐层透传 manager；
 * - 真正的串行、嵌套复用、队列上限和等待超时都只在 `transaction-coordinator.ts` 维护。
 */

import type { EntityManager } from 'typeorm'
import { AppDataSource } from './data-source.js'
import { initializeDatabaseInfrastructure } from '../database/database-strategy.js'

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
  await initializeDatabaseInfrastructure(AppDataSource)
  return AppDataSource.transaction(runInManager)
}

/**
 * 仅供测试与诊断：等待当前排队中的 SQLite 写事务全部结束。
 * 业务代码不需要调用它。
 */
export async function waitForPendingWriteTransactions(): Promise<void> {
  const coordinator = await initializeDatabaseInfrastructure(AppDataSource)
  await coordinator.waitForIdle()
}
