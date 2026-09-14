/**
 * 模块说明：Issue #71 数据迁移夹具专项验证。
 * 文件职责：直接执行全实体迁移夹具的 order_merge_relation 分支，确认同表双外键会生成两张不同订单。
 * 实现逻辑：在隔离 SQLite 中准备父单和操作记录，再复用真实 seedEmptyTable 生成关系并验证数据库约束。
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqliteRoot = path.resolve(process.cwd(), 'data', 'local-dev')
const sqlitePath = path.resolve(sqliteRoot, `order-merge-migration-fixture-${verifySeed}.sqlite`)

process.env.APP_PROFILE = 'verify-db-migration'
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DB_MIGRATION_E2E = 'true'
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

type QueryRow = Record<string, unknown>

async function main(): Promise<void> {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const [
    { AppDataSource },
    { initializeDatabaseSchemaIfNeeded },
    { BizOutboundOrder },
    { OrderMergeOperation },
    { seedEmptyTable },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/order-merge-operation.entity.js'),
    import('../src/commands/seed-database-migration-e2e.js'),
  ])

  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    await AppDataSource.query('ALTER TABLE `order_merge_operation` DROP COLUMN `result_json`')
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    const resultJsonColumns = await AppDataSource.query(
      "PRAGMA table_info('order_merge_operation')",
    ) as Array<{ name: string; notnull: number }>
    const resultJsonColumn = resultJsonColumns.find((column) => column.name === 'result_json')
    assert.equal(resultJsonColumn?.notnull, 1, 'SQLite 旧库兼容补列后必须将 result_json 收紧为 NOT NULL')

    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const operationRepo = AppDataSource.getRepository(OrderMergeOperation)
    const parent = await orderRepo.save(orderRepo.create({
      orderUuid: randomUUID(),
      showNo: 'hyyzjd900001',
      businessNo: 'hyyzjd900001',
      editVersion: 1,
      status: 'active',
      inventoryMode: 'manual_applied',
      orderType: 'department',
      hasCustomerOrder: false,
      isSystemApplied: false,
      issuerName: '迁移夹具验证员',
      customerDepartmentName: '总部 / 研发部',
      idempotencyKey: `migration-fixture-parent-${verifySeed}`,
      customerName: null,
      remark: 'Issue #71 定向迁移夹具',
      totalQty: '1.00',
      totalAmount: '12.34',
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deletedByUsername: null,
      deletedByDisplayName: null,
      creatorUserId: null,
      creatorUsername: null,
      creatorDisplayName: null,
    }))
    const operation = await operationRepo.save(operationRepo.create({
      operationUuid: randomUUID(),
      idempotencyKey: `migration-fixture-operation-${verifySeed}`,
      requestHash: '7'.repeat(64),
      targetOrderId: parent.id,
      targetOrderUuid: parent.orderUuid,
      targetEditVersion: parent.editVersion,
      mergedSourceOrderIdsJson: '[]',
      resultJson: '{}',
      reason: '验证双订单迁移夹具',
      actorUserId: null,
      actorUsername: 'migration-fixture',
      actorDisplayName: '迁移夹具验证员',
    }))

    const queryRunner = AppDataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      await queryRunner.query('PRAGMA foreign_keys = ON')
      const parentRows = await queryRunner.query(
        'SELECT * FROM `biz_outbound_order` WHERE `id` = ? LIMIT 1',
        [parent.id],
      ) as QueryRow[]
      const operationRows = await queryRunner.query(
        'SELECT * FROM `order_merge_operation` WHERE `id` = ? LIMIT 1',
        [operation.id],
      ) as QueryRow[]
      assert.ok(parentRows[0], '缺少父单夹具')
      assert.ok(operationRows[0], '缺少合并操作夹具')

      const relationMetadata = AppDataSource.getMetadata('order_merge_relation')
      const firstRows = new Map<string, QueryRow>([
        ['biz_outbound_order', parentRows[0]],
        ['order_merge_operation', operationRows[0]],
      ])
      await seedEmptyTable(queryRunner, relationMetadata, firstRows)

      const relationRows = await queryRunner.query(
        'SELECT * FROM `order_merge_relation` ORDER BY `id` ASC',
      ) as QueryRow[]
      assert.equal(relationRows.length, 1, '应生成一条合并关系夹具')
      const relation = relationRows[0]!
      assert.notEqual(relation.parent_order_id, relation.source_order_id, '父单与来源单必须是不同订单')
      assert.equal(relation.parent_order_uuid, parent.orderUuid, '父单 UUID 快照必须匹配父单')

      const sourceRows = await queryRunner.query(
        'SELECT * FROM `biz_outbound_order` WHERE `id` = ? LIMIT 1',
        [relation.source_order_id],
      ) as QueryRow[]
      assert.ok(sourceRows[0], '必须真实生成第二张来源订单')
      assert.equal(relation.source_order_uuid, sourceRows[0]!.order_uuid, '来源 UUID 快照必须匹配第二张订单')
      assert.equal(relation.source_business_no_snapshot, sourceRows[0]!.business_no, '来源业务单号快照必须匹配第二张订单')

      await assert.rejects(
        queryRunner.query(
          `INSERT INTO \`order_merge_relation\`
           (\`operation_id\`, \`parent_order_id\`, \`parent_order_uuid\`, \`parent_business_no_snapshot\`,
            \`source_order_id\`, \`source_order_uuid\`, \`source_business_no_snapshot\`, \`created_at\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [operation.id, parent.id, parent.orderUuid, parent.businessNo, parent.id, parent.orderUuid, parent.businessNo],
        ),
        'CHECK 必须拒绝 parent_order_id = source_order_id',
      )
      await assert.rejects(
        queryRunner.query(
          `INSERT INTO \`order_merge_relation\`
           (\`operation_id\`, \`parent_order_id\`, \`parent_order_uuid\`, \`parent_business_no_snapshot\`,
            \`source_order_id\`, \`source_order_uuid\`, \`source_business_no_snapshot\`, \`created_at\`)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [operation.id, relation.parent_order_id, relation.parent_order_uuid, relation.parent_business_no_snapshot,
            relation.source_order_id, relation.source_order_uuid, relation.source_business_no_snapshot],
        ),
        'UNIQUE 必须拒绝来源订单重复归并',
      )
      await assert.rejects(
        queryRunner.query('DELETE FROM `biz_outbound_order` WHERE `id` = ?', [parent.id]),
        'RESTRICT 必须拒绝物理删除关系父单',
      )
    } finally {
      await queryRunner.release()
    }

    console.log('order-merge:migration-fixture:verify 通过：SQLite 旧列收紧、真实 seed 双订单及 CHECK/UNIQUE/RESTRICT 均生效。')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    for (const candidate of [sqlitePath, `${sqlitePath}-shm`, `${sqlitePath}-wal`]) {
      if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true })
    }
  }
}

await main()
