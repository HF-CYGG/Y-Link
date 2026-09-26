/**
 * 模块说明：Issue #110 业务号释放专项验证。
 * 文件职责：在隔离 SQLite 中验证永久删除释放、普通改单反复复用、高水位及最小删除审计。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'

const seed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const backendRoot = process.cwd()
const sqliteRoot = path.resolve(backendRoot, 'data', 'local-dev')
const sqlitePath = path.resolve(sqliteRoot, `order-business-no-release-${seed}.sqlite`)

process.env.APP_PROFILE = `order-business-no-release-${seed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.INIT_ADMIN_PASSWORD = `Admin_${seed}_Aa1!`

function cleanup() {
  for (const filePath of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
  }
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const [
    { AppDataSource },
    { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime },
    { authService },
    { orderService },
    { systemConfigService },
    { BaseProduct },
    { BaseProductSku },
    { BizOutboundOrder },
    { BusinessSequence },
    { InventoryLog },
    { OrderRevision },
    { SysAuditLog },
    { SysUser },
    { DEFAULT_ROLE_PERMISSIONS },
    { buildRedactedDeleteTarget },
    { BizError },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/services/auth.service.js'),
    import('../src/services/order.service.js'),
    import('../src/services/system-config.service.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/business-sequence.entity.js'),
    import('../src/entities/inventory-log.entity.js'),
    import('../src/entities/order-revision.entity.js'),
    import('../src/entities/sys-audit-log.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/constants/auth-permissions.js'),
    import('../src/services/order-permanent-delete-cleanup.service.js'),
    import('../src/utils/errors.js'),
  ])

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()
    const adminProfile = await authService.ensureDefaultAdmin()
    const admin = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: adminProfile.username })
    const actor: AuthUserContext = {
      userId: String(admin.id),
      username: admin.username,
      displayName: admin.displayName,
      role: 'admin',
      permissions: [...DEFAULT_ROLE_PERMISSIONS.admin],
      status: 'enabled',
      sessionToken: 'issue110-release',
      authSource: 'bearer',
    }

    const product = await AppDataSource.getRepository(BaseProduct).save({
      productCode: `ISSUE110-${seed}`,
      productName: 'Issue110释放验证商品',
      pinyinAbbr: 'ISSUE',
      defaultPrice: '9.90',
      currentStock: 1000,
      preOrderedStock: 0,
      isActive: true,
    })
    const sku = await AppDataSource.getRepository(BaseProductSku).save({
      productId: product.id,
      skuCode: `ISSUE110-SKU-${seed}`,
      specValuesJson: '{}',
      specText: '默认规格',
      defaultPrice: '9.90',
      discountRate: '10.0',
      currentStock: 1000,
      preOrderedStock: 0,
      isActive: true,
      isCurrent: true,
      o2oRecommended: false,
      thumbnail: null,
      sortOrder: 0,
    })

    let requestIndex = 0
    const submit = async () => {
      requestIndex += 1
      return orderService.submit({
        idempotencyKey: `issue110-release-${seed}-${requestIndex}`,
        orderType: 'walkin',
        customerName: `释放验证-${requestIndex}`,
        items: [{ productId: product.id, skuId: sku.id, qty: 1, unitPrice: 9.9 }],
      }, actor)
    }
    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const source = await submit()
    const target = await submit()
    const blocker = await submit()
    const manualPurgeBlocked = await submit()
    const o2oPurgeBlocked = await submit()
    const sourceEntity = await orderRepo.findOneByOrFail({ id: String(source.order.id) })
    const targetEntity = await orderRepo.findOneByOrFail({ id: String(target.order.id) })
    const blockerEntity = await orderRepo.findOneByOrFail({ id: String(blocker.order.id) })
    const manualPurgeBlockedEntity = await orderRepo.findOneByOrFail({ id: String(manualPurgeBlocked.order.id) })
    const o2oPurgeBlockedEntity = await orderRepo.findOneByOrFail({ id: String(o2oPurgeBlocked.order.id) })
    const releasedBusinessNo = sourceEntity.businessNo
    const targetOriginalBusinessNo = targetEntity.businessNo

    const blockedPreview = await orderService.previewAmendments({ amendments: [{
      orderId: String(targetEntity.id),
      editVersion: Number(targetEntity.editVersion),
      businessNo: blockerEntity.businessNo,
    }] }, actor)
    assert.equal(blockedPreview.ready, false, '物理存在订单当前业务号必须阻断普通改单')

    blockerEntity.inventoryMode = 'legacy_none'
    await orderRepo.save(blockerEntity)
    await orderService.softDeleteById(String(blockerEntity.id), actor, blockerEntity.businessNo)
    const softDeletedPreview = await orderService.previewAmendments({ amendments: [{
      orderId: String(targetEntity.id),
      editVersion: Number(targetEntity.editVersion),
      businessNo: blockerEntity.businessNo,
    }] }, actor)
    assert.equal(softDeletedPreview.ready, false, '软删除订单仍物理存在，业务号必须继续占用')

    await orderService.softDeleteById(String(manualPurgeBlockedEntity.id), actor, manualPurgeBlockedEntity.businessNo)
    await assert.rejects(
      () => orderService.purgeById(String(manualPurgeBlockedEntity.id), actor, manualPurgeBlockedEntity.businessNo),
      (error: unknown) => error instanceof BizError && error.statusCode === 409 && /库存影响/.test(error.message),
      'manual_applied 库存订单必须继续禁止永久删除',
    )
    o2oPurgeBlockedEntity.inventoryMode = 'legacy_none'
    o2oPurgeBlockedEntity.sourceDocType = 'o2o_preorder'
    o2oPurgeBlockedEntity.sourceDocId = '999999'
    o2oPurgeBlockedEntity.sourceDocNo = 'PRE-W-999999'
    await orderRepo.save(o2oPurgeBlockedEntity)
    await orderService.softDeleteById(String(o2oPurgeBlockedEntity.id), actor, o2oPurgeBlockedEntity.businessNo)
    await assert.rejects(
      () => orderService.purgeById(String(o2oPurgeBlockedEntity.id), actor, o2oPurgeBlockedEntity.businessNo),
      (error: unknown) => error instanceof BizError && error.statusCode === 409 && /O2O 管理入口/.test(error.message),
      'O2O 关联正式单必须拒绝从普通出库入口单删',
    )

    await orderService.commitAmendments({ amendments: [{
      orderId: String(sourceEntity.id),
      editVersion: Number(sourceEntity.editVersion),
      remark: '用于验证 revision 会随永久删除清理',
      reason: '构造永久删除前修订记录',
    }] }, actor)
    sourceEntity.inventoryMode = 'legacy_none'
    await orderRepo.save(sourceEntity)
    await AppDataSource.getRepository(InventoryLog).save({
      productId: String(product.id),
      skuId: String(sku.id),
      changeType: 'issue110_release_fixture',
      changeQty: -1,
      beforeCurrentStock: 1000,
      afterCurrentStock: 999,
      beforePreorderedStock: 0,
      afterPreorderedStock: 0,
      beforeSkuCurrentStock: 1000,
      afterSkuCurrentStock: 999,
      beforeSkuPreorderedStock: 0,
      afterSkuPreorderedStock: 0,
      operatorType: 'admin',
      operatorId: actor.userId,
      operatorName: actor.displayName,
      refType: 'outbound_order',
      refId: String(sourceEntity.id),
      remark: `永久删除 ${sourceEntity.businessNo}`,
    })
    const unrelatedCollisionAudit = await AppDataSource.getRepository(SysAuditLog).save({
      actionType: 'verify.unrelated_o2o',
      actionLabel: '验证同主键异类型审计隔离',
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorDisplayName: actor.displayName,
      targetType: 'o2o_order',
      targetId: String(sourceEntity.id),
      targetCode: 'PRE-W-UNRELATED',
      resultStatus: 'success',
      detailJson: null,
      ipAddress: null,
      userAgent: null,
    })
    await orderService.softDeleteById(String(sourceEntity.id), actor, sourceEntity.businessNo)
    const purgeRequestMeta = {
      ipAddress: '198.51.100.110',
      userAgent: 'order-business-no-release-verify',
      clientRiskBrowserId: null,
      clientRiskSessionId: null,
    }
    await orderService.purgeById(String(sourceEntity.id), actor, sourceEntity.businessNo, purgeRequestMeta)
    assert.equal(await orderRepo.existsBy({ id: String(sourceEntity.id) }), false, '主单必须物理删除')
    assert.equal(await AppDataSource.getRepository(OrderRevision).countBy({ orderUuid: sourceEntity.orderUuid }), 0, 'revision 必须删除')
    const inventoryFact = await AppDataSource.getRepository(InventoryLog).findOneByOrFail({ changeType: 'issue110_release_fixture' })
    assert.equal(inventoryFact.refType, null)
    assert.equal(inventoryFact.refId, null)
    assert.equal(inventoryFact.remark, null)
    assert.equal(inventoryFact.operatorId, null)
    assert.equal(
      await AppDataSource.getRepository(SysAuditLog).existsBy({ id: unrelatedCollisionAudit.id }),
      true,
      '相同 targetId 但不同 targetType 的无关审计必须保留',
    )

    const purgeAudits = await AppDataSource.getRepository(SysAuditLog).findBy({ actionType: 'order.purge' })
    assert.equal(purgeAudits.length, 1, '永久删除后只保留一条最小审计')
    assert.equal(purgeAudits[0]?.targetId, null)
    assert.match(purgeAudits[0]?.targetCode ?? '', /^order:deleted:[0-9a-f-]{36}$/)
    assert.equal(purgeAudits[0]?.ipAddress, purgeRequestMeta.ipAddress, '最小永久删除审计必须保留请求 IP')
    assert.equal(purgeAudits[0]?.userAgent, purgeRequestMeta.userAgent, '最小永久删除审计必须保留 User-Agent')
    assert.deepEqual(
      JSON.parse(purgeAudits[0]?.detailJson ?? '{}'),
      { redactedTarget: purgeAudits[0]?.targetCode },
      '永久删除审计详情只能保留随机脱敏目标',
    )
    assert.doesNotMatch(purgeAudits[0]?.detailJson ?? '', new RegExp(releasedBusinessNo, 'i'))
    assert.doesNotMatch(purgeAudits[0]?.detailJson ?? '', new RegExp(sourceEntity.systemNo, 'i'))
    assert.doesNotMatch(purgeAudits[0]?.detailJson ?? '', new RegExp(sourceEntity.orderUuid, 'i'))
    const randomTargetA = buildRedactedDeleteTarget('order')
    const randomTargetB = buildRedactedDeleteTarget('order')
    assert.notEqual(randomTargetA, randomTargetB, '删除审计目标必须使用不可预测随机值，禁止由稳定主键推导')

    const reusePreview = await orderService.previewAmendments({ amendments: [{
      orderId: String(targetEntity.id),
      editVersion: Number(targetEntity.editVersion),
      businessNo: releasedBusinessNo,
    }] }, actor)
    assert.equal(reusePreview.ready, true, '物理删除后普通改单应立即允许复用')
    assert.equal(await orderRepo.findOneByOrFail({ id: String(targetEntity.id) }).then((row) => row.businessNo), targetOriginalBusinessNo, '预览必须无副作用')
    await orderService.commitAmendments({ amendments: [{
      orderId: String(targetEntity.id), editVersion: Number(targetEntity.editVersion), businessNo: releasedBusinessNo, reason: '复用已释放业务号',
    }] }, actor)
    const afterFirstReuse = await orderRepo.findOneByOrFail({ id: String(targetEntity.id) })
    await orderService.commitAmendments({ amendments: [{
      orderId: String(afterFirstReuse.id), editVersion: Number(afterFirstReuse.editVersion), businessNo: targetOriginalBusinessNo, reason: '切回原业务号',
    }] }, actor)
    const afterSwitchBack = await orderRepo.findOneByOrFail({ id: String(targetEntity.id) })
    await orderService.commitAmendments({ amendments: [{
      orderId: String(afterSwitchBack.id), editVersion: Number(afterSwitchBack.editVersion), businessNo: releasedBusinessNo, reason: '再次复用已释放业务号',
    }] }, actor)
    assert.equal((await orderRepo.findOneByOrFail({ id: String(targetEntity.id) })).businessNo, releasedBusinessNo, '必须支持 A→B→A 反复改单')

    const concurrentSource = await submit()
    const concurrentA = await submit()
    const concurrentB = await submit()
    const concurrentSourceEntity = await orderRepo.findOneByOrFail({ id: String(concurrentSource.order.id) })
    const concurrentAEntity = await orderRepo.findOneByOrFail({ id: String(concurrentA.order.id) })
    const concurrentBEntity = await orderRepo.findOneByOrFail({ id: String(concurrentB.order.id) })
    concurrentSourceEntity.inventoryMode = 'legacy_none'
    await orderRepo.save(concurrentSourceEntity)
    await orderService.softDeleteById(String(concurrentSourceEntity.id), actor, concurrentSourceEntity.businessNo)
    await orderService.purgeById(String(concurrentSourceEntity.id), actor, concurrentSourceEntity.businessNo)
    const concurrentResults = await Promise.allSettled([
      orderService.commitAmendments({ amendments: [{
        orderId: String(concurrentAEntity.id), editVersion: Number(concurrentAEntity.editVersion), businessNo: concurrentSourceEntity.businessNo, reason: '并发复用 A',
      }] }, actor),
      orderService.commitAmendments({ amendments: [{
        orderId: String(concurrentBEntity.id), editVersion: Number(concurrentBEntity.editVersion), businessNo: concurrentSourceEntity.businessNo, reason: '并发复用 B',
      }] }, actor),
    ])
    assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1, '同号并发只能成功一笔')
    const concurrentFailure = concurrentResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    assert.ok(concurrentFailure?.reason instanceof BizError && concurrentFailure.reason.statusCode === 409, '同号并发失败方必须返回 409')

    const atomicTarget = await submit()
    const atomicTargetEntity = await orderRepo.findOneByOrFail({ id: String(atomicTarget.order.id) })
    await assert.rejects(
      () => orderService.commitAmendments({ amendments: [
        { orderId: String(atomicTargetEntity.id), editVersion: Number(atomicTargetEntity.editVersion), businessNo: 'hyyz900001', reason: '批量合法项' },
        { orderId: String(concurrentBEntity.id), editVersion: Number(concurrentBEntity.editVersion), businessNo: releasedBusinessNo, reason: '批量冲突项' },
      ] }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '批量任一冲突必须整体返回 409',
    )
    assert.equal((await orderRepo.findOneByOrFail({ id: String(atomicTargetEntity.id) })).businessNo, atomicTargetEntity.businessNo, '批量失败不得部分写入')

    const sequenceBeforeNext = await AppDataSource.getRepository(BusinessSequence).findOneByOrFail({ sequenceKey: 'order.business.walkin' })
    const next = await submit()
    const nextEntity = await orderRepo.findOneByOrFail({ id: String(next.order.id) })
    assert.ok(Number(nextEntity.businessNo.slice(4)) > Number(releasedBusinessNo.slice(4)), '自动开单不得回填已释放低号')
    assert.ok(Number(nextEntity.businessNo.slice(4)) > Number(sequenceBeforeNext.currentValue), '自动开单必须使用高水位 + 1')

    const tableRows = await AppDataSource.query("SELECT name FROM sqlite_master WHERE type = 'table'") as Array<{ name: string }>
    const tableNames = new Set(tableRows.map((row) => row.name))
    assert.equal(tableNames.has('order_business_no_occupancy'), false)
    assert.equal(tableNames.has('order_business_no_reuse_event'), false)

    const routeSource = fs.readFileSync(path.resolve(backendRoot, 'src/routes/order.routes.ts'), 'utf8')
    assert.doesNotMatch(routeSource, /reclaim-business-no/)
    const migration056 = fs.readFileSync(path.resolve(backendRoot, 'sql/056_disable_order_business_no_permanent_occupancy.sql'), 'utf8')
    assert.match(migration056, /DROP TABLE IF EXISTS `order_business_no_reuse_event`/)
    assert.match(migration056, /DROP TABLE IF EXISTS `order_business_no_occupancy`/)
    const migration055 = fs.readFileSync(path.resolve(backendRoot, 'sql/055_order_identifier_namespaces.sql'), 'utf8')
    assert.doesNotMatch(migration055, /order_business_no_occupancy/)
    const migrationRunner = fs.readFileSync(path.resolve(backendRoot, 'src/config/mysql-migration-runner.ts'), 'utf8')
    assert.match(migrationRunner, /056_disable_order_business_no_permanent_occupancy\.sql/)
    assert.match(migrationRunner, /MYSQL_FORBIDDEN_TABLES[\s\S]*order_business_no_occupancy[\s\S]*order_business_no_reuse_event/)
    const dataSource = fs.readFileSync(path.resolve(backendRoot, 'src/config/data-source.ts'), 'utf8')
    assert.doesNotMatch(dataSource, /OrderBusinessNoOccupancy|OrderBusinessNoReuseEvent/)
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanup()
  }
}

main().then(() => {
  console.log('订单业务号释放专项验证通过')
}).catch((error) => {
  console.error(error)
  cleanup()
  process.exitCode = 1
})
