import assert from 'node:assert/strict';
import test from 'node:test';

import { runMigrationPlan, validateMigrationPlan } from './migration-runner.ts';

const MAX_SQLITE_USER_VERSION = 2_147_483_647;

test('迁移计划允许版本跳号并按版本严格升序执行', async () => {
  const input = [{ version: 3 }, { version: 1 }];
  const calls = [];

  const version = await runMigrationPlan(input, {
    getCurrentVersion: async () => 0,
    withExclusiveTransaction: async (task) => {
      calls.push('begin');
      await task({ id: calls.length });
      calls.push('commit');
    },
    executeMigration: async (migration) => {
      calls.push(`migrate:${migration.version}`);
    },
    setVersion: async (_transaction, nextVersion) => {
      calls.push(`version:${nextVersion}`);
    },
  });

  assert.equal(version, 3);
  assert.deepEqual(input.map(({ version: itemVersion }) => itemVersion), [3, 1]);
  assert.deepEqual(calls, [
    'begin',
    'migrate:1',
    'version:1',
    'commit',
    'begin',
    'migrate:3',
    'version:3',
    'commit',
  ]);
});

test('迁移计划拒绝超出 SQLite user_version 正整数范围的版本', () => {
  for (const invalidVersion of [
    Number.NaN,
    0,
    -1,
    1.5,
    MAX_SQLITE_USER_VERSION + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => validateMigrationPlan([{ version: invalidVersion }]),
      /迁移版本必须是 1 到 2147483647 之间的整数/,
    );
  }
});

test('迁移版本接受 SQLite user_version 的 32 位正整数上界', () => {
  assert.deepEqual(validateMigrationPlan([{ version: MAX_SQLITE_USER_VERSION }]), [
    { version: MAX_SQLITE_USER_VERSION },
  ]);
});

test('迁移计划拒绝重复版本', () => {
  assert.throws(
    () => validateMigrationPlan([{ version: 2 }, { version: 2 }]),
    /迁移版本不能重复/,
  );
});

test('完整清单校验失败时不触发任何数据库或迁移副作用', async () => {
  let sideEffectCount = 0;

  await assert.rejects(
    () =>
      runMigrationPlan([{ version: 1 }, { version: Number.NaN }], {
        getCurrentVersion: async () => {
          sideEffectCount += 1;
          return 0;
        },
        withExclusiveTransaction: async (task) => {
          sideEffectCount += 1;
          await task({});
        },
        executeMigration: async () => {
          sideEffectCount += 1;
        },
        setVersion: async () => {
          sideEffectCount += 1;
        },
      }),
    /迁移版本必须是 1 到 2147483647 之间的整数/,
  );

  assert.equal(sideEffectCount, 0);
});

test('数据库当前版本必须是 0 到 SQLite user_version 上界之间的整数', async () => {
  for (const currentVersion of [
    Number.NaN,
    -1,
    1.5,
    MAX_SQLITE_USER_VERSION + 1,
  ]) {
    let transactionCount = 0;

    await assert.rejects(
      () =>
        runMigrationPlan([{ version: 1 }], {
          getCurrentVersion: async () => currentVersion,
          withExclusiveTransaction: async () => {
            transactionCount += 1;
          },
          executeMigration: async () => {},
          setVersion: async () => {},
        }),
      /数据库当前版本必须是 0 到 2147483647 之间的整数/,
    );
    assert.equal(transactionCount, 0);
  }
});

test('数据库当前版本接受 SQLite user_version 的 32 位整数上界', async () => {
  const version = await runMigrationPlan([{ version: MAX_SQLITE_USER_VERSION }], {
    getCurrentVersion: async () => MAX_SQLITE_USER_VERSION,
    withExclusiveTransaction: async () => assert.fail('不应开启事务'),
    executeMigration: async () => assert.fail('不应执行迁移'),
    setVersion: async () => assert.fail('不应写版本'),
  });

  assert.equal(version, MAX_SQLITE_USER_VERSION);
});

test('空迁移清单仅允许全新版本 0', async () => {
  const runtime = {
    getCurrentVersion: async () => 0,
    withExclusiveTransaction: async () => assert.fail('不应开启事务'),
    executeMigration: async () => assert.fail('不应执行迁移'),
    setVersion: async () => assert.fail('不应写版本'),
  };

  assert.equal(await runMigrationPlan([], runtime), 0);

  await assert.rejects(
    () => runMigrationPlan([], { ...runtime, getCurrentVersion: async () => 1 }),
    /数据库版本 1 高于代码支持的最高迁移版本 0/,
  );
});

test('数据库版本高于代码支持版本时拒绝降级且不开启事务', async () => {
  let transactionCount = 0;

  await assert.rejects(
    () =>
      runMigrationPlan([{ version: 1 }, { version: 3 }], {
        getCurrentVersion: async () => 4,
        withExclusiveTransaction: async () => {
          transactionCount += 1;
        },
        executeMigration: async () => {},
        setVersion: async () => {},
      }),
    /数据库版本 4 高于代码支持的最高迁移版本 3/,
  );
  assert.equal(transactionCount, 0);
});

test('exclusive 事务启动失败时不执行迁移或版本写入', async () => {
  const calls = [];

  await assert.rejects(
    () =>
      runMigrationPlan([{ version: 1 }], {
        getCurrentVersion: async () => 0,
        withExclusiveTransaction: async () => {
          calls.push('transaction');
          throw new Error('事务启动失败');
        },
        executeMigration: async () => calls.push('migration'),
        setVersion: async () => calls.push('version'),
      }),
    /事务启动失败/,
  );
  assert.deepEqual(calls, ['transaction']);
});

test('exclusive 事务提交失败时不执行后续迁移', async () => {
  const calls = [];

  await assert.rejects(
    () =>
      runMigrationPlan([{ version: 1 }, { version: 2 }], {
        getCurrentVersion: async () => 0,
        withExclusiveTransaction: async (task) => {
          await task({});
          throw new Error('事务提交失败');
        },
        executeMigration: async (migration) => calls.push(`migration:${migration.version}`),
        setVersion: async (_transaction, version) => calls.push(`version:${version}`),
      }),
    /事务提交失败/,
  );
  assert.deepEqual(calls, ['migration:1', 'version:1']);
});

test('迁移失败时不写当前版本且不执行后续迁移', async () => {
  const calls = [];

  await assert.rejects(
    () =>
      runMigrationPlan([{ version: 1 }, { version: 2 }], {
        getCurrentVersion: async () => 0,
        withExclusiveTransaction: async (task) => task({}),
        executeMigration: async (migration) => {
          calls.push(`migration:${migration.version}`);
          throw new Error('迁移失败');
        },
        setVersion: async (_transaction, version) => calls.push(`version:${version}`),
      }),
    /迁移失败/,
  );
  assert.deepEqual(calls, ['migration:1']);
});
