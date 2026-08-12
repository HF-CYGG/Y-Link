/**
 * SQLite 旧库升级回归：模拟 SKU 功能上线前已有商品、入库明细和 O2O 主表的 009 时代数据库。
 * 验证启动升级不会先创建依赖缺失列的索引，并会在建 SKU 表后补默认 SKU 与入库关联。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sqlite3 from 'sqlite3'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-legacy-schema-'))
const databasePath = path.join(runtimeDir, 'legacy.sqlite')

const openLegacyDatabase = (): Promise<void> => new Promise((resolve, reject) => {
  const database = new sqlite3.Database(databasePath, (openError) => {
    if (openError) {
      reject(openError)
      return
    }
    database.exec(
      `
        CREATE TABLE base_product (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_code varchar(64) NOT NULL,
          product_name varchar(128) NOT NULL,
          pinyin_abbr varchar(64) NOT NULL,
          default_price decimal(12,2) NOT NULL DEFAULT 0,
          is_active tinyint NOT NULL DEFAULT 1,
          thumbnail varchar(255),
          limit_per_user integer NOT NULL DEFAULT 5,
          current_stock integer NOT NULL DEFAULT 7,
          pre_ordered_stock integer NOT NULL DEFAULT 0,
          created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO base_product (
          id, product_code, product_name, pinyin_abbr, default_price, is_active, current_stock
        ) VALUES (1, 'LEGACY-1', 'Legacy Product', 'LP', 12.50, 1, 7);

        CREATE TABLE biz_inbound_order (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          show_no varchar(48) NOT NULL,
          verify_code varchar(64) NOT NULL,
          supplier_id INTEGER NOT NULL,
          supplier_name varchar(128),
          status varchar(32) NOT NULL,
          total_qty decimal(10,2) NOT NULL DEFAULT 0,
          remark varchar(255),
          created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO biz_inbound_order (
          id, show_no, verify_code, supplier_id, status, total_qty
        ) VALUES (1, 'LEGACY-IN-1', 'legacy-verify', 1, 'pending', 3);

        CREATE TABLE biz_inbound_order_item (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL,
          product_name_snapshot varchar(255) NOT NULL,
          qty decimal(10,2) NOT NULL DEFAULT 0
        );
        INSERT INTO biz_inbound_order_item (
          id, order_id, product_id, product_name_snapshot, qty
        ) VALUES (1, 1, 1, 'Legacy Product', 3);

        CREATE TABLE o2o_preorder (id INTEGER PRIMARY KEY AUTOINCREMENT);
      `,
      (sqlError) => {
        database.close()
        sqlError ? reject(sqlError) : resolve()
      },
    )
  })
})

let dataSource: typeof import('../src/config/data-source.js')['AppDataSource'] | null = null
try {
  await openLegacyDatabase()
  process.env.DB_TYPE = 'sqlite'
  process.env.DB_SYNC = 'false'
  process.env.SQLITE_DB_PATH = databasePath
  process.env.APP_PROFILE = 'sqlite-legacy-schema-upgrade-verify'

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  dataSource = AppDataSource

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  const result = await initializeDatabaseSchemaIfNeeded(AppDataSource)
  assert.equal(result.action, 'synchronized')

  const skus = await AppDataSource.query(
    'SELECT id, product_id AS productId, current_stock AS currentStock FROM base_product_sku WHERE product_id = 1',
  ) as Array<{ id: string | number; productId: string | number; currentStock: string | number }>
  const inboundItems = await AppDataSource.query(
    'SELECT sku_id AS skuId FROM biz_inbound_order_item WHERE id = 1',
  ) as Array<{ skuId: string | number | null }>
  const indexes = await AppDataSource.query('PRAGMA index_list(o2o_preorder)') as Array<{ name: string }>

  assert.equal(skus.length, 1, '历史商品必须补一条默认 SKU')
  assert.equal(Number(skus[0]?.currentStock), 7, '默认 SKU 必须继承商品库存')
  assert.equal(String(inboundItems[0]?.skuId), String(skus[0]?.id), '历史入库明细必须绑定补建 SKU')
  assert.ok(
    indexes.some((index) => index.name === 'idx_o2o_preorder_client_deleted_id'),
    '依赖新列的商城索引必须在结构升级后创建',
  )

  console.log('OK SQLite 旧库结构、默认 SKU、入库关联与商城索引升级验收通过')
} finally {
  if (dataSource?.isInitialized) {
    await dataSource.destroy()
  }
  fs.rmSync(runtimeDir, { recursive: true, force: true })
}
