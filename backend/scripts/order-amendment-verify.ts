/**
 * 模块说明：订单业务号与改单治理专项验证。
 * 文件职责：在隔离 SQLite 中验证独立业务号、预览/提交、并发版本、批量原子性与永久留痕。
 * 实现逻辑：以真实实体、事务和订单服务执行 RED/GREEN 回归，不用 mock 绕过数据库一致性。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { AuthUserContext } from '../src/types/auth.js'

const verifySeed = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
const sqliteRoot = path.resolve(process.cwd(), 'data', 'local-dev')
const sqlitePath = path.resolve(sqliteRoot, `order-amendment-${verifySeed}.sqlite`)

process.env.APP_PROFILE = `order-amendment-${verifySeed}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath

const actor: AuthUserContext = {
  userId: '72001',
  username: 'issue72-verifier',
  displayName: 'Issue72验证员',
  role: 'admin',
  permissions: ['orders:create', 'orders:view', 'orders:update', 'orders:delete'],
  status: 'enabled',
  sessionToken: 'issue72-session',
  authSource: 'bearer',
}

interface AmendmentInput {
  orderId: string
  editVersion: number
  businessNo?: string
  orderType?: 'department' | 'walkin'
  customerDepartmentName?: string | null
  customerName?: string | null
  issuerName?: string | null
  hasCustomerOrder?: boolean
  isSystemApplied?: boolean
  remark?: string | null
  reason?: string
}

interface AmendmentPreview {
  ready: boolean
  cursorPlans: Array<{
    namespace: 'hyyzjd' | 'hyyz'
    beforeCursor: number
    afterCursor: number
    nextBusinessNo: string | null
  }>
  items: Array<{
    orderId: string
    blockingReasons: string[]
    before: Record<string, unknown>
    after: Record<string, unknown>
  }>
}

async function main() {
  fs.mkdirSync(sqliteRoot, { recursive: true })
  const [
    { AppDataSource },
    { BaseProduct },
    { BaseProductSku },
    { BizOutboundOrder },
    { BusinessSequence },
    { SysAuditLog },
    { SysUser },
    amendmentOccupancyModule,
    amendmentRevisionModule,
    { orderService },
    { dashboardService },
    { systemConfigService },
    { BizError },
  ] = await Promise.all([
    import('../src/config/data-source.js'),
    import('../src/entities/base-product.entity.js'),
    import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'),
    import('../src/entities/business-sequence.entity.js'),
    import('../src/entities/sys-audit-log.entity.js'),
    import('../src/entities/sys-user.entity.js'),
    import('../src/entities/order-business-no-occupancy.entity.js').catch(() => ({})),
    import('../src/entities/order-revision.entity.js').catch(() => ({})),
    import('../src/services/order.service.js'),
    import('../src/services/dashboard.service.js'),
    import('../src/services/system-config.service.js'),
    import('../src/utils/errors.js'),
  ])

  const amendmentApi = orderService as unknown as {
    previewAmendments?: (input: { amendments: AmendmentInput[] }, actor: AuthUserContext) => Promise<AmendmentPreview>
    commitAmendments?: (input: { amendments: AmendmentInput[] }, actor: AuthUserContext) => Promise<AmendmentPreview>
  }
  assert.equal(typeof amendmentApi.previewAmendments, 'function', '基线缺少 #72 改单预览能力')
  assert.equal(typeof amendmentApi.commitAmendments, 'function', '基线缺少 #72 改单提交能力')
  assert.ok('OrderBusinessNoOccupancy' in amendmentOccupancyModule, '基线缺少永久业务号占用实体')
  assert.ok('OrderRevision' in amendmentRevisionModule, '基线缺少永久订单修订实体')
  const mysqlMigrationPath = path.resolve(process.cwd(), 'sql', '042_order_business_no_amendment.sql')
  assert.equal(fs.existsSync(mysqlMigrationPath), true, '缺少 #72 MySQL 幂等迁移')
  const mysqlMigrationSource = fs.readFileSync(mysqlMigrationPath, 'utf8')
  assert.match(mysqlMigrationSource, /business_no/)
  assert.match(mysqlMigrationSource, /order_business_no_occupancy/)
  assert.match(mysqlMigrationSource, /order_revision/)
  assert.doesNotMatch(
    mysqlMigrationSource,
    /INSERT\s+IGNORE\s+INTO\s+`order_business_no_occupancy`/i,
    '历史业务号占用回填不得用 INSERT IGNORE 静默吞掉部分迁移污染',
  )
  for (const explicitGuard of [
    'ck_042_history_business_no_format',
    'ck_042_business_no_occupancy_precheck',
    'ck_042_business_no_occupancy_postcheck',
  ]) {
    assert.match(
      mysqlMigrationSource,
      new RegExp(explicitGuard),
      `MySQL 迁移缺少显式失败守卫 ${explicitGuard}`,
    )
  }
  assert.match(
    mysqlMigrationSource,
    /GREATEST[\s\S]*order\.serial\.department\.start[\s\S]*GREATEST[\s\S]*order\.serial\.walkin\.start/,
    '空命名空间游标必须尊重自定义 start - 1，而不是固定从 0 开始',
  )
  const migrationServiceSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'services', 'database-migration.service.ts'),
    'utf8',
  )
  assert.match(
    migrationServiceSource,
    /CRITICAL_VALIDATION_TABLES[\s\S]*order_business_no_occupancy[\s\S]*order_revision/,
    '数据迁移校验必须把永久占号和 revision 视为关键数据',
  )
  assert.match(
    migrationServiceSource,
    /source_outbound_order_constraint_dirty[\s\S]*business_no[\s\S]*edit_version/,
    'SQLite 到 MySQL 迁移前必须阻断缺失业务号或非法 editVersion',
  )
  const migrationSeedSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'commands', 'seed-database-migration-e2e.ts'),
    'utf8',
  )
  assert.match(
    migrationSeedSource,
    /biz_outbound_order[\s\S]*business_no[\s\S]*hyyzjd/,
    '全实体迁移夹具必须生成符合命名空间的订单业务号',
  )
  assert.match(
    migrationSeedSource,
    /order_business_no_occupancy[\s\S]*business_namespace[\s\S]*hyyzjd/,
    '全实体迁移夹具必须生成合法的永久占号数据',
  )

  const { OrderBusinessNoOccupancy } = amendmentOccupancyModule as {
    OrderBusinessNoOccupancy: new () => { businessNo: string; orderUuid: string }
  }
  const { OrderRevision } = amendmentRevisionModule as {
    OrderRevision: new () => { orderUuid: string }
  }

  await AppDataSource.initialize()
  try {
    await AppDataSource.synchronize()
    await systemConfigService.ensureDefaultConfigs()

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

    const productRepo = AppDataSource.getRepository(BaseProduct)
    const product = await productRepo.save(productRepo.create({
      productCode: `ISSUE72-${verifySeed}`,
      productName: 'Issue72验证商品',
      pinyinAbbr: 'ISSUE',
      defaultPrice: '9.90',
      currentStock: 100,
      preOrderedStock: 0,
      isActive: true,
    }))
    await AppDataSource.getRepository(BaseProductSku).save({
      productId: product.id,
      skuCode: `ISSUE72-SKU-${verifySeed}`,
      specValuesJson: '{}',
      specText: '默认规格',
      defaultPrice: '9.90',
      discountRate: '10.0',
      currentStock: 100,
      preOrderedStock: 0,
      isActive: true,
      isCurrent: true,
      o2oRecommended: false,
      thumbnail: null,
      sortOrder: 0,
    })

    const submitOrder = (suffix: string, orderType: 'department' | 'walkin') => orderService.submit({
      idempotencyKey: `issue72-${suffix}-${verifySeed}`,
      orderType,
      customerDepartmentName: orderType === 'department' ? `技术中心-${suffix}` : undefined,
      customerName: orderType === 'walkin' ? `散客-${suffix}` : undefined,
      hasCustomerOrder: orderType === 'department',
      isSystemApplied: orderType === 'department',
      items: [{ productId: product.id, qty: 1, unitPrice: 9.9 }],
    }, actor)

    const walkin = await submitOrder('walkin', 'walkin')
    const department = await submitOrder('department', 'department')
    const walkinView = walkin.order as typeof walkin.order & { businessNo: string; editVersion: number }
    const departmentView = department.order as typeof department.order & { businessNo: string; editVersion: number }
    assert.match(walkinView.businessNo, /^hyyz\d{6}$/)
    assert.match(departmentView.businessNo, /^hyyzjd\d{6}$/)
    assert.equal(walkinView.editVersion, 1)
    assert.equal(departmentView.editVersion, 1)

    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const occupancyRepo = AppDataSource.getRepository(OrderBusinessNoOccupancy)
    const revisionRepo = AppDataSource.getRepository(OrderRevision)
    const sequenceRepo = AppDataSource.getRepository(BusinessSequence)
    const originalWalkin = await orderRepo.findOneByOrFail({ id: walkin.order.id }) as BizOutboundOrder & {
      businessNo: string
      editVersion: number
    }
    const originalSystemNo = originalWalkin.systemNo
    const createAudit = await AppDataSource.getRepository(SysAuditLog).findOneByOrFail({
      actionType: 'order.create',
      targetId: walkin.order.id,
    })
    assert.equal(JSON.parse(createAudit.detailJson ?? '{}').businessNo, originalWalkin.businessNo, '创建审计必须记录创建当时的 businessNo')
    assert.equal(createAudit.targetCode, originalWalkin.businessNo, '创建审计 targetCode 必须使用事件时 businessNo')
    assert.equal(await occupancyRepo.count(), 2, '新单业务号必须立即永久占用')

    const cursorExampleTarget = await submitOrder('cursor-example-target', 'walkin')
    await sequenceRepo.update({ sequenceKey: 'order.business.walkin' }, { currentValue: 3 })
    await AppDataSource.query('UPDATE "system_configs" SET "config_value" = ? WHERE "config_key" = ?', ['3', 'order.business.walkin.current'])
    await amendmentApi.commitAmendments!({ amendments: [{
      orderId: cursorExampleTarget.order.id,
      editVersion: 1,
      businessNo: 'hyyz000007',
      reason: '验证 003 下调后重编为 007',
    }] }, actor)
    const cursorAfterSeven = await submitOrder('cursor-example-eight', 'walkin')
    assert.equal((cursorAfterSeven.order as typeof cursorAfterSeven.order & { businessNo: string }).businessNo, 'hyyz000008', '003→007 后下一单必须为 008')
    await sequenceRepo.update({ sequenceKey: 'order.business.walkin' }, { currentValue: 15 })
    await AppDataSource.query('UPDATE "system_configs" SET "config_value" = ? WHERE "config_key" = ?', ['15', 'order.business.walkin.current'])
    await amendmentApi.commitAmendments!({ amendments: [{
      orderId: cursorExampleTarget.order.id,
      editVersion: 2,
      businessNo: 'hyyz000009',
      reason: '验证 015 向下重编为 009',
    }] }, actor)
    const cursorAfterNine = await submitOrder('cursor-example-ten', 'walkin')
    assert.equal((cursorAfterNine.order as typeof cursorAfterNine.order & { businessNo: string }).businessNo, 'hyyz000016', '低号重编不得降低业务号高水位，015→009 后下一单必须为 016')

    await assert.rejects(
      () => amendmentApi.commitAmendments!({ amendments: [{
        orderId: walkin.order.id,
        editVersion: 1,
        customerName: '空白原因不应生效',
        reason: '   ',
      }] }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 400 && /原因/.test(error.message),
      '服务层必须拒绝空白修订原因',
    )

    const previewInput: AmendmentInput = {
      orderId: walkin.order.id,
      editVersion: 1,
      businessNo: 'hyyz000123',
      customerName: '预览后的散客名称',
      reason: '专项验证单笔重编',
    }
    const beforePreviewOccupancy = await occupancyRepo.count()
    const beforePreviewRevision = await revisionRepo.count()
    const preview = await amendmentApi.previewAmendments!({ amendments: [previewInput] }, actor)
    assert.equal(preview.ready, true)
    assert.deepEqual(preview.items[0]?.blockingReasons, [])
    assert.deepEqual(preview.cursorPlans, [{
      namespace: 'hyyz',
      beforeCursor: 16,
      afterCursor: 123,
      nextBusinessNo: 'hyyz000124',
    }])
    assert.equal((await orderRepo.findOneByOrFail({ id: walkin.order.id }) as BizOutboundOrder & { businessNo: string }).businessNo, originalWalkin.businessNo)
    assert.equal(await occupancyRepo.count(), beforePreviewOccupancy, '预览不得占用业务号')
    assert.equal(await revisionRepo.count(), beforePreviewRevision, '预览不得写 revision')

    const committed = await amendmentApi.commitAmendments!({ amendments: [previewInput] }, actor)
    assert.equal(committed.ready, true)
    const amendedWalkin = await orderRepo.findOneByOrFail({ id: walkin.order.id }) as BizOutboundOrder & {
      businessNo: string
      editVersion: number
    }
    assert.equal(amendedWalkin.businessNo, 'hyyz000123')
    assert.equal(amendedWalkin.customerName, '预览后的散客名称')
    assert.equal(amendedWalkin.editVersion, 2)
    assert.equal(amendedWalkin.systemNo, originalSystemNo, '改单不得修改 systemNo')
    assert.equal(await occupancyRepo.count(), beforePreviewOccupancy + 1)
    assert.equal(await revisionRepo.count(), beforePreviewRevision + 1)
    assert.equal(Number((await sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.walkin' })).currentValue), 123)
    assert.deepEqual(committed.cursorPlans, preview.cursorPlans)

    await orderService.softDeleteById(walkin.order.id, actor, amendedWalkin.businessNo)
    await orderService.restoreById(walkin.order.id, actor)
    const lifecycleAudits = await AppDataSource.getRepository(SysAuditLog).find({
      where: { targetId: walkin.order.id },
      order: { id: 'DESC' },
    })
    for (const actionType of ['order.delete', 'order.restore']) {
      const audit = lifecycleAudits.find((item) => item.actionType === actionType)
      assert.ok(audit, `${actionType} 必须写入审计`)
      assert.equal(JSON.parse(audit.detailJson ?? '{}').businessNo, 'hyyz000123', `${actionType} 必须记录操作当时的 businessNo`)
      assert.equal(audit.targetCode, 'hyyz000123', `${actionType} targetCode 必须使用操作时 businessNo`)
    }
    const lifecycleStats = await dashboardService.getStats(actor)
    for (const actionType of ['order.delete', 'order.restore'] as const) {
      const activity = lifecycleStats.recentActivities.find((item) => (
        item.orderId === walkin.order.id && item.actionType === actionType
      ))
      assert.ok(activity, `工作台近期动态必须包含 ${actionType}`)
      assert.equal(activity.businessNo, 'hyyz000123', `工作台 ${actionType} 必须展示修订后的业务号`)
      assert.equal(activity.systemNo, originalSystemNo, `管理员工作台 ${actionType} 必须通过审计详情保留 canonical systemNo`)
      assert.equal(activity.showNo, originalSystemNo, `管理员工作台 ${actionType} 的 legacy showNo 必须严格等于 systemNo`)
    }

    const lowered = await amendmentApi.commitAmendments!({ amendments: [{
      orderId: walkin.order.id,
      editVersion: 2,
      businessNo: 'hyyz000100',
      reason: '专项验证单笔游标下调',
    }] }, actor)
    assert.deepEqual(lowered.cursorPlans, [{
      namespace: 'hyyz',
      beforeCursor: 123,
      afterCursor: 123,
      nextBusinessNo: 'hyyz000124',
    }], '单笔低号重编不得降低业务号单调高水位')
    assert.equal(Number((await sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.walkin' })).currentValue), 123)

    await assert.rejects(
      () => amendmentApi.commitAmendments!({ amendments: [previewInput] }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '陈旧 editVersion 必须返回 409',
    )

    const departmentSwitch: AmendmentInput = {
      orderId: department.order.id,
      editVersion: 1,
      orderType: 'walkin',
      businessNo: 'hyyz000200',
      customerName: '分类修订散客',
      hasCustomerOrder: true,
      isSystemApplied: true,
      reason: '专项验证类型切换',
    }
    await amendmentApi.commitAmendments!({ amendments: [departmentSwitch] }, actor)
    const switched = await orderRepo.findOneByOrFail({ id: department.order.id })
    assert.equal(switched.orderType, 'walkin')
    assert.equal(switched.customerDepartmentName, null, '转散客单必须清理部门字段')
    assert.equal(Boolean(switched.hasCustomerOrder), false, '转散客单必须清理部门专属状态')
    assert.equal(Boolean(switched.isSystemApplied), false, '转散客单必须清理部门专属状态')

    const atomicA = await submitOrder('atomic-a', 'department')
    const atomicB = await submitOrder('atomic-b', 'department')
    const atomicABefore = await orderRepo.findOneByOrFail({ id: atomicA.order.id }) as BizOutboundOrder & { businessNo: string; editVersion: number }
    await assert.rejects(
      () => amendmentApi.commitAmendments!({
        amendments: [
          { orderId: atomicA.order.id, editVersion: 1, businessNo: 'hyyzjd000300', reason: '原子性合法项' },
          { orderId: atomicB.order.id, editVersion: 1, businessNo: 'hyyz000123', orderType: 'walkin', customerName: '冲突项', reason: '原子性冲突项' },
        ],
      }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '批量任一冲突必须整体返回 409',
    )
    const atomicAAfter = await orderRepo.findOneByOrFail({ id: atomicA.order.id }) as BizOutboundOrder & { businessNo: string; editVersion: number }
    assert.equal(atomicAAfter.businessNo, atomicABefore.businessNo, '批量失败不得部分修改前序订单')
    assert.equal(atomicAAfter.editVersion, atomicABefore.editVersion)

    const deterministicA = await submitOrder('deterministic-a', 'department')
    const deterministicB = await submitOrder('deterministic-b', 'department')
    const deterministicResult = await amendmentApi.commitAmendments!({
      amendments: [
        { orderId: deterministicA.order.id, editVersion: 1, businessNo: 'hyyzjd000350', reason: '确定性高号' },
        { orderId: deterministicB.order.id, editVersion: 1, businessNo: 'hyyzjd000320', reason: '确定性低号' },
      ],
    }, actor)
    assert.deepEqual(deterministicResult.cursorPlans, [{
      namespace: 'hyyzjd',
      beforeCursor: 5,
      afterCursor: 350,
      nextBusinessNo: 'hyyzjd000351',
    }], '同命名空间批量重编必须以最大确认号作为游标，不受请求顺序影响')
    assert.equal(
      Number((await sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.department' })).currentValue),
      350,
    )

    const concurrentOrders = await Promise.all([
      submitOrder('concurrent-a', 'department'),
      submitOrder('concurrent-b', 'department'),
    ])
    assert.deepEqual(
      concurrentOrders.map((result) => (result.order as typeof result.order & { businessNo: string }).businessNo).sort(),
      ['hyyzjd000351', 'hyyzjd000352'],
      '并发新单必须串行推进业务游标且不得重复或跳号',
    )

    await occupancyRepo.insert({
      namespace: 'hyyz',
      serialValue: 201,
      businessNo: 'hyyz000201',
      orderUuid: 'historical-occupancy-without-order',
      assignedReason: '专项验证永久占用',
      lastAssignedOrderUuid: 'historical-occupancy-without-order',
      lastAssignedAt: new Date(),
      reuseCount: 0,
    } as never)

    // 修订切换类型的自动编排建议：从游标顺延，跳过永久占用号与同批排除号，且只读不占号、不推进游标。
    const { orderBusinessNoService } = await import('../src/services/order-business-no.service.js')
    const suggestionOccupancyBefore = await occupancyRepo.count()
    const walkinSuggestion = await orderBusinessNoService.suggestForAmendment(
      'walkin',
      2,
      ['HYYZ000202', ' '],
      AppDataSource.manager,
    )
    assert.deepEqual(walkinSuggestion, {
      orderType: 'walkin',
      namespace: 'hyyz',
      cursor: 200,
      businessNos: ['hyyz000203', 'hyyz000204'],
      skippedBusinessNos: ['hyyz000201'],
    }, '散客建议号必须从游标顺延并跳过占用号与同批排除号')
    const departmentSuggestion = await orderBusinessNoService.suggestForAmendment('department', 1, [], AppDataSource.manager)
    assert.deepEqual(departmentSuggestion.businessNos, ['hyyzjd000353'], '部门建议号必须使用 hyyzjd 命名空间游标 + 1')
    assert.equal(await occupancyRepo.count(), suggestionOccupancyBefore, '建议号不得占用业务号')
    assert.equal(Number((await sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.walkin' })).currentValue), 200, '建议号不得推进游标')
    assert.equal(Number((await sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.department' })).currentValue), 352)
    await assert.rejects(
      () => submitOrder('strict-cursor', 'walkin'),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      'cursor + 1 被占用时必须 409，禁止扫描跳号',
    )

    const deletedTarget = await submitOrder('deleted-amendment-target', 'department')
    const deletedTargetEntity = await orderRepo.findOneByOrFail({ id: deletedTarget.order.id })
    await orderService.softDeleteById(deletedTarget.order.id, actor, deletedTargetEntity.businessNo)
    const deletedPreviewInput: AmendmentInput = {
      orderId: deletedTarget.order.id,
      editVersion: deletedTargetEntity.editVersion,
      businessNo: 'hyyzjd000360',
      reason: '专项验证已删除订单阻断',
    }
    const deletedPreview = await amendmentApi.previewAmendments!({ amendments: [deletedPreviewInput] }, actor)
    assert.equal(deletedPreview.ready, false, '已删除订单预览必须不可提交')
    assert.match(
      deletedPreview.items[0]?.blockingReasons.join('；') ?? '',
      /已删除订单不可修订/,
      '已删除订单预览必须返回明确 blocker',
    )
    await assert.rejects(
      () => amendmentApi.commitAmendments!({ amendments: [deletedPreviewInput] }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409,
      '已删除订单正式提交必须事务内重验并返回 409',
    )

    const complianceTarget = await submitOrder('single-compliance-flag', 'department')
    await orderService.updateComplianceFlags({
      orderId: complianceTarget.order.id,
      editVersion: 1,
      hasCustomerOrder: false,
    }, actor)
    const complianceTargetAfter = await orderRepo.findOneByOrFail({ id: complianceTarget.order.id })
    assert.equal(Boolean(complianceTargetAfter.hasCustomerOrder), false)
    assert.equal(
      Boolean(complianceTargetAfter.isSystemApplied),
      true,
      '兼容入口只更新一个合规开关时不得覆盖另一个未提交字段',
    )

    const purgeTarget = await submitOrder('purge-target', 'department')
    const purgeEntity = await orderRepo.findOneByOrFail({ id: purgeTarget.order.id }) as BizOutboundOrder & { businessNo: string; editVersion: number }
    await amendmentApi.commitAmendments!({ amendments: [{
      orderId: purgeTarget.order.id,
      editVersion: purgeEntity.editVersion,
      businessNo: 'hyyzjd000400',
      reason: '专项验证永久留痕',
    }] }, actor)
    const purgeOrderUuid = purgeEntity.orderUuid
    // 本段只验证永久删除后占号与 revision 留存；库存型新单由内容编辑专项断言禁止永久删除。
    // 因此将隔离夹具标记为升级前 legacy_none，避免把两种删除语义混在同一断言中。
    const amendedPurgeEntity = await orderRepo.findOneByOrFail({ id: purgeTarget.order.id })
    amendedPurgeEntity.inventoryMode = 'legacy_none'
    await orderRepo.save(amendedPurgeEntity)
    await orderService.softDeleteById(purgeTarget.order.id, actor, amendedPurgeEntity.businessNo)
    await orderService.purgeById(purgeTarget.order.id, actor, amendedPurgeEntity.businessNo)
    const purgeAudit = await AppDataSource.getRepository(SysAuditLog).findOneByOrFail({
      actionType: 'order.purge',
      targetId: purgeTarget.order.id,
    })
    assert.equal(JSON.parse(purgeAudit.detailJson ?? '{}').businessNo, 'hyyzjd000400', '永久删除审计必须记录删除当时的 businessNo')
    assert.equal(purgeAudit.targetCode, amendedPurgeEntity.businessNo, '永久删除审计 targetCode 必须使用删除时 businessNo')
    assert.equal(await occupancyRepo.count({ where: { orderUuid: purgeOrderUuid } }), 2, '永久删除后新旧业务号占用都必须保留')
    assert.equal(await revisionRepo.count({ where: { orderUuid: purgeOrderUuid } }), 1, '永久删除后 revision 必须保留')

    const staleActorTarget = await submitOrder('stale-actor-target', 'department')
    const staleActorAccount = await AppDataSource.getRepository(SysUser).findOneByOrFail({ id: actor.userId })
    staleActorAccount.status = 'disabled'
    await AppDataSource.getRepository(SysUser).save(staleActorAccount)
    await assert.rejects(
      () => amendmentApi.commitAmendments!({ amendments: [{
        orderId: staleActorTarget.order.id,
        editVersion: 1,
        remark: '停用账号不应写入',
        reason: '验证事务内账号复核',
      }] }, actor),
      (error: unknown) => error instanceof BizError && error.statusCode === 409 && /停用|注销/.test(error.message),
      '停用账号的陈旧请求不得提交订单修订',
    )
    assert.equal((await orderRepo.findOneByOrFail({ id: staleActorTarget.order.id })).remark, null)

    const routeSource = fs.readFileSync(path.resolve(process.cwd(), 'src', 'routes', 'order.routes.ts'), 'utf8')
    assert.match(routeSource, /\/amendments\/preview[\s\S]*requirePermission\('orders:update'\)/)
    assert.match(routeSource, /\/amendments['"][\s\S]*requirePermission\('orders:update'\)/)
    assert.match(routeSource, /orderAmendmentCommitSchema[\s\S]*reason:\s*z\.string\(\)\.trim\(\)\.min\(1/, '修订提交路由必须强制非空原因')
    assert.match(routeSource, /\/amendments\/preview[\s\S]*orderAmendmentBatchSchema\.parse/, '修订预览允许沿用可选原因 schema')
    assert.match(
      routeSource,
      /'\/amendments\/business-no-suggestions',[\s\S]*?requirePermission\('orders:update'\)/,
      '业务号建议接口必须要求 orders:update 权限',
    )
    const amendmentDialogSource = fs.readFileSync(
      path.resolve(process.cwd(), '..', 'src', 'views', 'order-list', 'components', 'OrderAmendmentDialog.vue'),
      'utf8',
    )
    assert.match(amendmentDialogSource, /@change="handleOrderTypeChange\(draft\)"/, '修订弹窗切换订单类型必须触发业务号自动编排')
    assert.match(amendmentDialogSource, /draft\.businessNo = draft\.originalBusinessNo/, '切回原类型必须恢复原业务号')
    assert.match(amendmentDialogSource, /seq !== draft\.suggestionSeq/, '自动编排必须丢弃过期响应')
    assert.match(amendmentDialogSource, /getOrderDepartmentOptions\(\)/, '修订弹窗客户部门必须复用系统部门配置选项')
    assert.match(
      amendmentDialogSource,
      /v-model="draft\.customerDepartmentName"[\s\S]*?filterable[\s\S]*?allow-create/,
      '修订弹窗客户部门必须支持搜索选择与手动录入',
    )
    const dashboardViewSource = fs.readFileSync(
      path.resolve(process.cwd(), '..', 'src', 'views', 'dashboard', 'DashboardView.vue'),
      'utf8',
    )
    assert.match(
      dashboardViewSource,
      /activity\.businessNo/,
      '工作台近期订单动态必须显示 businessNo，并继续使用 showNo 作为内部跳转键',
    )
    const orderListViewSource = fs.readFileSync(
      path.resolve(process.cwd(), '..', 'src', 'views', 'order-list', 'OrderListView.vue'),
      'utf8',
    )
    assert.match(orderListViewSource, /:selectable="isOrderAmendable"/, '桌面端不得选择已删除订单修订')
    assert.match(orderListViewSource, /const isOrderAmendable[\s\S]*?!order\.isDeleted/, '前端选择规则必须排除已删除订单')
    assert.match(orderListViewSource, /orders\.some\(\(order\) => order\.isDeleted\)/, '提交入口必须再次拒绝已删除订单')
    console.log('✅ Issue #72 订单业务号与改单治理专项验证通过')
  } finally {
    await AppDataSource.destroy()
    fs.rmSync(sqlitePath, { force: true })
  }
}

main().catch((error) => {
  console.error('❌ Issue #72 订单业务号与改单治理专项验证失败', error)
  process.exitCode = 1
})
