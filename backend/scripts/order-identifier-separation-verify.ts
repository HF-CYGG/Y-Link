/**
 * 模块说明：Issue #110 扩展——订单编号语义分离专项验证。
 * 文件职责：使用隔离 SQLite 验证正式单 systemNo、预订单 preorderNo 与永久业务号 businessNo 的独立流水和单调高水位。
 * 实现逻辑：所有编号均通过真实服务与事务生成；并发场景验证唯一性，业务号场景验证低号修订不会降低下一号。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-identifier-separation-'))
process.env.APP_PROFILE = 'identifier-separation-verify'
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = path.join(runtimeDir, 'verification.sqlite')
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

const { AppDataSource } = await import('../src/config/data-source.js')
const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { systemConfigService } = await import('../src/services/system-config.service.js')
const { orderSerialService } = await import('../src/services/order-serial.service.js')
const orderSerialModule = await import('../src/services/order-serial.service.js')
const { orderBusinessNoService } = await import('../src/services/order-business-no.service.js')
const { orderService } = await import('../src/services/order.service.js')
const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
const { dataMaintenanceService } = await import('../src/services/data-maintenance.service.js')
const { BusinessSequence } = await import('../src/entities/business-sequence.entity.js')
const { SystemConfig } = await import('../src/entities/system-config.entity.js')
const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')

type IdentifierSerialApi = {
  generateSystemNo(orderType: 'department' | 'walkin', manager?: typeof AppDataSource.manager): Promise<string>
  generatePreorderNo(orderType: 'department' | 'walkin', manager?: typeof AppDataSource.manager): Promise<string>
  rollbackDeletedIdentifierBatch(
    kind: 'system' | 'preorder',
    orderType: 'department' | 'walkin',
    deletedIdentifiers: string[],
    manager?: typeof AppDataSource.manager,
  ): Promise<{ rolledBack: boolean; current: number }>
}

type IdentifierCompatibilityApi = {
  resolveCompatibleIdentifierInput(input: {
    canonicalValue?: string
    legacyValue?: string
    fieldLabel: string
  }): string
}

const identifierSerialApi = orderSerialService as unknown as Partial<IdentifierSerialApi>
assert.equal(typeof identifierSerialApi.generateSystemNo, 'function', 'RED：缺少正式出库单 systemNo 生成入口')
assert.equal(typeof identifierSerialApi.generatePreorderNo, 'function', 'RED：缺少 O2O preorderNo 生成入口')
assert.equal(typeof identifierSerialApi.rollbackDeletedIdentifierBatch, 'function', 'RED：缺少按删除集合回收连续尾号的安全入口')
const removedLegacySerialApi = orderSerialService as unknown as Record<string, unknown>
for (const removedMethod of [
  'generateOrderNo',
  'rollbackCurrentIfMatches',
  'recalibrateCurrentFromOccupancy',
  'recalibrateSystemCurrentFromOccupancy',
  'recalibratePreorderCurrentFromOccupancy',
]) {
  assert.equal(typeof removedLegacySerialApi[removedMethod], 'undefined', `旧公共 API ${removedMethod} 必须删除或私有化`)
}
const compatibilityApi = orderSerialModule as unknown as Partial<IdentifierCompatibilityApi>
assert.equal(typeof compatibilityApi.resolveCompatibleIdentifierInput, 'function', 'RED：缺少新旧编号输入冲突门禁')
assert.throws(
  () => compatibilityApi.resolveCompatibleIdentifierInput?.({
    canonicalValue: 'OUT-D-000001',
    legacyValue: 'OUT-D-000002',
    fieldLabel: 'systemNo',
  }),
  (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 400),
  '新旧输入同时出现且不一致时必须返回 400',
)

const migrationPath = path.resolve(process.cwd(), 'sql/055_order_identifier_namespaces.sql')
assert.equal(fs.existsSync(migrationPath), true, 'RED：缺少 055_order_identifier_namespaces.sql')
const migrationSource = fs.readFileSync(migrationPath, 'utf8')
for (const requiredKey of [
  'order.system.department',
  'order.system.walkin',
  'o2o.preorder.department',
  'o2o.preorder.walkin',
  'order.business.department',
  'order.business.walkin',
]) {
  assert.ok(migrationSource.includes(requiredKey), `055 缺少编号命名空间：${requiredKey}`)
}
assert.doesNotMatch(migrationSource, /UPDATE\s+`?biz_outbound_order`?\s+SET\s+`?show_no`?/i, '055 不得改写历史正式单 show_no')
assert.doesNotMatch(migrationSource, /UPDATE\s+`?o2o_preorder`?\s+SET\s+`?show_no`?/i, '055 不得改写历史预订单 show_no')
assert.match(migrationSource, /@order_business_department_config_complete/i, '055 必须校验部门 business 三项 config 完整性')
assert.match(migrationSource, /@order_business_walkin_config_complete/i, '055 必须分别校验散客 business 三项 config 完整性')
assert.match(migrationSource, /order\.business\.department\.migration\.055/i, '055 必须为部门 business 首迁写入独立 marker')
assert.match(migrationSource, /order\.business\.walkin\.migration\.055/i, '055 必须为散客 business 首迁写入独立 marker')
assert.match(migrationSource, /SELECT\s+`config_value`[\s\S]*`config_key`\s*=\s*'order\.business\.department\.current'/i, '055 高水位必须合并新 config current')
assert.match(migrationSource, /`business_no`\s+REGEXP\s+'\^hyyzjd\[0-9\]\+\$'/i, '055 高水位必须合并部门单物理 business_no')
assert.match(migrationSource, /`business_no`\s+REGEXP\s+'\^hyyz\[0-9\]\+\$'/i, '055 高水位必须合并散客单物理 business_no')
assert.match(migrationSource, /IF\s*\(\s*@order_business_department_marker_complete\s*=\s*0[\s\S]*order\.serial\.department\.current/i, '055 只能在 marker 缺失的首次迁移吸收 legacy 部门流水')
const runnerSource = fs.readFileSync(path.resolve(process.cwd(), 'src/config/mysql-migration-runner.ts'), 'utf8')
assert.ok(runnerSource.includes("'055_order_identifier_namespaces.sql'"), 'MySQL 迁移 runner 未登记 055')
const bootstrapSource = fs.readFileSync(path.resolve(process.cwd(), 'src/config/database-bootstrap.ts'), 'utf8')
assert.ok(bootstrapSource.includes('order.system.department'), 'SQLite bootstrap 未补齐 systemNo 命名空间')
assert.ok(bootstrapSource.includes('o2o.preorder.department'), 'SQLite bootstrap 未补齐 preorderNo 命名空间')
const databaseMigrationSource = fs.readFileSync(path.resolve(process.cwd(), 'src/services/database-migration.service.ts'), 'utf8')
assert.match(databaseMigrationSource, /CRITICAL_VALIDATION_TABLES[\s\S]*'business_sequence'/, 'SQLite→MySQL 迁移关键表清单缺少 business_sequence')

try {
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()

  const outboundMetadata = AppDataSource.getMetadata('BizOutboundOrder')
  const outboundSystemNoColumn = outboundMetadata.findColumnWithPropertyName('systemNo')
  assert.equal(outboundSystemNoColumn?.databaseName, 'show_no', '正式单 systemNo 必须继续映射物理 show_no')
  assert.equal(outboundMetadata.findColumnWithPropertyName('showNo'), undefined, '正式单实体不得保留 showNo 双写属性')
  const preorderMetadata = AppDataSource.getMetadata('O2oPreorder')
  const preorderNoColumn = preorderMetadata.findColumnWithPropertyName('preorderNo')
  assert.equal(preorderNoColumn?.databaseName, 'show_no', '预订单 preorderNo 必须继续映射物理 show_no')
  assert.equal(preorderMetadata.findColumnWithPropertyName('showNo'), undefined, '预订单实体不得保留 showNo 双写属性')
  assert.equal(
    typeof (orderService as unknown as { detailBySystemNo?: unknown }).detailBySystemNo,
    'function',
    '正式单服务必须提供 systemNo 明确查询入口',
  )
  assert.equal(
    typeof (o2oPreorderService as unknown as { getVerifyDetailByPreorderNo?: unknown }).getVerifyDetailByPreorderNo,
    'function',
    '预订单服务必须提供 preorderNo 明确查询入口',
  )
  const orderRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/order.routes.ts'), 'utf8')
  const o2oRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/o2o.routes.ts'), 'utf8')
  assert.match(orderRouteSource, /\/system-no\/:systemNo/, '缺少 GET /api/orders/system-no/:systemNo')
  assert.match(o2oRouteSource, /\/verify\/preorder-no\/:preorderNo/, '缺少 GET /api/o2o/verify/preorder-no/:preorderNo')

  const requiredDefaults = new Map<string, string>([
    ['order.system.department.start', '1'],
    ['order.system.department.current', '0'],
    ['order.system.department.width', '6'],
    ['order.system.walkin.start', '1'],
    ['order.system.walkin.current', '0'],
    ['order.system.walkin.width', '6'],
    ['o2o.preorder.department.start', '1'],
    ['o2o.preorder.department.current', '0'],
    ['o2o.preorder.department.width', '6'],
    ['o2o.preorder.walkin.start', '1'],
    ['o2o.preorder.walkin.current', '0'],
    ['o2o.preorder.walkin.width', '6'],
    ['order.business.department.start', '1'],
    ['order.business.department.current', '0'],
    ['order.business.department.width', '6'],
    ['order.business.walkin.start', '1'],
    ['order.business.walkin.current', '0'],
    ['order.business.walkin.width', '6'],
  ])
  const configRows = await AppDataSource.getRepository(SystemConfig).findBy(
    [...requiredDefaults.keys()].map((configKey) => ({ configKey })),
  )
  const configMap = new Map(configRows.map((row) => [row.configKey, row.configValue]))
  for (const [configKey, expectedValue] of requiredDefaults) {
    assert.equal(configMap.get(configKey), expectedValue, `缺少或错误的编号配置：${configKey}`)
  }

  const [systemDepartment, preorderDepartment, systemWalkin, preorderWalkin] = await Promise.all([
    identifierSerialApi.generateSystemNo?.('department'),
    identifierSerialApi.generatePreorderNo?.('department'),
    identifierSerialApi.generateSystemNo?.('walkin'),
    identifierSerialApi.generatePreorderNo?.('walkin'),
  ])
  assert.equal(systemDepartment, 'OUT-D-000001')
  assert.equal(preorderDepartment, 'PRE-D-000001')
  assert.equal(systemWalkin, 'OUT-W-000001')
  assert.equal(preorderWalkin, 'PRE-W-000001')

  const concurrentSystemNos = await Promise.all(
    Array.from({ length: 8 }, () => identifierSerialApi.generateSystemNo?.('walkin')),
  )
  const concurrentPreorderNos = await Promise.all(
    Array.from({ length: 8 }, () => identifierSerialApi.generatePreorderNo?.('walkin')),
  )
  assert.equal(new Set(concurrentSystemNos).size, concurrentSystemNos.length, 'systemNo 并发生成不得重复')
  assert.equal(new Set(concurrentPreorderNos).size, concurrentPreorderNos.length, 'preorderNo 并发生成不得重复')
  assert.ok(concurrentSystemNos.every((value) => /^OUT-W-\d{6}$/.test(String(value))))
  assert.ok(concurrentPreorderNos.every((value) => /^PRE-W-\d{6}$/.test(String(value))))

  const configRepo = AppDataSource.getRepository(SystemConfig)
  const sequenceRepo = AppDataSource.getRepository(BusinessSequence)
  await configRepo.update({ configKey: 'order.business.walkin.current' }, { configValue: '100' })
  await sequenceRepo.save(sequenceRepo.create({ sequenceKey: 'order.business.walkin', currentValue: 100 }))
  await AppDataSource.transaction(async (manager) => {
    await orderBusinessNoService.reserveConfirmed('hyyz000005', 'walkin', randomUUID(), '低号修订单调性验证', manager)
  })
  const afterLowReservation = await sequenceRepo.findOneByOrFail({ sequenceKey: 'order.business.walkin' })
  assert.equal(Number(afterLowReservation.currentValue), 100, '低号修订不得降低业务号高水位')
  const nextBusinessNo = await AppDataSource.transaction((manager) =>
    orderBusinessNoService.allocate('walkin', randomUUID(), manager),
  )
  assert.equal(nextBusinessNo, 'hyyz000101', '业务号必须从单调高水位之后继续分配')
  const businessCurrent = await configRepo.findOneByOrFail({ configKey: 'order.business.walkin.current' })
  assert.equal(businessCurrent.configValue, '101', '业务号配置镜像必须与高水位同步')
  const lowBusinessNoPreview = await orderBusinessNoService.previewCursorPlans([
    await orderBusinessNoService.parseForOrderType('hyyz000005', 'walkin', AppDataSource.manager),
  ], AppDataSource.manager)
  assert.equal(lowBusinessNoPreview[0]?.afterCursor, 101, '低号修订预览也不得展示业务号游标回退')

  const legacySerialCurrent = await configRepo.findOneByOrFail({ configKey: 'order.serial.walkin.current' })
  assert.equal(legacySerialCurrent.configValue, '0', '旧 order.serial.* 必须只读冻结，不得被新编号生成推进')

  const actorRow = await AppDataSource.getRepository(SysUser).save({
    username: `identifier_admin_${Date.now()}`,
    passwordHash: 'test-only',
    displayName: '编号专项管理员',
    role: 'admin',
    status: 'enabled',
  })
  const actor = {
    userId: String(actorRow.id),
    username: actorRow.username,
    displayName: actorRow.displayName,
    role: 'admin' as const,
    permissions: ['orders:view', 'orders:create', 'orders:update', 'orders:delete'],
    status: 'enabled' as const,
    sessionToken: 'identifier-separation-test',
  }
  const client = await AppDataSource.getRepository(ClientUser).save({
    realName: '编号专项客户',
    passwordHash: 'test-only',
    status: 'enabled',
    accountType: 'personal',
  })

  const linkedPreorder = await AppDataSource.transaction(async (manager) => {
    const preorderNo = await identifierSerialApi.generatePreorderNo?.('department', manager) as string
    return manager.getRepository(O2oPreorder).save({
      preorderNo,
      clientUserId: client.id,
      verifyCode: randomUUID(),
      status: 'pending',
      clientOrderType: 'department',
    })
  })
  const linkedOutbound = await AppDataSource.transaction(async (manager) => {
    const orderUuid = randomUUID()
    const systemNo = await (orderSerialService as unknown as IdentifierSerialApi).generateSystemNo('department', manager)
    const businessNo = await orderBusinessNoService.allocate('department', orderUuid, manager)
    return manager.getRepository(BizOutboundOrder).save({
      orderUuid,
      systemNo,
      businessNo,
      idempotencyKey: `o2o-preorder-verify:${linkedPreorder.id}`,
      sourceDocType: 'o2o_preorder',
      sourceDocId: linkedPreorder.id,
      sourceDocNo: linkedPreorder.preorderNo,
      inventoryMode: 'legacy_none',
      orderType: 'department',
    })
  })
  const exportedData = await dataMaintenanceService.exportJson(actor)
  const exportedPreorder = exportedData.tables.preorders.find((row) => row.id === linkedPreorder.id)
  assert.equal(exportedPreorder?.preorderNo, linkedPreorder.preorderNo, '数据导出必须使用 preorderNo canonical 字段')
  assert.equal(exportedPreorder?.showNo, linkedPreorder.preorderNo, '数据导出必须保留 showNo 响应别名')

  const orderSearch = await orderService.list({
    page: 1,
    pageSize: 20,
    keyword: linkedPreorder.preorderNo,
  })
  const matchedOutbound = orderSearch.list.find((item) => item.id === String(linkedOutbound.id)) as unknown as {
    matchedIdentifierType?: string
    matchedIdentifierValue?: string
  }
  assert.equal(matchedOutbound?.matchedIdentifierType, 'preorderNo', '正式单按来源预订单号搜索必须返回命中类型')
  assert.equal(matchedOutbound?.matchedIdentifierValue, linkedPreorder.preorderNo)

  const preorderSearch = await o2oPreorderService.listConsoleOrders({ keyword: linkedOutbound.businessNo })
  const matchedPreorderIds = await (o2oPreorderService as unknown as {
    resolveMatchedPreorderIdsByCustomerOrderKeyword(keyword: string): Promise<string[]>
  }).resolveMatchedPreorderIdsByCustomerOrderKeyword(linkedOutbound.businessNo)
  assert.deepEqual(matchedPreorderIds, [String(linkedPreorder.id)], '关联正式单编号必须可反查来源预订单 ID')
  const matchedPreorder = preorderSearch.find((item) => item.id === String(linkedPreorder.id)) as unknown as {
    matchedIdentifierType?: string
    matchedIdentifierValue?: string
  }
  assert.ok(matchedPreorder, `按关联正式单业务号搜索未返回来源预订单：${JSON.stringify(preorderSearch)}`)
  assert.equal(matchedPreorder?.matchedIdentifierType, 'businessNo', '预订单按关联正式单业务号搜索必须返回命中类型')
  assert.equal(matchedPreorder?.matchedIdentifierValue, linkedOutbound.businessNo)

  const purgeOutbound = await AppDataSource.transaction(async (manager) => {
    const orderUuid = randomUUID()
    const systemNo = await orderSerialService.generateSystemNo('walkin', manager)
    const businessNo = await orderBusinessNoService.allocate('walkin', orderUuid, manager)
    return manager.getRepository(BizOutboundOrder).save({
      orderUuid,
      systemNo,
      businessNo,
      idempotencyKey: `identifier-purge-${randomUUID()}`,
      inventoryMode: 'legacy_none',
      orderType: 'walkin',
      isDeleted: true,
    })
  })
  await assert.rejects(
    orderService.purgeById(String(purgeOutbound.id), actor, purgeOutbound.systemNo),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 400),
    '正式单永久删除不得接受 systemNo 确认',
  )
  await orderService.purgeById(String(purgeOutbound.id), actor, purgeOutbound.businessNo)
  const outboundPurgeAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'order.purge' },
    order: { id: 'DESC' },
  })
  assert.equal(outboundPurgeAudit.targetId, null, '永久删除审计不得保留已删除主键')
  assert.match(outboundPurgeAudit.targetCode ?? '', /^order:deleted:[0-9a-f-]{36}$/, '正式单永久删除审计只保留随机脱敏标识')
  assert.doesNotMatch(outboundPurgeAudit.detailJson ?? '', new RegExp(purgeOutbound.businessNo, 'i'))

  const purgePreorder = await AppDataSource.transaction(async (manager) => {
    const preorderNo = await orderSerialService.generatePreorderNo('walkin', manager)
    return manager.getRepository(O2oPreorder).save({
      preorderNo,
      clientUserId: client.id,
      verifyCode: randomUUID(),
      status: 'cancelled',
      cancelReason: 'manual',
      clientOrderType: 'walkin',
    })
  })
  const preorderPurge = await o2oPreorderService.batchPurgeCancelledOrders({
    orders: [{ id: String(purgePreorder.id), confirmPreorderNo: purgePreorder.preorderNo }],
    actor,
    requestMeta: { ipAddress: '127.0.0.1', userAgent: 'identifier-separation-verify' },
  })
  assert.equal(preorderPurge.summary.deleted, 1)
  const preorderPurgeAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'o2o.preorder.purge_cancelled' },
    order: { id: 'DESC' },
  })
  assert.equal(preorderPurgeAudit.targetId, null, '预订单永久删除审计不得保留已删除主键')
  assert.match(preorderPurgeAudit.targetCode ?? '', /^o2o:deleted:[0-9a-f-]{36}$/, '预订单永久删除审计只保留随机脱敏标识')
  assert.doesNotMatch(preorderPurgeAudit.detailJson ?? '', new RegExp(purgePreorder.preorderNo, 'i'))

  const legacySystemCurrentAfterPurges = await configRepo.findOneByOrFail({ configKey: 'order.serial.walkin.current' })
  assert.equal(legacySystemCurrentAfterPurges.configValue, '0', '永久删除回拨不得触碰旧 order.serial.*')

  console.log('OK 编号格式、四套独立流水、并发唯一性与业务号单调高水位全部通过')
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  fs.rmSync(runtimeDir, { recursive: true, force: true })
}
