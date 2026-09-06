export interface VersionedMigration {
  readonly version: number;
}

export const MAX_SQLITE_USER_VERSION = 2_147_483_647;

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
    if (
      !Number.isInteger(migration.version) ||
      migration.version < 1 ||
      migration.version > MAX_SQLITE_USER_VERSION
    ) {
      throw new Error(
        `迁移版本必须是 1 到 ${MAX_SQLITE_USER_VERSION} 之间的整数：${migration.version}`,
      );
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
  if (
    !Number.isInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > MAX_SQLITE_USER_VERSION
  ) {
    throw new Error(
      `数据库当前版本必须是 0 到 ${MAX_SQLITE_USER_VERSION} 之间的整数：${currentVersion}`,
    );
  }

  const highestSupportedVersion = validatedPlan.at(-1)?.version ?? 0;
  if (currentVersion > highestSupportedVersion) {
    throw new Error(
      `数据库版本 ${currentVersion} 高于代码支持的最高迁移版本 ${highestSupportedVersion}，拒绝降级运行`,
    );
  }

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
