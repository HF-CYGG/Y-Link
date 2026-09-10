/**
 * 模块说明：backend/scripts/report-inventory-verify.ts
 * 文件职责：使用隔离 SQLite 验证商品服务、库存报表预览和真实 Excel 的库存汇总口径一致。
 * 实现逻辑：
 * - 手工固定商品主表与 SKU 差异夹具，覆盖当前、停用、退役和无当前 SKU 的回退语义；
 * - 调用真实 ProductService、ReportService，并解析流式生成的 ExcelJS 工作簿；
 * - 对三个出口逐项核对固定期望，同时确认报表读取不会修改库存或库存流水。
 * 维护说明：
 * - 夹具期望必须独立手工给出，不能从任一被测出口反推；
 * - 脚本只能连接本次唯一临时 SQLite，禁止读取或修改业务数据库。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'
import type { ReportQueryInput, ReportType } from '../src/services/report.service.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `report-inventory-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `report-inventory-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

type StockTriple = readonly [currentStock: number, preOrderedStock: number, availableStock: number]

type FixtureInput = {
  code: string
  name: string
  mainStock: StockTriple
  skus: Array<{
    suffix: string
    currentStock: number
    preOrderedStock: number
    isActive: boolean
    isCurrent: boolean
  }>
  expected: StockTriple
}

const fixtures: FixtureInput[] = [
  {
    code: 'REPORT-DEFAULT',
    name: '默认规格差额商品',
    mainStock: [90, 40, 50],
    skus: [{ suffix: 'DEFAULT', currentStock: 8, preOrderedStock: 3, isActive: true, isCurrent: true }],
    expected: [8, 3, 5],
  },
  {
    code: 'REPORT-MULTI',
    name: '多规格占用商品',
    mainStock: [100, 60, 40],
    skus: [
      { suffix: 'A', currentStock: 7, preOrderedStock: 2, isActive: true, isCurrent: true },
      { suffix: 'B', currentStock: 4, preOrderedStock: 1, isActive: true, isCurrent: true },
    ],
    expected: [11, 3, 8],
  },
  {
    code: 'REPORT-ZERO',
    name: '零库存商品',
    mainStock: [12, 5, 7],
    skus: [{ suffix: 'ZERO', currentStock: 0, preOrderedStock: 0, isActive: true, isCurrent: true }],
    expected: [0, 0, 0],
  },
  {
    code: 'REPORT-INACTIVE',
    name: '当前规格全停用商品',
    mainStock: [14, 4, 10],
    skus: [{ suffix: 'OFF', currentStock: 14, preOrderedStock: 4, isActive: false, isCurrent: true }],
    expected: [0, 0, 0],
  },
  {
    code: 'REPORT-HISTORY',
    name: '仅历史规格商品',
    mainStock: [9, 1, 8],
    skus: [{ suffix: 'OLD', currentStock: 50, preOrderedStock: 10, isActive: true, isCurrent: false }],
    expected: [9, 1, 8],
  },
  {
    code: 'REPORT-NO-SKU',
    name: '无规格旧数据商品',
    mainStock: [6, 2, 4],
    skus: [],
    expected: [6, 2, 4],
  },
]

const reportTitleMap: Record<ReportType, string> = {
  inventory: '库存一览表',
  'tag-sales': '标签销售汇总表',
  kingdee: '金蝶汇总表',
  walkin: '散客汇总表',
  'outbound-flow': '出库单流水表',
}

function cleanupSqliteFile() {
  for (const suffix of ['', '-shm', '-wal']) {
    const target = `${sqlitePath}${suffix}`
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true })
    }
  }
}

function stockFromRow(row: Record<string, unknown>): StockTriple {
  return [Number(row.currentStock), Number(row.preOrderedStock), Number(row.availableStock)]
}

function collectStockMismatches(
  source: string,
  rows: Array<Record<string, unknown>>,
  mismatches: string[],
) {
  const rowMap = new Map(rows.map((row) => [String(row.productCode), row]))
  for (const fixture of fixtures) {
    const row = rowMap.get(fixture.code)
    if (!row) {
      mismatches.push(`${source} 缺少 ${fixture.code}`)
      continue
    }
    const actual = stockFromRow(row)
    if (actual.some((value, index) => value !== fixture.expected[index])) {
      mismatches.push(`${source} ${fixture.code} 期望 ${fixture.expected.join('/')}，实际 ${actual.join('/')}`)
    }
  }
}

async function exportReportBuffer(
  reportService: typeof import('../src/services/report.service.js').reportService,
  type: ReportType,
  input: ReportQueryInput,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      callback()
    },
  })
  await reportService.exportExcel(type, input, output, undefined, `report-${type}-${verifySeed}`)
  return Buffer.concat(chunks)
}

async function parseReportExcel(buffer: Buffer, type: ReportType) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const worksheet = workbook.getWorksheet(reportTitleMap[type])
  assert.ok(worksheet, `流式导出必须生成${reportTitleMap[type]}工作表`)
  assert.equal(worksheet.views[0]?.state, 'frozen', `${reportTitleMap[type]}必须冻结表头`)
  assert.equal(worksheet.views[0]?.ySplit, 5, `${reportTitleMap[type]}必须冻结前五行`)
  const headers = (worksheet.getRow(5).values as unknown[]).slice(1).map((value) => String(value ?? ''))
  const rows: unknown[][] = []
  for (let rowNumber = 6; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const values = (worksheet.getRow(rowNumber).values as unknown[]).slice(1)
    if (!values.every((value) => value === null || value === undefined || value === '')) {
      rows.push(values)
    }
  }
  return { headers, rows }
}

async function parseInventoryExcel(buffer: Buffer): Promise<Array<Record<string, unknown>>> {
  const { headers, rows: worksheetRows } = await parseReportExcel(buffer, 'inventory')
  assert.deepEqual(headers, ['商品编码', '当前库存', '预订库存', '可用库存'])
  return worksheetRows.map((values) => ({
      productCode: values[0],
      currentStock: values[1],
      preOrderedStock: values[2],
      availableStock: values[3],
  }))
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { BaseTag } = await import('../src/entities/base-tag.entity.js')
  const { RelProductTag } = await import('../src/entities/rel-product-tag.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { inboundService } = await import('../src/services/inbound.service.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
  const { orderService } = await import('../src/services/order.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { reportService } = await import('../src/services/report.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { summarizeProductInventory } = await import('../src/utils/product-inventory-summary.js')

  assert.deepEqual(
    summarizeProductInventory(
      { currentStock: '99', preOrderedStock: '88' },
      [{ currentStock: '-3', preOrderedStock: '2', isActive: 'true', isCurrent: 'true' }],
    ),
    { currentStock: 0, preOrderedStock: 2, availableStock: 0 },
    'SKU 数字字符串应沿用 Math.max(0, Number(value))，flag 字符串 true 应保持启用',
  )
  assert.deepEqual(
    summarizeProductInventory(
      { currentStock: '-4', preOrderedStock: '-2' },
      [{ currentStock: '30', preOrderedStock: '10', isActive: 'true', isCurrent: 'false' }],
    ),
    { currentStock: -4, preOrderedStock: -2, availableStock: 0 },
    '无当前 SKU 时应原样保留主表 Number(...) 回退语义',
  )
  const nonFiniteSkuSummary = summarizeProductInventory(
    { currentStock: '8', preOrderedStock: '2' },
    [{ currentStock: 'not-a-number', preOrderedStock: '1', isActive: true, isCurrent: true }],
  )
  assert.equal(Number.isNaN(nonFiniteSkuSummary.currentStock), true, 'SKU 非数值应保持既有 NaN 语义，不得静默归零')
  assert.deepEqual(
    summarizeProductInventory(
      { currentStock: '7', preOrderedStock: '1' },
      [false, 0, '0', 'false'].map((isCurrent) => ({
        currentStock: 99,
        preOrderedStock: 88,
        isActive: true,
        isCurrent,
      })),
    ),
    { currentStock: 7, preOrderedStock: 1, availableStock: 6 },
    'false/0/字符串 0/字符串 false 都必须被识别为非当前 SKU',
  )
  assert.deepEqual(
    summarizeProductInventory(
      { currentStock: '7', preOrderedStock: '1' },
      [false, 0, '0', 'false'].map((isActive) => ({
        currentStock: 99,
        preOrderedStock: 88,
        isActive,
        isCurrent: true,
      })),
    ),
    { currentStock: 0, preOrderedStock: 0, availableStock: 0 },
    '存在当前 SKU 但全部以兼容假值停用时库存必须为零，不能回退主表',
  )

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()
    const productRepo = AppDataSource.getRepository(BaseProduct)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const tagRepo = AppDataSource.getRepository(BaseTag)
    const relationRepo = AppDataSource.getRepository(RelProductTag)
    const inventoryLogRepo = AppDataSource.getRepository(InventoryLog)
    const tag = await tagRepo.save(tagRepo.create({
      tagName: `库存报表验证-${verifySeed}`,
      tagCode: `REPORT-${verifySeed}`,
    }))

    for (const [fixtureIndex, fixture] of fixtures.entries()) {
      const product = await productRepo.save(productRepo.create({
        productCode: `${fixture.code}-${verifySeed}`,
        productName: fixture.name,
        pinyinAbbr: 'KCBG',
        defaultPrice: '10.00',
        discountRate: '10.0',
        isActive: true,
        o2oStatus: 'unlisted',
        o2oRecommended: false,
        thumbnail: null,
        detailContent: null,
        limitPerUser: 20,
        currentStock: fixture.mainStock[0],
        preOrderedStock: fixture.mainStock[1],
      }))
      await relationRepo.save(relationRepo.create({ productId: product.id, tagId: tag.id }))
      if (fixture.skus.length > 0) {
        await skuRepo.save(fixture.skus.map((sku, skuIndex) => skuRepo.create({
          productId: product.id,
          skuCode: `${fixture.code}-${sku.suffix}-${verifySeed}`,
          specValuesJson: JSON.stringify({ 规格: sku.suffix }),
          specText: sku.suffix,
          defaultPrice: '10.00',
          discountRate: '10.0',
          currentStock: sku.currentStock,
          preOrderedStock: sku.preOrderedStock,
          isActive: sku.isActive,
          isCurrent: sku.isCurrent,
          o2oRecommended: false,
          thumbnail: null,
          sortOrder: fixtureIndex * 10 + skuIndex,
        })))
      }
      fixture.code = String(product.productCode)
    }

    const beforeSnapshot = {
      products: await productRepo.find({ order: { id: 'ASC' } }),
      skus: await skuRepo.find({ order: { id: 'ASC' } }),
      inventoryLogs: await inventoryLogRepo.find({ order: { id: 'ASC' } }),
    }
    const mismatches: string[] = []
    const productViews = await productService.list({ tagId: String(tag.id) })
    collectStockMismatches('商品服务', productViews as unknown as Array<Record<string, unknown>>, mismatches)

    const reportInput = {
      page: 1,
      pageSize: 100,
      tagIds: [String(tag.id)],
      fields: ['productCode', 'currentStock', 'preOrderedStock', 'availableStock'],
    }
    const preview = await reportService.query('inventory', reportInput)
    assert.equal(preview.total, fixtures.length)
    collectStockMismatches('报表预览', preview.list, mismatches)

    const excelRows = await parseInventoryExcel(await exportReportBuffer(reportService, 'inventory', reportInput))
    assert.equal(excelRows.length, fixtures.length)
    collectStockMismatches('Excel 导出', excelRows, mismatches)

    const afterSnapshot = {
      products: await productRepo.find({ order: { id: 'ASC' } }),
      skus: await skuRepo.find({ order: { id: 'ASC' } }),
      inventoryLogs: await inventoryLogRepo.find({ order: { id: 'ASC' } }),
    }
    assert.deepEqual(afterSnapshot, beforeSnapshot, '商品/报表/Excel 读取前后不得修改商品、SKU 或库存流水')
    assert.deepEqual(mismatches, [], mismatches.join('\n'))

    const pagedCodes: string[] = []
    for (let page = 1; page <= 3; page += 1) {
      const paged = await reportService.query('inventory', {
        page,
        pageSize: 2,
        tagIds: [String(tag.id)],
        fields: ['productCode', 'currentStock'],
      })
      assert.equal(paged.total, fixtures.length)
      assert.deepEqual(paged.fields.map((field) => field.key), ['productCode', 'currentStock'])
      pagedCodes.push(...paged.list.map((row) => String(row.productCode)))
    }
    assert.equal(new Set(pagedCodes).size, fixtures.length, '库存预览分页不得出现重复或漏行')
    assert.deepEqual(new Set(pagedCodes), new Set(fixtures.map((fixture) => fixture.code)))

    for (const type of ['tag-sales', 'kingdee', 'walkin', 'outbound-flow'] as const) {
      const { headers, rows } = await parseReportExcel(await exportReportBuffer(reportService, type, {}), type)
      assert.deepEqual(headers, reportService.getFieldDefinitions(type).map((field) => field.label))
      assert.equal(rows.length, 0, `${reportTitleMap[type]}空结果导出不得生成伪数据行`)
    }

    const fillerProducts = Array.from({ length: 501 }, (_, index) => productRepo.create({
      productCode: `REPORT-BATCH-${String(index + 1).padStart(3, '0')}-${verifySeed}`,
      productName: `跨批次库存商品${String(index + 1).padStart(3, '0')}`,
      pinyinAbbr: 'KPCB',
      defaultPrice: '1.00',
      discountRate: '10.0',
      isActive: true,
      o2oStatus: 'unlisted',
      o2oRecommended: false,
      thumbnail: null,
      detailContent: null,
      limitPerUser: 20,
      currentStock: index % 9,
      preOrderedStock: 0,
    }))
    await productRepo.save(fillerProducts, { chunk: 100 })
    const beforeLargeExport = {
      products: await productRepo.find({ order: { id: 'ASC' } }),
      skus: await skuRepo.find({ order: { id: 'ASC' } }),
      inventoryLogs: await inventoryLogRepo.find({ order: { id: 'ASC' } }),
    }
    const expectedCodes = beforeLargeExport.products.map((product) => product.productCode)
    const largeExport = await parseReportExcel(
      await exportReportBuffer(reportService, 'inventory', { fields: ['productCode'] }),
      'inventory',
    )
    assert.deepEqual(largeExport.headers, ['商品编码'])
    const exportedCodes = largeExport.rows.map((row) => String(row[0]))
    assert.equal(exportedCodes.length, expectedCodes.length, '跨 500 行批次导出不得漏行')
    assert.equal(new Set(exportedCodes).size, expectedCodes.length, '跨 500 行批次导出不得重复')
    assert.deepEqual(new Set(exportedCodes), new Set(expectedCodes), '跨批次导出商品集合必须与数据库固定集合一致')
    const afterLargeExport = {
      products: await productRepo.find({ order: { id: 'ASC' } }),
      skus: await skuRepo.find({ order: { id: 'ASC' } }),
      inventoryLogs: await inventoryLogRepo.find({ order: { id: 'ASC' } }),
    }
    assert.deepEqual(afterLargeExport, beforeLargeExport, '跨批次导出前后不得修改商品、SKU 或库存流水')

    const lifecycleTag = await tagRepo.save(tagRepo.create({
      tagName: `库存生命周期-${verifySeed}`,
      tagCode: `LIFECYCLE-${verifySeed}`,
    }))
    const lifecycleProduct = await productService.create({
      productCode: `REPORT-LIFECYCLE-${verifySeed}`,
      productName: `库存生命周期商品-${verifySeed}`,
      pinyinAbbr: 'KCSMZQ',
      defaultPrice: 10,
      discountRate: 10,
      isActive: true,
      o2oStatus: 'listed',
      currentStock: 10,
      limitPerUser: 20,
      tagIds: [String(lifecycleTag.id)],
    })
    const lifecycleSku = lifecycleProduct.skus[0]
    assert.ok(lifecycleSku, '生命周期商品必须生成默认 SKU')

    const readStoredLifecycleState = async () => {
      const [product, skus, logs] = await Promise.all([
        productRepo.findOneByOrFail({ id: lifecycleProduct.id }),
        skuRepo.find({ where: { productId: lifecycleProduct.id }, order: { id: 'ASC' } }),
        inventoryLogRepo.find({ where: { productId: lifecycleProduct.id }, order: { id: 'ASC' } }),
      ])
      return {
        product: [Number(product.currentStock), Number(product.preOrderedStock)],
        skus: skus.map((sku) => [
          String(sku.id),
          Number(sku.currentStock),
          Number(sku.preOrderedStock),
          sku.isActive,
          sku.isCurrent,
        ]),
        logs: logs.map((log) => [
          String(log.id),
          log.changeType,
          Number(log.changeQty),
          Number(log.beforeCurrentStock),
          Number(log.afterCurrentStock),
          Number(log.beforePreorderedStock),
          Number(log.afterPreorderedStock),
        ]),
      }
    }

    const assertLifecycleStock = async (expected: StockTriple, scene: string) => {
      const storedBefore = await readStoredLifecycleState()
      const detail = await productService.detail(lifecycleProduct.id)
      assert.deepEqual(
        [detail.currentStock, detail.preOrderedStock, detail.availableStock],
        expected,
        `${scene}：商品服务库存不符`,
      )
      const lifecycleInput: ReportQueryInput = {
        tagIds: [String(lifecycleTag.id)],
        fields: ['productCode', 'currentStock', 'preOrderedStock', 'availableStock'],
      }
      const lifecyclePreview = await reportService.query('inventory', lifecycleInput)
      assert.equal(lifecyclePreview.total, 1, `${scene}：生命周期标签只能命中一个商品`)
      assert.deepEqual(stockFromRow(lifecyclePreview.list[0] ?? {}), expected, `${scene}：报表预览库存不符`)
      const lifecycleExcelRows = await parseInventoryExcel(
        await exportReportBuffer(reportService, 'inventory', lifecycleInput),
      )
      assert.equal(lifecycleExcelRows.length, 1, `${scene}：Excel 只能包含一个生命周期商品`)
      assert.deepEqual(stockFromRow(lifecycleExcelRows[0] ?? {}), expected, `${scene}：Excel 库存不符`)
      assert.deepEqual(await readStoredLifecycleState(), storedBefore, `${scene}：三个读取出口不得修改库存或流水`)
    }

    await assertLifecycleStock([10, 0, 10], '初始库存')

    const supplierRepo = AppDataSource.getRepository(SysUser)
    const supplier = await supplierRepo.save(supplierRepo.create({
      username: `report-supplier-${verifySeed}`,
      passwordHash: 'verify-only',
      displayName: '库存报表验证供货方',
      email: null,
      role: 'supplier',
      status: 'enabled',
      lastLoginAt: null,
    }))
    const supplierActor: AuthUserContext = {
      userId: String(supplier.id),
      username: supplier.username,
      displayName: supplier.displayName,
      role: 'supplier',
      permissions: [],
      status: 'enabled',
      sessionToken: 'report-inventory-supplier',
      authSource: 'bearer',
    }
    const adminActor: AuthUserContext = {
      ...supplierActor,
      userId: 'report-inventory-admin',
      username: 'report-inventory-admin',
      displayName: '库存报表验证管理员',
      role: 'admin',
      sessionToken: 'report-inventory-admin-session',
    }
    const inbound = await inboundService.submitSupplierDelivery(supplierActor, {
      remark: '库存报表真实入库验证',
      items: [{ productId: lifecycleProduct.id, skuId: lifecycleSku.id, qty: 5 }],
    })
    await inboundService.verifyInbound(inbound.order.verifyCode, adminActor)
    await assertLifecycleStock([15, 0, 15], '入库后')

    const clientRepo = AppDataSource.getRepository(ClientUser)
    const client = await clientRepo.save(clientRepo.create({
      mobile: `1${Date.now().toString().slice(-10)}`,
      email: null,
      mobileVerifiedAt: new Date(),
      emailVerifiedAt: null,
      passwordHash: 'verify-only',
      realName: '库存报表验证客户',
      departmentName: '',
      accountType: 'personal',
      staffNo: null,
      staffVerified: false,
      status: 'enabled',
      lastLoginAt: null,
    }))
    const clientAuth: ClientAuthContext = {
      userId: String(client.id),
      account: client.mobile,
      mobile: client.mobile,
      email: '',
      realName: client.realName,
      accountType: 'personal',
      staffNo: null,
      sessionToken: 'report-inventory-client-session',
    }

    const cancelledPreorder = await o2oPreorderService.submit(clientAuth, {
      clientRequestId: `report-inventory-cancel-${verifySeed}`,
      items: [{ productId: lifecycleProduct.id, skuId: lifecycleSku.id, qty: 2 }],
      pickupContact: '库存报表验证客户',
      isSystemApplied: false,
    })
    await assertLifecycleStock([15, 2, 13], '预占后')
    await o2oPreorderService.cancelMyOrder(clientAuth, cancelledPreorder.order.id)
    await assertLifecycleStock([15, 0, 15], '取消后')

    const verifiedPreorder = await o2oPreorderService.submit(clientAuth, {
      clientRequestId: `report-inventory-verify-${verifySeed}`,
      items: [{ productId: lifecycleProduct.id, skuId: lifecycleSku.id, qty: 3 }],
      pickupContact: '库存报表验证客户',
      isSystemApplied: false,
    })
    await assertLifecycleStock([15, 3, 12], '核销前预占后')
    await o2oPreorderService.verifyByCode(verifiedPreorder.order.verifyCode, adminActor)
    await assertLifecycleStock([12, 0, 12], '核销后')

    const returnRequest = await o2oPreorderService.createReturnRequest(clientAuth, verifiedPreorder.order.id, {
      reason: '库存报表真实退货验证',
      items: [{ productId: lifecycleProduct.id, skuId: lifecycleSku.id, qty: 1 }],
    })
    await o2oPreorderService.verifyByCode(returnRequest.verifyCode, adminActor)
    await assertLifecycleStock([13, 0, 13], '退货后')

    const beforeOrdinaryOrder = await readStoredLifecycleState()
    await orderService.submit({
      idempotencyKey: `report-inventory-ordinary-${verifySeed}`,
      orderType: 'walkin',
      customerName: '库存报表普通出库验证',
      items: [{ productId: lifecycleProduct.id, qty: 2, unitPrice: 10 }],
    }, adminActor)
    assert.deepEqual(await readStoredLifecycleState(), beforeOrdinaryOrder, '普通出库保存单据与价格时不得改变商品/SKU库存或库存流水')
    await assertLifecycleStock([13, 0, 13], '普通出库后')

    console.log('库存报表专项验证通过：固定口径、分页、跨批次、真实 Excel 与库存生命周期均一致')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
    cleanupSqliteFile()
  }
}

main().catch((error) => {
  console.error(`[report-inventory-verify] 验证失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  cleanupSqliteFile()
  process.exitCode = 1
})
