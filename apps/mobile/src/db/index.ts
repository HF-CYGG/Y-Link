import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { runMigrationPlan } from './migration-runner';

const DATABASE_NAME = 'y-link-mobile.db';

export type DatabaseTransaction = Parameters<
  Parameters<SQLiteDatabase['withExclusiveTransactionAsync']>[0]
>[0];

export interface DatabaseMigration {
  version: number;
  migrate(transaction: DatabaseTransaction): Promise<void>;
}

export function openMobileDatabase(): Promise<SQLiteDatabase> {
  return openDatabaseAsync(DATABASE_NAME);
}

export async function getDatabaseVersion(database: SQLiteDatabase): Promise<number> {
  const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * 只允许由应用初始化链的单一入口 await 调用，并在该入口内串行完成全部迁移。
 * 页面、后台同步和 hydration 不得并发触发迁移，否则会破坏初始化时序约束。
 */
export async function migrateDatabase(
  database: SQLiteDatabase,
  migrations: readonly DatabaseMigration[] = [],
): Promise<number> {
  return runMigrationPlan<DatabaseMigration, DatabaseTransaction>(migrations, {
    getCurrentVersion: () => getDatabaseVersion(database),
    withExclusiveTransaction: (task) => database.withExclusiveTransactionAsync(task),
    executeMigration: (migration, transaction) => migration.migrate(transaction),
    setVersion: (transaction, version) =>
      transaction.execAsync(`PRAGMA user_version = ${version}`),
  });
}
