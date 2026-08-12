export interface VersionedMigration {
  readonly version: number;
}

export interface MigrationRuntime<TMigration extends VersionedMigration, TTransaction> {
  getCurrentVersion(): Promise<number>;
  withExclusiveTransaction(task: (transaction: TTransaction) => Promise<void>): Promise<void>;
  executeMigration(migration: TMigration, transaction: TTransaction): Promise<void>;
  setVersion(transaction: TTransaction, version: number): Promise<void>;
}

/**
 * 在接触数据库前校验完整迁移清单，并返回不修改原数组的升序副本。
 * 版本允许跳号，便于预留或撤销尚未发布的迁移号；实际执行始终严格递增。
 */
export function validateMigrationPlan<TMigration extends VersionedMigration>(
  migrations: readonly TMigration[],
): readonly TMigration[] {
  const versions = new Set<number>();

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error(`迁移版本必须是正安全整数：${migration.version}`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`迁移版本不能重复：${migration.version}`);
    }
    versions.add(migration.version);
  }

  return [...migrations].sort((left, right) => left.version - right.version);
}

export async function runMigrationPlan<TMigration extends VersionedMigration, TTransaction>(
  migrations: readonly TMigration[],
  runtime: MigrationRuntime<TMigration, TTransaction>,
): Promise<number> {
  const validatedPlan = validateMigrationPlan(migrations);
  let currentVersion = await runtime.getCurrentVersion();

  for (const migration of validatedPlan) {
    if (migration.version <= currentVersion) {
      continue;
    }

    await runtime.withExclusiveTransaction(async (transaction) => {
      await runtime.executeMigration(migration, transaction);
      await runtime.setVersion(transaction, migration.version);
    });
    currentVersion = migration.version;
  }

  return currentVersion;
}
