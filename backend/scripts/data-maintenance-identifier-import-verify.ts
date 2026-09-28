/**
 * 模块说明：JSON 数据导入后的订单编号命名空间回归验证。
 * 文件职责：用隔离 SQLite 验证旧版备份领养、游标高水位、权限审计和导入事务回滚。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const runtimeRoot = path.resolve(process.cwd(), '.local-dev')
const runtimeDir = path.join(runtimeRoot, `identifier-import-verify-${randomUUID()}`)
fs.mkdirSync(runtimeDir, { recursive: true })
process.env.APP_PROFILE = 'identifier-import-verify'
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = path.join(runtimeDir, 'verification.sqlite')
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

const { AppDataSource } = await import('../src/config/data-source.js')
const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { dataMaintenanceService } = await import('../src/services/data-maintenance.service.js')
const { systemConfigService } = await import('../src/services/system-config.service.js')
const { orderBusinessNoService } = await import('../src/services/order-business-no.service.js')
const { orderSerialService } = await import('../src/services/order-serial.service.js')
const { validateExportPayload } = await import('../src/services/data-maintenance.shared.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { SystemConfig } = await import('../src/entities/system-config.entity.js')
const { BusinessSequence } = await import('../src/entities/business-sequence.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')

const requestMeta = { ipAddress: '127.0.0.1', userAgent: 'identifier-import-verify' }

try {
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
  const user = await AppDataSource.getRepository(SysUser).save({
    username: `identifier_import_${randomUUID().slice(0, 8)}`,
    passwordHash: 'test-only',
    displayName: '编号导入验证管理员',
    role: 'admin',
    status: 'enabled',
  })
  const admin = {
    userId: String(user.id), username: user.username, displayName: user.displayName,
    role: 'admin' as const, permissions: ['data_maintenance:import', 'system_configs:view'],
    status: 'enabled' as const, sessionToken: 'test-only',
  }
  const operator = { ...admin, role: 'operator' as const }
  const configRepo = AppDataSource.getRepository(SystemConfig)
  const sequenceRepo = AppDataSource.getRepository(BusinessSequence)
  const auditRepo = AppDataSource.getRepository(SysAuditLog)
  const readConfig = async (key: string) => (await configRepo.findOneBy({ configKey: key }))?.configValue
  const readSequence = async (key: string) => Number((await sequenceRepo.findOneByOrFail({ sequenceKey: key })).currentValue)
  const client = await AppDataSource.getRepository(ClientUser).save({
    mobile: '13800000000', passwordHash: 'test-only', realName: '隔离导入用户',
    status: 'enabled', accountType: 'personal',
  })
  await AppDataSource.getRepository(O2oPreorder).save([
    { preorderNo: 'PRE-W-000075', clientUserId: client.id, verifyCode: 'verify-pre-75', status: 'pending', clientOrderType: 'walkin' },
    { preorderNo: 'hyyz000999', clientUserId: client.id, verifyCode: 'verify-legacy-999', status: 'pending', clientOrderType: 'walkin' },
  ])
  const currentExport = JSON.parse(JSON.stringify(await dataMaintenanceService.exportJson(admin, requestMeta)))
  assert.ok(currentExport.tables.systemConfigs.some((row: { configValue: string }) => row.configValue === ''),
    '真实导出夹具应包含空字符串的默认系统配置')
  for (const invalidValue of [undefined, null, 0, 'x'.repeat(20001)]) {
    const invalidPayload = structuredClone(currentExport)
    const emptyConfig = invalidPayload.tables.systemConfigs.find((row: { configValue: string }) => row.configValue === '')
    assert.ok(emptyConfig)
    if (invalidValue === undefined) delete emptyConfig.configValue
    else emptyConfig.configValue = invalidValue
    assert.throws(
      () => validateExportPayload(invalidPayload),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
      '缺失、非字符串或超长系统配置值必须继续拒绝',
    )
  }
  const invalidPasswordPayload = structuredClone(currentExport)
  assert.ok(invalidPasswordPayload.tables.clientUsers.length > 0)
  invalidPasswordPayload.tables.clientUsers[0].passwordHash = ''
  assert.throws(
    () => validateExportPayload(invalidPasswordPayload),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
    '系统配置允许空值不得放宽客户端密码哈希校验',
  )

  const legacyConfigs = currentExport.tables.systemConfigs.filter((row: { configKey: string }) =>
    !/^(order\.system\.|order\.business\.|o2o\.preorder\.)/.test(row.configKey))
  const legacyCursor = legacyConfigs.find((row: { configKey: string }) => row.configKey === 'order.serial.walkin.current')
  assert.ok(legacyCursor, '测试基线缺少旧散客流水配置')
  legacyCursor.configValue = '42'
  const legacyPayload = {
    ...currentExport,
    version: 'o2o-preorder-v1',
    tables: {
      ...currentExport.tables,
      systemConfigs: legacyConfigs,
      preorders: currentExport.tables.preorders.map((row: { preorderNo?: string; showNo: string }) => {
        const legacyRow = { ...row }
        delete legacyRow.preorderNo
        return legacyRow
      }),
    },
  }
  const emptyLegacyCursorPayload = structuredClone(legacyPayload)
  const emptyLegacyCursor = emptyLegacyCursorPayload.tables.systemConfigs.find((row: { configKey: string }) =>
    row.configKey === 'order.serial.walkin.current')
  assert.ok(emptyLegacyCursor)
  emptyLegacyCursor.configValue = ''
  const beforeEmptyCursor = {
    configs: await configRepo.find({ order: { configKey: 'ASC' } }),
    sequences: await sequenceRepo.find({ order: { sequenceKey: 'ASC' } }),
    preorders: await AppDataSource.getRepository(O2oPreorder).find({ order: { id: 'ASC' } }),
  }
  await assert.rejects(
    () => dataMaintenanceService.importJson(emptyLegacyCursorPayload, admin, requestMeta),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    '旧编号游标为空时应在导入事务中拒绝',
  )
  assert.deepEqual(await configRepo.find({ order: { configKey: 'ASC' } }), beforeEmptyCursor.configs)
  assert.deepEqual(await sequenceRepo.find({ order: { sequenceKey: 'ASC' } }), beforeEmptyCursor.sequences)
  assert.deepEqual(await AppDataSource.getRepository(O2oPreorder).find({ order: { id: 'ASC' } }), beforeEmptyCursor.preorders)
  await assert.rejects(
    () => dataMaintenanceService.importJson(legacyPayload, operator, requestMeta),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 403,
    '非管理员不得导入旧备份',
  )
  assert.equal(await readConfig('order.business.walkin.migration.055'), '1', '越权拒绝不得清除原配置')
  const deniedAudit = await auditRepo.findOneBy({ actionType: 'data_maintenance.import_json', resultStatus: 'failed' })
  assert.ok(deniedAudit, '非管理员导入须保留越权审计')

  await dataMaintenanceService.importJson(legacyPayload, admin, requestMeta)
  const identifiers = await systemConfigService.getOrderIdentifierConfigs()
  assert.equal(identifiers.business.walkin.prefix, 'hyyz')
  assert.equal(identifiers.system.walkin.prefix, 'OUT-W-')
  assert.equal(identifiers.preorder.walkin.prefix, 'PRE-W-')
  assert.equal(await readConfig('order.business.walkin.migration.055'), '1')
  assert.equal(Number(await readConfig('order.business.walkin.current')), 42, '旧备份的业务号高水位须被领养')
  const allocatedBusinessNo = await AppDataSource.transaction((manager) =>
    orderBusinessNoService.allocate('walkin', randomUUID(), manager))
  const allocatedSystemNo = await orderSerialService.generateSystemNo('walkin')
  const allocatedPreorderNo = await orderSerialService.generatePreorderNo('walkin')
  assert.equal(allocatedBusinessNo, 'hyyz000043')
  assert.match(allocatedSystemNo, /^OUT-W-\d{6}$/)
  assert.equal(allocatedPreorderNo, 'PRE-W-000076', '只采纳 PRE 物理预订单最大号，不采纳旧 hyyz 预订单号')
  console.log('✅ v1 旧备份导入后六套编号配置齐全，业务号、正式单和预订单均可分配')

  // 在物理预订单号已完成领养后，验证未经改写的 v2 JSON 可原样回灌，避免正常高水位校准干扰逐键比较。
  const roundTripPayload = JSON.parse(JSON.stringify(await dataMaintenanceService.exportJson(admin, requestMeta)))
  assert.ok(roundTripPayload.tables.systemConfigs.some((row: { configValue: string }) => row.configValue === ''),
    'v2 原样回灌夹具必须包含空字符串配置值')
  const configPairs = (rows: Array<{ configKey: string; configValue: string }>) =>
    rows.map((row) => [row.configKey, row.configValue]).sort(([left], [right]) => left.localeCompare(right))
  const roundTripResult = await dataMaintenanceService.importJson(roundTripPayload, admin, requestMeta)
  assert.equal(roundTripResult.imported.systemConfigs, roundTripPayload.tables.systemConfigs.length)
  const roundTripAfter = JSON.parse(JSON.stringify(await dataMaintenanceService.exportJson(admin, requestMeta)))
  assert.deepEqual(configPairs(roundTripAfter.tables.systemConfigs), configPairs(roundTripPayload.tables.systemConfigs),
    'v2 原样回灌后每个系统配置键及空字符串值都必须保留')
  assert.deepEqual(roundTripAfter.tables, roundTripPayload.tables, 'v2 原样回灌不得丢失或改写六张载荷表')
  console.log('✅ 未修改的 v2 JSON 导出可原样导入，逐键配置与六表数据均保持一致')

  await configRepo.update({ configKey: 'order.business.department.start' }, { configValue: '25' })
  await configRepo.update({ configKey: 'order.business.department.width' }, { configValue: '8' })
  await configRepo.update({ configKey: 'order.business.department.current' }, { configValue: '100' })
  await sequenceRepo.update({ sequenceKey: 'order.business.department' }, { currentValue: 100 })
  const stalePayload = {
    ...currentExport,
    version: 'data-maintenance-v2',
  }
  await dataMaintenanceService.importJson(stalePayload, admin, requestMeta)
  assert.equal(await readConfig('order.business.department.start'), '25', '旧备份不得覆盖已有业务号起始形状')
  assert.equal(await readConfig('order.business.department.width'), '8', '旧备份不得覆盖已有业务号位宽')
  assert.equal(Number(await readConfig('order.business.department.current')), 100, '旧备份不得降低配置镜像')
  assert.equal(await readSequence('order.business.department'), 100, '旧备份不得降低并发流水')
  const nextDepartmentBusinessNo = await AppDataSource.transaction((manager) =>
    orderBusinessNoService.allocate('department', randomUUID(), manager))
  assert.equal(nextDepartmentBusinessNo, 'hyyzjd00000101')
  assert.equal(await auditRepo.count({ where: { actionType: 'data_maintenance.import_json', resultStatus: 'success' } }), 3)
  console.log('✅ v2 备份导入不回退已有编号形状和游标')

  await AppDataSource.query('CREATE TABLE identifier_import_external_cascade (client_user_id INTEGER NOT NULL REFERENCES client_user(id) ON DELETE CASCADE)')
  await AppDataSource.query('INSERT INTO identifier_import_external_cascade (client_user_id) VALUES (?)', [client.id])
  const cascadeConfigsBefore = await configRepo.find({ order: { configKey: 'ASC' } })
  const cascadeSequencesBefore = await sequenceRepo.find({ order: { sequenceKey: 'ASC' } })
  await assert.rejects(
    () => dataMaintenanceService.importJson(stalePayload, admin, requestMeta),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    '存在六表外 CASCADE 引用时必须拒绝导入',
  )
  assert.equal((await AppDataSource.query('SELECT COUNT(1) AS count FROM identifier_import_external_cascade'))[0].count, 1)
  assert.deepEqual(await configRepo.find({ order: { configKey: 'ASC' } }), cascadeConfigsBefore)
  assert.deepEqual(await sequenceRepo.find({ order: { sequenceKey: 'ASC' } }), cascadeSequencesBefore)
  await AppDataSource.query('DELETE FROM identifier_import_external_cascade')
  console.log('✅ SQLite 六表外 CASCADE 引用阻断导入且原数据保留')

  await AppDataSource.query('CREATE TABLE identifier_import_external_set_null (client_user_id INTEGER REFERENCES client_user(id) ON DELETE SET NULL)')
  await AppDataSource.query('INSERT INTO identifier_import_external_set_null (client_user_id) VALUES (?)', [client.id])
  await assert.rejects(
    () => dataMaintenanceService.importJson(stalePayload, admin, requestMeta),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    '存在六表外 SET NULL 引用时必须拒绝导入',
  )
  assert.equal((await AppDataSource.query('SELECT client_user_id AS clientUserId FROM identifier_import_external_set_null'))[0].clientUserId, Number(client.id))
  await AppDataSource.query('DELETE FROM identifier_import_external_set_null')
  console.log('✅ SQLite 六表外 SET NULL 引用阻断导入且原外键值保留')

  const configBeforeForeignKeyFailure = await configRepo.find({ order: { configKey: 'ASC' } })
  const preorderBeforeForeignKeyFailure = await AppDataSource.getRepository(O2oPreorder).find({ order: { id: 'ASC' } })
  const sequenceBeforeForeignKeyFailure = await sequenceRepo.find({ order: { sequenceKey: 'ASC' } })
  await AppDataSource.query('CREATE TABLE identifier_import_external_ref (client_user_id INTEGER NOT NULL REFERENCES client_user(id) ON DELETE RESTRICT)')
  await AppDataSource.query('INSERT INTO identifier_import_external_ref (client_user_id) VALUES (?)', [client.id])
  await assert.rejects(() => dataMaintenanceService.importJson(stalePayload, admin, requestMeta), /FOREIGN KEY constraint failed/)
  assert.deepEqual(await configRepo.find({ order: { configKey: 'ASC' } }), configBeforeForeignKeyFailure)
  assert.deepEqual(await AppDataSource.getRepository(O2oPreorder).find({ order: { id: 'ASC' } }), preorderBeforeForeignKeyFailure)
  assert.deepEqual(await sequenceRepo.find({ order: { sequenceKey: 'ASC' } }), sequenceBeforeForeignKeyFailure)
  await AppDataSource.query('DELETE FROM identifier_import_external_ref')
  console.log('✅ 六表之外存在 RESTRICT 外键时导入失败且原数据完整保留')

  const sixTables = ['inventory_log', 'o2o_preorder_item', 'o2o_preorder', 'client_user', 'base_product', 'system_configs']
  const snapshot = async () => JSON.stringify({
    tables: Object.fromEntries(await Promise.all(sixTables.map(async (table) => [table, await AppDataSource.query(`SELECT * FROM ${table} ORDER BY id`)]))),
    sequences: await AppDataSource.query('SELECT * FROM business_sequence ORDER BY sequence_key'),
    successfulAudits: await auditRepo.count({ where: { actionType: 'data_maintenance.import_json', resultStatus: 'success' } }),
  })
  const malformedOrder = await AppDataSource.getRepository(BizOutboundOrder).save({
    orderUuid: randomUUID(), systemNo: 'OUT-W-000050', businessNo: 'hyyz1234567',
    idempotencyKey: `identifier-import-malformed-${randomUUID()}`, orderType: 'walkin',
  })
  for (const malformedNo of ['hyyz1234567', 'hyyz9007199254740993']) {
    await AppDataSource.getRepository(BizOutboundOrder).update({ id: malformedOrder.id }, { businessNo: malformedNo })
    const beforeMalformedAttempt = await snapshot()
    await assert.rejects(
      () => dataMaintenanceService.importJson(stalePayload, admin, requestMeta),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
      `物理订单业务号 ${malformedNo} 不可被导入领养`,
    )
    assert.equal(await snapshot(), beforeMalformedAttempt, '异常物理单号拒绝后六表、游标与成功审计必须回滚')
  }
  await AppDataSource.getRepository(BizOutboundOrder).delete({ id: malformedOrder.id })
  console.log('✅ SQLite 超位宽或超安全整数的物理业务号拒绝导入并完整回滚')

  const lateFailurePayload = JSON.parse(JSON.stringify(stalePayload))
  const raisedCurrent = lateFailurePayload.tables.systemConfigs.find((row: { configKey: string }) =>
    row.configKey === 'order.business.department.current')
  assert.ok(raisedCurrent)
  raisedCurrent.configValue = '500'
  const beforeLateFailure = await snapshot()
  await AppDataSource.query(`CREATE TRIGGER reject_identifier_import_audit_test
    BEFORE INSERT ON sys_audit_log
    WHEN NEW.action_type = 'data_maintenance.import_json'
      AND (SELECT current_value FROM business_sequence WHERE sequence_key = 'order.business.department') >= 500
    BEGIN SELECT RAISE(ABORT, 'injected late audit failure'); END`)
  await assert.rejects(() => dataMaintenanceService.importJson(lateFailurePayload, admin, requestMeta), /injected late audit failure/)
  assert.equal(await snapshot(), beforeLateFailure, '编号领养后审计失败须连同六表和游标完整回滚')
  console.log('✅ SQLite 编号领养后审计失败，六表、游标与成功审计均回滚')

  await AppDataSource.query(`CREATE TRIGGER reject_identifier_import_table_trigger
    BEFORE DELETE ON system_configs BEGIN SELECT RAISE(ABORT, 'untrusted table trigger'); END`)
  await assert.rejects(
    () => dataMaintenanceService.importJson(stalePayload, admin, requestMeta),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    '六张导入表的未知触发器必须在删除前拒绝',
  )
  assert.equal(await snapshot(), beforeLateFailure)
  console.log('✅ SQLite 六表未知触发器阻断导入')
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  const resolved = path.resolve(runtimeDir)
  if (!resolved.startsWith(`${runtimeRoot}${path.sep}`)) throw new Error('拒绝清理范围外验证目录')
  fs.rmSync(resolved, { recursive: true, force: true })
}
