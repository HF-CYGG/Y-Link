/**
 * 文件说明：库位关联商品规格的专项回归，使用独立 SQLite 临时库。
 * 验证范围：当前 SKU 列表、分页搜索、关联/转移/移出、并发基线、停用与退役边界、商品编辑保留新库位、审计及库存不变。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const seed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `inventory-location-sku-${seed}.sqlite`)
process.env.APP_PROFILE = `inventory-location-sku-${seed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${seed}_Aa1!`

const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${sqlitePath}${suffix}`
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
  const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { inventoryMasterDataService } = await import('../src/services/inventory-master-data.service.js')
  const { productService } = await import('../src/services/product.service.js')
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    const userRepo = AppDataSource.getRepository(SysUser)
    const user = await userRepo.save(userRepo.create({
      username: `location-verify-${seed}`,
      passwordHash: 'verify-only',
      displayName: '库位验证管理员',
      email: null,
      role: 'admin',
      status: 'enabled',
      lastLoginAt: null,
    }))
    const actor: AuthUserContext = {
      userId: String(user.id), username: user.username, displayName: user.displayName,
      role: 'admin', permissions: resolvePermissionsByRole('admin'), status: 'enabled',
      sessionToken: 'verify-only', authSource: 'bearer',
    }
    const shelfA = await inventoryMasterDataService.createLocation({ locationCode: 'A-01' }, actor)
    const shelfB = await inventoryMasterDataService.createLocation({ locationCode: 'B-01' }, actor)
    const disabledShelf = await inventoryMasterDataService.createLocation({ locationCode: 'C-01', isActive: false }, actor)
    const productA = await productService.create({ productName: '星空贴纸', currentStock: 3, skus: [{ specValues: {}, currentStock: 3, locationId: shelfA.id }] }, actor)
    const productB = await productService.create({ productName: '帆布包', currentStock: 4, specGroups: [{ name: '颜色', values: ['米白'] }], skus: [{ specValues: { 颜色: '米白' }, currentStock: 4, locationId: shelfB.id }] }, actor)
    const productC = await productService.create({ productName: '金属书签', currentStock: 0 }, actor)
    const skuA = productA.skus[0]!
    const skuB = productB.skus[0]!
    const skuC = productC.skus[0]!
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const auditRepo = AppDataSource.getRepository(SysAuditLog)
    const query = (locationId: string, scope: 'assigned' | 'other', keyword = '', page = 1, pageSize = 20) =>
      inventoryMasterDataService.listLocationSkus(locationId, { scope, keyword, page, pageSize })

    const assigned = await query(shelfA.id, 'assigned')
    assert.equal(assigned.total, (await inventoryMasterDataService.listLocations()).find((row) => row.id === shelfA.id)?.skuCount)
    assert.deepEqual(assigned.list.map((row) => row.skuId), [skuA.id])
    const otherPage = await query(shelfA.id, 'other', '', 1, 1)
    assert.equal(otherPage.total, 2)
    assert.equal(otherPage.list.length, 1)
    assert.deepEqual((await query(shelfA.id, 'other', '帆布包')).list.map((row) => row.skuId), [skuB.id])
    assert.deepEqual((await query(shelfA.id, 'other', skuB.skuCode)).list.map((row) => row.skuId), [skuB.id])
    assert.deepEqual((await query(shelfA.id, 'other', '米白')).list.map((row) => row.skuId), [skuB.id])
    assert.equal((await query(shelfA.id, 'other', '%')).total, 0, 'LIKE 通配符应按字面量搜索')

    const stockBefore = await AppDataSource.getRepository(BaseProduct).find({ select: ['id', 'currentStock', 'preOrderedStock'] })
    const skuStockBefore = await skuRepo.find({ select: ['id', 'currentStock', 'preOrderedStock'] })
    const logCountBefore = await AppDataSource.getRepository(InventoryLog).count()
    const auditCountBefore = await auditRepo.count({ where: { actionType: 'product.location.update', targetId: skuC.id } })

    assert.equal((await inventoryMasterDataService.changeSkuLocation(shelfA.id, skuC.id, { action: 'assign', expectedLocationId: null }, actor)).locationCode, 'A-01')
    await assert.rejects(() => inventoryMasterDataService.changeSkuLocation(shelfB.id, skuC.id, { action: 'assign', expectedLocationId: null }, actor), /已变化/)
    assert.equal((await query(shelfA.id, 'assigned')).total, 2)
    assert.equal((await inventoryMasterDataService.listLocations()).find((row) => row.id === shelfA.id)?.skuCount, 2)
    await inventoryMasterDataService.changeSkuLocation(shelfA.id, skuC.id, { action: 'assign', expectedLocationId: shelfA.id }, actor)
    assert.equal(await auditRepo.count({ where: { actionType: 'product.location.update', targetId: skuC.id } }), auditCountBefore + 1, '重复关联不应写审计')
    assert.equal((await inventoryMasterDataService.changeSkuLocation(shelfB.id, skuC.id, { action: 'assign', expectedLocationId: shelfA.id }, actor)).locationId, shelfB.id)
    await assert.rejects(() => inventoryMasterDataService.changeSkuLocation(shelfA.id, skuC.id, { action: 'remove', expectedLocationId: shelfB.id }, actor), /不属于当前库位/)
    assert.equal((await inventoryMasterDataService.changeSkuLocation(shelfB.id, skuC.id, { action: 'remove', expectedLocationId: shelfB.id }, actor)).locationId, null)
    assert.equal(await auditRepo.count({ where: { actionType: 'product.location.update', targetId: skuC.id } }), auditCountBefore + 3)
    await assert.rejects(() => inventoryMasterDataService.changeSkuLocation(disabledShelf.id, skuC.id, { action: 'assign', expectedLocationId: null }, actor), /已停用/)
    await skuRepo.update({ id: skuC.id }, { isCurrent: false })
    await assert.rejects(() => inventoryMasterDataService.changeSkuLocation(shelfA.id, skuC.id, { action: 'assign', expectedLocationId: null }, actor), /已退役/)
    assert.equal((await query(shelfA.id, 'other')).total, 1, '退役规格不应出现在待关联列表')
    await skuRepo.update({ id: skuC.id }, { isCurrent: true, isActive: false })
    await inventoryMasterDataService.changeSkuLocation(shelfA.id, skuC.id, { action: 'assign', expectedLocationId: null }, actor)
    assert.equal((await query(shelfA.id, 'assigned')).list.find((row) => row.skuId === skuC.id)?.isActive, false)
    await inventoryMasterDataService.changeSkuLocation(shelfA.id, skuC.id, { action: 'remove', expectedLocationId: shelfA.id }, actor)

    const productStockAfter = await AppDataSource.getRepository(BaseProduct).find({ select: ['id', 'currentStock', 'preOrderedStock'] })
    const skuStockAfter = await skuRepo.find({ select: ['id', 'currentStock', 'preOrderedStock'] })
    assert.deepEqual(productStockAfter, stockBefore)
    assert.deepEqual(skuStockAfter, skuStockBefore)
    assert.equal(await AppDataSource.getRepository(InventoryLog).count(), logCountBefore)

    // 商品弹窗打开后，库位页先改了默认库位；商品编辑只提交其他字段时，服务层应保留锁内最新关联。
    const single = await productService.create({
      productName: '单规格库位回归', currentStock: 2,
      defaultSku: { locationId: shelfA.id },
    }, actor)
    const multiSpecGroups = [{ name: '颜色', values: ['红色', '蓝色'] }]
    const multi = await productService.create({
      productName: '多规格库位回归', currentStock: 7, specGroups: multiSpecGroups,
      skus: [
        { specValues: { 颜色: '红色' }, currentStock: 3, locationId: shelfA.id },
        { specValues: { 颜色: '蓝色' }, currentStock: 4, locationId: shelfA.id },
      ],
    }, actor)
    const singleSku = single.skus[0]!
    const redSku = multi.skus.find((row) => row.specValues['颜色'] === '红色')!
    const blueSku = multi.skus.find((row) => row.specValues['颜色'] === '蓝色')!
    const singleOldLocationId = singleSku.locationId
    const redOldLocationId = redSku.locationId
    assert.equal(singleOldLocationId, shelfA.id)
    assert.equal(redOldLocationId, shelfA.id)
    const stockBeforeProductEdit = await AppDataSource.getRepository(BaseProduct).find({ select: ['id', 'currentStock', 'preOrderedStock'] })
    const skuStockBeforeProductEdit = await skuRepo.find({ select: ['id', 'currentStock', 'preOrderedStock'] })
    const logCountBeforeProductEdit = await AppDataSource.getRepository(InventoryLog).count()

    await inventoryMasterDataService.changeSkuLocation(shelfB.id, singleSku.id, { action: 'assign', expectedLocationId: singleOldLocationId }, actor)
    const editedSingle = await productService.update(single.id, { defaultSku: { costPrice: 1.25 } }, actor)
    assert.equal(editedSingle.skus[0]?.id, singleSku.id)
    assert.equal(editedSingle.skus[0]?.locationId, shelfB.id, '单规格其他字段编辑不应写回旧库位')
    assert.equal(String((await skuRepo.findOneByOrFail({ id: singleSku.id })).locationId), shelfB.id)

    await inventoryMasterDataService.changeSkuLocation(shelfB.id, redSku.id, { action: 'assign', expectedLocationId: redOldLocationId }, actor)
    const editedMulti = await productService.update(multi.id, {
      specGroups: multiSpecGroups,
      skus: [
        { id: redSku.id, specValues: { 颜色: '红色' }, costPrice: 2.5 },
        { id: blueSku.id, specValues: { 颜色: '蓝色' } },
      ],
    }, actor)
    assert.equal(editedMulti.skus.find((row) => row.id === redSku.id)?.locationId, shelfB.id, '多规格其他字段编辑不应写回旧库位')
    assert.equal(editedMulti.skus.find((row) => row.id === blueSku.id)?.locationId, shelfA.id)
    assert.equal(String((await skuRepo.findOneByOrFail({ id: redSku.id })).locationId), shelfB.id)
    assert.deepEqual(await AppDataSource.getRepository(BaseProduct).find({ select: ['id', 'currentStock', 'preOrderedStock'] }), stockBeforeProductEdit)
    assert.deepEqual(await skuRepo.find({ select: ['id', 'currentStock', 'preOrderedStock'] }), skuStockBeforeProductEdit)
    assert.equal(await AppDataSource.getRepository(InventoryLog).count(), logCountBeforeProductEdit)
    console.log('inventory location SKU verify: passed')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanup()
  }
}

try {
  cleanup()
  await main()
} catch (error) {
  console.error('inventory location SKU verify: failed', error)
  process.exitCode = 1
}
