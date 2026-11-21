/**
 * 模块说明：订单普通改单治理专项验证。
 * 文件职责：在隔离 SQLite 中验证改单的版本、字段收敛、账号状态与只读建议等长期保护。
 * 维护边界：业务号释放/永久删除由 order-business-no-release-verify 单独覆盖；本文件不依赖已停用的永久占用模型。
 */

import { resolveIssueVerificationRoot } from './issue-verification-paths.js'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'

const seed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqliteRoot = resolveIssueVerificationRoot(path.resolve(process.cwd(), 'data', 'local-dev'))
const sqlitePath = path.resolve(sqliteRoot, `order-amendment-${seed}.sqlite`)

process.env.APP_PROFILE = `order-amendment-${seed}`
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
    { orderBusinessNoService },
    { systemConfigService },
    { BaseProduct },
    { BaseProductSku },
    { BizOutboundOrder },
    { BusinessSequence },
    { OrderRevision },
    { SysUser },
    { DEFAULT_ROLE_PERMISSIONS },
    { BizError },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/config/database-bootstrap.js'),
    import('../src/services/auth.service.js'),
    import('../src/services/order.service.js'),
    import('../src/services/order-business-no.service.js'),
    import('../src/services/system-config.service.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/business-sequence.entity.js'),
    import('../src/entities/order-revision.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/constants/auth-permissions.js'),
    import('../src/utils/errors.js'),
  ])

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  try {
    await initializeDatabaseSchemaIfNeeded(AppDataSource)
    await systemConfigService.ensureDefaultConfigs()
    const profile = await authService.ensureDefaultAdmin()
    const persistedActor = await AppDataSource.getRepository(SysUser).findOneByOrFail({ username: profile.username })
    const actor: AuthUserContext = {
      userId: String(persistedActor.id),
      username: persistedActor.username,
      displayName: persistedActor.displayName,
      role: 'admin',
      permissions: [...DEFAULT_ROLE_PERMISSIONS.admin],
      status: 'enabled',
      sessionToken: 'order-amendment-verify',
      authSource: 'bearer',
    }

    const product = await AppDataSource.getRepository(BaseProduct).save({
      productCode: `AMEND-${seed}`,
      productName: '普通改单保护验证商品',
      pinyinAbbr: 'AMEND',
      defaultPrice: '9.90',
      currentStock: 1000,
      preOrderedStock: 0,
      isActive: true,
    })
    const sku = await AppDataSource.getRepository(BaseProductSku).save({
      productId: product.id,
      skuCode: `AMEND-SKU-${seed}`,
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

    let submitIndex = 0
    const submit = async (orderType: 'department' | 'walkin') => {
      submitIndex += 1
      return orderService.submit({
        idempotencyKey: `amend-${seed}-${submitIndex}`,
        orderType,
        customerDepartmentName: orderType === 'department' ? `验证部门-${submitIndex}` : undefined,
        customerName: orderType === 'walkin' ? `验证散客-${submitIndex}` : undefined,
        hasCustomerOrder: orderType === 'department',
        isSystemApplied: orderType === 'department',
        items: [{ productId: product.id, skuId: sku.id, qty: 1, unitPrice: 9.9 }],
      }, actor)
    }

    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const revisionRepo = AppDataSource.getRepository(OrderRevision)
    const walkin = await submit('walkin')
    const department = await submit('department')
    const originalWalkin = await orderRepo.findOneByOrFail({ id: String(walkin.order.id) })
    const originalDepartment = await orderRepo.findOneByOrFail({ id: String(department.order.id) })
    const originalWalkinSystemNo = originalWalkin.systemNo
    const originalDepartmentSystemNo = originalDepartment.systemNo

    await assert.rejects(
      () => orderService.commitAmendments({ amendments: [{
        orderId: String(originalWalkin.id),
        editVersion: Number(originalWalkin.editVersion),
        customerName: '空原因不得写入',
        reason: '   ',
      }] }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 400 && /原因/.test(error.message),
      '服务层必须拒绝空白修订原因',
    )
    assert.notEqual((await orderRepo.findOneByOrFail({ id: String(originalWalkin.id) })).customerName, '空原因不得写入')

    const sequenceBeforeSuggestion = await AppDataSource.getRepository(BusinessSequence)
      .findOneByOrFail({ sequenceKey: 'order.business.walkin' })
    const orderCountBeforeSuggestion = await orderRepo.count()
    const suggestion = await orderBusinessNoService.suggestForAmendment('walkin', 2, [], AppDataSource.manager)
    assert.equal(suggestion.businessNos.length, 2)
    assert.equal(
      Number((await AppDataSource.getRepository(BusinessSequence)
        .findOneByOrFail({ sequenceKey: 'order.business.walkin' })).currentValue),
      Number(sequenceBeforeSuggestion.currentValue),
      '业务号建议不得推进高水位',
    )
    assert.equal(await orderRepo.count(), orderCountBeforeSuggestion, '业务号建议不得创建或修改订单')

    const amendment = {
      orderId: String(originalWalkin.id),
      editVersion: Number(originalWalkin.editVersion),
      businessNo: suggestion.businessNos[0],
      customerName: '改单后的散客',
      reason: '验证普通改单保护',
    }
    const beforePreview = await orderRepo.findOneByOrFail({ id: String(originalWalkin.id) })
    const preview = await orderService.previewAmendments({ amendments: [amendment] }, actor)
    assert.equal(preview.ready, true)
    assert.deepEqual(
      await orderRepo.findOneByOrFail({ id: String(originalWalkin.id) }),
      beforePreview,
      '预览不得产生任何订单副作用',
    )
    await orderService.commitAmendments({ amendments: [amendment] }, actor)
    const amendedWalkin = await orderRepo.findOneByOrFail({ id: String(originalWalkin.id) })
    assert.equal(amendedWalkin.businessNo, suggestion.businessNos[0])
    assert.equal(amendedWalkin.customerName, '改单后的散客')
    assert.equal(amendedWalkin.systemNo, originalWalkinSystemNo, '普通改单不得改变 systemNo')
    assert.equal(Number(amendedWalkin.editVersion), Number(originalWalkin.editVersion) + 1)
    assert.equal(await revisionRepo.countBy({ orderUuid: amendedWalkin.orderUuid }), 1)

    await assert.rejects(
      () => orderService.commitAmendments({ amendments: [amendment] }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409 && /editVersion/.test(error.message),
      '陈旧 editVersion 必须返回 409',
    )
    assert.equal((await orderRepo.findOneByOrFail({ id: String(originalWalkin.id) })).editVersion, amendedWalkin.editVersion)

    const switchSuggestion = await orderBusinessNoService.suggestForAmendment(
      'walkin',
      1,
      suggestion.businessNos,
      AppDataSource.manager,
    )
    await orderService.commitAmendments({ amendments: [{
      orderId: String(originalDepartment.id),
      editVersion: Number(originalDepartment.editVersion),
      orderType: 'walkin',
      businessNo: switchSuggestion.businessNos[0],
      customerName: '切换后的散客',
      customerDepartmentName: '必须被清理的部门',
      hasCustomerOrder: true,
      isSystemApplied: true,
      reason: '验证订单类型与字段收敛',
    }] }, actor)
    const switched = await orderRepo.findOneByOrFail({ id: String(originalDepartment.id) })
    assert.equal(switched.orderType, 'walkin')
    assert.equal(switched.customerDepartmentName, null)
    assert.equal(switched.customerName, '切换后的散客')
    assert.equal(Boolean(switched.hasCustomerOrder), false)
    assert.equal(Boolean(switched.isSystemApplied), false)
    assert.equal(switched.systemNo, originalDepartmentSystemNo, '类型切换也不得改变 systemNo')

    const batchOrders = [(await submit('walkin')).order, (await submit('walkin')).order]
    const swapInput = batchOrders.map((row, index) => ({
      orderId: String(row.id), editVersion: Number(row.editVersion), businessNo: batchOrders[1 - index]!.businessNo,
      reason: '验证同批互换仍按原占用规则阻断',
    }))
    const swapPreview = await orderService.previewAmendments({ amendments: swapInput }, actor)
    assert.equal(swapPreview.ready, false)
    assert.ok(swapPreview.items.every((item) => item.blockingReasons.some((reason) => /当前已被其他订单使用/.test(reason))))
    await assert.rejects(() => orderService.commitAmendments({ amendments: swapInput }, actor), /当前已被其他订单使用/)

    const batchSuggestions = await orderBusinessNoService.suggestForAmendment('walkin', 2, [], AppDataSource.manager)
    const batchInput = batchOrders.map((row, index) => ({
      orderId: String(row.id), editVersion: Number(row.editVersion), businessNo: batchSuggestions.businessNos[index],
      remark: `批次变更 ${index + 1}`, reason: '验证原子提交两张订单',
    }))
    const { auditService } = await import('../src/services/audit.service.js')
    const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
    const auditRepo = AppDataSource.getRepository(SysAuditLog)
    const sequenceRepo = AppDataSource.getRepository(BusinessSequence)
    const latestCursor = () => sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.walkin' })
    const [beforeAudit, beforeRevision, beforeCursor] = await Promise.all([auditRepo.count(), revisionRepo.count(), latestCursor()])
    const originalRecordBatch = auditService.recordBatch
    auditService.recordBatch = async (...args) => {
      await originalRecordBatch.apply(auditService, args)
      throw new Error('验证批审计写入后整单回滚')
    }
    try {
      await assert.rejects(() => orderService.commitAmendments({ amendments: batchInput }, actor), /验证批审计写入后整单回滚/)
    } finally {
      auditService.recordBatch = originalRecordBatch
    }
    assert.equal(await auditRepo.count(), beforeAudit)
    assert.equal(await revisionRepo.count(), beforeRevision)
    assert.equal((await latestCursor()).currentValue, beforeCursor.currentValue)
    for (const order of batchOrders) {
      const stored = await orderRepo.findOneByOrFail({ id: String(order.id) })
      assert.equal(stored.businessNo, order.businessNo)
      assert.equal(Number(stored.editVersion), Number(order.editVersion))
    }
    const committedBatch = await orderService.commitAmendments({ amendments: [...batchInput].reverse() }, actor)
    assert.ok(committedBatch.ready)
    assert.equal(await auditRepo.count(), beforeAudit + 2)
    assert.equal(await revisionRepo.count(), beforeRevision + 2)
    for (const item of batchInput) {
      const stored = await orderRepo.findOneByOrFail({ id: item.orderId })
      assert.equal(stored.businessNo, item.businessNo)
      assert.equal(stored.remark, item.remark)
      assert.equal(Number(stored.editVersion), item.editVersion + 1)
    }

    const deleted = await submit('department')
    const deletedEntity = await orderRepo.findOneByOrFail({ id: String(deleted.order.id) })
    await orderService.softDeleteById(String(deletedEntity.id), actor, deletedEntity.businessNo)
    const deletedInput = {
      orderId: String(deletedEntity.id),
      editVersion: Number(deletedEntity.editVersion),
      remark: '软删除后不得写入',
      reason: '验证软删除阻断',
    }
    const deletedPreview = await orderService.previewAmendments({ amendments: [deletedInput] }, actor)
    assert.equal(deletedPreview.ready, false)
    assert.match(deletedPreview.items[0]?.blockingReasons.join('；') ?? '', /已删除订单不可修订/)
    await assert.rejects(
      () => orderService.commitAmendments({ amendments: [deletedInput] }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '软删除订单提交必须在事务内再次阻断',
    )

    const disabledActorTarget = await submit('department')
    const disabledActorEntity = await orderRepo.findOneByOrFail({ id: String(disabledActorTarget.order.id) })
    persistedActor.status = 'disabled'
    await AppDataSource.getRepository(SysUser).save(persistedActor)
    await assert.rejects(
      () => orderService.commitAmendments({ amendments: [{
        orderId: String(disabledActorEntity.id),
        editVersion: Number(disabledActorEntity.editVersion),
        remark: '停用账号不应写入',
        reason: '验证事务内账号复核',
      }] }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409 && /停用|注销/.test(error.message),
      '提交时必须锁定并重验后台账号状态',
    )
    assert.equal((await orderRepo.findOneByOrFail({ id: String(disabledActorEntity.id) })).remark, null)

    await AppDataSource.getRepository(SysUser).update(persistedActor.id, { status: 'enabled' })
    const parentId = '9007199254740993'
    const sourceId = '9007199254740995'
    const parentUuid = randomUUID()
    const sourceUuid = randomUUID()
    const parentNumber = 'hyyz987654'
    const sourceNumber = 'hyyz987655'
    await AppDataSource.query(`
      INSERT INTO biz_outbound_order (id, order_uuid, show_no, business_no, idempotency_key, status, customer_name)
      VALUES (9007199254740992, ?, 'HIGH-DECOY', 'hyyz987653', 'high-decoy', 'active', '无关相邻订单'),
             (9007199254740993, ?, 'HIGH-PARENT', ?, 'high-parent', 'active', '合并目标客户'),
             (9007199254740995, ?, 'HIGH-SOURCE', ?, 'high-source', 'merged', '合并来源客户')
    `, [randomUUID(), parentUuid, parentNumber, sourceUuid, sourceNumber])
    await AppDataSource.query(`
      INSERT INTO order_merge_operation (
        id, operation_uuid, idempotency_key, request_hash, target_order_id, target_order_uuid,
        target_edit_version, merged_source_order_ids_json, result_json, reason, actor_username, actor_display_name
      ) VALUES (9007199254740993, ?, 'high-merge', 'test-only', 9007199254740993, ?, 1, ?, '{}', '高位主键验收', ?, ?)
    `, [randomUUID(), parentUuid, JSON.stringify([sourceId]), actor.username, actor.displayName])
    await AppDataSource.query(`
      INSERT INTO order_merge_relation (
        id, operation_id, parent_order_id, parent_order_uuid, parent_business_no_snapshot,
        source_order_id, source_order_uuid, source_business_no_snapshot
      ) VALUES (9007199254740993, 9007199254740993, 9007199254740993, ?, ?, 9007199254740995, ?, ?)
    `, [parentUuid, parentNumber, sourceUuid, sourceNumber])
    const { orderMergeService } = await import('../src/services/order-merge.service.js')
    const parent = (await orderMergeService.getMetadataMap([parentId])).get(parentId)
    assert.equal(parent?.role, 'parent')
    assert.deepEqual(parent?.children.map((item) => item.id), [sourceId])
    const source = (await orderMergeService.getMetadataMap([sourceId])).get(sourceId)
    assert.equal(source?.role, 'source')
    assert.equal(source?.parent?.id, parentId)
    const highAmendment = { amendments: [{
      orderId: parentId, editVersion: 1, customerName: '不允许结构修改', reason: '验证高位父单门禁',
    }] }
    const highPreview = await orderService.previewAmendments(highAmendment, actor)
    assert.equal(highPreview.ready, false)
    assert.match(highPreview.items[0]?.blockingReasons.join('；') ?? '', /合并目标父单禁止结构/)
    await assert.rejects(() => orderService.commitAmendments(highAmendment, actor), /合并目标父单禁止结构/)
    const [highStored] = await AppDataSource.query('SELECT customer_name AS customerName FROM biz_outbound_order WHERE id = 9007199254740993')
    assert.equal(highStored.customerName, '合并目标客户')
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    cleanup()
  }
}

main().then(() => {
  console.log('订单普通改单治理专项验证通过')
}).catch((error) => {
  console.error(error)
  cleanup()
  process.exitCode = 1
})
