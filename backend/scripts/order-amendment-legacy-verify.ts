/**
 * 模块说明：Issue #72 历史 SQLite 订单升级专项验证。
 * 文件职责：从不含 businessNo/editVersion/永久占号表的真实旧结构启动，验证自动升级、原值回填与重复执行安全。
 * 实现逻辑：先用当前实体建立完整夹具，再降级为旧结构，最后只通过正式 bootstrap 恢复并核对业务不变量。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqliteRoot = path.resolve(process.cwd(), 'data', 'local-dev')
const sqlitePath = path.resolve(sqliteRoot, `order-amendment-legacy-${verifySeed}.sqlite`)
const orderUuid = '00000000-0000-4000-8000-000000000072'
const legacyShowNo = 'hyyzjd000072'

process.env.APP_PROFILE = `order-amendment-legacy-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const [{ AppDataSource }, { backfillSqliteOrderAmendmentData, initializeDatabaseSchemaIfNeeded }] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
  ])

  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    await AppDataSource.query(
      `INSERT INTO "biz_outbound_order"
       ("order_uuid", "show_no", "business_no", "edit_version", "order_type", "has_customer_order",
        "is_system_applied", "issuer_name", "customer_department_name", "idempotency_key", "customer_name",
        "remark", "total_qty", "total_amount", "is_deleted", "created_at", "updated_at")
       VALUES (?, ?, ?, 1, 'department', 1, 1, '历史验证员', '总院/历史部门', ?, NULL, NULL, 1, 9.9, 0,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [orderUuid, legacyShowNo, legacyShowNo, `legacy-${verifySeed}`],
    )
    await AppDataSource.query('DROP TABLE "order_business_no_occupancy"')
    await AppDataSource.query('DROP TABLE "order_revision"')
    await AppDataSource.query('DROP INDEX "uk_biz_outbound_business_no"')
    await AppDataSource.query('ALTER TABLE "biz_outbound_order" DROP COLUMN "business_no"')
    await AppDataSource.query('ALTER TABLE "biz_outbound_order" DROP COLUMN "edit_version"')

    const firstResult = await initializeDatabaseSchemaIfNeeded(AppDataSource)
    assert.equal(firstResult.action, 'synchronized')
    const orderRows = await AppDataSource.query(
      'SELECT "show_no" AS "showNo", "business_no" AS "businessNo", "edit_version" AS "editVersion" FROM "biz_outbound_order" WHERE "order_uuid" = ?',
      [orderUuid],
    ) as Array<{ showNo: string; businessNo: string; editVersion: number }>
    assert.equal(orderRows[0]?.showNo, legacyShowNo)
    assert.equal(orderRows[0]?.businessNo, legacyShowNo, '历史业务号必须初始回填 showNo 原值')
    assert.equal(Number(orderRows[0]?.editVersion), 1)

    const occupancyRows = await AppDataSource.query(
      'SELECT "business_namespace" AS "namespace", "serial_value" AS "serialValue", "order_uuid" AS "orderUuid" FROM "order_business_no_occupancy" WHERE "business_no" = ?',
      [legacyShowNo],
    ) as Array<{ namespace: string; serialValue: number; orderUuid: string }>
    assert.equal(occupancyRows.length, 1)
    assert.deepEqual(
      [occupancyRows[0]?.namespace, Number(occupancyRows[0]?.serialValue), occupancyRows[0]?.orderUuid],
      ['hyyzjd', 72, orderUuid],
    )
    const sequenceRows = await AppDataSource.query(
      'SELECT "current_value" AS "currentValue" FROM "business_sequence" WHERE "sequence_key" = ?',
      ['order.business.department'],
    ) as Array<{ currentValue: number }>
    assert.equal(Number(sequenceRows[0]?.currentValue), 72)

    await AppDataSource.query(
      `UPDATE "order_business_no_occupancy"
       SET "business_namespace" = 'hyyz', "serial_value" = 720072
       WHERE "business_no" = ?`,
      [legacyShowNo],
    )
    await assert.rejects(
      () => backfillSqliteOrderAmendmentData(AppDataSource),
      /业务号永久占用存在冲突/,
      '幂等回填必须拒绝命名空间或流水与订单不一致的部分占用记录',
    )
    await AppDataSource.query(
      `UPDATE "order_business_no_occupancy"
       SET "business_namespace" = 'hyyzjd', "serial_value" = 72
       WHERE "business_no" = ?`,
      [legacyShowNo],
    )

    await AppDataSource.query(
      `INSERT INTO "system_configs" ("config_key", "config_value", "config_group", "remark", "created_at", "updated_at")
       VALUES ('order.serial.walkin.start', '50', 'order_serial', '专项验证自定义起始号', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT("config_key") DO UPDATE SET "config_value" = '50', "updated_at" = CURRENT_TIMESTAMP`,
    )
    await AppDataSource.query(
      'DELETE FROM "business_sequence" WHERE "sequence_key" = ?',
      ['order.business.walkin'],
    )
    await backfillSqliteOrderAmendmentData(AppDataSource)
    const emptyNamespaceSequenceRows = await AppDataSource.query(
      'SELECT "current_value" AS "currentValue" FROM "business_sequence" WHERE "sequence_key" = ?',
      ['order.business.walkin'],
    ) as Array<{ currentValue: number }>
    assert.equal(
      Number(emptyNamespaceSequenceRows[0]?.currentValue),
      49,
      '空命名空间游标必须从自定义 start - 1 初始化',
    )

    const secondResult = await initializeDatabaseSchemaIfNeeded(AppDataSource)
    assert.equal(secondResult.action, 'skipped')
    const occupancyCounts = await AppDataSource.query(
      'SELECT COUNT(1) AS "total" FROM "order_business_no_occupancy" WHERE "business_no" = ?',
      [legacyShowNo],
    ) as Array<{ total: number }>
    assert.equal(Number(occupancyCounts[0]?.total), 1, '重复 bootstrap 不得重复占号')
    console.log('✅ Issue #72 历史 SQLite 订单升级专项验证通过')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    fs.rmSync(sqlitePath, { force: true })
  }
}

main().catch((error) => {
  console.error('❌ Issue #72 历史 SQLite 订单升级专项验证失败', error)
  process.exitCode = 1
})
