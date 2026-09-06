/**
 * 文件说明：数据库事务协调器的历史兼容入口。
 * 实现逻辑：旧调用仍可使用 `installSqliteTransactionQueue`，内部统一转交数据库策略层，
 * 因而 MySQL 也能获得 manager 复用和连接池等待超时能力。
 * 维护重点：新代码优先直接调用 `initializeDatabaseInfrastructure`；删除本入口前需先迁移全部验证脚本。
 */

import type { DataSource } from 'typeorm'
import {
  initializeDatabaseInfrastructure,
} from '../database/database-strategy.js'
import type { TransactionCoordinator } from '../database/transaction-coordinator.js'

export function installSqliteTransactionQueue(
  dataSource: DataSource,
): Promise<TransactionCoordinator> {
  return initializeDatabaseInfrastructure(dataSource)
}
