/**
 * 模块说明：手工出库 SKU 接入专项验证。
 * 文件职责：在隔离 SQLite 中验证手工出库的 SKU 校验、快照、历史兼容和零库存副作用。
 * 实现逻辑：
 * - 创建单规格、多规格商品，覆盖自动选择、强制选择、归属/启停/当前版本校验；
 * - 以人工修改价提交同商品不同 SKU，核对单 SKU 主价兼容与多 current SKU 主价隔离；
 * - 模拟存量 SQLite 缺少 SKU 外键，确认安全复制升级不丢明细并补齐 ON DELETE SET NULL；
 * - 将一张隔离单据改造成历史无 SKU 数据，确认仍可读取，并校验打印/PDF 共用聚合逻辑。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')
const repositoryRoot = path.resolve(backendRoot, '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `manual-order-sku-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `manual-order-sku-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

const actor = {
  userId: `manual-sku-${verifySeed}`,
  username: 'manual-sku-verifier',
  displayName: '手工出库 SKU 验证员',
  role: 'admin',
  permissions: [],
  status: 'enabled',
  sessionToken: 'manual-sku-verify-session',
  authSource: 'bearer',
} as const

function cleanupSqliteFile() {
  if (!fs.existsSync(sqlitePath)) {
    return
  }
  try {
    fs.rmSync(sqlitePath, { force: true })
  } catch (error) {
    console.warn(`[manual-order-sku-verify] 临时 SQLite 清理跳过：${error instanceof Error ? error.message : String(error)}`)
  }
}

function readSource(relativePath: string) {
  return fs.readFileSync(path.resolve(repositoryRoot, relativePath), 'utf8')
}

async function rebuildOutboundItemsWithoutSkuForeignKey(dataSource: {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}) {
  const [tableDefinition] = await dataSource.query(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'biz_outbound_order_item'`,
  ) as Array<{ sql: string }>
  assert.ok(tableDefinition?.sql, '隔离 SQLite 必须存在出库明细表定义')
  const legacyTableSql = tableDefinition.sql.replace(
    /,\s*CONSTRAINT\s+"[^"]+"\s+FOREIGN KEY\s*\("sku_id"\)\s+REFERENCES\s+"base_product_sku"\s*\("id"\)\s+ON DELETE SET NULL\s+ON UPDATE NO ACTION/i,
    '',
  )
  assert.notEqual(legacyTableSql, tableDefinition.sql, '测试夹具必须能移除 SKU 外键以模拟存量 SQLite')

  const indexDefinitions = await dataSource.query(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'biz_outbound_order_item' AND sql IS NOT NULL`,
  ) as Array<{ sql: string }>
  const columns = await dataSource.query('PRAGMA table_info("biz_outbound_order_item")') as Array<{ name: string }>
  const columnList = columns.map((column) => `"${column.name.replaceAll('"', '""')}"`).join(', ')
  const backupTableName = `biz_outbound_order_item_with_sku_fk_${verifySeed.replaceAll('-', '_')}`

  await dataSource.query('PRAGMA foreign_keys = OFF')
  try {
    await dataSource.query(`ALTER TABLE "biz_outbound_order_item" RENAME TO "${backupTableName}"`)
    await dataSource.query(legacyTableSql)
    await dataSource.query(
      `INSERT INTO "biz_outbound_order_item" (${columnList}) SELECT ${columnList} FROM "${backupTableName}"`,
    )
    await dataSource.query(`DROP TABLE "${backupTableName}"`)
    for (const indexDefinition of indexDefinitions) {
      await dataSource.query(indexDefinition.sql)
    }
  } finally {
    await dataSource.query('PRAGMA foreign_keys = ON')
  }
}

async function expectBizError(action: () => Promise<unknown>, expectedMessage: RegExp) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, expectedMessage)
    return true
  })
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { BizOutboundOrderItem } = await import('../src/entities/biz-outbound-order-item.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { orderService } = await import('../src/services/order.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { reportService } = await import('../src/services/report.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()

    const outboundColumns = await AppDataSource.query('PRAGMA table_info("biz_outbound_order_item")') as Array<{ name: string }>
    const outboundColumnSet = new Set(outboundColumns.map((column) => column.name))
    assert.deepEqual(
      ['sku_id', 'sku_code_snapshot', 'spec_text_snapshot'].filter((column) => !outboundColumnSet.has(column)),
      [],
      'SQLite bootstrap 必须为手工出库明细补齐可空 SKU 快照列',
    )

    const singleProduct = await productService.create({
      productName: `手工单规格-${verifySeed}`,
      pinyinAbbr: 'DG',
      defaultPrice: 11,
      isActive: true,
      currentStock: 17,
      specGroups: [{ name: '颜色', values: ['单色'] }],
      skus: [{
        skuCode: `MANUAL-SINGLE-${verifySeed}`,
        specValues: { 颜色: '单色' },
        defaultPrice: 11,
        currentStock: 17,
        isActive: true,
      }],
    } as Parameters<typeof productService.create>[0])
    const singleSku = singleProduct.skus[0]
    assert.ok(singleSku)

    const multiProduct = await productService.create({
      productName: `手工多规格-${verifySeed}`,
      pinyinAbbr: 'DG',
      defaultPrice: 13,
      isActive: true,
      currentStock: 42,
      specGroups: [{ name: '颜色', values: ['红色', '蓝色'] }],
      skus: [
        {
          skuCode: `MANUAL-RED-${verifySeed}`,
          specValues: { 颜色: '红色' },
          defaultPrice: 13,
          currentStock: 19,
          isActive: true,
          sortOrder: 0,
        },
        {
          skuCode: `MANUAL-BLUE-${verifySeed}`,
          specValues: { 颜色: '蓝色' },
          defaultPrice: 15,
          currentStock: 23,
          isActive: true,
          sortOrder: 1,
        },
      ],
    } as Parameters<typeof productService.create>[0])
    const redSku = multiProduct.skus.find((sku) => sku.specText === '红色')
    const blueSku = multiProduct.skus.find((sku) => sku.specText === '蓝色')
    assert.ok(redSku)
    assert.ok(blueSku)

    const submit = (payload: Record<string, unknown>) => (
      orderService.submit as unknown as (
        input: Record<string, unknown>,
        currentActor: typeof actor,
      ) => Promise<{ order: { id: string }; items: Array<Record<string, unknown>> }>
    )(payload, actor)

    const singleResult = await submit({
      idempotencyKey: `manual-single-${verifySeed}`,
      orderType: 'walkin',
      customerName: '单规格验证',
      items: [{ productId: singleProduct.id, qty: 2, unitPrice: 12.34 }],
    })
    const singleDetail = await orderService.detailById(singleResult.order.id)
    const singleDetailItem = singleDetail.items[0] as unknown as Record<string, unknown>
    assert.equal(singleDetailItem.skuId, singleSku.id, '单规格商品省略 skuId 时必须唯一自动选择')
    assert.equal(singleDetailItem.skuCodeSnapshot, singleSku.skuCode)
    assert.equal(singleDetailItem.specTextSnapshot, singleSku.specText)
    assert.equal(singleDetailItem.unitPrice, '12.34', 'SKU 默认价只能预填，人工价格必须保存为单价快照')
    const singleProductAfterSubmit = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: singleProduct.id })
    assert.equal(
      Number(singleProductAfterSubmit.defaultPrice).toFixed(2),
      '12.34',
      '单一 current SKU 商品必须保留手工单价回写商品主价的既有兼容行为',
    )

    const outboundItemCountBeforeLegacyUpgrade = await AppDataSource.getRepository(BizOutboundOrderItem).count()
    await rebuildOutboundItemsWithoutSkuForeignKey(AppDataSource)
    const foreignKeysBeforeLegacyUpgrade = await AppDataSource.query(
      'PRAGMA foreign_key_list("biz_outbound_order_item")',
    ) as Array<{ table: string; from: string; to: string; on_delete: string }>
    assert.equal(
      foreignKeysBeforeLegacyUpgrade.some((foreignKey) => foreignKey.from === 'sku_id'),
      false,
      '测试夹具必须真实模拟缺少 SKU 外键的存量 SQLite',
    )
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    const foreignKeysAfterLegacyUpgrade = await AppDataSource.query(
      'PRAGMA foreign_key_list("biz_outbound_order_item")',
    ) as Array<{ table: string; from: string; to: string; on_delete: string }>
    assert.ok(
      foreignKeysAfterLegacyUpgrade.some((foreignKey) => (
        foreignKey.table === 'base_product_sku'
        && foreignKey.from === 'sku_id'
        && foreignKey.to === 'id'
        && foreignKey.on_delete.toUpperCase() === 'SET NULL'
      )),
      'SQLite 存量升级必须补齐 sku_id -> base_product_sku.id / ON DELETE SET NULL 外键',
    )
    assert.equal(
      await AppDataSource.getRepository(BizOutboundOrderItem).count(),
      outboundItemCountBeforeLegacyUpgrade,
      'SQLite 补外键时不得丢失历史出库明细',
    )
    assert.deepEqual(await AppDataSource.query('PRAGMA foreign_key_check'), [], 'SQLite 补外键后不得产生约束违规')

    await expectBizError(
      () => submit({
        idempotencyKey: `manual-multi-missing-${verifySeed}`,
        orderType: 'walkin',
        items: [{ productId: multiProduct.id, qty: 1, unitPrice: 13 }],
      }),
      /多规格|请选择规格/,
    )
    await expectBizError(
      () => submit({
        idempotencyKey: `manual-missing-sku-${verifySeed}`,
        orderType: 'walkin',
        items: [{ productId: multiProduct.id, skuId: '999999999', qty: 1, unitPrice: 13 }],
      }),
      /规格无效|规格不存在/,
    )
    await expectBizError(
      () => submit({
        idempotencyKey: `manual-wrong-product-${verifySeed}`,
        orderType: 'walkin',
        items: [{ productId: multiProduct.id, skuId: singleSku.id, qty: 1, unitPrice: 13 }],
      }),
      /不属于|规格无效/,
    )

    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const blueSkuEntity = await skuRepo.findOneByOrFail({ id: blueSku.id })
    blueSkuEntity.isActive = false
    await skuRepo.save(blueSkuEntity)
    await expectBizError(
      () => submit({
        idempotencyKey: `manual-inactive-sku-${verifySeed}`,
        orderType: 'walkin',
        items: [{ productId: multiProduct.id, skuId: blueSku.id, qty: 1, unitPrice: 15 }],
      }),
      /停用|规格无效|已退役/,
    )
    const multiProductBeforeInactiveSiblingSubmit = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: multiProduct.id })
    await submit({
      idempotencyKey: `manual-multi-inactive-sibling-${verifySeed}`,
      orderType: 'walkin',
      items: [{ productId: multiProduct.id, skuId: redSku.id, qty: 1, unitPrice: 17.77 }],
    })
    const multiProductAfterInactiveSiblingSubmit = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: multiProduct.id })
    assert.equal(
      Number(multiProductAfterInactiveSiblingSubmit.defaultPrice).toFixed(2),
      Number(multiProductBeforeInactiveSiblingSubmit.defaultPrice).toFixed(2),
      '只要存在多个 current SKU，即使仅一个启用，手工价也不得回写商品主价',
    )
    blueSkuEntity.isActive = true
    blueSkuEntity.isCurrent = false
    await skuRepo.save(blueSkuEntity)
    await expectBizError(
      () => submit({
        idempotencyKey: `manual-retired-sku-${verifySeed}`,
        orderType: 'walkin',
        items: [{ productId: multiProduct.id, skuId: blueSku.id, qty: 1, unitPrice: 15 }],
      }),
      /当前版本|规格无效|已退役/,
    )
    blueSkuEntity.isCurrent = true
    await skuRepo.save(blueSkuEntity)

    const beforeProduct = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: multiProduct.id })
    const beforeSkuRows = await skuRepo.find({ where: { productId: multiProduct.id }, order: { id: 'ASC' } })
    const beforeInventoryLogCount = await AppDataSource.getRepository(InventoryLog).count()
    const multiResult = await submit({
      idempotencyKey: `manual-multi-${verifySeed}`,
      orderType: 'walkin',
      customerName: '多规格验证',
      items: [
        { productId: multiProduct.id, skuId: redSku.id, qty: 2, unitPrice: 18.8, remark: '红色人工价' },
        { productId: multiProduct.id, skuId: blueSku.id, qty: 3, unitPrice: 20.6, remark: '蓝色人工价' },
      ],
    })
    assert.equal(multiResult.items.length, 2, '同一商品不同 SKU 必须允许分行保存')

    const storedItems = await AppDataSource.getRepository(BizOutboundOrderItem).find({
      where: { orderId: multiResult.order.id },
      order: { lineNo: 'ASC' },
    })
    assert.deepEqual(
      storedItems.map((item) => String((item as unknown as Record<string, unknown>).skuId)),
      [redSku.id, blueSku.id],
    )
    assert.deepEqual(storedItems.map((item) => (item as unknown as Record<string, unknown>).skuCodeSnapshot), [redSku.skuCode, blueSku.skuCode])
    assert.deepEqual(storedItems.map((item) => (item as unknown as Record<string, unknown>).specTextSnapshot), [redSku.specText, blueSku.specText])
    assert.deepEqual(storedItems.map((item) => Number(item.unitPrice).toFixed(2)), ['18.80', '20.60'])

    const afterForwardProduct = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: multiProduct.id })
    await submit({
      idempotencyKey: `manual-multi-reversed-${verifySeed}`,
      orderType: 'walkin',
      customerName: '多规格反序验证',
      items: [
        { productId: multiProduct.id, skuId: blueSku.id, qty: 3, unitPrice: 20.6, remark: '蓝色人工价' },
        { productId: multiProduct.id, skuId: redSku.id, qty: 2, unitPrice: 18.8, remark: '红色人工价' },
      ],
    })
    const afterReversedProduct = await AppDataSource.getRepository(BaseProduct).findOneByOrFail({ id: multiProduct.id })
    const afterSkuRows = await skuRepo.find({ where: { productId: multiProduct.id }, order: { id: 'ASC' } })
    assert.equal(
      Number(afterForwardProduct.defaultPrice).toFixed(2),
      Number(beforeProduct.defaultPrice).toFixed(2),
      '多 current SKU 商品不得因正序手工明细将最后一行价格回写为商品主价',
    )
    assert.equal(
      Number(afterReversedProduct.defaultPrice).toFixed(2),
      Number(beforeProduct.defaultPrice).toFixed(2),
      '多 current SKU 商品不得因反序手工明细将最后一行价格回写为商品主价',
    )
    assert.equal(afterReversedProduct.currentStock, beforeProduct.currentStock, '手工出库不得修改商品库存')
    assert.equal(afterReversedProduct.preOrderedStock, beforeProduct.preOrderedStock, '手工出库不得修改商品预订库存')
    assert.deepEqual(
      afterSkuRows.map((sku) => [sku.id, sku.currentStock, sku.preOrderedStock, sku.defaultPrice]),
      beforeSkuRows.map((sku) => [sku.id, sku.currentStock, sku.preOrderedStock, sku.defaultPrice]),
      '手工出库不得修改 SKU 库存或 SKU 默认价',
    )
    assert.equal(await AppDataSource.getRepository(InventoryLog).count(), beforeInventoryLogCount, '手工出库不得新增库存流水')

    await expectBizError(
      () => submit({
        idempotencyKey: `manual-duplicate-sku-${verifySeed}`,
        orderType: 'walkin',
        items: [
          { productId: multiProduct.id, skuId: redSku.id, qty: 1, unitPrice: 13 },
          { productId: multiProduct.id, skuId: redSku.id, qty: 1, unitPrice: 13 },
        ],
      }),
      /同一规格|重复/,
    )

    await AppDataSource.query(
      'UPDATE "biz_outbound_order_item" SET "sku_id" = NULL, "sku_code_snapshot" = NULL, "spec_text_snapshot" = NULL WHERE "order_id" = ?',
      [singleResult.order.id],
    )
    const legacyDetail = await orderService.detailById(singleResult.order.id)
    const legacyItem = legacyDetail.items[0] as unknown as Record<string, unknown>
    assert.equal(legacyItem.skuId, null)
    assert.equal(legacyItem.skuCodeSnapshot, null)
    assert.equal(legacyItem.specTextSnapshot, null)
    assert.equal(legacyItem.productName, singleProduct.productName, '历史无 SKU 行必须继续使用商品名称快照')

    const report = await reportService.query('walkin', {
      page: 1,
      pageSize: 100,
      fields: ['productName', 'specText', 'unitPrice'],
    })
    const multiReportRows = report.list.filter((row) => row.productName === multiProduct.productName)
    assert.deepEqual(new Set(multiReportRows.map((row) => row.specText)), new Set([redSku.specText, blueSku.specText]))
    const legacyReportRow = report.list.find((row) => row.productName === singleProduct.productName)
    assert.equal(legacyReportRow?.specText, '-', '历史无 SKU 报表行必须提供稳定占位而不是回查当前规格')

    const { aggregateOrderVoucherItems } = await import('../../src/views/order-list/order-voucher-aggregation.js')
    const voucherRows = aggregateOrderVoucherItems([
      { id: '1', productId: multiProduct.id, skuId: redSku.id, productName: multiProduct.productName, specText: redSku.specText, qty: '2.00', unitPrice: '18.80', subTotal: '37.60' },
      { id: '2', productId: multiProduct.id, skuId: blueSku.id, productName: multiProduct.productName, specText: blueSku.specText, qty: '3.00', unitPrice: '20.60', subTotal: '61.80' },
    ])
    assert.equal(voucherRows.length, 2, '打印/PDF 展示不得合并同商品的不同 SKU')
    assert.ok(voucherRows.some((row) => row.productName.includes(redSku.specText)))
    assert.ok(voucherRows.some((row) => row.productName.includes(blueSku.specText)))

    const routeSource = readSource('backend/src/routes/order.routes.ts')
    const orderEntryTypeSource = readSource('src/views/order-entry/types.ts')
    const orderEntryFormSource = readSource('src/views/order-entry/composables/useOrderEntryForm.ts')
    const orderEntryEditorSource = readSource('src/views/order-entry/components/OrderEntryItemsEditor.vue')
    assert.match(routeSource, /skuId:\s*z\.union/)
    assert.match(orderEntryTypeSource, /skuId:\s*string/)
    assert.match(orderEntryFormSource, /handleSkuChange/)
    assert.match(orderEntryFormSource, /row\.skuId\s*\?\?\s*''/, '旧草稿缺少 skuId 时必须按空值恢复')
    assert.match(orderEntryEditorSource, /v-model="row\.skuId"/)
    assert.match(orderEntryEditorSource, /v-model="drawerForm\.skuId"/)
    assert.doesNotMatch(orderEntryEditorSource, /:disabled="isExistingProduct\([^)]*\)"/, 'SKU 价格只预填，人工单价输入不得禁用')

    const migrationSource = readSource('backend/sql/041_manual_outbound_sku.sql')
    for (const column of ['sku_id', 'sku_code_snapshot', 'spec_text_snapshot']) {
      assert.ok(migrationSource.includes(column), `MySQL 幂等迁移缺少 ${column}`)
    }

    console.log('手工出库 SKU 专项验证通过：校验、快照、主价隔离、SQLite 外键、历史兼容、展示与零库存副作用均符合预期')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(`[manual-order-sku-verify] 验证失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  cleanupSqliteFile()
  process.exitCode = 1
})
