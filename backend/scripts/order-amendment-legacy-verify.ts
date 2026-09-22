/**
 * 模块说明：Issue #72/#110 历史 SQLite 订单升级专项验证。
 * 文件职责：从缺少 businessNo/editVersion 且仍残留永久占号表的旧结构启动，验证升级、释放迁移与重复执行安全。
 * 实现逻辑：先用当前实体建立夹具，再降级并补造 054 历史表，最后只通过正式 bootstrap 恢复。
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
      `INSERT INTO "system_configs" ("config_key", "config_value", "config_group", "remark", "created_at", "updated_at")
       VALUES ('order.serial.walkin.start', '50', 'order_serial', '专项验证自定义起始号', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT("config_key") DO UPDATE SET "config_value" = '50', "updated_at" = CURRENT_TIMESTAMP`,
    )
    await AppDataSource.query(
      `DELETE FROM "system_configs"
       WHERE "config_key" IN ('order.business.walkin.start', 'order.business.walkin.current', 'order.business.walkin.width')`,
    )
    await AppDataSource.query(
      'DELETE FROM "business_sequence" WHERE "sequence_key" = ?',
      ['order.business.walkin'],
    )
    await AppDataSource.query(
      `INSERT INTO "biz_outbound_order"
       ("order_uuid", "show_no", "business_no", "edit_version", "order_type", "has_customer_order",
        "is_system_applied", "issuer_name", "customer_department_name", "idempotency_key", "customer_name",
        "remark", "total_qty", "total_amount", "is_deleted", "created_at", "updated_at")
       VALUES (?, ?, ?, 1, 'department', 1, 1, '历史验证员', '总院/历史部门', ?, NULL, NULL, 1, 9.9, 0,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [orderUuid, legacyShowNo, legacyShowNo, `legacy-${verifySeed}`],
    )
    await AppDataSource.query(`CREATE TABLE "order_business_no_occupancy" (
      "id" integer PRIMARY KEY AUTOINCREMENT,
      "business_namespace" varchar(16) NOT NULL,
      "serial_value" integer NOT NULL,
      "business_no" varchar(32) NOT NULL,
      "order_uuid" varchar(36) NOT NULL,
      "created_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await AppDataSource.query(`CREATE TABLE "order_business_no_reuse_event" (
      "id" integer PRIMARY KEY AUTOINCREMENT,
      "business_no" varchar(32) NOT NULL,
      "created_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    await AppDataSource.query(
      `INSERT INTO "order_business_no_occupancy"
       ("business_namespace", "serial_value", "business_no", "order_uuid") VALUES ('hyyzjd', 72, ?, ?)`,
      [legacyShowNo, orderUuid],
    )
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

    const legacyTableRows = await AppDataSource.query(
      `SELECT "name" FROM "sqlite_master"
       WHERE "type" = 'table' AND "name" IN ('order_business_no_occupancy', 'order_business_no_reuse_event')`,
    ) as Array<{ name: string }>
    assert.equal(legacyTableRows.length, 0, '056 语义必须移除历史永久占号与复用事件表')
    const sequenceRows = await AppDataSource.query(
      'SELECT "current_value" AS "currentValue" FROM "business_sequence" WHERE "sequence_key" = ?',
      ['order.business.department'],
    ) as Array<{ currentValue: number }>
    assert.equal(Number(sequenceRows[0]?.currentValue), 72)
    const emptyNamespaceFirstMigrationRows = await AppDataSource.query(
      'SELECT "current_value" AS "currentValue" FROM "business_sequence" WHERE "sequence_key" = ?',
      ['order.business.walkin'],
    ) as Array<{ currentValue: number }>
    assert.equal(
      Number(emptyNamespaceFirstMigrationRows[0]?.currentValue),
      49,
      '空命名空间首次迁移必须从旧配置自定义 start - 1 初始化',
    )
    const migrationMarkerRows = await AppDataSource.query(
      `SELECT COUNT(1) AS "total" FROM "system_configs"
       WHERE "config_key" IN ('order.business.department.migration.055', 'order.business.walkin.migration.055')
         AND "config_value" = '1'`,
    ) as Array<{ total: number }>
    assert.equal(Number(migrationMarkerRows[0]?.total), 2, '两类 business namespace 首迁完成后必须原子写入 marker')

    await AppDataSource.query(
      `INSERT INTO "system_configs" ("config_key", "config_value", "config_group", "remark", "created_at", "updated_at")
       VALUES ('order.serial.walkin.start', '60', 'order_serial', '专项验证旧配置后续抬高', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT("config_key") DO UPDATE SET "config_value" = '60', "updated_at" = CURRENT_TIMESTAMP`,
    )
    await AppDataSource.query(
      `INSERT INTO "business_sequence" ("sequence_key", "current_value", "created_at", "updated_at")
       VALUES ('order.serial.walkin', 900, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT("sequence_key") DO UPDATE SET "current_value" = 900, "updated_at" = CURRENT_TIMESTAMP`,
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
      '命名空间三项新配置齐全后不得再次回灌旧配置或旧序列',
    )

    const secondResult = await initializeDatabaseSchemaIfNeeded(AppDataSource)
    assert.equal(secondResult.action, 'skipped')
    const legacyTableRowsAfterSecondRun = await AppDataSource.query(
      `SELECT "name" FROM "sqlite_master"
       WHERE "type" = 'table' AND "name" IN ('order_business_no_occupancy', 'order_business_no_reuse_event')`,
    ) as Array<{ name: string }>
    assert.equal(legacyTableRowsAfterSecondRun.length, 0, '重复 bootstrap 不得重建已停用表')
    console.log('✅ Issue #72/#110 历史 SQLite 订单升级专项验证通过')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    fs.rmSync(sqlitePath, { force: true })
  }
}

main().catch((error) => {
  console.error('❌ Issue #72 历史 SQLite 订单升级专项验证失败', error)
  process.exitCode = 1
})
