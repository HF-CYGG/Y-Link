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

        CREATE TABLE biz_outbound_order (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_uuid varchar(36) NOT NULL,
          show_no varchar(32) NOT NULL,
          order_type varchar(32) NOT NULL DEFAULT 'walkin',
          has_customer_order tinyint NOT NULL DEFAULT 0,
          is_system_applied tinyint NOT NULL DEFAULT 0,
          issuer_name varchar(64),
          customer_department_name varchar(271),
          idempotency_key varchar(128) NOT NULL,
          customer_name varchar(128),
          remark varchar(500),
          total_qty decimal(12,2) NOT NULL DEFAULT 0,
          total_amount decimal(14,2) NOT NULL DEFAULT 0,
          is_deleted tinyint NOT NULL DEFAULT 0,
          created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO biz_outbound_order (
          order_uuid, show_no, idempotency_key, customer_name, total_qty, total_amount
        ) VALUES
          ('00000000-0000-4000-8000-000000000073', 'hyyz000001', 'legacy-manual-73', 'Legacy Manual', 1, 12.50),
          ('00000000-0000-4000-8000-000000000074', 'hyyz000002', 'o2o-preorder-verify:legacy-73', 'Legacy O2O', 1, 12.50);

        CREATE TABLE inventory_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL,
          change_type varchar(32) NOT NULL,
          change_qty integer NOT NULL,
          before_current_stock integer NOT NULL DEFAULT 0,
          after_current_stock integer NOT NULL DEFAULT 0,
          before_preordered_stock integer NOT NULL DEFAULT 0,
          after_preordered_stock integer NOT NULL DEFAULT 0,
          operator_type varchar(32) NOT NULL DEFAULT 'system',
          created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO inventory_log (
          product_id, change_type, change_qty, before_current_stock, after_current_stock
        ) VALUES (1, 'legacy_adjustment', 1, 6, 7);
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
  const preorderColumns = await AppDataSource.query('PRAGMA table_info(o2o_preorder)') as Array<{ name: string; notnull: number }>
  const inboundOrderColumns = await AppDataSource.query('PRAGMA table_info(biz_inbound_order)') as Array<{ name: string; notnull: number }>
  const inventoryModes = await AppDataSource.query(
    'SELECT idempotency_key AS idempotencyKey, inventory_mode AS inventoryMode FROM biz_outbound_order ORDER BY id',
  ) as Array<{ idempotencyKey: string; inventoryMode: string }>
  const legacyInventoryLogs = await AppDataSource.query(
    'SELECT sku_id AS skuId, before_sku_current_stock AS beforeSkuCurrentStock FROM inventory_log WHERE change_type = ?',
    ['legacy_adjustment'],
  ) as Array<{ skuId: string | number | null; beforeSkuCurrentStock: number | null }>
  const inventoryLogForeignKeys = await AppDataSource.query('PRAGMA foreign_key_list(inventory_log)') as Array<{
    from: string
    table: string
    to: string
    on_delete: string
  }>

  assert.equal(skus.length, 1, '历史商品必须补一条默认 SKU')
  assert.equal(Number(skus[0]?.currentStock), 7, '默认 SKU 必须继承商品库存')
  assert.equal(String(inboundItems[0]?.skuId), String(skus[0]?.id), '历史入库明细必须绑定补建 SKU')
  assert.ok(
    indexes.some((index) => index.name === 'idx_o2o_preorder_client_deleted_id'),
    '依赖新列的商城索引必须在结构升级后创建',
  )
  // Issue #96：到店取货时间对历史订单必须是可空新列，升级不得要求回填。
  const pickupAtColumn = preorderColumns.find((column) => column.name === 'pickup_at')
  assert.ok(pickupAtColumn, '结构升级后必须补齐 o2o_preorder.pickup_at 列')
  assert.equal(Number(pickupAtColumn?.notnull), 0, '历史订单没有到店取货时间，pickup_at 必须允许为空')
  // Issue #95：预计送达时间对历史送货单必须是可空新列，升级不得要求回填。
  const expectedArrivalColumn = inboundOrderColumns.find((column) => column.name === 'expected_arrival_at')
  assert.ok(expectedArrivalColumn, '结构升级后必须补齐 biz_inbound_order.expected_arrival_at 列')
  assert.equal(Number(expectedArrivalColumn?.notnull), 0, '历史送货单没有预计送达时间，expected_arrival_at 必须允许为空')
  assert.deepEqual(
    inventoryModes.map((item) => [item.idempotencyKey, item.inventoryMode]),
    [
      ['legacy-manual-73', 'legacy_none'],
      ['o2o-preorder-verify:legacy-73', 'o2o_preapplied'],
    ],
    'SQLite 历史手工单与 O2O 正式单必须按既定库存模式推断',
  )
  assert.deepEqual(legacyInventoryLogs, [{ skuId: null, beforeSkuCurrentStock: null }], '历史库存流水新增 SKU 字段必须保持 NULL')
  const sourceDocRows = await AppDataSource.query(
    'SELECT idempotency_key AS idempotencyKey, source_doc_type AS sourceDocType, source_doc_no AS sourceDocNo FROM biz_outbound_order ORDER BY id',
  ) as Array<{ idempotencyKey: string; sourceDocType: string | null; sourceDocNo: string | null }>
  assert.deepEqual(
    sourceDocRows.map((item) => [item.idempotencyKey, item.sourceDocType, item.sourceDocNo]),
    [
      ['legacy-manual-73', null, null],
      ['o2o-preorder-verify:legacy-73', null, null],
    ],
    '#70 来源快照列必须补齐，无法确认来源预订单的历史单据保持为空',
  )
  const outboundOrderIndexes = await AppDataSource.query('PRAGMA index_list(biz_outbound_order)') as Array<{ name: string }>
  assert.ok(
    outboundOrderIndexes.some((index) => index.name === 'idx_biz_outbound_source_doc'),
    '#70 来源快照组合索引必须在旧库升级后存在',
  )
  assert.ok(
    inventoryLogForeignKeys.some((foreignKey) => (
      foreignKey.from === 'sku_id'
      && foreignKey.table === 'base_product_sku'
      && foreignKey.to === 'id'
      && foreignKey.on_delete.toUpperCase() === 'SET NULL'
    )),
    'SQLite inventory_log.sku_id 必须安全补齐 SET NULL 外键',
  )

  await AppDataSource.query('DROP INDEX uk_client_user_department_node_id')
  await AppDataSource.query('CREATE UNIQUE INDEX uk_client_user_department_node_id ON client_user (real_name)')
  const indexRepairResult = await initializeDatabaseSchemaIfNeeded(AppDataSource)
  assert.equal(indexRepairResult.action, 'synchronized', '客户端用户节点唯一索引列形状错误时必须触发安全结构补齐')
  const clientUserIndexes = await AppDataSource.query('PRAGMA index_list(client_user)') as Array<{ name: string; unique: number }>
  assert.ok(
    clientUserIndexes.some((index) => index.name === 'uk_client_user_department_node_id' && Number(index.unique) === 1),
    '结构补齐后必须恢复部门节点唯一索引',
  )
  const repairedDepartmentNodeIndex = await AppDataSource.query('PRAGMA index_info(uk_client_user_department_node_id)') as Array<{ seqno: number; name: string }>
  assert.deepEqual(
    repairedDepartmentNodeIndex.sort((left, right) => Number(left.seqno) - Number(right.seqno)).map((column) => column.name),
    ['department_node_id'],
    '结构补齐后部门节点唯一索引必须精确绑定 department_node_id，不能只按索引名称误判',
  )

  console.log('OK SQLite 旧库结构、库存模式、默认 SKU、入库关联与商城索引升级验收通过')

  // ============ PR #109 第六轮评审复核追加：051 历史编码回填在 SQLite 侧的等价实现验收 ============
  //
  // 背景：051_product_legacy_code.sql 把此前升级路径误回填进 barcode 的历史编码搬到 legacy_sku_code
  // 并清空 barcode，但该脚本只面向 MySQL（用了 INNER JOIN...SET 与 REGEXP），SQLite 环境这条回填
  // 从未执行过。这里直接构造"SQLite 库里已经有历史遗留错误状态"的 SKU 行，验证
  // backfillSqliteLegacySkuCodeFromBarcode 用 JS 实现的等价口径：P-/WC 两种历史编码格式的行应被
  // 搬运，真实原厂条码格式的行必须保持原样不动（判定必须保守）。
  const { BaseProduct: BaseProductForLegacyBarcodeFixture } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku: BaseProductSkuForLegacyBarcodeFixture } = await import('../src/entities/base-product-sku.entity.js')

  const legacyBarcodeProductRepo = AppDataSource.getRepository(BaseProductForLegacyBarcodeFixture)
  const legacyBarcodeProduct = await legacyBarcodeProductRepo.save(legacyBarcodeProductRepo.create({
    productCode: 'YZLB01',
    productName: '051 legacy barcode fixture product',
    pinyinAbbr: 'LB',
    defaultPrice: '10.00',
    discountRate: '10.0',
    isActive: true,
    o2oStatus: 'unlisted',
    o2oRecommended: false,
    thumbnail: null,
    detailContent: null,
    limitPerUser: 5,
    currentStock: 0,
    categoryId: null,
    preOrderedStock: 0,
    primarySeriesTagId: null,
    seriesSeq: null,
    codeScheme: 'yz',
  }))

  const legacyBarcodeSkuRepo = AppDataSource.getRepository(BaseProductSkuForLegacyBarcodeFixture)
  const buildLegacyBarcodeFixtureSku = (suffix: string, barcode: string) => legacyBarcodeSkuRepo.create({
    productId: legacyBarcodeProduct.id,
    skuCode: `YZLB01-${suffix}`,
    barcode,
    legacySkuCode: null,
    specValuesJson: JSON.stringify({ 规格: suffix }),
    specText: suffix,
    defaultPrice: '10.00',
    discountRate: '10.0',
    isActive: true,
    isCurrent: true,
    o2oRecommended: false,
    sortOrder: 0,
    variantCode: null,
    sizeCode: null,
  })
  const [legacyPStyleSku, legacyWcStyleSku, realBarcodeSku] = await legacyBarcodeSkuRepo.save([
    buildLegacyBarcodeFixtureSku('P', 'P-240101-0001-DEFAULT'), // 旧 P- 系编码：应被搬运
    buildLegacyBarcodeFixtureSku('WC', 'WC12345'), // 旧 WC 系编码：应被搬运
    buildLegacyBarcodeFixtureSku('REAL', '6901234567892'), // 真实原厂条码格式：不应被搬运
  ])

  await initializeDatabaseSchemaIfNeeded(AppDataSource)

  const legacyBarcodeSkuIds = [legacyPStyleSku.id, legacyWcStyleSku.id, realBarcodeSku.id]
  const legacyBarcodeSkusAfterBackfill = await AppDataSource.query(
    `SELECT id, barcode, legacy_sku_code AS legacySkuCode FROM "base_product_sku" WHERE id IN (${legacyBarcodeSkuIds.map(() => '?').join(', ')})`,
    legacyBarcodeSkuIds,
  ) as Array<{ id: string | number; barcode: string | null; legacySkuCode: string | null }>
  const legacyBarcodeSkuById = new Map(legacyBarcodeSkusAfterBackfill.map((row) => [String(row.id), row]))

  assert.deepEqual(
    legacyBarcodeSkuById.get(String(legacyPStyleSku.id)),
    { id: legacyPStyleSku.id, barcode: null, legacySkuCode: 'P-240101-0001-DEFAULT' },
    '051 回填：P- 系历史编码应从 barcode 搬到 legacy_sku_code，barcode 置空',
  )
  assert.deepEqual(
    legacyBarcodeSkuById.get(String(legacyWcStyleSku.id)),
    { id: legacyWcStyleSku.id, barcode: null, legacySkuCode: 'WC12345' },
    '051 回填：WC 系历史编码应从 barcode 搬到 legacy_sku_code，barcode 置空',
  )
  assert.deepEqual(
    legacyBarcodeSkuById.get(String(realBarcodeSku.id)),
    { id: realBarcodeSku.id, barcode: '6901234567892', legacySkuCode: null },
    '051 回填：真实原厂条码格式必须保持原样，不能被误判为历史编码搬运',
  )
  console.log('OK 051 历史编码回填的 SQLite 等价实现验收通过：P-/WC 两种历史编码格式已搬运到 legacy_sku_code，真实原厂条码保持不动')

  // ============ PR #109 第六轮评审修复 + 复核追加：P1-B（存活 YZ 商品占用回填）/ P2-C（占用表
  // 唯一索引与非空约束的结构补齐）联合验收 ============
  //
  // 场景还原：先直接用 repository 落一条"已经建档、但从未在占用表登记过"的存活 YZ 商品（对应
  // P1-B——例如该商品是在占用表还没上线时创建的）；再把此时已经是最终结构的占用表整表降级重建成
  // 052 时代的旧结构（缺 series_code/code_prefix 两列，唯一索引仍按 series_tag_id+series_seq，
  // 对应 P2-C 的问题前提），并插入一条反推不出系列码的历史脏数据行（标签早已不存在、product_code
  // 也不符合当前前缀格式）。重新跑一次结构初始化后，一次性验证两个修复点。
  const { BaseTag: BaseTagForLiveYzFixture } = await import('../src/entities/base-tag.entity.js')
  const { BaseProduct: BaseProductForLiveYzFixture } = await import('../src/entities/base-product.entity.js')
  const { reserveSeriesSeq } = await import('../src/services/product-code.service.js')
  const { runInTransaction } = await import('../src/config/transaction-runner.js')
  const { BizError } = await import('../src/utils/errors.js')

  const liveYzTagRepo = AppDataSource.getRepository(BaseTagForLiveYzFixture)
  const liveYzTag = await liveYzTagRepo.save(liveYzTagRepo.create({
    tagName: 'p1b-live-yz-tag',
    tagCode: null,
    seriesCode: 'LG',
  }))

  // 直接用 repository 落存活 YZ 商品，刻意不经过 productService，模拟占用表从未替它登记过这一事实。
  const liveYzProductRepo = AppDataSource.getRepository(BaseProductForLiveYzFixture)
  const liveYzProduct = await liveYzProductRepo.save(liveYzProductRepo.create({
    productCode: 'YZLG03',
    productName: 'p1b live yz product',
    pinyinAbbr: 'LG',
    defaultPrice: '10.00',
    discountRate: '10.0',
    isActive: true,
    o2oStatus: 'unlisted',
    o2oRecommended: false,
    thumbnail: null,
    detailContent: null,
    limitPerUser: 5,
    currentStock: 0,
    categoryId: null,
    preOrderedStock: 0,
    primarySeriesTagId: liveYzTag.id,
    seriesSeq: 3,
    codeScheme: 'yz',
  }))

  // 把占用表整表降级重建为 052 时代的旧结构：无 series_code/code_prefix，唯一索引仍按标签维度。
  await AppDataSource.query('DROP INDEX IF EXISTS "uk_yz_series_seq_reservation_code"')
  await AppDataSource.query('DROP INDEX IF EXISTS "idx_yz_series_seq_reservation_tag"')
  await AppDataSource.query(`
    CREATE TABLE "base_yz_series_seq_reservation__v052" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "series_tag_id" integer NOT NULL,
      "series_seq" smallint NOT NULL,
      "product_code" varchar(64) NOT NULL,
      "created_at" datetime NOT NULL DEFAULT (datetime('now')),
      "updated_at" datetime NOT NULL DEFAULT (datetime('now'))
    )
  `)
  await AppDataSource.query(`
    INSERT INTO "base_yz_series_seq_reservation__v052"
      ("id", "series_tag_id", "series_seq", "product_code", "created_at", "updated_at")
    SELECT "id", "series_tag_id", "series_seq", "product_code", "created_at", "updated_at"
    FROM "base_yz_series_seq_reservation"
  `)
  await AppDataSource.query('DROP TABLE "base_yz_series_seq_reservation"')
  await AppDataSource.query('ALTER TABLE "base_yz_series_seq_reservation__v052" RENAME TO "base_yz_series_seq_reservation"')
  await AppDataSource.query(
    'CREATE UNIQUE INDEX "uk_yz_series_seq_reservation" ON "base_yz_series_seq_reservation" ("series_tag_id", "series_seq")',
  )
  // 一条反推不出系列码的历史脏数据：series_tag_id=999999 查无此标签，product_code 也不符合当前前缀格式。
  await AppDataSource.query(
    'INSERT INTO "base_yz_series_seq_reservation" ("series_tag_id", "series_seq", "product_code") VALUES (999999, 1, ?)',
    ['YZLEGACY01'],
  )

  // 注意：P2-C 的修复方式是准备函数自己直接完成表重建（见 database-bootstrap.ts 的
  // rebuildSqliteYzReservationConstraints），不依赖 shouldSynchronizeSqliteSchema 触发整体
  // synchronize()——因此这里的 action 可能是 'skipped'（没有其它原因触发整体同步），
  // 不能像上面 client_user 的索引修复用例那样断言 action 必须是 'synchronized'；
  // 真正要验证的是占用表的实际结构，见下面的列/索引断言。
  await initializeDatabaseSchemaIfNeeded(AppDataSource)

  const reservationColumns = await AppDataSource.query('PRAGMA table_info("base_yz_series_seq_reservation")') as Array<{ name: string; notnull: number }>
  const seriesCodeColumn = reservationColumns.find((column) => column.name === 'series_code')
  const codePrefixColumn = reservationColumns.find((column) => column.name === 'code_prefix')
  assert.ok(seriesCodeColumn && Number(seriesCodeColumn.notnull) === 1, 'P2-C：series_code 结构补齐后必须是 NOT NULL')
  assert.ok(codePrefixColumn && Number(codePrefixColumn.notnull) === 1, 'P2-C：code_prefix 结构补齐后必须是 NOT NULL')

  const reservationIndexes = await AppDataSource.query('PRAGMA index_list("base_yz_series_seq_reservation")') as Array<{ name: string; unique: number }>
  assert.ok(
    reservationIndexes.some((index) => index.name === 'uk_yz_series_seq_reservation_code' && Number(index.unique) === 1),
    'P2-C：结构补齐后必须建出 (code_prefix, series_code, series_seq) 唯一索引',
  )
  assert.ok(
    !reservationIndexes.some((index) => index.name === 'uk_yz_series_seq_reservation' && Number(index.unique) === 1),
    'P2-C：旧的按标签唯一索引不能再以唯一索引形态存在（降级为普通索引或直接消失均可）',
  )
  const newUniqueIndexColumns = await AppDataSource.query('PRAGMA index_info("uk_yz_series_seq_reservation_code")') as Array<{ seqno: number; name: string }>
  assert.deepEqual(
    newUniqueIndexColumns.sort((left, right) => Number(left.seqno) - Number(right.seqno)).map((column) => column.name),
    ['code_prefix', 'series_code', 'series_seq'],
    'P2-C：新唯一索引必须精确绑定 (code_prefix, series_code, series_seq) 三列，不能只按索引名称误判',
  )

  const legacyReservationRow = await AppDataSource.query(
    'SELECT series_code AS seriesCode, code_prefix AS codePrefix FROM "base_yz_series_seq_reservation" WHERE series_tag_id = 999999 AND series_seq = 1',
  ) as Array<{ seriesCode: string; codePrefix: string }>
  assert.deepEqual(
    legacyReservationRow[0],
    { seriesCode: '??', codePrefix: '?' },
    'P2-C 附带：反推不出系列码（标签已删除且 product_code 不匹配当前前缀）的历史行应落入占位哨兵，标记待人工核对',
  )

  const p1bBackfilledRow = await AppDataSource.query(
    'SELECT product_code AS productCode, series_code AS seriesCode, code_prefix AS codePrefix FROM "base_yz_series_seq_reservation" WHERE series_tag_id = ? AND series_seq = 3',
    [liveYzTag.id],
  ) as Array<{ productCode: string; seriesCode: string; codePrefix: string }>
  assert.deepEqual(
    p1bBackfilledRow[0],
    { productCode: 'YZLG03', seriesCode: 'LG', codePrefix: 'YZ' },
    'P1-B：结构初始化时应为仍存活、但从未登记过的 YZ 商品自动补齐占用登记',
  )

  // 该商品被删除后，同序号导入仍应被永久占用拒绝——证明补齐的登记确实生效，不是摆设。
  await liveYzProductRepo.delete({ id: liveYzProduct.id })
  await assert.rejects(
    () => runInTransaction((manager) => reserveSeriesSeq(manager, liveYzTag.id, 3, 'LG', 'YZ')),
    (error: unknown) => error instanceof BizError && error.statusCode === 409,
    'P1-B：回填登记后，该商品被删除，同序号导入仍应被永久占用拒绝',
  )

  console.log('OK P1-B/P2-C：SQLite 旧库占用表结构补齐（新唯一索引 + 非空约束 + 旧索引降级）与存活 YZ 商品占用自动回填均验收通过')
} finally {
  if (dataSource?.isInitialized) {
    await dataSource.destroy()
  }
  fs.rmSync(runtimeDir, { recursive: true, force: true })
}
