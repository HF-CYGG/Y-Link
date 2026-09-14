/**
 * 模块说明：Issue #82 手工出库库存扣减链路专项验证。
 * 文件职责：在隔离 SQLite 中验证出库开单扣减、库存不足整单回滚、幂等与并发、删除回补与恢复重扣、
 *           商品编辑库存基线防覆盖，以及只读库存差异核查脚本。
 * 实现逻辑：使用真实实体、事务与服务层；核查脚本以子进程方式连接同一 SQLite，验证能检出人为制造的差异且不写库。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(backendRoot, '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `manual-outbound-inventory-${verifySeed}.sqlite`)
const auditOutDir = path.resolve(sqliteRoot, `manual-outbound-inventory-audit-${verifySeed}`)
const readSource = (relativePath: string) => fs.readFileSync(path.resolve(repositoryRoot, relativePath), 'utf8')

// 在任何数据库配置模块动态导入前锁定隔离环境，真实 HTTP 回归与服务层验证共用同一临时 SQLite。
const adminPassword = `Admin_${verifySeed}_Zz9!`
delete process.env.ENV_FILE
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
process.env.APP_PROFILE = `manual-outbound-inventory-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.DB_AUTO_MIGRATE = 'false'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = adminPassword

const actor: AuthUserContext = {
  userId: '82001',
  username: 'issue82-verifier',
  displayName: 'Issue82验证员',
  role: 'admin',
  permissions: ['orders:create', 'orders:view', 'orders:update', 'orders:edit', 'orders:delete', 'products:manage', 'products:view'],
  status: 'enabled',
  sessionToken: 'issue82-session',
  authSource: 'bearer',
}

function cleanup() {
  for (const target of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true })
  }
  if (fs.existsSync(auditOutDir)) fs.rmSync(auditOutDir, { recursive: true, force: true })
}

async function expectFailure(action: () => Promise<unknown>, message: RegExp, statusCode = 409) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error, '期望抛出 Error')
    assert.match(error.message, message)
    assert.equal((error as Error & { statusCode?: number }).statusCode, statusCode, `错误码不符：${error.message}`)
    return true
  })
}

function verifyFrontendContracts() {
  const orderEntrySource = readSource('src/views/order-entry/composables/useOrderEntryForm.ts')
  assert.match(orderEntrySource, /pendingSubmission\.value\?\.fingerprint\s*===\s*fingerprint/, '开单页必须在载荷未变时复用幂等键')
  assert.match(orderEntrySource, /findStockShortage\(\)/, '开单页必须在提交前按可用库存预检')
  assert.match(orderEntrySource, /idempotentReplay/, '开单页必须区分幂等重放提示')

  const deleteDialogSource = readSource('src/views/order-list/components/OrderDeleteConfirmDialog.vue')
  assert.match(deleteDialogSource, /CONFIRM_DELAY_SECONDS\s*=\s*3/, '删除弹窗必须有 3 秒等待')
  assert.match(deleteDialogSource, /inventoryChoice\s*=\s*ref<'release' \| 'keep' \| ''>\(''\)/, '回补选项不得有默认值')
  assert.match(deleteDialogSource, /ElMessageBox\.confirm/, '删除弹窗必须二次确认')
  assert.match(readSource('src/views/order-list/composables/useOrderListView.ts'), /releaseInventory/, '列表删除必须透传回补选择')

  assert.match(readSource('src/views/base-data/components/ProductManager.vue'), /stockBaseline/, '商品管理编辑必须携带库存基线')
  assert.match(readSource('src/views/o2o/O2oProductMallManageView.vue'), /stockBaseline/, 'O2O 商品编辑必须携带库存基线')
  assert.match(readSource('backend/src/routes/order.routes.ts'), /releaseInventory:\s*z\.boolean\(\)\.optional\(\)/)
  assert.match(readSource('backend/src/routes/product.routes.ts'), /stockBaseline:\s*z\.object/)
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  verifyFrontendContracts()

  const [
    { AppDataSource },
    { BaseProduct },
    { BaseProductSku },
    { BizOutboundOrder },
    { BizOutboundOrderItem },
    { InventoryLog },
    { SysUser },
    { orderService },
    { productService },
    { systemConfigService },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/biz-outbound-order-item.entity.js'),
    import('../src/entities/inventory-log.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/services/order.service.js'),
    import('../src/services/product.service.js'),
    import('../src/services/system-config.service.js'),
  ])

  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    await systemConfigService.ensureDefaultConfigs()
    const productRepo = AppDataSource.getRepository(BaseProduct)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const itemRepo = AppDataSource.getRepository(BizOutboundOrderItem)
    const logRepo = AppDataSource.getRepository(InventoryLog)

    const persistedActor = await AppDataSource.getRepository(SysUser).save({
      username: actor.username,
      passwordHash: 'test-only-password-hash',
      displayName: actor.displayName,
      email: null,
      role: actor.role,
      status: actor.status,
      lastLoginAt: null,
      deactivatedAt: null,
      deactivationReason: null,
      deactivatedByUserId: null,
      deactivatedByUsername: null,
      deactivatedByDisplayName: null,
      restoredAt: null,
      restoredByUserId: null,
      restoredByUsername: null,
      restoredByDisplayName: null,
    })
    actor.userId = persistedActor.id

    let productSequence = 0
    /** 直接落库的商品夹具：可构造预订占用或汇总与 SKU 不一致等边界状态。 */
    const createFixture = async (skuStocks: Array<{ stock: number; reserved?: number }>, aggregate?: { stock: number; reserved: number }) => {
      productSequence += 1
      const totalStock = skuStocks.reduce((sum, item) => sum + item.stock, 0)
      const totalReserved = skuStocks.reduce((sum, item) => sum + (item.reserved ?? 0), 0)
      const product = await productRepo.save(productRepo.create({
        productCode: `ISSUE82-P-${productSequence}-${verifySeed}`,
        productName: `Issue82商品${productSequence}`,
        pinyinAbbr: 'ISSUE',
        defaultPrice: '10.00',
        discountRate: '10.0',
        isActive: true,
        o2oStatus: 'listed',
        currentStock: aggregate?.stock ?? totalStock,
        preOrderedStock: aggregate?.reserved ?? totalReserved,
      }))
      const skus = []
      for (const [index, item] of skuStocks.entries()) {
        skus.push(await skuRepo.save(skuRepo.create({
          productId: product.id,
          skuCode: `ISSUE82-SKU-${productSequence}-${index}-${verifySeed}`,
          specValuesJson: skuStocks.length > 1 ? JSON.stringify({ 颜色: `色${index}` }) : '{}',
          specText: skuStocks.length > 1 ? `颜色:色${index}` : '默认规格',
          defaultPrice: '10.00',
          discountRate: '10.0',
          currentStock: item.stock,
          preOrderedStock: item.reserved ?? 0,
          isActive: true,
          isCurrent: true,
          sortOrder: index,
        })))
      }
      return { product, skus }
    }

    const stockOf = async (productId: string, skuIds: string[]) => ({
      product: await productRepo.findOneByOrFail({ id: productId }),
      skus: await Promise.all(skuIds.map((id) => skuRepo.findOneByOrFail({ id }))),
    })

    let keySequence = 0
    const nextKey = (label: string) => `issue82-${label}-${verifySeed}-${++keySequence}`
    const submit = (idempotencyKey: string, items: Array<{ productId: string; skuId: string; qty: number }>) => orderService.submit({
      idempotencyKey,
      orderType: 'walkin',
      customerName: 'Issue82客户',
      items: items.map((item) => ({ ...item, unitPrice: 10 })),
    }, actor)
    const createLogCount = (orderId: string, changeType: string) => logRepo.countBy({ refType: 'biz_outbound_order', refId: orderId, changeType })

    // 1. 单 SKU：商品与 SKU 同步扣减，预订量不变，流水字段完整。
    {
      const fixture = await createFixture([{ stock: 20, reserved: 3 }])
      const result = await submit(nextKey('single'), [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 4 }])
      assert.equal(result.order.inventoryMode, 'manual_applied')
      assert.equal(result.idempotentReplay, false)
      assert.equal(result.inventory.deductedQty, 4)
      const after = await stockOf(fixture.product.id, [fixture.skus[0].id])
      assert.equal(after.product.currentStock, 16)
      assert.equal(after.skus[0].currentStock, 16)
      assert.equal(after.product.preOrderedStock, 3, '手工出库不得改动商品预订量')
      assert.equal(after.skus[0].preOrderedStock, 3, '手工出库不得改动 SKU 预订量')
      const logs = await logRepo.findBy({ refType: 'biz_outbound_order', refId: result.order.id, changeType: 'manual_outbound_create' })
      assert.equal(logs.length, 1)
      const [log] = logs
      assert.equal(String(log.skuId), String(fixture.skus[0].id))
      assert.equal(log.changeQty, 4)
      assert.deepEqual(
        [log.beforeCurrentStock, log.afterCurrentStock, log.beforeSkuCurrentStock, log.afterSkuCurrentStock],
        [20, 16, 20, 16],
      )
      assert.deepEqual([log.beforePreorderedStock, log.afterPreorderedStock], [3, 3])
      assert.equal(String(log.operatorId), String(actor.userId))
      assert.equal(log.operatorName, actor.displayName)
    }

    // 2. 多明细、同商品多 SKU：各 SKU 分别扣减，商品汇总等于 SKU 合计。
    {
      const multi = await createFixture([{ stock: 10 }, { stock: 15 }])
      const single = await createFixture([{ stock: 8 }])
      const logBefore = await logRepo.count()
      await submit(nextKey('multi'), [
        { productId: multi.product.id, skuId: multi.skus[0].id, qty: 3 },
        { productId: multi.product.id, skuId: multi.skus[1].id, qty: 5 },
        { productId: single.product.id, skuId: single.skus[0].id, qty: 2 },
      ])
      const multiAfter = await stockOf(multi.product.id, multi.skus.map((sku) => sku.id))
      assert.deepEqual(multiAfter.skus.map((sku) => sku.currentStock), [7, 10])
      assert.equal(multiAfter.product.currentStock, 17)
      assert.equal(multiAfter.product.currentStock, multiAfter.skus.reduce((sum, sku) => sum + sku.currentStock, 0))
      assert.equal((await stockOf(single.product.id, [single.skus[0].id])).product.currentStock, 6)
      assert.equal(await logRepo.count(), logBefore + 3, '三条明细必须写三条流水')
    }

    // 3. SKU 级可用库存不足：整单拒绝，主单、明细、流水、库存均无写入。
    {
      const fixture = await createFixture([{ stock: 5, reserved: 2 }])
      const key = nextKey('sku-short')
      const [orderBefore, itemBefore, logBefore] = await Promise.all([orderRepo.count(), itemRepo.count(), logRepo.count()])
      await expectFailure(() => submit(key, [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 4 }]), /SKU .*可用库存不足/)
      assert.equal(await orderRepo.countBy({ idempotencyKey: key }), 0)
      assert.deepEqual([await orderRepo.count(), await itemRepo.count(), await logRepo.count()], [orderBefore, itemBefore, logBefore])
      assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 5)
    }

    // 4. 商品汇总级可用库存不足（汇总被预订占满）：同样整单拒绝。
    {
      const fixture = await createFixture([{ stock: 10 }], { stock: 10, reserved: 8 })
      const key = nextKey('product-short')
      await expectFailure(() => submit(key, [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 5 }]), /商品 .*可用库存不足/)
      assert.equal(await orderRepo.countBy({ idempotencyKey: key }), 0)
      const after = await stockOf(fixture.product.id, [fixture.skus[0].id])
      assert.deepEqual([after.product.currentStock, after.skus[0].currentStock], [10, 10])
    }

    // 5. 同一幂等键顺序重复提交：只生成一张单、一组流水、只扣一次。
    {
      const fixture = await createFixture([{ stock: 12 }])
      const key = nextKey('idem-seq')
      const first = await submit(key, [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 2 }])
      const second = await submit(key, [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 2 }])
      assert.equal(second.order.id, first.order.id)
      assert.equal(second.idempotentReplay, true)
      assert.equal(second.inventory.deductedQty, 0)
      assert.equal(await orderRepo.countBy({ idempotencyKey: key }), 1)
      assert.equal(await createLogCount(first.order.id, 'manual_outbound_create'), 1)
      assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 10)
    }

    // 6. 同一幂等键并发提交：仍只落一张单、只扣一次。
    {
      const fixture = await createFixture([{ stock: 12 }])
      const key = nextKey('idem-concurrent')
      const results = await Promise.all([1, 2, 3].map(() => submit(key, [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 3 }])))
      assert.equal(new Set(results.map((item) => item.order.id)).size, 1)
      assert.equal(results.filter((item) => !item.idempotentReplay).length, 1, '并发同键只能有一次真实扣减')
      assert.equal(await orderRepo.countBy({ idempotencyKey: key }), 1)
      assert.equal(await createLogCount(results[0].order.id, 'manual_outbound_create'), 1)
      assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 9)
    }

    // 7. 不同幂等键并发抢最后几件库存：一成一败，库存不为负。
    {
      const fixture = await createFixture([{ stock: 5 }])
      const settled = await Promise.allSettled([
        submit(nextKey('race-a'), [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 3 }]),
        submit(nextKey('race-b'), [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 3 }]),
      ])
      assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1)
      const rejected = settled.find((item) => item.status === 'rejected') as PromiseRejectedResult
      assert.match(String((rejected.reason as Error).message), /可用库存不足/)
      const after = await stockOf(fixture.product.id, [fixture.skus[0].id])
      assert.deepEqual([after.product.currentStock, after.skus[0].currentStock], [2, 2])
    }

    // 8. 删除不回补：库存保持扣减后状态，恢复不重复扣减。
    {
      const fixture = await createFixture([{ stock: 10 }])
      const created = await submit(nextKey('delete-keep'), [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 2 }])
      const deleted = await orderService.softDeleteById(created.order.id, actor, created.order.businessNo)
      assert.equal(deleted.inventoryReleased, false)
      assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 8)
      assert.equal((await orderService.detailById(created.order.id)).order.inventoryReleased, false)
      await orderService.restoreById(created.order.id, actor)
      assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 8)
      assert.equal(await createLogCount(created.order.id, 'manual_outbound_restore_apply'), 0)
    }

    // 9. 删除回补 → 恢复重扣：流水成对出现，回补状态随之切换。
    {
      const fixture = await createFixture([{ stock: 6 }, { stock: 4 }])
      const created = await submit(nextKey('delete-release'), [
        { productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 3 },
        { productId: fixture.product.id, skuId: fixture.skus[1].id, qty: 1 },
      ])
      assert.deepEqual((await stockOf(fixture.product.id, fixture.skus.map((sku) => sku.id))).skus.map((sku) => sku.currentStock), [3, 3])
      const deleted = await orderService.softDeleteById(created.order.id, actor, created.order.businessNo, undefined, { releaseInventory: true })
      assert.equal(deleted.inventoryReleased, true)
      const released = await stockOf(fixture.product.id, fixture.skus.map((sku) => sku.id))
      assert.deepEqual(released.skus.map((sku) => sku.currentStock), [6, 4])
      assert.equal(released.product.currentStock, 10)
      const releaseLogs = await logRepo.findBy({ refType: 'biz_outbound_order', refId: created.order.id, changeType: 'manual_outbound_delete_release' })
      assert.deepEqual(releaseLogs.map((log) => log.changeQty).sort(), [-1, -3])
      assert.equal((await orderService.detailById(created.order.id)).order.inventoryReleased, true)
      const deletedList = await orderService.list({ page: 1, pageSize: 100, onlyDeleted: true })
      assert.equal(deletedList.list.find((item) => item.id === created.order.id)?.inventoryReleased, true)

      await orderService.restoreById(created.order.id, actor)
      const restored = await stockOf(fixture.product.id, fixture.skus.map((sku) => sku.id))
      assert.deepEqual(restored.skus.map((sku) => sku.currentStock), [3, 3])
      assert.equal(await createLogCount(created.order.id, 'manual_outbound_restore_apply'), 2)
      assert.equal((await orderService.detailById(created.order.id)).order.inventoryReleased, false)

      // 再次删除但不回补：最近一条是恢复重扣，状态必须为未回补。
      await orderService.softDeleteById(created.order.id, actor, created.order.businessNo)
      assert.equal((await orderService.detailById(created.order.id)).order.inventoryReleased, false)
      assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 3)
    }

    // 10. 恢复时库存不足：拒绝恢复，订单保持删除态，库存不变。
    {
      const fixture = await createFixture([{ stock: 5 }])
      const created = await submit(nextKey('restore-short'), [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 4 }])
      await orderService.softDeleteById(created.order.id, actor, created.order.businessNo, undefined, { releaseInventory: true })
      await submit(nextKey('restore-short-consume'), [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 3 }])
      await expectFailure(() => orderService.restoreById(created.order.id, actor), /恢复需要重新扣减.*可用库存不足/)
      assert.equal(Boolean((await orderRepo.findOneByOrFail({ id: created.order.id })).isDeleted),true)
      assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 2)
    }

    // 11. 非手工库存单选择回补：拒绝删除，订单不变。
    {
      const fixture = await createFixture([{ stock: 5 }])
      const created = await submit(nextKey('legacy-release'), [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 1 }])
      await orderRepo.update({ id: created.order.id }, { inventoryMode: 'legacy_none' })
      await expectFailure(
        () => orderService.softDeleteById(created.order.id, actor, created.order.businessNo, undefined, { releaseInventory: true }),
        /不承载手工库存扣减/,
      )
      assert.equal(Boolean((await orderRepo.findOneByOrFail({ id: created.order.id })).isDeleted),false)
      assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 4)
    }

    // 12. 商品编辑库存基线：旧值覆盖被拦截，未提交库存保留扣减结果，合法调整写调整流水。
    {
      const fixture = await createFixture([{ stock: 10 }])
      const productId = fixture.product.id
      const skuId = fixture.skus[0].id
      await submit(nextKey('edit-base'), [{ productId, skuId, qty: 4 }])
      await expectFailure(
        () => productService.update(productId, { currentStock: 10 }, actor),
        /缺少打开编辑时的库存基线/,
      )
      await expectFailure(
        () => productService.update(productId, { currentStock: 10, stockBaseline: { currentStock: 10 } }, actor),
        /库存已被出入库变动（打开编辑时 10，当前 6）/,
      )
      assert.deepEqual(Object.values((({ product, skus }) => ({ p: product.currentStock, s: skus[0].currentStock }))(await stockOf(productId, [skuId]))), [6, 6])

      await productService.update(productId, { productName: `Issue82改名${verifySeed}`, defaultPrice: 12 }, actor)
      const renamed = await stockOf(productId, [skuId])
      assert.deepEqual([renamed.product.currentStock, renamed.skus[0].currentStock], [6, 6], '未提交库存的编辑不得回写旧库存')

      const adjustLogBefore = await logRepo.countBy({ productId, changeType: 'manual_stock_adjust' })
      await productService.update(productId, { currentStock: 9, stockBaseline: { currentStock: 6 } }, actor)
      const adjusted = await stockOf(productId, [skuId])
      assert.deepEqual([adjusted.product.currentStock, adjusted.skus[0].currentStock], [9, 9])
      const adjustLogs = await logRepo.find({ where: { productId, changeType: 'manual_stock_adjust' }, order: { id: 'ASC' } })
      assert.equal(adjustLogs.length, adjustLogBefore + 1)
      const adjustLog = adjustLogs[adjustLogs.length - 1]
      assert.deepEqual(
        [adjustLog.changeQty, adjustLog.beforeCurrentStock, adjustLog.afterCurrentStock, adjustLog.beforeSkuCurrentStock, adjustLog.afterSkuCurrentStock, adjustLog.refType],
        [3, 6, 9, 6, 9, 'base_product'],
      )
    }

    // 13. 多规格商品按 SKU 列表编辑：已扣减 SKU 的旧值覆盖被拦截；未改动 SKU 省略库存即保留。
    {
      const created = await productService.create({
        productName: `Issue82多规格${verifySeed}`,
        defaultPrice: 10,
        specGroups: [{ name: '颜色', values: ['红', '蓝'] }],
        skus: [
          { specValues: { 颜色: '红' }, currentStock: 5 },
          { specValues: { 颜色: '蓝' }, currentStock: 5 },
        ],
      }, actor)
      const red = created.skus.find((sku) => sku.specValues['颜色'] === '红')
      const blue = created.skus.find((sku) => sku.specValues['颜色'] === '蓝')
      assert.ok(red && blue, '多规格夹具创建失败')
      await submit(nextKey('multi-edit'), [{ productId: created.id, skuId: red.id, qty: 2 }])
      const specGroups = [{ name: '颜色', values: ['红', '蓝'] }]
      await expectFailure(() => productService.update(created.id, {
        specGroups,
        skus: [
          { id: red.id, specValues: { 颜色: '红' }, currentStock: 5 },
          { id: blue.id, specValues: { 颜色: '蓝' } },
        ],
        stockBaseline: { skus: [{ id: red.id, currentStock: 5 }, { id: blue.id, currentStock: 5 }] },
      }, actor), /库存已被出入库变动（打开编辑时 5，当前 3）/)

      await productService.update(created.id, {
        specGroups,
        skus: [
          { id: red.id, specValues: { 颜色: '红' } },
          { id: blue.id, specValues: { 颜色: '蓝' }, currentStock: 8 },
        ],
        stockBaseline: { skus: [{ id: red.id, currentStock: 3 }, { id: blue.id, currentStock: 5 }] },
      }, actor)
      const after = await stockOf(created.id, [red.id, blue.id])
      assert.deepEqual(after.skus.map((sku) => sku.currentStock), [3, 8], '未提交库存的 SKU 必须保留扣减结果')
      assert.equal(after.product.currentStock, 11)
      const blueLogs = await logRepo.findBy({ skuId: blue.id, changeType: 'manual_stock_adjust' })
      assert.equal(blueLogs.length, 1)
      assert.deepEqual([blueLogs[0].changeQty, blueLogs[0].beforeCurrentStock, blueLogs[0].afterCurrentStock], [3, 8, 11])
    }

    // 14. 商品编辑不得改写预订量。
    {
      const fixture = await createFixture([{ stock: 20, reserved: 3 }])
      await productService.update(fixture.product.id, { preOrderedStock: 0, productName: `Issue82预订${verifySeed}` }, actor)
      assert.equal((await productRepo.findOneByOrFail({ id: fixture.product.id })).preOrderedStock, 3)
    }

    // 15. 真实 HTTP 回归：经过 Express 路由校验、鉴权与服务层，验证开单扣减、幂等重放、库存不足与删除回补/恢复重扣。
    {
      const { requestLocalHttp } = await import('./support/local-http-request.js')
      const { createApp } = await import('../src/app.js')
      const { authService } = await import('../src/services/auth.service.js')
      await authService.ensureDefaultAdmin()
      const server = createApp().listen(0, '127.0.0.1')
      try {
        if (!server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.once('listening', () => resolve())
          })
        }
        const address = server.address()
        assert.ok(address && typeof address === 'object' && typeof address.port === 'number', 'HTTP 回归服务端口获取失败')
        const baseUrl = `http://127.0.0.1:${address.port}`
        const callJson = async <TData>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
          // Node http.request 不会自动补 Content-Length，带 body 的请求显式声明长度，避免分块传输被服务端拒绝。
          const response = await requestLocalHttp(`${baseUrl}${url}`, init.body === undefined
            ? init
            : { ...init, headers: { ...init.headers, 'Content-Length': String(Buffer.byteLength(init.body)) } })
          const text = await response.text()
          let payload: { code?: number; message?: string; data?: TData }
          try {
            payload = JSON.parse(text) as typeof payload
          } catch {
            throw new Error(`${url} 响应不是合法 JSON：status=${response.status} body=${text}`)
          }
          return { status: response.status, payload, response }
        }

        const login = await callJson<{ token?: string }>('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: adminPassword }),
        })
        assert.equal(login.status, 200, `HTTP 管理员登录失败：${JSON.stringify(login.payload)}`)
        const cookieHeader = login.response.headers.get('set-cookie') ?? ''
        const cookieToken = cookieHeader.match(/y_link_admin_session=([^;]+)/)?.[1]
        const token = login.payload.data?.token ?? (cookieToken ? decodeURIComponent(cookieToken) : undefined)
        assert.ok(token, 'HTTP 管理员登录未返回可用会话')
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

        type HttpSubmitData = { order: { id: string; businessNo: string }; inventory: { deductedQty: number }; idempotentReplay: boolean }
        const fixture = await createFixture([{ stock: 10 }])
        const httpKey = nextKey('http')
        const submitBody = JSON.stringify({
          idempotencyKey: httpKey,
          orderType: 'walkin',
          items: [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 3, unitPrice: 10 }],
        })
        const first = await callJson<HttpSubmitData>('/api/orders/submit', { method: 'POST', headers, body: submitBody })
        assert.equal(first.status, 200, `HTTP 开单失败：${JSON.stringify(first.payload)}`)
        assert.equal(first.payload.data?.inventory.deductedQty, 3)
        assert.equal(first.payload.data?.idempotentReplay, false)
        const replay = await callJson<HttpSubmitData>('/api/orders/submit', { method: 'POST', headers, body: submitBody })
        assert.equal(replay.status, 200)
        assert.equal(replay.payload.data?.idempotentReplay, true, 'HTTP 同一幂等键重放必须标记 idempotentReplay')
        assert.equal(replay.payload.data?.order.id, first.payload.data?.order.id)
        assert.deepEqual(
          (({ product, skus }) => [product.currentStock, skus[0].currentStock])(await stockOf(fixture.product.id, [fixture.skus[0].id])),
          [7, 7],
          'HTTP 开单与重放后库存只能扣减一次',
        )

        const shortage = await callJson('/api/orders/submit', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            idempotencyKey: nextKey('http-short'),
            orderType: 'walkin',
            items: [{ productId: fixture.product.id, skuId: fixture.skus[0].id, qty: 99, unitPrice: 10 }],
          }),
        })
        assert.equal(shortage.status, 409, `HTTP 库存不足应返回 409：${JSON.stringify(shortage.payload)}`)
        assert.match(String(shortage.payload.message), /可用库存不足/)

        const orderId = String(first.payload.data?.order.id)
        const deleted = await callJson<{ inventoryReleased: boolean }>(`/api/orders/${orderId}`, {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ confirmShowNo: first.payload.data?.order.businessNo, releaseInventory: true }),
        })
        assert.equal(deleted.status, 200, `HTTP 删除回补失败：${JSON.stringify(deleted.payload)}`)
        assert.equal(deleted.payload.data?.inventoryReleased, true)
        assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 10, 'HTTP 删除回补后库存应恢复')
        const detail = await callJson<{ order: { inventoryReleased: boolean } }>(`/api/orders/${orderId}`, { headers })
        assert.equal(detail.payload.data?.order.inventoryReleased, true, 'HTTP 详情必须暴露已回补状态')

        const restored = await callJson(`/api/orders/${orderId}/restore`, { method: 'POST', headers })
        assert.equal(restored.status, 200, `HTTP 恢复失败：${JSON.stringify(restored.payload)}`)
        assert.equal((await stockOf(fixture.product.id, [fixture.skus[0].id])).skus[0].currentStock, 7, 'HTTP 恢复后必须重新扣减')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }

    // 16. 只读库存差异核查：人为制造三类差异后能检出，且核查前后数据行数不变。
    {
      const broken = await createFixture([{ stock: 9 }])
      const unlogged = await submit(nextKey('audit-unlogged'), [{ productId: broken.product.id, skuId: broken.skus[0].id, qty: 2 }])
      // 模拟“订单已保存但库存未扣”：删除该单的创建流水并把库存改回扣减前。
      await logRepo.delete({ refType: 'biz_outbound_order', refId: unlogged.order.id })
      await productRepo.update({ id: broken.product.id }, { currentStock: 9 })
      await skuRepo.update({ id: broken.skus[0].id }, { currentStock: 9 })

      const drifted = await createFixture([{ stock: 7 }])
      await submit(nextKey('audit-drift'), [{ productId: drifted.product.id, skuId: drifted.skus[0].id, qty: 1 }])
      // 模拟修复前的商品编辑覆盖：SKU 库存被写回旧值且无流水，同时商品汇总与 SKU 不一致。
      await skuRepo.update({ id: drifted.skus[0].id }, { currentStock: 7 })

      const counts = async () => Promise.all([orderRepo.count(), itemRepo.count(), logRepo.count(), productRepo.count(), skuRepo.count()])
      const countsBefore = await counts()
      await AppDataSource.destroy()

      const tsxCli = path.resolve(backendRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
      const run = spawnSync(process.execPath, [tsxCli, path.resolve(backendRoot, 'scripts', 'inventory-reconcile-audit.ts'), '--out', auditOutDir], {
        cwd: backendRoot,
        env: { ...process.env, DB_SYNC: 'false' },
        encoding: 'utf8',
      })
      assert.equal(run.status, 0, `核查脚本执行失败：${run.stderr || run.stdout}`)
      const reportLine = run.stdout.split(/\r?\n/).find((line) => line.startsWith('REPORT_JSON='))
      assert.ok(reportLine, `核查脚本未输出报告路径：${run.stdout}`)
      const report = JSON.parse(fs.readFileSync(reportLine.slice('REPORT_JSON='.length).trim(), 'utf8')) as {
        findings: Record<string, Array<Record<string, unknown>>>
      }
      assert.ok(
        report.findings.orderInventoryMismatch.some((item) => String(item.orderId) === String(unlogged.order.id)),
        '必须检出“订单已保存但库存未扣”',
      )
      assert.ok(
        report.findings.skuLogChainBreak.some((item) => String(item.skuId) === String(drifted.skus[0].id)),
        '必须检出 SKU 库存与最近流水不一致',
      )
      assert.ok(
        report.findings.productAggregateMismatch.some((item) => String(item.productId) === String(drifted.product.id)),
        '必须检出商品汇总与 SKU 合计不一致',
      )
      assert.equal(fs.readdirSync(auditOutDir).some((name) => name.endsWith('.csv')), true, '核查脚本必须同时输出 CSV')

      await AppDataSource.initialize()
      assert.deepEqual(await counts(), countsBefore, '核查脚本不得写库')
    }

    console.log('[manual-outbound-inventory-verify] PASS')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanup()
  }
}

main().catch((error) => {
  console.error('[manual-outbound-inventory-verify] FAIL')
  console.error(error)
  cleanup()
  process.exitCode = 1
})
