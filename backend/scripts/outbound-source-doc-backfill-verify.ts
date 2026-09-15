/**
 * 文件说明：backend/scripts/outbound-source-doc-backfill-verify.ts
 * 文件职责：线上预订核销出库单来源快照回填专项验收（Issue #70）。
 * 实现逻辑：
 * 1. 以最小化 SQLite 旧库夹具模拟历史正式出库单、明细与预订单，调用 backfillSqliteOrderSourceDocs；
 * 2. 断言仅逐字节等于系统自动文案的主单/明细备注被清理，人工备注、带人工追加内容、无法确认来源与非数字幂等键一律保留；
 * 3. 断言合并父单中复制自来源单的明细按来源主单判断，重复执行幂等且不会清理之后人工写回的同样文案，更新时间不被改写；
 * 4. 静态校验 MySQL 046 迁移使用二进制精确比较、仅处理未回填主单，并已登记自动迁移白名单与结构契约。
 * 维护说明：调整来源字段或自动文案识别规则时，必须同步更新本脚本与 sql/046_outbound_order_source_doc.sql。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sqlite3 from 'sqlite3'

const runId = `${process.pid}-${Date.now()}`
const runtimeDir = path.join(os.tmpdir(), `ylink-source-doc-backfill-${runId}`)
const databasePath = path.join(runtimeDir, 'source-doc.sqlite')
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `source-doc-backfill-${runId}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = databasePath
process.env.Y_LINK_DATA_DIR = runtimeDir

fs.mkdirSync(runtimeDir, { recursive: true })

const AUTO_ORDER = (showNo: string) => `线上预订核销出库，预订单号：${showNo}`
const AUTO_ITEM = (showNo: string) => `线上预订核销，预订单号：${showNo}`

const createFixture = () => new Promise<void>((resolve, reject) => {
  const database = new sqlite3.Database(databasePath, (openError) => {
    if (openError) {
      reject(openError)
      return
    }
    const quote = (value: string | null) => (value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`)
    database.exec(
      `
        CREATE TABLE o2o_preorder (id INTEGER PRIMARY KEY, show_no varchar(48) NOT NULL);
        INSERT INTO o2o_preorder (id, show_no) VALUES (1, 'hyyz000037'), (2, 'hyyz000038'), (3, 'hyyz000039'), (12, 'hyyz000012');

        CREATE TABLE biz_outbound_order (
          id INTEGER PRIMARY KEY,
          idempotency_key varchar(128) NOT NULL,
          remark varchar(500),
          source_doc_type varchar(32),
          source_doc_id integer,
          source_doc_no varchar(64),
          updated_at datetime NOT NULL
        );
        INSERT INTO biz_outbound_order (id, idempotency_key, remark, updated_at) VALUES
          (1, 'o2o-preorder-verify:1', ${quote(AUTO_ORDER('hyyz000037'))}, '2020-01-01 00:00:00'),
          (2, 'o2o-preorder-verify:2', ${quote(`${AUTO_ORDER('hyyz000038')}；客户要求加急`)}, '2020-01-01 00:00:00'),
          (3, 'o2o-preorder-verify:3', '人工备注', '2020-01-01 00:00:00'),
          (4, 'o2o-preorder-verify:999', ${quote(AUTO_ORDER('hyyz000999'))}, '2020-01-01 00:00:00'),
          (5, 'manual-order-5', ${quote(AUTO_ORDER('hyyz000037'))}, '2020-01-01 00:00:00'),
          (6, 'o2o-preorder-verify:12abc', ${quote(AUTO_ORDER('hyyz000012'))}, '2020-01-01 00:00:00'),
          (7, 'o2o-preorder-verify:12', NULL, '2020-01-01 00:00:00');

        CREATE TABLE biz_outbound_order_item (
          id INTEGER PRIMARY KEY,
          order_id integer NOT NULL,
          source_order_id integer,
          remark varchar(200),
          updated_at datetime NOT NULL
        );
        INSERT INTO biz_outbound_order_item (id, order_id, source_order_id, remark, updated_at) VALUES
          (1, 1, NULL, ${quote(AUTO_ITEM('hyyz000037'))}, '2020-01-01 00:00:00'),
          (2, 2, NULL, ${quote(`${AUTO_ITEM('hyyz000038')}（人工补充）`)}, '2020-01-01 00:00:00'),
          (3, 4, NULL, ${quote(AUTO_ITEM('hyyz000999'))}, '2020-01-01 00:00:00'),
          (4, 7, 1, ${quote(AUTO_ITEM('hyyz000037'))}, '2020-01-01 00:00:00'),
          (5, 7, NULL, ${quote(AUTO_ITEM('hyyz000012'))}, '2020-01-01 00:00:00'),
          (6, 5, NULL, ${quote(AUTO_ITEM('hyyz000037'))}, '2020-01-01 00:00:00'),
          (7, 3, NULL, NULL, '2020-01-01 00:00:00');
      `,
      (sqlError) => {
        database.close()
        sqlError ? reject(sqlError) : resolve()
      },
    )
  })
})

const main = async () => {
  await createFixture()
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { backfillSqliteOrderSourceDocs, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await runAssertions(AppDataSource, backfillSqliteOrderSourceDocs)
  } finally {
    // 断言失败时也必须释放 SQLite 句柄，否则 Windows 下清理临时目录会因文件占用失败并掩盖真实错误。
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  }
}

const runAssertions = async (
  AppDataSource: typeof import('../src/config/data-source.js')['AppDataSource'],
  backfillSqliteOrderSourceDocs: typeof import('../src/config/database-bootstrap.js')['backfillSqliteOrderSourceDocs'],
) => {
  const readOrders = async () => AppDataSource.query(
    'SELECT id, remark, source_doc_type AS sourceDocType, source_doc_id AS sourceDocId, source_doc_no AS sourceDocNo, updated_at AS updatedAt FROM biz_outbound_order ORDER BY id',
  ) as Promise<Array<{ id: number; remark: string | null; sourceDocType: string | null; sourceDocId: number | null; sourceDocNo: string | null; updatedAt: string }>>
  const readItems = async () => AppDataSource.query(
    'SELECT id, remark, updated_at AS updatedAt FROM biz_outbound_order_item ORDER BY id',
  ) as Promise<Array<{ id: number; remark: string | null; updatedAt: string }>>

  const firstRun = await backfillSqliteOrderSourceDocs(AppDataSource)
  assert.deepEqual(firstRun, { clearedItemRemarks: 3, backfilledOrders: 4 }, '首次回填应清理 3 条明细自动备注并回填 4 张可确认来源的主单')

  const orders = await readOrders()
  assert.deepEqual(
    orders.map((item) => [item.id, item.remark, item.sourceDocType, item.sourceDocId === null ? null : Number(item.sourceDocId), item.sourceDocNo]),
    [
      [1, null, 'o2o_preorder', 1, 'hyyz000037'],
      [2, `${AUTO_ORDER('hyyz000038')}；客户要求加急`, 'o2o_preorder', 2, 'hyyz000038'],
      [3, '人工备注', 'o2o_preorder', 3, 'hyyz000039'],
      [4, AUTO_ORDER('hyyz000999'), null, null, null],
      [5, AUTO_ORDER('hyyz000037'), null, null, null],
      [6, AUTO_ORDER('hyyz000012'), null, null, null],
      [7, null, 'o2o_preorder', 12, 'hyyz000012'],
    ],
    '主单只清理逐字节等于自动文案的备注，无法确认来源与非数字幂等键不得回填',
  )
  assert.ok(orders.every((item) => item.updatedAt === '2020-01-01 00:00:00'), '回填不得改写主单更新时间')

  const items = await readItems()
  assert.deepEqual(
    items.map((item) => [item.id, item.remark]),
    [
      [1, null],
      [2, `${AUTO_ITEM('hyyz000038')}（人工补充）`],
      [3, AUTO_ITEM('hyyz000999')],
      [4, null],
      [5, null],
      [6, AUTO_ITEM('hyyz000037')],
      [7, null],
    ],
    '明细只清理血缘主单可确认来源且逐字节等于自动文案的备注，合并复制行按来源主单判断',
  )
  assert.ok(items.every((item) => item.updatedAt === '2020-01-01 00:00:00'), '回填不得改写明细更新时间')

  // 回填完成后人工写回与自动文案相同的备注，再次执行不得清理。
  await AppDataSource.query('UPDATE biz_outbound_order SET remark = ? WHERE id = 1', [AUTO_ORDER('hyyz000037')])
  await AppDataSource.query('UPDATE biz_outbound_order_item SET remark = ? WHERE id = 1', [AUTO_ITEM('hyyz000037')])
  const secondRun = await backfillSqliteOrderSourceDocs(AppDataSource)
  assert.deepEqual(secondRun, { clearedItemRemarks: 0, backfilledOrders: 0 }, '重复执行必须幂等')
  assert.equal((await readOrders())[0]!.remark, AUTO_ORDER('hyyz000037'), '已回填主单的人工写回备注不得被再次清理')
  assert.equal((await readItems())[0]!.remark, AUTO_ITEM('hyyz000037'), '已回填主单下的人工写回明细备注不得被再次清理')

  const mysqlMigration = fs.readFileSync(path.join(backendRoot, 'sql/046_outbound_order_source_doc.sql'), 'utf8')
  assert.match(mysqlMigration, /information_schema\.COLUMNS/, '046 必须使用 information_schema 幂等补列')
  assert.doesNotMatch(mysqlMigration, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i, 'MySQL 8.4 不支持 ADD COLUMN IF NOT EXISTS')
  assert.match(mysqlMigration, /CAST\(i\.`remark` AS BINARY\) = CAST\(CONCAT\('线上预订核销，预订单号：', p\.`show_no`\) AS BINARY\)/, '明细清理必须逐字节精确比较')
  assert.match(mysqlMigration, /CAST\(o\.`remark` AS BINARY\) = CAST\(CONCAT\('线上预订核销出库，预订单号：', p\.`show_no`\) AS BINARY\)/, '主单清理必须逐字节精确比较')
  assert.match(mysqlMigration, /lineage\.`source_doc_type` IS NULL/, '明细清理必须以血缘主单未回填为一次性判断依据')
  assert.match(mysqlMigration, /WHERE o\.`source_doc_type` IS NULL/, '主单回填必须只处理未回填主单')
  assert.ok(mysqlMigration.indexOf('UPDATE `biz_outbound_order_item`') < mysqlMigration.indexOf('UPDATE `biz_outbound_order` AS o'), '必须先清理明细再回填主单')
  assert.doesNotMatch(mysqlMigration, /DELETE\s+FROM|DROP\s+TABLE/i, '046 不得删除任何数据')

  const migrationRunner = fs.readFileSync(path.join(backendRoot, 'src/config/mysql-migration-runner.ts'), 'utf8')
  assert.match(migrationRunner, /'046_outbound_order_source_doc\.sql',\s*\n\]/, '046 必须登记到自动迁移白名单末尾')
  for (const column of ['source_doc_type', 'source_doc_id', 'source_doc_no', 'idx_biz_outbound_source_doc']) {
    assert.ok(migrationRunner.includes(column), `MySQL 结构契约缺少 ${column}`)
  }

  console.log('OK 线上预订核销出库单来源快照回填、自动备注精确清理、幂等与 046 迁移契约验收通过')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })
