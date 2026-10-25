/**
 * 文件说明：规格分库位库存的专项回归，使用独立 SQLite 临时库。
 * 验证范围：
 * - 按数量拨转：件数搬动、总库存与流水不变、来源件数基线、超量、停用库位、退役规格、审计；
 * - 扣减规则：默认规则先扣主库位、不够再按库位编码扣其他库位，流水备注写明扣减库位；先扣后加的顺序正确；
 * - 主库位切换：拨转时设为主库位、整体移入、移出（主库位清空 / 拆分库位并回主库位）；
 * - 按库位盘点：建单按“规格 × 库位”展开、账面取库位件数、计数需选库位、只调本库位、冲突口径；
 * - 列表与查询：库位已关联规格、关联数、库存查询的库位筛选与分布；
 * - 商品编辑调低库存时按扣减规则规整分库位件数。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const seed = `${Date.now()}-${randomBytes(8).toString('hex')}`
const sqlitePath = path.resolve(sqliteRoot, `inventory-location-stock-${seed}.sqlite`)
process.env.APP_PROFILE = `inventory-location-stock-${seed}`
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
  const { runInTransaction } = await import('../src/config/transaction-runner.js')
  const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { inventoryMasterDataService } = await import('../src/services/inventory-master-data.service.js')
  const { inventoryQueryService } = await import('../src/services/inventory-query.service.js')
  const { applyInventoryDeltas, loadLockedSkuTargets } = await import('../src/services/inventory-ledger.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { stocktakeService } = await import('../src/services/stocktake.service.js')
  const { hashPassword } = await import('../src/utils/password.js')
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    const tables = await AppDataSource.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inv_sku_location_stock'") as unknown[]
    assert.equal(tables.length, 1, 'SQLite 启动后应建好分库位库存表')
    // 存量 SQLite 升级：把盘点明细还原成 060 之前的形状（无库位列、旧唯一键），再走一次启动准备。
    await AppDataSource.query('DROP INDEX IF EXISTS "uk_inv_stocktake_item_sku_location"')
    await AppDataSource.query('ALTER TABLE "inv_stocktake_item" DROP COLUMN "location_scope_id"')
    await AppDataSource.query('CREATE UNIQUE INDEX "uk_inv_stocktake_item_sku" ON "inv_stocktake_item" ("stocktake_id", "sku_id")')
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    const stocktakeColumns = await AppDataSource.query("PRAGMA table_info('inv_stocktake_item')") as Array<{ name: string; notnull: number; dflt_value: string | null }>
    const scopeColumn = stocktakeColumns.find((column) => column.name === 'location_scope_id')
    assert.ok(scopeColumn && scopeColumn.notnull === 1 && String(scopeColumn.dflt_value).replace(/[()]/g, '') === '0', '升级后应补齐 NOT NULL DEFAULT 0 的库位列')
    const stocktakeIndexes = await AppDataSource.query("PRAGMA index_list('inv_stocktake_item')") as Array<{ name: string; unique: number }>
    assert.ok(stocktakeIndexes.some((row) => row.name === 'uk_inv_stocktake_item_sku_location' && row.unique === 1), '盘点明细应有规格 × 库位唯一键')
    assert.ok(!stocktakeIndexes.some((row) => row.name === 'uk_inv_stocktake_item_sku'), '旧的规格唯一键应已删除')

    const userRepo = AppDataSource.getRepository(SysUser)
    const user = await userRepo.save(userRepo.create({
      username: `location-stock-${seed}`,
      passwordHash: await hashPassword(`Location_${seed}_Aa1!`),
      displayName: '分库位验证管理员',
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
    const shelfC = await inventoryMasterDataService.createLocation({ locationCode: 'C-01' }, actor)
    const disabledShelf = await inventoryMasterDataService.createLocation({ locationCode: 'D-01', isActive: false }, actor)
    const product = await productService.create({
      productName: '分库位保温杯', currentStock: 10,
      defaultSku: { locationId: shelfA.id },
    }, actor)
    const skuId = product.skus[0]!.id
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const logRepo = AppDataSource.getRepository(InventoryLog)
    const auditRepo = AppDataSource.getRepository(SysAuditLog)

    const distribution = async () => {
      const view = await inventoryMasterDataService.getSkuLocationDistribution(skuId)
      return {
        main: view.mainLocationCode,
        mainQty: view.mainQty,
        others: Object.fromEntries(view.others.map((item) => [item.locationCode, item.qty])),
        total: view.currentStock,
      }
    }
    const transfer = async (toId: string, fromId: string | null, qty: number, options: { setAsMain?: boolean; expectedFromQty?: number } = {}) => {
      const view = await inventoryMasterDataService.getSkuLocationDistribution(skuId)
      const fromQty = fromId === view.mainLocationId ? view.mainQty : view.others.find((item) => item.locationId === fromId)?.qty ?? 0
      return inventoryMasterDataService.transferSkuStock(toId, skuId, {
        fromLocationId: fromId,
        qty,
        expectedFromQty: options.expectedFromQty ?? fromQty,
        expectedMainLocationId: view.mainLocationId,
        setAsMain: options.setAsMain,
      }, actor)
    }
    const deduct = (delta: number, locationId?: string | null) => runInTransaction(async (manager) => {
      const targets = await loadLockedSkuTargets(manager, [skuId])
      const target = targets.get(skuId)!
      return applyInventoryDeltas(manager, {
        deltas: [{ ...target, stockDelta: delta, ...(locationId === undefined ? {} : { locationId }) }],
        changeType: delta < 0 ? 'stock_out' : 'stock_in',
        refType: 'verify',
        refId: seed,
        operator: { type: 'admin', id: actor.userId, name: actor.displayName },
        buildRemark: () => `分库位验证 ${delta}`,
      })
    })

    // 1. 拨转：总库存与流水不变，只搬件数。
    const logCountBefore = await logRepo.count()
    await transfer(shelfB.id, shelfA.id, 4)
    assert.deepEqual(await distribution(), { main: 'A-01', mainQty: 6, others: { 'B-01': 4 }, total: 10 })
    assert.equal(await logRepo.count(), logCountBefore, '拨转不应写库存流水')
    assert.equal(await auditRepo.count({ where: { actionType: 'product.location.transfer', targetId: skuId } }), 1)
    await assert.rejects(() => transfer(shelfC.id, shelfA.id, 1, { expectedFromQty: 5 }), /件数已变化/)
    await assert.rejects(() => transfer(shelfC.id, shelfA.id, 7), /只有 6 件/)
    await assert.rejects(() => transfer(disabledShelf.id, shelfA.id, 1), /已停用/)
    await transfer(shelfC.id, shelfB.id, 1)
    assert.deepEqual(await distribution(), { main: 'A-01', mainQty: 6, others: { 'B-01': 3, 'C-01': 1 }, total: 10 })

    // 2. 默认扣减：先扣主库位 6，再按库位编码扣 B-01 1 件。
    const outLines = await deduct(-7)
    assert.equal(outLines.length, 1)
    assert.deepEqual(await distribution(), { main: 'A-01', mainQty: 0, others: { 'B-01': 2, 'C-01': 1 }, total: 3 })
    const outLog = await logRepo.findOne({ where: { refType: 'verify', changeType: 'stock_out' }, order: { id: 'DESC' } })
    assert.match(outLog?.remark ?? '', /扣减其他库位 B-01×1/)
    // 先扣后加：入库落主库位，不能把入库件数算到其他库位。
    await deduct(5)
    assert.deepEqual(await distribution(), { main: 'A-01', mainQty: 5, others: { 'B-01': 2, 'C-01': 1 }, total: 8 })
    // 指定库位扣减：只扣该库位，不足即拒绝。
    await assert.rejects(() => deduct(-2, shelfC.id), /件数不足/)
    await deduct(-1, shelfC.id)
    assert.deepEqual(await distribution(), { main: 'A-01', mainQty: 5, others: { 'B-01': 2 }, total: 7 })
    await deduct(1, shelfC.id)

    // 3. 拨转并设为主库位：原主库位剩余件数留在原库位，目标库位已有件数并回主库位。
    await transfer(shelfB.id, shelfC.id, 1, { setAsMain: true })
    assert.deepEqual(await distribution(), { main: 'B-01', mainQty: 3, others: { 'A-01': 5 }, total: 8 })
    // 整体移入：主库位全部件数搬到 C-01 并设为主库位，A-01 的拆分件数不动。
    await inventoryMasterDataService.changeSkuLocation(shelfC.id, skuId, { action: 'assign', expectedLocationId: shelfB.id }, actor)
    assert.deepEqual(await distribution(), { main: 'C-01', mainQty: 3, others: { 'A-01': 5 }, total: 8 })
    // 移出拆分库位：件数并回主库位。
    await inventoryMasterDataService.changeSkuLocation(shelfA.id, skuId, { action: 'remove', expectedLocationId: shelfC.id }, actor)
    assert.deepEqual(await distribution(), { main: 'C-01', mainQty: 8, others: {}, total: 8 })
    await assert.rejects(
      () => inventoryMasterDataService.changeSkuLocation(shelfA.id, skuId, { action: 'remove', expectedLocationId: shelfC.id }, actor),
      /不属于当前库位/,
    )

    // 主库位为空时移出拆分库位：件数归入“未设置库位”，不能因来源与目标相同而被拒绝。
    await transfer(shelfA.id, shelfC.id, 2)
    await inventoryMasterDataService.changeSkuLocation(shelfC.id, skuId, { action: 'remove', expectedLocationId: shelfC.id }, actor)
    assert.deepEqual(await distribution(), { main: null, mainQty: 6, others: { 'A-01': 2 }, total: 8 })
    await inventoryMasterDataService.changeSkuLocation(shelfA.id, skuId, { action: 'remove', expectedLocationId: null }, actor)
    assert.deepEqual(await distribution(), { main: null, mainQty: 8, others: {}, total: 8 })
    await inventoryMasterDataService.changeSkuLocation(shelfC.id, skuId, { action: 'assign', expectedLocationId: null }, actor)
    assert.deepEqual(await distribution(), { main: 'C-01', mainQty: 8, others: {}, total: 8 })

    // 4. 列表与查询。
    await transfer(shelfA.id, shelfC.id, 2)
    const assignedA = await inventoryMasterDataService.listLocationSkus(shelfA.id, { scope: 'assigned', keyword: '', page: 1, pageSize: 20 })
    assert.equal(assignedA.total, 1)
    assert.equal(assignedA.list[0]?.locationQty, 2)
    assert.equal(assignedA.list[0]?.isMainHere, false)
    assert.equal((await inventoryMasterDataService.listLocations()).find((row) => row.id === shelfA.id)?.skuCount, 1)
    const otherA = await inventoryMasterDataService.listLocationSkus(shelfA.id, { scope: 'other', keyword: '', page: 1, pageSize: 20 })
    assert.ok(!otherA.list.some((row) => row.skuId === skuId), '在本库位拆有件数的规格不应出现在“其他规格”')
    const stocksAtA = await inventoryQueryService.listStocks({ locationId: shelfA.id })
    assert.equal(stocksAtA.list.length, 1)
    assert.equal(stocksAtA.list[0]?.locationCode, 'C-01')
    assert.equal(stocksAtA.list[0]?.mainLocationQty, 6)
    assert.deepEqual(stocksAtA.list[0]?.otherLocations.map((item) => [item.locationCode, item.qty]), [['A-01', 2]])

    // 5. 按库位盘点：A-01 账面 2 实盘 1，C-01（主库位）账面 6 实盘 7。
    const stocktake = await stocktakeService.create({ scopeType: 'location', locationIds: [shelfA.id, shelfC.id], blindMode: false }, actor)
    assert.equal(stocktake.itemCount, 2)
    assert.deepEqual(stocktake.scopeLocations.map((item) => item.locationCode).sort(), ['A-01', 'C-01'])
    // 计数前的按库位明细：账面展示该库位当前件数，而不是规格总库存。
    const uncountedItems = await stocktakeService.listItems(stocktake.id, { pageSize: 50 }, actor)
    assert.deepEqual(
      uncountedItems.list.map((item) => [item.locationCode, item.bookQty]).sort(),
      [['A-01', 2], ['C-01', 6]],
    )
    await assert.rejects(() => stocktakeService.count(stocktake.id, { skuId, qty: 1, mode: 'set' }, actor), /请先选择当前盘点库位/)
    const countedA = await stocktakeService.count(stocktake.id, { skuId, qty: 1, mode: 'set', locationId: shelfA.id }, actor)
    assert.equal(countedA.bookQty, 2)
    assert.equal(countedA.locationCode, 'A-01')
    const countedC = await stocktakeService.count(stocktake.id, { skuId, qty: 7, mode: 'set', locationId: shelfC.id }, actor)
    assert.equal(countedC.bookQty, 6)
    // 冲突口径：按总量盘点与之冲突；同一库位冲突；其他库位不冲突（B-01 没有该规格，故以“范围内无规格”结束）。
    await assert.rejects(() => stocktakeService.create({ scopeType: 'sku', skuIds: [skuId] }, actor), /正在盘点单/)
    await assert.rejects(() => stocktakeService.create({ scopeType: 'location', locationIds: [shelfA.id] }, actor), /正在盘点单/)
    await assert.rejects(() => stocktakeService.create({ scopeType: 'location', locationIds: [shelfB.id] }, actor), /没有可盘点/)
    await stocktakeService.submit(stocktake.id, {}, actor)
    const diffItems = await stocktakeService.listItems(stocktake.id, { filter: 'diff', pageSize: 50 }, actor)
    assert.equal(diffItems.total, 2)
    for (const item of diffItems.list) {
      await stocktakeService.resolveItem(stocktake.id, item.id, { resolution: 'adjust', diffReason: 'lost' }, actor)
    }
    await stocktakeService.complete(stocktake.id, actor)
    assert.deepEqual(await distribution(), { main: 'C-01', mainQty: 7, others: { 'A-01': 1 }, total: 8 })
    const stocktakeLogs = await logRepo.find({ where: { refType: 'inv_stocktake', refId: stocktake.id } })
    assert.deepEqual(stocktakeLogs.map((log) => log.changeQty).sort((left, right) => left - right), [-1, 1])

    // 6. 商品编辑调低库存：按扣减规则先扣主库位，再扣其他库位。
    const sku = await skuRepo.findOneByOrFail({ id: skuId })
    await productService.update(product.id, { currentStock: 0, stockBaseline: { currentStock: Number(sku.currentStock) } }, actor)
    assert.deepEqual(await distribution(), { main: 'C-01', mainQty: 0, others: {}, total: 0 })
    const editLog = await logRepo.findOne({ where: { refType: 'base_product', refId: product.id, changeType: 'manual_stock_adjust' }, order: { id: 'DESC' } })
    assert.match(editLog?.remark ?? '', /扣减其他库位 A-01×1/)

    // 7. 退役规格不能拨转。
    await deduct(3)
    await skuRepo.update({ id: skuId }, { isCurrent: false })
    await assert.rejects(() => transfer(shelfA.id, shelfC.id, 1), /已退役/)

    console.log('[inventory:location-stock:verify] 分库位库存、拨转、扣减规则与按库位盘点回归通过')
  } finally {
    await AppDataSource.destroy().catch(() => undefined)
    cleanup()
  }
}

main().catch((error) => {
  console.error('[inventory:location-stock:verify] 失败：', error)
  cleanup()
  process.exitCode = 1
})
