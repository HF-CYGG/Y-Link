/**
 * 文件说明：文创店库存管理（Issue #103）端到端验证。
 * 覆盖：分类/库位主数据、WC 编码与初始库存流水、条码唯一与扫码识别、打印数据、Excel 预览与导入、
 * 库存单据（入库/出库/报损/调整/幂等/作废）、盘点（盲盘裁剪、计数、范围外追加、并发冲突、差异处理、确认调账）。
 * 每一步都校验：商品库存 = 当前启用 SKU 合计、流水 after − before = changeQty、库存不为负。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import ExcelJS from 'exceljs'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `inventory-stock-management-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `inventory-stock-management-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${verifySeed}_Aa1!`

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${sqlitePath}${suffix}`
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { productService } = await import('../src/services/product.service.js')
  const { productExcelService } = await import('../src/services/product-excel.service.js')
  const { inventoryMasterDataService } = await import('../src/services/inventory-master-data.service.js')
  const { inventoryDocService } = await import('../src/services/inventory-doc.service.js')
  const { inventoryQueryService } = await import('../src/services/inventory-query.service.js')
  const { stocktakeService } = await import('../src/services/stocktake.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    const userRepo = AppDataSource.getRepository(SysUser)
    const buildActor = async (role: 'admin' | 'operator', name: string): Promise<AuthUserContext> => {
      const user = await userRepo.save(userRepo.create({
        username: `${role}-${verifySeed}`,
        passwordHash: 'verify-only',
        displayName: name,
        email: null,
        role,
        status: 'enabled',
        lastLoginAt: null,
      }))
      return {
        userId: String(user.id),
        username: user.username,
        displayName: user.displayName,
        role,
        permissions: resolvePermissionsByRole(role),
        status: 'enabled',
        sessionToken: `verify-${role}`,
        authSource: 'bearer',
      }
    }
    const admin = await buildActor('admin', '库存验证管理员')
    const operator = await buildActor('operator', '库存验证店员')
    assert.ok(operator.permissions.includes('stocktake:count'))
    assert.ok(!operator.permissions.includes('stocktake:approve'))

    const assertInvariants = async () => {
      const products = await AppDataSource.getRepository(BaseProduct).find()
      const skus = await AppDataSource.getRepository(BaseProductSku).find()
      for (const product of products) {
        const total = skus
          .filter((sku) => String(sku.productId) === String(product.id) && sku.isActive && sku.isCurrent)
          .reduce((sum, sku) => sum + Number(sku.currentStock), 0)
        assert.equal(Number(product.currentStock), total, `商品 ${product.productName} 汇总库存应等于启用 SKU 合计`)
      }
      for (const sku of skus) assert.ok(Number(sku.currentStock) >= 0, `SKU ${sku.skuCode} 库存不能为负`)
      const logs = await AppDataSource.getRepository(InventoryLog).find()
      for (const log of logs) {
        if (log.beforeSkuCurrentStock !== null && log.changeType.startsWith('stock')) {
          assert.equal(Number(log.afterSkuCurrentStock) - Number(log.beforeSkuCurrentStock), Number(log.changeQty), `流水 ${log.id} 差量不一致`)
        }
      }
    }
    const skuStock = async (skuId: string) => Number((await AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: skuId })).currentStock)

    // ---- 主数据 ----
    const stickers = await inventoryMasterDataService.createCategory({ categoryCode: '02', categoryName: '贴纸' }, admin)
    const bags = await inventoryMasterDataService.createCategory({ categoryCode: '03', categoryName: '帆布包' }, admin)
    await assert.rejects(() => inventoryMasterDataService.createCategory({ categoryCode: '2', categoryName: '非法' }, admin), /两位数字/)
    await assert.rejects(() => inventoryMasterDataService.createCategory({ categoryCode: '02', categoryName: '重复' }, admin), /已存在/)
    const shelfA = await inventoryMasterDataService.createLocation({ locationCode: 'a-01-01', locationName: 'A 架一层' }, admin)
    assert.equal(shelfA.locationCode, 'A-01-01')
    const shelfB = await inventoryMasterDataService.createLocation({ locationCode: 'B-02-01' }, admin)

    // ---- WC 编码、初始库存流水、条码 ----
    const starSticker = await productService.create({
      productName: '星空贴纸',
      defaultPrice: 6,
      categoryId: stickers.id,
      currentStock: 25,
      skus: [{ specValues: {}, currentStock: 25, costPrice: 2.5, locationId: shelfA.id }],
    }, admin)
    const starSku = starSticker.skus[0]
    assert.equal(starSku.skuCode, 'WC02001')
    assert.equal(starSku.effectiveBarcode, 'WC02001')
    assert.equal(starSku.locationCode, 'A-01-01')
    assert.equal(starSku.costPrice, '2.50')
    assert.equal(starSticker.categoryName, '贴纸')
    const initialLog = await AppDataSource.getRepository(InventoryLog).findOneByOrFail({ skuId: starSku.id, changeType: 'stock_initial' })
    assert.equal(Number(initialLog.changeQty), 25)
    assert.equal(Number(initialLog.beforeSkuCurrentStock), 0)
    assert.match(String(initialLog.remark), /新建商品初始库存/)

    const bag = await productService.create({
      productName: '帆布包',
      defaultPrice: 49,
      categoryId: bags.id,
      specGroups: [{ name: '颜色', values: ['米白', '黑色'] }],
      skus: [
        { specValues: { 颜色: '米白' }, currentStock: 10, barcode: '6901234567892', locationId: shelfB.id },
        { specValues: { 颜色: '黑色' }, currentStock: 8 },
      ],
    }, admin)
    assert.deepEqual(bag.skus.map((sku) => sku.skuCode), ['WC03001', 'WC03002'])
    const [whiteBag, blackBag] = bag.skus
    assert.equal(whiteBag.effectiveBarcode, '6901234567892')
    await assert.rejects(() => productService.create({
      productName: '撞码商品',
      skus: [{ specValues: {}, barcode: '6901234567892' }],
    }, admin), /已被其他商品的规格使用/)
    await assert.rejects(() => productService.create({
      productName: '撞编码商品',
      skus: [{ specValues: {}, barcode: 'WC02001' }],
    }, admin), /已被其他商品的规格使用/)
    await assert.rejects(() => inventoryMasterDataService.updateCategory(stickers.id, { categoryCode: '09' }, admin), /不能修改分类编码/)

    // 单规格商品：通过 defaultSku 维护默认规格的条码、成本价与库位；多规格商品不允许走该入口。
    const pen = await productService.create({ productName: '金属书签笔', defaultPrice: 12, currentStock: 3 }, admin)
    assert.equal(pen.skus[0].skuCode.endsWith('-DEFAULT'), true)
    const penUpdated = await productService.update(pen.id, { defaultSku: { barcode: '6907777777770', costPrice: 4.2, locationId: shelfB.id } }, admin)
    assert.equal(penUpdated.skus[0].barcode, '6907777777770')
    assert.equal(penUpdated.skus[0].costPrice, '4.20')
    assert.equal(penUpdated.skus[0].locationCode, 'B-02-01')
    assert.equal(penUpdated.currentStock, 3)
    await assert.rejects(() => productService.update(bag.id, { defaultSku: { barcode: '6908888888881' } }, admin), /多规格商品/)
    const penCleared = await productService.update(pen.id, { defaultSku: { barcode: null, locationId: null } }, admin)
    assert.equal(penCleared.skus[0].barcode, null)
    assert.equal(penCleared.skus[0].locationId, null)
    assert.equal(penCleared.skus[0].costPrice, '4.20')

    const byBarcode = await productService.lookupByCode('6901234567892')
    assert.equal(byBarcode.matchedBy, 'barcode')
    assert.equal(byBarcode.sku.id, whiteBag.id)
    const byCode = await productService.lookupByCode('WC02001')
    assert.equal(byCode.matchedBy, 'sku_code')
    assert.equal(byCode.product.productName, '星空贴纸')
    await assert.rejects(() => productService.lookupByCode('NOT-EXISTS'), /未找到/)
    const labels = await productService.listLabels([blackBag.id, starSku.id])
    assert.deepEqual(labels.map((label) => label.barcode), ['WC03002', 'WC02001'])
    assert.equal(labels[1].locationCode, 'A-01-01')
    const filtered = await productService.list({ keyword: '6901234567892' })
    assert.deepEqual(filtered.map((item) => item.id), [bag.id])
    const byCategory = await productService.list({ categoryId: stickers.id })
    assert.deepEqual(byCategory.map((item) => item.id), [starSticker.id])
    await assertInvariants()

    // ---- Excel ----
    const template = await productExcelService.buildTemplate()
    assert.ok(template.length > 1000)
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('导入')
    sheet.addRow(['商品名称*', '分类编码', '规格（如 颜色=红;尺寸=L）', 'SKU编码（留空自动生成）', '原厂条码', '成本价', '售价', '初始库存', '库位编码', '商品状态（启用/停用）'])
    sheet.addRow(['书签', '02', '', '', '', 1, 3, 40, 'A-01-01', '启用'])
    sheet.addRow(['明信片', '02', '款式=城市', '', '', 1, 5, 12, '', '启用'])
    sheet.addRow(['明信片', '02', '款式=山川', '', '6909999999999', 1, 5, 6, '', '启用'])
    const goodBuffer = Buffer.from(await workbook.xlsx.writeBuffer())
    const preview = await productExcelService.preview(goodBuffer)
    assert.equal(preview.errorCount, 0, JSON.stringify(preview.rows.filter((row) => row.errors.length)))
    assert.equal(preview.productCount, 2)
    assert.equal(preview.skuCount, 3)

    const badBook = new ExcelJS.Workbook()
    const badSheet = badBook.addWorksheet('导入')
    badSheet.addRow(['商品名称', '分类编码', '规格', '原厂条码', '初始库存', '库位编码'])
    badSheet.addRow(['坏行', '99', '', '6901234567892', -1, 'Z-99'])
    badSheet.addRow(['', '02', '', '', 1, ''])
    const badBuffer = Buffer.from(await badBook.xlsx.writeBuffer())
    const badPreview = await productExcelService.preview(badBuffer)
    assert.equal(badPreview.errorCount, 2)
    const badErrors = badPreview.rows[0].errors.join('|')
    assert.match(badErrors, /分类编码 99 不存在/)
    assert.match(badErrors, /已被系统中的商品使用/)
    assert.match(badErrors, /初始库存/)
    assert.match(badErrors, /库位 Z-99 不存在/)
    await assert.rejects(() => productExcelService.importProducts(badBuffer, admin), /未通过校验/)

    const imported = await productExcelService.importProducts(goodBuffer, admin)
    assert.equal(imported.productCount, 2)
    const postcardSkus = await AppDataSource.getRepository(BaseProductSku).find({ where: { skuCode: 'WC02003' } })
    assert.equal(postcardSkus.length, 1)
    assert.equal(Number(postcardSkus[0].currentStock), 12)
    await assert.rejects(() => productExcelService.preview(goodBuffer).then((result) => {
      if (result.errorCount > 0) throw new Error('重复导入被识别')
    }), /重复导入被识别/)
    await assertInvariants()

    // ---- 库存单据 ----
    await inventoryDocService.create({ docType: 'purchase_in', items: [{ skuId: starSku.id, qty: -2 }] }, operator).then(
      () => assert.fail('入库数量为负应被拒绝'),
      (error: Error) => assert.match(error.message, /必须大于 0/),
    )
    await AppDataSource.getRepository(BaseProductSku).update({ id: starSku.id }, { currentStock: 23 })
    await AppDataSource.getRepository(BaseProduct).update({ id: starSticker.id }, { currentStock: 23 })
    const purchase = await inventoryDocService.create({
      docType: 'purchase_in',
      clientRequestId: `req-${verifySeed}`,
      items: [{ skuId: starSku.id, qty: 50 }],
    }, operator)
    assert.match(purchase.docNo, /^KD\d{8}-0001$/)
    assert.equal(purchase.items?.[0].beforeSkuStock, 23)
    assert.equal(purchase.items?.[0].afterSkuStock, 73)
    const replay = await inventoryDocService.create({
      docType: 'purchase_in',
      clientRequestId: `req-${verifySeed}`,
      items: [{ skuId: starSku.id, qty: 50 }],
    }, operator)
    assert.equal(replay.id, purchase.id)
    assert.equal(await skuStock(starSku.id), 73)
    await assert.rejects(() => inventoryDocService.create({
      docType: 'purchase_in',
      clientRequestId: `req-${verifySeed}`,
      items: [{ skuId: starSku.id, qty: 50 }],
    }, admin), /请求标识已被其他单据使用/)

    await assert.rejects(() => inventoryDocService.create({ docType: 'damage_out', items: [{ skuId: starSku.id, qty: 1 }] }, operator), /需要选择原因/)
    await assert.rejects(() => inventoryDocService.create({ docType: 'damage_out', reasonCode: 'damaged', items: [{ skuId: blackBag.id, qty: 9 }] }, operator), /可用库存不足/)
    const damage = await inventoryDocService.create({ docType: 'damage_out', reasonCode: 'damaged', items: [{ skuId: blackBag.id, qty: 3 }] }, operator)
    assert.equal(damage.items?.[0].qty, -3)
    assert.equal(await skuStock(blackBag.id), 5)
    await assert.rejects(
      () => inventoryDocService.create({ docType: 'other_out', reasonCode: 'gift', items: [{ skuId: starSku.id, qty: 3 }, { skuId: starSku.id, qty: 2 }] }, operator),
      /同一规格/,
    )
    await assert.rejects(
      () => inventoryDocService.create({ docType: 'damage_out', reasonCode: 'valueOf', items: [{ skuId: starSku.id, qty: 1 }] }, operator),
      /不在可选范围/,
    )
    const otherOut = await inventoryDocService.create({ docType: 'other_out', reasonCode: 'gift', items: [{ skuId: starSku.id, qty: 5 }] }, operator)
    assert.deepEqual(otherOut.items?.map((item) => [item.beforeSkuStock, item.afterSkuStock]), [[73, 68]])
    const returned = await inventoryDocService.create({ docType: 'return_in', items: [{ skuId: whiteBag.id, qty: 1 }] }, operator)
    assert.equal(returned.items?.[0].afterSkuStock, 11)
    await assert.rejects(() => inventoryDocService.create({ docType: 'adjust', reasonCode: 'other', items: [{ skuId: whiteBag.id, qty: -1 }] }, operator), /备注/)
    const adjust = await inventoryDocService.create({ docType: 'adjust', reasonCode: 'entry_error', items: [{ skuId: whiteBag.id, qty: -2 }] }, operator)
    assert.equal(adjust.items?.[0].afterSkuStock, 9)
    await assertInvariants()

    const voidedDamage = await inventoryDocService.voidDoc(damage.id, '误报损', admin)
    assert.equal(voidedDamage.status, 'voided')
    assert.equal(await skuStock(blackBag.id), 8)
    await assert.rejects(() => inventoryDocService.voidDoc(damage.id, '重复', admin), /已作废/)
    await assertInvariants()

    const docLogs = await inventoryQueryService.listLogs({ refType: 'inv_stock_doc', pageSize: 50 })
    assert.equal(docLogs.total, 6)
    assert.ok(docLogs.list.every((row) => row.stockDelta === row.afterStock - row.beforeStock))
    assert.ok(docLogs.list.filter((row) => row.changeType === 'stock_other_out').every((row) => row.stockDelta < 0))
    assert.ok(docLogs.list.every((row) => row.skuCode && row.changeTypeLabel !== row.changeType))
    const stocks = await inventoryQueryService.listStocks({ locationId: shelfA.id })
    assert.deepEqual(stocks.list.map((row) => row.skuCode).sort(), ['WC02001', 'WC02002'])
    const lowStocks = await inventoryQueryService.listStocks({ maxStock: 8 })
    assert.ok(lowStocks.list.some((row) => row.skuCode === 'WC03002'))
    assert.ok((await inventoryQueryService.exportLogs({})).length > 1000)
    const docList = await inventoryDocService.list({ keyword: '星空贴纸' })
    assert.equal(docList.total, 2)

    // ---- 盘点 ----
    const stocktake = await stocktakeService.create({ scopeType: 'category', categoryIds: [stickers.id], blindMode: true }, operator)
    assert.match(stocktake.stocktakeNo, /^PD\d{8}-01$/)
    assert.equal(stocktake.itemCount, 4)
    assert.equal(stocktake.diffCount, null)
    await assert.rejects(() => stocktakeService.create({ scopeType: 'sku', skuIds: [starSku.id] }, operator), /正在盘点单/)
    await assert.rejects(() => stocktakeService.submit(stocktake.id, {}, operator), /还没有任何计数/)

    const operatorItems = await stocktakeService.listItems(stocktake.id, {}, operator)
    assert.ok(operatorItems.list.every((row) => row.bookQty === null && row.diffQty === null))
    await assert.rejects(() => stocktakeService.listItems(stocktake.id, { filter: 'diff' }, operator), /审核权限/)

    const firstCount = await stocktakeService.count(stocktake.id, { skuId: starSku.id, qty: 60, mode: 'set' }, operator)
    assert.equal(firstCount.countedQty, 60)
    assert.equal(firstCount.bookQty, null)
    await stocktakeService.count(stocktake.id, { skuId: starSku.id, qty: 5, mode: 'add' }, operator)
    // 盘点中发生正常入库：快照已在首次计数时固定，确认时按差异增量调账，不会覆盖这笔入库。
    await inventoryDocService.create({ docType: 'purchase_in', items: [{ skuId: starSku.id, qty: 10 }] }, operator)
    assert.equal(await skuStock(starSku.id), 78)
    const outOfScope = await stocktakeService.count(stocktake.id, { skuId: blackBag.id, qty: 8, mode: 'set' }, operator)
    assert.equal(outOfScope.inScope, false)
    const bookmarkSku = await AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ skuCode: 'WC02002' })
    await stocktakeService.count(stocktake.id, { skuId: bookmarkSku.id, qty: 38, mode: 'set' }, operator)
    const postcardMountain = await AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ skuCode: 'WC02004' })
    await stocktakeService.count(stocktake.id, { skuId: postcardMountain.id, qty: 9, mode: 'set' }, operator)

    const submitted = await stocktakeService.submit(stocktake.id, {}, operator)
    assert.equal(submitted.status, 'reviewing')
    await assert.rejects(() => stocktakeService.count(stocktake.id, { skuId: starSku.id, qty: 1, mode: 'add' }, operator), /只有盘点中/)
    const diffs = await stocktakeService.listItems(stocktake.id, { filter: 'diff' }, admin)
    const diffBySku = new Map(diffs.list.map((row) => [row.skuCode, row]))
    assert.equal(diffBySku.get('WC02001')?.bookQty, 68)
    assert.equal(diffBySku.get('WC02001')?.diffQty, -3)
    assert.equal(diffBySku.get('WC02002')?.diffQty, -2)
    assert.equal(diffBySku.get('WC02004')?.diffQty, 3)
    assert.equal(diffBySku.has('WC03002'), false)
    await assert.rejects(() => stocktakeService.complete(stocktake.id, admin), /未选择处理方式/)
    const star = diffBySku.get('WC02001')!
    const bookmark = diffBySku.get('WC02002')!
    const mountain = diffBySku.get('WC02004')!
    await assert.rejects(() => stocktakeService.resolveItem(stocktake.id, mountain.id, { resolution: 'damage' }, admin), /盘盈不能按报损/)
    await stocktakeService.resolveItem(stocktake.id, star.id, { diffReason: 'missed_sale', resolution: 'adjust' }, admin)
    await stocktakeService.resolveItem(stocktake.id, bookmark.id, { diffReason: 'damaged', resolution: 'recount' }, admin)
    await stocktakeService.resolveItem(stocktake.id, mountain.id, { diffReason: 'inbound_error', resolution: 'adjust' }, admin)
    await assert.rejects(() => stocktakeService.complete(stocktake.id, admin), /重新盘点/)
    const reopened = await stocktakeService.reopen(stocktake.id, admin)
    assert.equal(reopened.status, 'counting')
    await stocktakeService.count(stocktake.id, { skuId: bookmarkSku.id, qty: 37, mode: 'set' }, operator)
    await stocktakeService.submit(stocktake.id, {}, operator)
    const reDiffs = await stocktakeService.listItems(stocktake.id, { filter: 'diff' }, admin)
    const reBookmark = reDiffs.list.find((row) => row.skuCode === 'WC02002')!
    assert.equal(reBookmark.diffQty, -3)
    assert.equal(reDiffs.list.find((row) => row.skuCode === 'WC02001')?.resolution, 'adjust')
    await stocktakeService.resolveItem(stocktake.id, reBookmark.id, { diffReason: 'damaged', resolution: 'damage' }, admin)
    const completed = await stocktakeService.complete(stocktake.id, admin)
    assert.equal(completed.status, 'completed')
    assert.equal(await skuStock(starSku.id), 75)
    assert.equal(await skuStock(bookmarkSku.id), 37)
    assert.equal(await skuStock(postcardMountain.id), 9)
    const stocktakeLogs = await inventoryQueryService.listLogs({ refType: 'inv_stocktake', pageSize: 20 })
    assert.deepEqual(stocktakeLogs.list.map((row) => row.changeType).sort(), ['stocktake_damage', 'stocktake_gain', 'stocktake_loss'])
    await assert.rejects(() => stocktakeService.complete(stocktake.id, admin), /只有待确认/)
    await assertInvariants()

    const cancelled = await stocktakeService.create({ scopeType: 'location', locationIds: [shelfB.id], blindMode: false }, operator)
    const openItems = await stocktakeService.listItems(cancelled.id, {}, operator)
    assert.ok(openItems.list.every((row) => row.bookQty !== null), '明盘单应向计数人展示账面数')
    const zeroSubmit = await stocktakeService.submit(cancelled.id, { treatUncountedAsZero: true }, operator)
    assert.equal(zeroSubmit.countedCount, zeroSubmit.itemCount)
    await stocktakeService.cancel(cancelled.id, admin)
    assert.equal(await skuStock(whiteBag.id), 9)
    await assertInvariants()

    // ---- 评审修复回归 ----
    // 实体直接 JSON 化（如送货单详情带出的 SKU 关联）不下发成本价。
    const rawSku = await AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: starSku.id })
    assert.notEqual(rawSku.costPrice, null)
    assert.equal('costPrice' in (JSON.parse(JSON.stringify(rawSku)) as Record<string, unknown>), false)

    // 单规格商品编辑（前端固定提交 skus: []）不改写已有编码：自定义编码、清空分类都保留原编码。
    const customCoded = await productService.create({ productName: '自定义编码商品', skus: [{ specValues: {}, skuCode: 'BM-001', currentStock: 2 }] }, admin)
    const repriced = await productService.update(customCoded.id, { defaultPrice: 9, skus: [] }, admin)
    assert.equal(repriced.skus[0].id, customCoded.skus[0].id)
    assert.equal(repriced.skus[0].skuCode, 'BM-001')
    const unCategorized = await productService.update(starSticker.id, { categoryId: null, skus: [] }, admin)
    assert.equal(unCategorized.skus[0].skuCode, 'WC02001')

    // 规格互换条码、删除后加回并沿用旧条码都能保存；扫码优先命中当前版本规格。
    const colorGroups = (values: string[]) => [{ name: '色', values }]
    const swap = await productService.create({
      productName: '互换条码商品',
      specGroups: colorGroups(['红', '蓝']),
      skus: [{ specValues: { 色: '红' }, barcode: 'SWAP-A' }, { specValues: { 色: '蓝' }, barcode: 'SWAP-B' }],
    }, admin)
    const [red, blue] = swap.skus
    const swapped = await productService.update(swap.id, {
      specGroups: colorGroups(['红', '蓝']),
      skus: [{ id: red.id, specValues: { 色: '红' }, barcode: 'SWAP-B' }, { id: blue.id, specValues: { 色: '蓝' }, barcode: 'SWAP-A' }],
    }, admin)
    assert.deepEqual(swapped.skus.map((sku) => [sku.id, sku.barcode]), [[red.id, 'SWAP-B'], [blue.id, 'SWAP-A']])
    await productService.update(swap.id, { specGroups: colorGroups(['红']), skus: [{ id: red.id, specValues: { 色: '红' } }] }, admin)
    const retiredBlue = await AppDataSource.getRepository(BaseProductSku).findOneByOrFail({ id: blue.id })
    assert.equal(retiredBlue.barcode, null, '退役规格应释放条码')
    const readded = await productService.update(swap.id, {
      specGroups: colorGroups(['红', '青']),
      skus: [{ id: red.id, specValues: { 色: '红' } }, { specValues: { 色: '青' }, barcode: 'SWAP-A' }],
    }, admin)
    const cyan = readded.skus.find((sku) => sku.specValues['色'] === '青')!
    assert.equal(cyan.barcode, 'SWAP-A')
    assert.equal((await productService.lookupByCode('SWAP-A')).sku.id, cyan.id)

    // WC 流水号撞到原厂条码时跳过。
    await productService.create({ productName: '条码占号商品', skus: [{ specValues: {}, barcode: 'WC03003' }] }, admin)
    const nextBag = await productService.create({ productName: '新帆布包', categoryId: bags.id }, admin)
    assert.equal(nextBag.skus[0].skuCode, 'WC03004')
    const nextBagSkuId = nextBag.skus[0].id

    // 盘点：set 刷新账面快照；范围外规格清除后移除并释放；差异处理只改单个字段；退役规格不能调账。
    const st2 = await stocktakeService.create({ scopeType: 'sku', skuIds: [nextBagSkuId], blindMode: false }, operator)
    await stocktakeService.count(st2.id, { skuId: nextBagSkuId, qty: 0, mode: 'set' }, operator)
    const bagPurchase = await inventoryDocService.create({ docType: 'purchase_in', items: [{ skuId: nextBagSkuId, qty: 10 }] }, operator)
    await stocktakeService.count(st2.id, { skuId: nextBagSkuId, qty: 7, mode: 'set' }, operator)
    const refreshed = (await stocktakeService.listItems(st2.id, {}, admin)).list[0]
    assert.equal(refreshed.bookQty, 10, 'set 计数应刷新账面快照')
    assert.equal(refreshed.diffQty, -3)
    await stocktakeService.count(st2.id, { skuId: red.id, qty: 1, mode: 'set' }, operator)
    await stocktakeService.count(st2.id, { skuId: red.id, mode: 'clear' }, operator)
    assert.equal((await stocktakeService.listItems(st2.id, {}, admin)).total, 1, '范围外规格清除后应移除')
    const freed = await stocktakeService.create({ scopeType: 'sku', skuIds: [red.id] }, operator)
    await stocktakeService.cancel(freed.id, admin)
    await stocktakeService.submit(st2.id, {}, operator)
    const st2Diff = (await stocktakeService.listItems(st2.id, { filter: 'diff' }, admin)).list[0]
    await stocktakeService.resolveItem(st2.id, st2Diff.id, { diffReason: 'lost' }, admin)
    const resolvedTwice = await stocktakeService.resolveItem(st2.id, st2Diff.id, { resolution: 'adjust' }, admin)
    assert.equal(resolvedTwice.diffReason, 'lost', '只提交处理方式时不应清空原因')
    assert.equal(resolvedTwice.resolution, 'adjust')
    await assert.rejects(() => stocktakeService.resolveItem(st2.id, st2Diff.id, { resolution: 'toString' }, admin), /不在可选范围/)
    await productService.update(nextBag.id, { specGroups: [{ name: '尺寸', values: ['大'] }], skus: [{ specValues: { 尺寸: '大' } }] }, admin)
    await assert.rejects(() => stocktakeService.complete(st2.id, admin), /已退役/)
    await assert.rejects(() => inventoryDocService.voidDoc(bagPurchase.id, '测试退役', admin), /已退役/)
    await stocktakeService.resolveItem(st2.id, st2Diff.id, { resolution: 'ignore' }, admin)
    assert.equal((await stocktakeService.complete(st2.id, admin)).status, 'completed')

    // 幂等重放：内容或类型不一致时拒绝，并提示原单号。
    const replayKey = `req2-${verifySeed}`
    const firstSubmit = await inventoryDocService.create({ docType: 'purchase_in', clientRequestId: replayKey, items: [{ skuId: red.id, qty: 1 }] }, operator)
    const sameSubmit = await inventoryDocService.create({ docType: 'purchase_in', clientRequestId: replayKey, items: [{ skuId: red.id, qty: 1 }] }, operator)
    assert.equal(sameSubmit.id, firstSubmit.id)
    await assert.rejects(
      () => inventoryDocService.create({ docType: 'purchase_in', clientRequestId: replayKey, items: [{ skuId: red.id, qty: 2 }] }, operator),
      new RegExp(`${firstSubmit.docNo}.*内容不一致`),
    )
    await assert.rejects(
      () => inventoryDocService.create({ docType: 'return_in', clientRequestId: replayKey, items: [{ skuId: red.id, qty: 1 }] }, operator),
      /内容不一致/,
    )

    // 解压炸弹：中央目录谎报小体积，真实解压超过上限时在交给 exceljs 之前拒绝。
    const bomb = buildDeflateZip('xl/worksheets/sheet1.xml', new Uint8Array(30 * 1024 * 1024).fill(0x20), 128)
    await assert.rejects(() => productExcelService.preview(bomb), /解压后超过/)
    await assert.rejects(() => productExcelService.preview(Buffer.from('not-a-zip-file-content')), /无法识别/)
    await assertInvariants()

    console.log('inventory stock management verify: passed')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanup()
  }
}

/** 仅供测试：拼装只含一个 deflate 条目的 zip，并可在中央目录里谎报解压大小。 */
function buildDeflateZip(name: string, content: Uint8Array, declaredSize: number): Buffer {
  const compressed = new Uint8Array(deflateRawSync(content))
  const nameBytes = new TextEncoder().encode(name)
  const local = new Uint8Array(30)
  const localView = new DataView(local.buffer)
  localView.setUint32(0, 0x04034b50, true)
  localView.setUint16(4, 20, true)
  localView.setUint16(8, 8, true)
  localView.setUint32(18, compressed.length, true)
  localView.setUint32(22, declaredSize, true)
  localView.setUint16(26, nameBytes.length, true)
  const central = new Uint8Array(46)
  const centralView = new DataView(central.buffer)
  centralView.setUint32(0, 0x02014b50, true)
  centralView.setUint16(4, 20, true)
  centralView.setUint16(6, 20, true)
  centralView.setUint16(10, 8, true)
  centralView.setUint32(20, compressed.length, true)
  centralView.setUint32(24, declaredSize, true)
  centralView.setUint16(28, nameBytes.length, true)
  centralView.setUint32(42, 0, true)
  const localLength = local.length + nameBytes.length + compressed.length
  const centralLength = central.length + nameBytes.length
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, 1, true)
  eocdView.setUint16(10, 1, true)
  eocdView.setUint32(12, centralLength, true)
  eocdView.setUint32(16, localLength, true)
  const parts = [local, nameBytes, compressed, central, nameBytes, eocd]
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return Buffer.from(output)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
