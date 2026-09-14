/**
 * 模块说明：Issue #71 出库单合并治理专项验证。
 * 文件职责：在隔离 SQLite 中验证合并预览、原子提交、幂等、追溯、树查询与 O2O 联动契约。
 * 实现逻辑：先验证必需模块存在，再以真实 TypeORM 实体和服务执行端到端数据一致性断言。
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'

const servicePath = path.resolve(process.cwd(), 'src', 'services', 'order-merge.service.ts')
const migrationPath = path.resolve(process.cwd(), 'sql', '045_order_merge_governance.sql')

assert.equal(fs.existsSync(servicePath), true, '缺少订单合并服务')
assert.equal(fs.existsSync(migrationPath), true, '缺少 045_order_merge_governance.sql')

const migrationSource = fs.readFileSync(migrationPath, 'utf8')
for (const requiredToken of [
  'order_merge_operation',
  'order_merge_relation',
  'source_order_id',
  'source_order_item_id',
  'request_hash',
  'status',
]) {
  assert.match(migrationSource, new RegExp(requiredToken), `045 迁移缺少 ${requiredToken}`)
}

const serviceSource = fs.readFileSync(servicePath, 'utf8')
for (const [pattern, message] of [
  [/MAX_TRANSACTION_ATTEMPTS\s*=\s*3/, 'MySQL 合并事务必须保留三次尝试上限'],
  [/setLock\('pessimistic_write'\)/, 'MySQL 合并事务必须使用悲观写锁'],
  [/isRetryableMysqlTransactionError/, 'MySQL 合并事务必须识别可重试死锁'],
  [/orderBy\('order\.id',\s*'ASC'\)/, '参与订单必须按稳定顺序加锁'],
  [/addOrderBy\('item\.id',\s*'ASC'\)/, '参与明细必须按稳定顺序加锁'],
] as const) {
  assert.match(serviceSource, pattern, message)
}

const routeSource = fs.readFileSync(path.resolve(process.cwd(), 'src', 'routes', 'order.routes.ts'), 'utf8')
assert.match(routeSource, /\/merges\/preview[\s\S]*orders:merge/, '合并预览必须使用 orders:merge 权限')
assert.match(routeSource, /\/merges['"][\s\S]*orders:merge/, '合并提交必须使用 orders:merge 权限')

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqliteRoot = path.resolve(process.cwd(), 'data', 'local-dev')
const sqlitePath = path.resolve(sqliteRoot, `order-merge-${verifySeed}.sqlite`)
process.env.APP_PROFILE = `order-merge-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath

const actor: AuthUserContext = {
  userId: '71001',
  username: 'issue71-verifier',
  displayName: 'Issue71验证员',
  role: 'admin',
  permissions: ['orders:create', 'orders:view', 'orders:update', 'orders:edit', 'orders:delete', 'orders:merge'],
  status: 'enabled',
  sessionToken: 'issue71-session',
  authSource: 'bearer',
}

interface MergeInput {
  target: { orderId: string; editVersion: number }
  sources: Array<{ orderId: string; editVersion: number }>
  reason: string
}

const requestJson = (
  port: number,
  pathname: string,
  body: Record<string, unknown>,
  bearerToken?: string,
) => new Promise<{ status: number; payload: Record<string, unknown> }>((resolve, reject) => {
  const serialized = JSON.stringify(body)
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path: pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(serialized),
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
  }, (response) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => chunks.push(chunk))
    response.on('end', () => {
      const responseText = Buffer.concat(chunks).toString('utf8')
      resolve({
        status: response.statusCode ?? 0,
        payload: responseText ? JSON.parse(responseText) as Record<string, unknown> : {},
      })
    })
  })
  request.once('error', reject)
  request.write(serialized)
  request.end()
})

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  let httpServer: Server | undefined
  const [
    { AppDataSource },
    { BaseProduct },
    { BaseProductSku },
    { BizOutboundOrder },
    { BizOutboundOrderItem },
    { InventoryLog },
    { OrderRevision },
    { OrderMergeOperation },
    { OrderMergeRelation },
    { SysAuditLog },
    { SysUser },
    { SysUserSession },
    { orderMergeService },
    { orderService },
    { reportService },
    { dashboardService },
    { BizError },
    { hashSessionToken },
    { createApp },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/biz-outbound-order-item.entity.js'),
    import('../src/entities/inventory-log.entity.js'),
    import('../src/entities/order-revision.entity.js'),
    import('../src/entities/order-merge-operation.entity.js'),
    import('../src/entities/order-merge-relation.entity.js'),
    import('../src/entities/sys-audit-log.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/entities/sys-user-session.entity.js'),
    import('../src/services/order-merge.service.js'),
    import('../src/services/order.service.js'),
    import('../src/services/report.service.js'),
    import('../src/services/dashboard.service.js'),
    import('../src/utils/errors.js'),
    import('../src/utils/session-token.js'),
    import('../src/app.js'),
  ])

  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    const sysUserRepo = AppDataSource.getRepository(SysUser)
    const persistedActor = await sysUserRepo.save(sysUserRepo.create({
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
    }))
    actor.userId = String(persistedActor.id)

    const productRepo = AppDataSource.getRepository(BaseProduct)
    const skuRepo = AppDataSource.getRepository(BaseProductSku)
    const product = await productRepo.save(productRepo.create({
      productCode: `ISSUE71-${verifySeed}`,
      productName: 'Issue71验证商品',
      pinyinAbbr: 'ISSUE',
      defaultPrice: '10.00',
      currentStock: 1000,
      preOrderedStock: 0,
      isActive: true,
    }))
    const sku = await skuRepo.save(skuRepo.create({
      productId: product.id,
      skuCode: `ISSUE71-SKU-${verifySeed}`,
      specValuesJson: '{}',
      specText: '默认规格',
      defaultPrice: '10.00',
      discountRate: '10.0',
      currentStock: 1000,
      preOrderedStock: 0,
      isActive: true,
      isCurrent: true,
      o2oRecommended: false,
      thumbnail: null,
      sortOrder: 0,
    }))

    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const itemRepo = AppDataSource.getRepository(BizOutboundOrderItem)
    let sequence = 100
    const createOrder = async (label: string, qty: number, unitPrice = 10) => {
      sequence += 1
      const order = await orderRepo.save(orderRepo.create({
        orderUuid: randomUUID(),
        showNo: `ISSUE71-${sequence}`,
        businessNo: `hyyz${String(sequence).padStart(6, '0')}`,
        editVersion: 1,
        status: 'active',
        inventoryMode: 'manual_applied',
        orderType: 'walkin',
        hasCustomerOrder: false,
        isSystemApplied: false,
        issuerName: 'Issue71验证员',
        customerDepartmentName: null,
        idempotencyKey: `issue71-${label}-${verifySeed}`,
        customerName: '同一散客',
        remark: label,
        totalQty: qty.toFixed(2),
        totalAmount: (qty * unitPrice).toFixed(2),
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        deletedByUsername: null,
        deletedByDisplayName: null,
        creatorUserId: actor.userId,
        creatorUsername: actor.username,
        creatorDisplayName: actor.displayName,
      }))
      const item = await itemRepo.save(itemRepo.create({
        orderId: order.id,
        lineNo: 1,
        productId: product.id,
        productNameSnapshot: `${product.productName}-${label}`,
        skuId: sku.id,
        skuCodeSnapshot: sku.skuCode,
        specTextSnapshot: sku.specText,
        qty: qty.toFixed(2),
        unitPrice: unitPrice.toFixed(2),
        lineAmount: (qty * unitPrice).toFixed(2),
        remark: label,
        sourceOrderId: null,
        sourceOrderUuid: null,
        sourceOrderItemId: null,
      }))
      return { order, item }
    }

    const target = await createOrder('target', 10)
    const source = await createOrder('source', 3)
    const source2 = await createOrder('source-2', 2)
    await orderRepo.update({ id: source.order.id }, { totalQty: '999.00', totalAmount: '999.00' })
    const mergeInput: MergeInput = {
      target: { orderId: String(target.order.id), editVersion: 1 },
      sources: [{ orderId: String(source.order.id), editVersion: 1 }],
      reason: '专项验证首次合并',
    }

    const beforeCounts = {
      operations: await AppDataSource.getRepository(OrderMergeOperation).count(),
      relations: await AppDataSource.getRepository(OrderMergeRelation).count(),
      items: await itemRepo.count(),
      revisions: await AppDataSource.getRepository(OrderRevision).count(),
      audits: await AppDataSource.getRepository(SysAuditLog).count(),
      inventoryLogs: await AppDataSource.getRepository(InventoryLog).count(),
    }
    const preview = await orderMergeService.preview(mergeInput, actor)
    assert.equal(preview.ready, true)
    assert.equal(preview.blockers.length, 0)
    assert.equal(preview.beforeTotals.totalQty, '10.00')
    assert.equal(preview.afterTotals.totalQty, '13.00')
    assert.equal(preview.inventoryImpact.movementDelta, 0)
    assert.equal(preview.mergedItems[0]?.sourceOrderItemId, String(source.item.id))
    assert.deepEqual({
      operations: await AppDataSource.getRepository(OrderMergeOperation).count(),
      relations: await AppDataSource.getRepository(OrderMergeRelation).count(),
      items: await itemRepo.count(),
      revisions: await AppDataSource.getRepository(OrderRevision).count(),
      audits: await AppDataSource.getRepository(SysAuditLog).count(),
      inventoryLogs: await AppDataSource.getRepository(InventoryLog).count(),
    }, beforeCounts, '预览不得产生任何数据库副作用')

    const productStockBefore = Number((await productRepo.findOneByOrFail({ id: product.id })).currentStock)
    const skuStockBefore = Number((await skuRepo.findOneByOrFail({ id: sku.id })).currentStock)
    const commitInput = { ...mergeInput, idempotencyKey: `issue71-merge-${verifySeed}` }
    const committed = await orderService.commitMerge(commitInput, actor, { ipAddress: '127.0.0.1', userAgent: 'issue71-verifier' })
    assert.equal(committed.idempotentReplay, false)
    assert.equal(committed.targetOrderId, String(target.order.id))
    assert.deepEqual(committed.mergedSourceOrderIds, [String(source.order.id)])

    const targetAfter = await orderRepo.findOneByOrFail({ id: target.order.id })
    const sourceAfter = await orderRepo.findOneByOrFail({ id: source.order.id })
    assert.equal(targetAfter.status, 'active')
    assert.equal(sourceAfter.status, 'merged')
    assert.equal(targetAfter.editVersion, 2)
    assert.equal(sourceAfter.editVersion, 2)
    assert.equal(Number(targetAfter.totalQty), 13)
    assert.equal(Number(targetAfter.totalAmount), 130)
    const targetItems = await itemRepo.find({ where: { orderId: target.order.id }, order: { lineNo: 'ASC' } })
    assert.equal(targetItems.length, 2)
    assert.equal(String(targetItems[1]?.sourceOrderId), String(source.order.id))
    assert.equal(targetItems[1]?.sourceOrderUuid, source.order.orderUuid)
    assert.equal(String(targetItems[1]?.sourceOrderItemId), String(source.item.id))
    assert.equal(await AppDataSource.getRepository(OrderMergeRelation).count(), 1)
    assert.equal(await AppDataSource.getRepository(OrderMergeOperation).count(), 1)
    assert.equal(await AppDataSource.getRepository(OrderRevision).count(), 2, '目标和来源必须分别写 revision')
    assert.equal(await AppDataSource.getRepository(SysAuditLog).count({ where: { actionType: 'order.merge' } }), 1)
    assert.equal(await AppDataSource.getRepository(InventoryLog).count(), beforeCounts.inventoryLogs, '合并不得新增库存流水')
    assert.equal(Number((await productRepo.findOneByOrFail({ id: product.id })).currentStock), productStockBefore)
    assert.equal(Number((await skuRepo.findOneByOrFail({ id: sku.id })).currentStock), skuStockBefore)

    const relationRepo = AppDataSource.getRepository(OrderMergeRelation)
    await assert.rejects(
      () => relationRepo.insert(relationRepo.create({
        operationId: committed.operationId,
        parentOrderId: String(target.order.id),
        parentOrderUuid: target.order.orderUuid,
        parentBusinessNoSnapshot: target.order.businessNo,
        sourceOrderId: String(target.order.id),
        sourceOrderUuid: target.order.orderUuid,
        sourceBusinessNoSnapshot: target.order.businessNo,
      })),
      /CHECK constraint failed/i,
      '父单与来源单相同必须由数据库 CHECK 拒绝',
    )
    await assert.rejects(
      () => relationRepo.insert(relationRepo.create({
        operationId: committed.operationId,
        parentOrderId: String(source2.order.id),
        parentOrderUuid: source2.order.orderUuid,
        parentBusinessNoSnapshot: source2.order.businessNo,
        sourceOrderId: String(source.order.id),
        sourceOrderUuid: source.order.orderUuid,
        sourceBusinessNoSnapshot: source.order.businessNo,
      })),
      /UNIQUE constraint failed/i,
      '同一来源单只能出现于一条父子关系',
    )
    await assert.rejects(
      () => orderRepo.delete({ id: target.order.id }),
      /FOREIGN KEY constraint failed/i,
      '任意合并成员必须受 RESTRICT 外键保护',
    )

    const replay = await orderService.commitMerge(commitInput, actor)
    assert.equal(replay.idempotentReplay, true)
    assert.deepEqual(replay.detail, committed.detail, '首次重放必须返回提交时持久化的详情快照')
    assert.equal(await AppDataSource.getRepository(OrderMergeOperation).count(), 1)
    assert.equal((await itemRepo.find({ where: { orderId: target.order.id } })).length, 2, '幂等重放不得重复复制明细')
    await assert.rejects(
      () => orderService.commitMerge({
        ...commitInput,
        sources: [{ orderId: String(source2.order.id), editVersion: 1 }],
      }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '同幂等键不同请求必须返回 409',
    )

    const stalePreview = await orderMergeService.preview({
      target: { orderId: String(target.order.id), editVersion: 1 },
      sources: [{ orderId: String(source2.order.id), editVersion: 99 }],
      reason: '专项验证过期版本',
    }, actor)
    assert.equal(stalePreview.ready, false)
    assert.match(stalePreview.blockers.map((item) => item.code).join(','), /ORDER_VERSION_CONFLICT/)

    const originalDetailById = orderService.detailById.bind(orderService)
    orderService.detailById = async (orderId, manager) => {
      assert.equal(
        manager?.queryRunner?.isTransactionActive,
        true,
        '提交响应详情必须在合并事务提交前构造，禁止事务外二次读取',
      )
      return originalDetailById(orderId, manager)
    }
    let appended
    try {
      appended = await orderService.commitMerge({
        target: { orderId: String(target.order.id), editVersion: 2 },
        sources: [{ orderId: String(source2.order.id), editVersion: 1 }],
        reason: '专项验证继续追加',
        idempotencyKey: `issue71-append-${verifySeed}`,
      }, actor)
    } finally {
      orderService.detailById = originalDetailById
    }
    assert.equal(appended.targetEditVersion, 3)
    assert.equal(await AppDataSource.getRepository(OrderMergeRelation).count(), 2)
    assert.equal(Number((await orderRepo.findOneByOrFail({ id: target.order.id })).totalQty), 15)
    const replayAfterAppend = await orderService.commitMerge(commitInput, actor)
    assert.equal(replayAfterAppend.idempotentReplay, true)
    assert.deepEqual(
      replayAfterAppend.detail,
      committed.detail,
      '父单继续追加后，旧幂等键必须完整重放首次提交时的历史详情快照',
    )
    orderService.detailById = async () => {
      throw new Error('issue71 simulated post-commit detail query failure')
    }
    try {
      const replayDuringDetailFailure = await orderService.commitMerge(commitInput, actor)
      assert.deepEqual(
        replayDuringDetailFailure.detail,
        committed.detail,
        '事务提交后的详情查询故障不得把已成功合并伪装成失败',
      )
    } finally {
      orderService.detailById = originalDetailById
    }
    await assert.rejects(
      () => orderService.commitMerge({
        target: { orderId: String(source.order.id), editVersion: 2 },
        sources: [{ orderId: String(target.order.id), editVersion: 3 }],
        reason: '专项验证交叉合并阻断',
        idempotencyKey: `issue71-cross-${verifySeed}`,
      }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
    )

    assert.equal(orderService.describeContentEditability(sourceAfter).contentEditable, false)
    const amendmentPreview = await orderService.previewAmendments({ amendments: [{
      orderId: String(source.order.id),
      editVersion: 2,
      remark: '来源单禁止修订',
    }] }, actor)
    assert.equal(amendmentPreview.ready, false)
    assert.match(amendmentPreview.items[0]?.blockingReasons.join('；') ?? '', /合并来源/)
    const parentBusinessNoPreview = await orderService.previewAmendments({ amendments: [{
      orderId: String(target.order.id),
      editVersion: 3,
      businessNo: 'hyyz999999',
      reason: '父单业务号属于结构字段，禁止修改',
    }] }, actor)
    assert.equal(parentBusinessNoPreview.ready, false)
    assert.match(parentBusinessNoPreview.items[0]?.blockingReasons.join('；') ?? '', /合并目标父单/)
    await assert.rejects(
      () => orderService.softDeleteById(String(source.order.id), actor, source.order.showNo),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
    )

    const deletedParent = await orderService.softDeleteById(String(target.order.id), actor, target.order.showNo)
    assert.equal(deletedParent.merge.role, 'parent', '父单软删响应必须保留合并角色')
    assert.equal(deletedParent.merge.children.length, 2, '父单软删响应必须保留完整子树')
    const restoredParent = await orderService.restoreById(String(target.order.id), actor)
    assert.equal(restoredParent.merge.role, 'parent', '父单恢复响应必须保留合并角色')
    assert.equal(restoredParent.merge.children.length, 2, '父单恢复响应必须保留完整子树')
    await assert.rejects(
      () => orderService.purgeById(String(target.order.id), actor, target.order.showNo),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '任意合并成员必须阻断永久删除',
    )

    await orderRepo.update({ id: source.order.id }, { status: 'active' })
    const rootList = await orderService.list({ page: 1, pageSize: 100 })
    assert.equal(rootList.total, 1, '来源单不得占根分页 total')
    assert.equal(rootList.list[0]?.merge.role, 'parent')
    assert.equal(rootList.list[0]?.merge.children.length, 2)
    await orderRepo.update({ id: source.order.id }, { status: 'merged' })
    const childSearch = await orderService.list({ page: 1, pageSize: 20, keyword: source2.order.businessNo })
    assert.equal(childSearch.total, 1, '命中来源单时必须返回父单且不重复分页')
    assert.equal(childSearch.list[0]?.id, String(target.order.id))
    assert.equal(childSearch.list[0]?.merge.children.length, 2, '子搜索必须带完整子树')
    const childShowNoExactSearch = await orderService.list({ page: 1, pageSize: 20, showNo: source2.order.showNo })
    assert.equal(childShowNoExactSearch.total, 1, 'showNo 精确命中来源单时必须返回父单')
    assert.equal(childShowNoExactSearch.list[0]?.id, String(target.order.id))
    assert.equal(childShowNoExactSearch.list[0]?.merge.children.length, 2)
    const childShowNoPartialSearch = await orderService.list({
      page: 1,
      pageSize: 20,
      showNo: source2.order.showNo.slice(-2),
    })
    assert.equal(childShowNoPartialSearch.total, 1, 'showNo 模糊命中来源单时必须返回父单且不重复 total')
    assert.equal(childShowNoPartialSearch.list[0]?.id, String(target.order.id))
    await orderRepo.update({ id: source2.order.id }, { createdAt: new Date('2020-02-03T08:00:00.000Z') })
    const childDateSearch = await orderService.list({
      page: 1,
      pageSize: 20,
      startDate: '2020-02-03',
      endDate: '2020-02-03',
    })
    assert.equal(childDateSearch.total, 1, '日期范围命中来源单时必须返回父单')
    assert.equal(childDateSearch.list[0]?.id, String(target.order.id))
    assert.equal(childDateSearch.list[0]?.merge.children.length, 2, '子日期命中必须带完整子树')
    const childDetail = await orderService.detailById(String(source.order.id))
    assert.equal(childDetail.order.merge.role, 'source')
    assert.equal(childDetail.order.merge.parent?.id, String(target.order.id))
    assert.equal(childDetail.items[0]?.sourceOrderId, null, '来源原明细保持原样')

    const dashboardStats = await dashboardService.getStats()
    assert.equal(dashboardStats.todayOrderCount, 1, 'Dashboard 必须只统计 active 父单')
    const outboundFlow = await reportService.query('outbound-flow', { page: 1, pageSize: 100 })
    assert.equal(outboundFlow.total, 1, '出库流水必须过滤 merged 来源单')
    assert.equal(outboundFlow.list[0]?.businessNo, target.order.businessNo)
    const walkinReport = await reportService.query('walkin', { page: 1, pageSize: 100 })
    assert.equal(walkinReport.total, 3, '明细报表应统计父单汇总后的三行，不重复统计来源原行')

    const maxQtyTarget = await createOrder('max-qty-target', 1, 1)
    const maxQtySource = await createOrder('max-qty-source', 1, 1)
    await itemRepo.update({ id: maxQtyTarget.item.id }, { qty: '9999999998.99', lineAmount: '1.00' })
    await orderRepo.update({ id: maxQtyTarget.order.id }, { totalQty: '9999999998.99', totalAmount: '1.00' })
    const maxQtyPreview = await orderMergeService.preview({
      target: { orderId: String(maxQtyTarget.order.id), editVersion: 1 },
      sources: [{ orderId: String(maxQtySource.order.id), editVersion: 1 }],
      reason: '数量精度合法上界验证',
    }, actor)
    assert.equal(maxQtyPreview.ready, true)
    assert.equal(maxQtyPreview.afterTotals.totalQty, '9999999999.99')

    const overflowQtyTarget = await createOrder('overflow-qty-target', 1, 1)
    const overflowQtySource = await createOrder('overflow-qty-source', 0.01, 1)
    await itemRepo.update({ id: overflowQtyTarget.item.id }, { qty: '9999999999.99', lineAmount: '1.00' })
    await orderRepo.update({ id: overflowQtyTarget.order.id }, { totalQty: '9999999999.99', totalAmount: '1.00' })
    const overflowQtyInput = {
      target: { orderId: String(overflowQtyTarget.order.id), editVersion: 1 },
      sources: [{ orderId: String(overflowQtySource.order.id), editVersion: 1 }],
      reason: '数量精度溢出验证',
    }
    const overflowQtyPreview = await orderMergeService.preview(overflowQtyInput, actor)
    assert.equal(overflowQtyPreview.ready, false)
    assert.match(overflowQtyPreview.blockers.map((item) => item.code).join(','), /TOTAL_QTY_OVERFLOW/)
    await assert.rejects(
      () => orderService.commitMerge({
        ...overflowQtyInput,
        idempotencyKey: `issue71-overflow-qty-${verifySeed}`,
      }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '锁内提交必须再次拒绝 decimal(12,2) 数量溢出',
    )

    const maxAmountTarget = await createOrder('max-amount-target', 1, 1)
    const maxAmountSource = await createOrder('max-amount-source', 1, 1)
    await itemRepo.update({ id: maxAmountTarget.item.id }, { lineAmount: '999999999998.99' })
    await orderRepo.update({ id: maxAmountTarget.order.id }, { totalAmount: '999999999998.99' })
    const maxAmountPreview = await orderMergeService.preview({
      target: { orderId: String(maxAmountTarget.order.id), editVersion: 1 },
      sources: [{ orderId: String(maxAmountSource.order.id), editVersion: 1 }],
      reason: '金额精度合法上界验证',
    }, actor)
    assert.equal(maxAmountPreview.ready, true)
    assert.equal(maxAmountPreview.afterTotals.totalAmount, '999999999999.99')

    const overflowAmountTarget = await createOrder('overflow-amount-target', 1, 1)
    const overflowAmountSource = await createOrder('overflow-amount-source', 1, 1)
    await itemRepo.update({ id: overflowAmountTarget.item.id }, { lineAmount: '999999999999.99' })
    await itemRepo.update({ id: overflowAmountSource.item.id }, { lineAmount: '0.01' })
    await orderRepo.update({ id: overflowAmountTarget.order.id }, { totalAmount: '999999999999.99' })
    const overflowAmountPreview = await orderMergeService.preview({
      target: { orderId: String(overflowAmountTarget.order.id), editVersion: 1 },
      sources: [{ orderId: String(overflowAmountSource.order.id), editVersion: 1 }],
      reason: '金额精度溢出验证',
    }, actor)
    assert.equal(overflowAmountPreview.ready, false)
    assert.match(overflowAmountPreview.blockers.map((item) => item.code).join(','), /TOTAL_AMOUNT_OVERFLOW/)

    const invalidScaleTarget = await createOrder('invalid-scale-target', 1, 1)
    const invalidScaleSource = await createOrder('invalid-scale-source', 1, 1)
    await itemRepo.update({ id: invalidScaleSource.item.id }, { qty: '1.001' })
    const invalidScalePreview = await orderMergeService.preview({
      target: { orderId: String(invalidScaleTarget.order.id), editVersion: 1 },
      sources: [{ orderId: String(invalidScaleSource.order.id), editVersion: 1 }],
      reason: '小数位数非法验证',
    }, actor)
    assert.equal(invalidScalePreview.ready, false)
    assert.match(invalidScalePreview.blockers.map((item) => item.code).join(','), /DECIMAL_SCALE_INVALID/)

    const rollbackTarget = await createOrder('rollback-target', 4)
    const rollbackSource = await createOrder('rollback-source', 1)
    const failedAuditCountBeforeRollback = await AppDataSource.getRepository(SysAuditLog).count({
      where: { actionType: 'order.merge_failed' },
    })
    assert.match(String(rollbackSource.order.id), /^\d+$/, 'SQLite 测试主键应为数字')
    await AppDataSource.query(`
      CREATE TRIGGER "issue71_force_relation_failure"
      BEFORE INSERT ON "order_merge_relation"
      WHEN NEW."source_order_id" = ${Number(rollbackSource.order.id)}
      BEGIN
        SELECT RAISE(ABORT, 'issue71 forced rollback');
      END
    `)
    await assert.rejects(() => orderService.commitMerge({
      target: { orderId: String(rollbackTarget.order.id), editVersion: 1 },
      sources: [{ orderId: String(rollbackSource.order.id), editVersion: 1 }],
      reason: '专项验证事务失败整体回滚',
      idempotencyKey: `issue71-rollback-${verifySeed}`,
    }, actor))
    await AppDataSource.query('DROP TRIGGER "issue71_force_relation_failure"')
    assert.equal((await orderRepo.findOneByOrFail({ id: rollbackTarget.order.id })).editVersion, 1)
    assert.equal(Number((await orderRepo.findOneByOrFail({ id: rollbackTarget.order.id })).totalQty), 4)
    assert.equal((await orderRepo.findOneByOrFail({ id: rollbackSource.order.id })).status, 'active')
    assert.equal((await itemRepo.find({ where: { orderId: rollbackTarget.order.id } })).length, 1)
    assert.equal(await AppDataSource.getRepository(OrderMergeOperation).count({
      where: { idempotencyKey: `issue71-rollback-${verifySeed}` },
    }), 0)
    assert.equal(
      await AppDataSource.getRepository(SysAuditLog).count({ where: { actionType: 'order.merge_failed' } }),
      failedAuditCountBeforeRollback + 1,
    )
    const failedAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
      where: { actionType: 'order.merge_failed' },
      order: { id: 'DESC' },
    })
    assert.doesNotMatch(failedAudit.detailJson ?? '', /issue71 forced rollback/i, '失败审计不得写入底层数据库错误原文')
    assert.match(failedAudit.detailJson ?? '', /订单合并失败/, '内部失败审计应使用脱敏通用文案')

    const httpTarget = await createOrder('http-target', 2)
    const httpSource = await createOrder('http-source', 1)
    const httpPayload = {
      target: { orderId: String(httpTarget.order.id), editVersion: 1 },
      sources: [{ orderId: String(httpSource.order.id), editVersion: 1 }],
      reason: 'HTTP 契约验证',
    }
    const operator = await sysUserRepo.save(sysUserRepo.create({
      username: `issue71-operator-${verifySeed}`,
      passwordHash: 'test-only-password-hash',
      displayName: 'Issue71操作员',
      email: null,
      role: 'operator',
      status: 'enabled',
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
    }))
    const adminToken = `issue71-admin-http-${verifySeed}`
    const operatorToken = `issue71-operator-http-${verifySeed}`
    const sessionRepo = AppDataSource.getRepository(SysUserSession)
    await sessionRepo.save([
      sessionRepo.create({
        userId: persistedActor.id,
        sessionToken: hashSessionToken(adminToken),
        expiresAt: new Date(Date.now() + 60_000),
        lastAccessAt: new Date(),
      }),
      sessionRepo.create({
        userId: operator.id,
        sessionToken: hashSessionToken(operatorToken),
        expiresAt: new Date(Date.now() + 60_000),
        lastAccessAt: new Date(),
      }),
    ])
    httpServer = createApp().listen(0, '127.0.0.1')
    if (!httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.once('listening', resolve)
        httpServer!.once('error', reject)
      })
    }
    const address = httpServer.address()
    assert.ok(address && typeof address === 'object')
    assert.equal((await requestJson(address.port, '/api/orders/merges/preview', httpPayload)).status, 401)
    assert.equal((await requestJson(address.port, '/api/orders/merges/preview', httpPayload, operatorToken)).status, 403)
    assert.equal((await requestJson(address.port, '/api/orders/merges/preview', { ...httpPayload, reason: '' }, adminToken)).status, 400)
    assert.equal((await requestJson(address.port, '/api/orders/merges/preview', httpPayload, adminToken)).status, 200)
    assert.equal((await requestJson(address.port, '/api/orders/merges', {
      ...httpPayload,
      target: { ...httpPayload.target, editVersion: 99 },
      idempotencyKey: `issue71-http-conflict-${verifySeed}`,
    }, adminToken)).status, 409)
    assert.equal((await requestJson(address.port, '/api/orders/merges', {
      ...httpPayload,
      sources: [{ orderId: '999999999', editVersion: 1 }],
      idempotencyKey: `issue71-http-missing-${verifySeed}`,
    }, adminToken)).status, 404)
    await new Promise<void>((resolve, reject) => httpServer!.close((error) => error ? reject(error) : resolve()))
    httpServer = undefined

    console.log('✅ Issue #71 出库单合并治理专项验证通过')
  } finally {
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()))
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    fs.rmSync(sqlitePath, { force: true })
  }
}

main().catch((error) => {
  console.error('❌ Issue #71 出库单合并治理专项验证失败', error)
  process.exitCode = 1
})
