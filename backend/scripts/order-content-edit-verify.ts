/**
 * 模块说明：Issue #73 订单内容编辑与库存治理专项验证。
 * 文件职责：在隔离 SQLite 中验证库存模式、创建扣库、差额编辑、回滚、锁定规则、并发版本与永久修订。
 * 实现逻辑：使用真实实体、事务和服务层验证行为，仅在注入审计失败时替换写入点以证明全事务回滚。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthUserContext } from '../src/types/auth.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(backendRoot, '..')
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqlitePath = path.resolve(sqliteRoot, `order-content-edit-${verifySeed}.sqlite`)
const readSource = (relativePath: string) => fs.readFileSync(path.resolve(repositoryRoot, relativePath), 'utf8')

process.env.APP_PROFILE = `order-content-edit-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.PERMANENT_DELETE_PASSWORD = `Purge_${verifySeed}_Aa1!`

const actor: AuthUserContext = {
  userId: '73001',
  username: 'issue73-verifier',
  displayName: 'Issue73验证员',
  role: 'admin',
  permissions: ['orders:create', 'orders:view', 'orders:update', 'orders:edit', 'orders:delete'],
  status: 'enabled',
  sessionToken: 'issue73-session',
  authSource: 'bearer',
}

function cleanup() {
  for (const target of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true })
  }
}

async function expectFailure(action: () => Promise<unknown>, message: RegExp, statusCode = 409) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, message)
    assert.equal((error as Error & { statusCode?: number }).statusCode, statusCode)
    return true
  })
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const routeSource = fs.readFileSync(path.resolve(backendRoot, 'src/routes/order.routes.ts'), 'utf8')
  assert.match(routeSource, /\/:id\/content[\s\S]*requirePermission\('orders:edit'\)/, '内容编辑路由未由 orders:edit 保护')
  assert.match(routeSource, /\/:id\/revisions[\s\S]*requirePermission\('orders:view'\)/, '修订时间线路由 orders:view 保护')
  const serviceSource = fs.readFileSync(path.resolve(backendRoot, 'src/services/order-content-edit.service.ts'), 'utf8')
  const productLockIndex = serviceSource.indexOf("orderBy('product.id', 'ASC')")
  const skuLockIndex = serviceSource.indexOf("orderBy('sku.productId', 'ASC')")
  assert.ok(productLockIndex >= 0, '内容编辑必须按主键升序批量锁定商品')
  assert.ok(skuLockIndex > productLockIndex, '内容编辑必须在商品之后按商品/SKU 升序锁定 SKU')

  const mysqlMigrationPath = path.resolve(backendRoot, 'sql/043_order_content_inventory_mode.sql')
  assert.equal(fs.existsSync(mysqlMigrationPath), true, '缺少 Issue #73 MySQL 幂等迁移')
  const mysqlMigrationSource = fs.readFileSync(mysqlMigrationPath, 'utf8')
  assert.match(mysqlMigrationSource, /inventory_mode[\s\S]*legacy_none[\s\S]*o2o_preapplied/)
  assert.match(mysqlMigrationSource, /inventory_log[\s\S]*sku_id/)
  assert.doesNotMatch(mysqlMigrationSource, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i, '迁移不得使用 MySQL 8.0.44 不兼容语法')
  const migrationServiceSource = readSource('backend/src/services/database-migration.service.ts')
  assert.match(migrationServiceSource, /source_outbound_order_constraint_dirty[\s\S]*inventory_mode[\s\S]*manual_applied[\s\S]*o2o_preapplied/)
  assert.match(readSource('backend/src/commands/seed-database-migration-e2e.ts'), /inventory_mode[\s\S]*manual_applied/)

  const authBackend = fs.readFileSync(path.resolve(backendRoot, 'src/constants/auth-permissions.ts'), 'utf8')
  const authFrontend = fs.readFileSync(path.resolve(repositoryRoot, 'src/api/modules/auth.ts'), 'utf8')
  for (const source of [authBackend, authFrontend]) {
    assert.match(source, /orders:edit/)
    assert.match(source, /admin:[\s\S]*orders:update[\s\S]*orders:edit/)
    assert.match(source, /operator:[\s\S]*orders:update[\s\S]*orders:edit/)
    assert.doesNotMatch(source, /supplier:\s*\[[^\]]*orders:edit/)
  }
  const orderApiSource = readSource('src/api/modules/order.ts')
  const orderListSource = readSource('src/views/order-list/OrderListView.vue')
  const contentDialogSource = readSource('src/views/order-list/components/OrderContentEditDialog.vue')
  const detailDrawerSource = readSource('src/views/order-list/components/OrderDetailDrawerContent.vue')
  assert.match(orderApiSource, /method:\s*'PATCH'[\s\S]*`\/orders\/\$\{id\}\/content`/)
  assert.match(orderApiSource, /method:\s*'GET'[\s\S]*`\/orders\/\$\{id\}\/revisions`/)
  assert.match(orderListSource, /orders:edit[\s\S]*OrderContentEditDialog/)
  assert.match(contentDialogSource, /legacy_none[\s\S]*不追溯扣减或回补库存/)
  assert.match(contentDialogSource, /row\.original\s*&&\s*props\.order\.inventoryMode\s*===\s*'legacy_none'/, '历史无 SKU 明细必须可保留并编辑')
  assert.match(detailDrawerSource, /getOrderRevisions[\s\S]*内容修订时间线/)

  const [
    { AppDataSource },
    { BaseProduct },
    { BaseProductSku },
    { BizOutboundOrder },
    { BizOutboundOrderItem },
    { InventoryLog },
    { OrderRevision },
    { SysAuditLog },
    { SysUser },
    { orderService },
    { systemConfigService },
    { auditService },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/biz-outbound-order-item.entity.js'),
    import('../src/entities/inventory-log.entity.js'),
    import('../src/entities/order-revision.entity.js'),
    import('../src/entities/sys-audit-log.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/services/order.service.js'),
    import('../src/services/system-config.service.js'),
    import('../src/services/audit.service.js'),
  ])

  const contentApi = orderService as typeof orderService & {
    updateContent: (
      orderId: string,
      input: { expectedVersion: number; reason: string; businessNo?: string; items: Array<Record<string, unknown>> },
      currentActor: AuthUserContext,
    ) => Promise<{ order: Record<string, unknown>; items: Array<Record<string, unknown>>; revision: Record<string, unknown>; inventoryDeltas: unknown[]; notice: string | null }>
    listRevisions: (orderId: string) => Promise<Array<{ revisionNo: number; before: Record<string, unknown>; after: Record<string, unknown> }>>
  }

  assert.equal(typeof contentApi.updateContent, 'function', '基线缺少订单内容编辑服务')
  assert.equal(typeof contentApi.listRevisions, 'function', '基线缺少订单修订时间线服务')

  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    await systemConfigService.ensureDefaultConfigs()
    const productRepo = AppDataSource.getRepository(BaseProduct)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const itemRepo = AppDataSource.getRepository(BizOutboundOrderItem)
    const inventoryLogRepo = AppDataSource.getRepository(InventoryLog)
    const revisionRepo = AppDataSource.getRepository(OrderRevision)

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
    const createProduct = async (stock = 20, reserved = 3) => {
      productSequence += 1
      const product = await productRepo.save(productRepo.create({
        productCode: `ISSUE73-P-${productSequence}-${verifySeed}`,
        productName: `Issue73商品${productSequence}`,
        pinyinAbbr: 'ISSUE',
        defaultPrice: '10.00',
        discountRate: '10.0',
        isActive: true,
        o2oStatus: 'listed',
        currentStock: stock,
        preOrderedStock: reserved,
      }))
      const sku = await skuRepo.save(skuRepo.create({
        productId: product.id,
        skuCode: `ISSUE73-SKU-${productSequence}-${verifySeed}`,
        specValuesJson: '{}',
        specText: `规格${productSequence}`,
        defaultPrice: '10.00',
        discountRate: '10.0',
        currentStock: stock,
        preOrderedStock: reserved,
        isActive: true,
        isCurrent: true,
        sortOrder: 0,
      }))
      return { product, sku }
    }

    let orderSequence = 0
    const submit = async (productId: string, skuId: string, qty: number, extra: Record<string, unknown> = {}) => {
      orderSequence += 1
      return orderService.submit({
        idempotencyKey: `issue73-${verifySeed}-${orderSequence}`,
        orderType: 'walkin',
        customerName: `验证客户${orderSequence}`,
        items: [{ productId, skuId, qty, unitPrice: 10 }],
        ...extra,
      }, actor)
    }

    const decimalFixture = await createProduct()
    await expectFailure(() => submit(decimalFixture.product.id, decimalFixture.sku.id, 1.5), /正整数/, 400)
    await expectFailure(() => submit(decimalFixture.product.id, decimalFixture.sku.id, 1.001), /正整数/, 400)
    assert.equal((await productRepo.findOneByOrFail({ id: decimalFixture.product.id })).currentStock, 20)

    const duplicateSkuFixture = await createProduct(5, 0)
    duplicateSkuFixture.product.currentStock = 100
    await productRepo.save(duplicateSkuFixture.product)
    await expectFailure(() => orderService.submit({
      idempotencyKey: `issue73-duplicate-sku-${verifySeed}`,
      orderType: 'walkin',
      items: [
        { productId: duplicateSkuFixture.product.id, skuId: duplicateSkuFixture.sku.id, qty: 4, unitPrice: 10 },
        { productId: duplicateSkuFixture.product.id, skuId: duplicateSkuFixture.sku.id, qty: 4, unitPrice: 10 },
      ],
    }, actor), /同一规格|SKU.*库存不足/, 400)
    assert.equal((await skuRepo.findOneByOrFail({ id: duplicateSkuFixture.sku.id })).currentStock, 5)

    const fixture = await createProduct()
    const created = await submit(fixture.product.id, fixture.sku.id, 4)
    assert.equal((created.order as typeof created.order & { inventoryMode: string }).inventoryMode, 'manual_applied')
    assert.equal((await productRepo.findOneByOrFail({ id: fixture.product.id })).currentStock, 16)
    assert.equal((await skuRepo.findOneByOrFail({ id: fixture.sku.id })).currentStock, 16)
    const createLogs = await inventoryLogRepo.find({ where: { refType: 'biz_outbound_order', refId: created.order.id, changeType: 'manual_outbound_create' } })
    assert.equal(createLogs.length, 1)
    assert.equal(createLogs[0]?.skuId, fixture.sku.id)
    assert.deepEqual(
      [createLogs[0]?.beforeCurrentStock, createLogs[0]?.afterCurrentStock, createLogs[0]?.beforeSkuCurrentStock, createLogs[0]?.afterSkuCurrentStock],
      [20, 16, 20, 16],
      '创建流水必须可还原商品与 SKU 库存',
    )

    const invalidPriceOrderBefore = await orderService.detailById(created.order.id)
    const invalidPriceProductStockBefore = (await productRepo.findOneByOrFail({ id: fixture.product.id })).currentStock
    const invalidPriceSkuStockBefore = (await skuRepo.findOneByOrFail({ id: fixture.sku.id })).currentStock
    const invalidPriceLogCountBefore = await inventoryLogRepo.countBy({ refType: 'biz_outbound_order', refId: created.order.id })
    const invalidPriceRevisionCountBefore = await revisionRepo.countBy({ orderUuid: String((await orderRepo.findOneByOrFail({ id: created.order.id })).orderUuid) })
    const invalidPriceAuditCountBefore = await AppDataSource.getRepository(SysAuditLog).countBy({ actionType: 'order.content_edit', targetId: created.order.id })
    await expectFailure(() => contentApi.updateContent(created.order.id, {
      expectedVersion: 1,
      reason: '单价舍入为零应失败',
      items: [{ productId: fixture.product.id, skuId: fixture.sku.id, qty: 5, unitPrice: 0.001 }],
    }, actor), /单价.*(?:0\.01|舍入)/, 400)
    assert.deepEqual(await orderService.detailById(created.order.id), invalidPriceOrderBefore, '无效单价不得改写订单版本或明细')
    assert.equal((await productRepo.findOneByOrFail({ id: fixture.product.id })).currentStock, invalidPriceProductStockBefore)
    assert.equal((await skuRepo.findOneByOrFail({ id: fixture.sku.id })).currentStock, invalidPriceSkuStockBefore)
    assert.equal(await inventoryLogRepo.countBy({ refType: 'biz_outbound_order', refId: created.order.id }), invalidPriceLogCountBefore)
    assert.equal(await revisionRepo.countBy({ orderUuid: String((await orderRepo.findOneByOrFail({ id: created.order.id })).orderUuid) }), invalidPriceRevisionCountBefore)
    assert.equal(await AppDataSource.getRepository(SysAuditLog).countBy({ actionType: 'order.content_edit', targetId: created.order.id }), invalidPriceAuditCountBefore)

    const roundedPriceFixture = await createProduct()
    const roundedPriceCreated = await submit(roundedPriceFixture.product.id, roundedPriceFixture.sku.id, 1)
    const roundedPriceStockBefore = (await skuRepo.findOneByOrFail({ id: roundedPriceFixture.sku.id })).currentStock
    const roundedPriceEdited = await contentApi.updateContent(roundedPriceCreated.order.id, {
      expectedVersion: 1,
      reason: '验证两位单价舍入',
      items: [{ productId: roundedPriceFixture.product.id, skuId: roundedPriceFixture.sku.id, qty: 1, unitPrice: 0.006 }],
    }, actor)
    assert.equal(roundedPriceEdited.items[0]?.unitPrice, '0.01', '能按两位精度舍入至 0.01 的正数单价必须允许编辑')
    assert.equal(roundedPriceEdited.order.totalAmount, '0.01')
    assert.equal((await skuRepo.findOneByOrFail({ id: roundedPriceFixture.sku.id })).currentStock, roundedPriceStockBefore)

    await expectFailure(() => contentApi.updateContent(created.order.id, {
      expectedVersion: 1,
      reason: '小数精度绕过应失败',
      items: [{ productId: fixture.product.id, skuId: fixture.sku.id, qty: 4.001, unitPrice: 10 }],
    }, actor), /正整数/, 400)

    const edited = await contentApi.updateContent(created.order.id, {
      expectedVersion: 1,
      reason: '客户追加',
      items: [{ productId: fixture.product.id, skuId: fixture.sku.id, qty: 6, unitPrice: 12, remark: '追加两件' }],
    }, actor)
    assert.equal(edited.order.editVersion, 2)
    assert.equal(edited.order.totalQty, '6.00')
    assert.equal(edited.order.totalAmount, '72.00')
    const persistedEditedOrder = await orderRepo.findOneByOrFail({ id: created.order.id })
    assert.equal(edited.order.customerName, persistedEditedOrder.customerName, '编辑响应必须保留完整客户快照')
    assert.ok(String(edited.order.createdAt ?? ''), '编辑响应必须保留开单时间')
    assert.equal(edited.items[0]?.productCode, fixture.product.productCode, '编辑响应必须保留商品编码')
    assert.equal((await productRepo.findOneByOrFail({ id: fixture.product.id })).currentStock, 14)
    assert.equal((await skuRepo.findOneByOrFail({ id: fixture.sku.id })).currentStock, 14)
    assert.equal(await revisionRepo.countBy({ orderUuid: String((await orderRepo.findOneByOrFail({ id: created.order.id })).orderUuid) }), 1)
    assert.equal(await AppDataSource.getRepository(SysAuditLog).countBy({ actionType: 'order.content_edit', targetId: created.order.id }), 1)

    const retiredSku = await skuRepo.findOneByOrFail({ id: fixture.sku.id })
    retiredSku.isActive = false
    retiredSku.isCurrent = false
    await skuRepo.save(retiredSku)
    const reduced = await contentApi.updateContent(created.order.id, {
      expectedVersion: 2,
      reason: '退役规格减量',
      items: [{ productId: fixture.product.id, skuId: fixture.sku.id, qty: 2, unitPrice: 12 }],
    }, actor)
    assert.equal(reduced.order.editVersion, 3)
    assert.equal((await skuRepo.findOneByOrFail({ id: fixture.sku.id })).currentStock, 18)
    await expectFailure(() => contentApi.updateContent(created.order.id, {
      expectedVersion: 3,
      reason: '退役规格增量应失败',
      items: [{ productId: fixture.product.id, skuId: fixture.sku.id, qty: 3, unitPrice: 12 }],
    }, actor), /退役|停用|当前版本/)
    assert.equal((await orderRepo.findOneByOrFail({ id: created.order.id })).editVersion, 3)

    const legacyFixture = await createProduct(12, 1)
    const legacyCreated = await submit(legacyFixture.product.id, legacyFixture.sku.id, 2)
    const legacyOrder = await orderRepo.findOneByOrFail({ id: legacyCreated.order.id })
    legacyOrder.inventoryMode = 'legacy_none'
    await orderRepo.save(legacyOrder)
    const legacyStockBefore = (await skuRepo.findOneByOrFail({ id: legacyFixture.sku.id })).currentStock
    const legacyEdited = await contentApi.updateContent(legacyCreated.order.id, {
      expectedVersion: 1,
      reason: '历史单据数量更正',
      items: [{ productId: legacyFixture.product.id, skuId: legacyFixture.sku.id, qty: 5.5, unitPrice: 8 }],
    }, actor)
    assert.match(legacyEdited.notice ?? '', /不追溯扣减或回补库存/)
    assert.equal((await skuRepo.findOneByOrFail({ id: legacyFixture.sku.id })).currentStock, legacyStockBefore)
    assert.equal(await inventoryLogRepo.countBy({ refType: 'biz_outbound_order', refId: legacyCreated.order.id, changeType: 'manual_outbound_edit' }), 0)

    const lockedFixture = await createProduct()
    const lockedCreated = await submit(lockedFixture.product.id, lockedFixture.sku.id, 1, { hasCustomerOrder: true })
    await expectFailure(() => contentApi.updateContent(lockedCreated.order.id, {
      expectedVersion: 1,
      reason: '带单锁定',
      items: [{ productId: lockedFixture.product.id, skuId: lockedFixture.sku.id, qty: 2, unitPrice: 10 }],
    }, actor), /客户订单|带单|锁定/)

    const o2oFixture = await createProduct()
    const o2oCreated = await submit(o2oFixture.product.id, o2oFixture.sku.id, 1)
    const o2oOrder = await orderRepo.findOneByOrFail({ id: o2oCreated.order.id })
    o2oOrder.inventoryMode = 'o2o_preapplied'
    await orderRepo.save(o2oOrder)
    await expectFailure(() => contentApi.updateContent(o2oCreated.order.id, {
      expectedVersion: 1,
      reason: 'O2O 锁定',
      items: [{ productId: o2oFixture.product.id, skuId: o2oFixture.sku.id, qty: 2, unitPrice: 10 }],
    }, actor), /O2O|预扣|锁定/)

    const insufficientFixture = await createProduct(5, 4)
    const insufficientCreated = await submit(insufficientFixture.product.id, insufficientFixture.sku.id, 1)
    const insufficientBefore = await orderService.detailById(insufficientCreated.order.id)
    await expectFailure(() => contentApi.updateContent(insufficientCreated.order.id, {
      expectedVersion: 1,
      reason: '库存不足',
      items: [{ productId: insufficientFixture.product.id, skuId: insufficientFixture.sku.id, qty: 2, unitPrice: 99 }],
    }, actor), /库存不足|可用库存/)
    assert.deepEqual(await orderService.detailById(insufficientCreated.order.id), insufficientBefore)

    const createRollbackFixture = await createProduct()
    const createRollbackIdempotencyKey = `issue73-create-rollback-${verifySeed}`
    const originalAuditRecord = auditService.record.bind(auditService)
    auditService.record = (async (input: Parameters<typeof auditService.record>[0], manager: Parameters<typeof auditService.record>[1]) => {
      if (input.actionType === 'order.create') throw new Error('INJECTED_ORDER_CREATE_AUDIT_FAILURE')
      return originalAuditRecord(input, manager)
    }) as typeof auditService.record
    try {
      await assert.rejects(() => orderService.submit({
        idempotencyKey: createRollbackIdempotencyKey,
        orderType: 'walkin',
        items: [{ productId: createRollbackFixture.product.id, skuId: createRollbackFixture.sku.id, qty: 2, unitPrice: 10 }],
      }, actor), /INJECTED_ORDER_CREATE_AUDIT_FAILURE/)
    } finally {
      auditService.record = originalAuditRecord
    }
    assert.equal((await productRepo.findOneByOrFail({ id: createRollbackFixture.product.id })).currentStock, 20)
    assert.equal((await skuRepo.findOneByOrFail({ id: createRollbackFixture.sku.id })).currentStock, 20)
    assert.equal(await orderRepo.countBy({ idempotencyKey: createRollbackIdempotencyKey }), 0)
    assert.equal(await inventoryLogRepo.countBy({ refType: 'biz_outbound_order', changeType: 'manual_outbound_create', productId: createRollbackFixture.product.id }), 0)

    const rollbackFixture = await createProduct()
    const rollbackCreated = await submit(rollbackFixture.product.id, rollbackFixture.sku.id, 2)
    const rollbackOrderBefore = await orderService.detailById(rollbackCreated.order.id)
    const rollbackProductBefore = (await productRepo.findOneByOrFail({ id: rollbackFixture.product.id })).currentStock
    const rollbackSkuBefore = (await skuRepo.findOneByOrFail({ id: rollbackFixture.sku.id })).currentStock
    auditService.record = (async (input: Parameters<typeof auditService.record>[0], manager: Parameters<typeof auditService.record>[1]) => {
      if (input.actionType === 'order.content_edit') throw new Error('INJECTED_ORDER_CONTENT_AUDIT_FAILURE')
      return originalAuditRecord(input, manager)
    }) as typeof auditService.record
    try {
      await assert.rejects(() => contentApi.updateContent(rollbackCreated.order.id, {
        expectedVersion: 1,
        reason: '注入审计失败',
        items: [{ productId: rollbackFixture.product.id, skuId: rollbackFixture.sku.id, qty: 3, unitPrice: 10 }],
      }, actor), /INJECTED_ORDER_CONTENT_AUDIT_FAILURE/)
    } finally {
      auditService.record = originalAuditRecord
    }
    assert.deepEqual(await orderService.detailById(rollbackCreated.order.id), rollbackOrderBefore)
    assert.equal((await productRepo.findOneByOrFail({ id: rollbackFixture.product.id })).currentStock, rollbackProductBefore)
    assert.equal((await skuRepo.findOneByOrFail({ id: rollbackFixture.sku.id })).currentStock, rollbackSkuBefore)

    const concurrentFixture = await createProduct(30, 0)
    const concurrentCreated = await submit(concurrentFixture.product.id, concurrentFixture.sku.id, 2)
    const concurrentResults = await Promise.allSettled([
      contentApi.updateContent(concurrentCreated.order.id, {
        expectedVersion: 1,
        reason: '并发 A',
        items: [{ productId: concurrentFixture.product.id, skuId: concurrentFixture.sku.id, qty: 3, unitPrice: 10 }],
      }, actor),
      contentApi.updateContent(concurrentCreated.order.id, {
        expectedVersion: 1,
        reason: '并发 B',
        items: [{ productId: concurrentFixture.product.id, skuId: concurrentFixture.sku.id, qty: 4, unitPrice: 10 }],
      }, actor),
    ])
    assert.equal(concurrentResults.filter((item) => item.status === 'fulfilled').length, 1)
    assert.equal(concurrentResults.filter((item) => item.status === 'rejected').length, 1)
    assert.equal((await orderRepo.findOneByOrFail({ id: concurrentCreated.order.id })).editVersion, 2)

    const revisions = await contentApi.listRevisions(created.order.id)
    assert.deepEqual(revisions.map((item) => item.revisionNo), [3, 2])
    assert.equal(revisions[0]?.after.inventoryMode, 'manual_applied')
    await orderService.softDeleteById(created.order.id, actor, created.order.businessNo)
    await orderService.restoreById(created.order.id, actor)
    assert.equal((await contentApi.listRevisions(created.order.id)).length, 2, '删除和恢复不得删除修订时间线')
    await orderService.softDeleteById(created.order.id, actor, created.order.businessNo)
    const stockBeforeBlockedPurge = (await productRepo.findOneByOrFail({ id: fixture.product.id })).currentStock
    const skuStockBeforeBlockedPurge = (await skuRepo.findOneByOrFail({ id: fixture.sku.id })).currentStock
    const itemCountBeforeBlockedPurge = await itemRepo.countBy({ orderId: created.order.id })
    const logCountBeforeBlockedPurge = await inventoryLogRepo.countBy({ refType: 'biz_outbound_order', refId: created.order.id })
    await expectFailure(() => orderService.purgeById(created.order.id, actor, created.order.businessNo), /库存影响|永久删除/)
    assert.ok(await orderRepo.findOneBy({ id: created.order.id }), '被库存影响的手工单永久删除失败后必须完整保留')
    assert.equal((await productRepo.findOneByOrFail({ id: fixture.product.id })).currentStock, stockBeforeBlockedPurge)
    assert.equal((await skuRepo.findOneByOrFail({ id: fixture.sku.id })).currentStock, skuStockBeforeBlockedPurge)
    assert.equal(await itemRepo.countBy({ orderId: created.order.id }), itemCountBeforeBlockedPurge)
    assert.equal(await inventoryLogRepo.countBy({ refType: 'biz_outbound_order', refId: created.order.id }), logCountBeforeBlockedPurge)
    assert.equal((await contentApi.listRevisions(created.order.id)).length, 2, '阻止永久删除后修订时间线仍必须可查')

    const staleContentFixture = await createProduct()
    const staleContentOrder = await submit(staleContentFixture.product.id, staleContentFixture.sku.id, 1)
    const staleActor = await AppDataSource.getRepository(SysUser).findOneByOrFail({ id: actor.userId })
    staleActor.status = 'disabled'
    await AppDataSource.getRepository(SysUser).save(staleActor)
    await expectFailure(() => contentApi.updateContent(staleContentOrder.order.id, {
      expectedVersion: 1,
      reason: '停用账号不应继续编辑',
      items: [{ productId: staleContentFixture.product.id, skuId: staleContentFixture.sku.id, qty: 2, unitPrice: 10 }],
    }, actor), /停用|注销/)
    assert.equal((await productRepo.findOneByOrFail({ id: staleContentFixture.product.id })).currentStock, 19)
    const staleFixture = await createProduct()
    await expectFailure(() => submit(staleFixture.product.id, staleFixture.sku.id, 1), /停用|注销/)
    assert.equal((await productRepo.findOneByOrFail({ id: staleFixture.product.id })).currentStock, 20)

    console.log('[order-content-edit-verify] PASS')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanup()
  }
}

main().catch((error) => {
  console.error('[order-content-edit-verify] FAILED', error)
  cleanup()
  process.exitCode = 1
})
