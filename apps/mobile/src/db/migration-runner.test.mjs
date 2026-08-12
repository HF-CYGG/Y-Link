import assert from 'node:assert/strict';
import test from 'node:test';

import { runMigrationPlan, validateMigrationPlan } from './migration-runner.ts';

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

test('迁移计划拒绝非正安全整数版本', () => {
  for (const invalidVersion of [Number.NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateMigrationPlan([{ version: invalidVersion }]),
      /迁移版本必须是正安全整数/,
    );
  }
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
    /迁移版本必须是正安全整数/,
  );

  assert.equal(sideEffectCount, 0);
});
