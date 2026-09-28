/**
 * 模块说明：隔离 MySQL JSON 导入事务回滚验证。
 * 文件职责：证明旧 clear()/TRUNCATE 无法回滚，并验证新导入对六表及游标的原子性。
 * 运行边界：只接受 127.0.0.1 随机高位端口、专用库名及显式匹配的临时 datadir。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DataSource, type DataSourceOptions } from 'typeorm'

const expectedDataDir = process.env.YLINK_IDENTIFIER_IMPORT_MYSQL_DATADIR
const databaseName = process.env.DB_NAME ?? ''
const port = Number(process.env.DB_PORT)
const runtimeRoot = path.resolve(process.cwd(), '..', '.local-dev')
assert.equal(process.env.DB_TYPE, 'mysql', '本验证仅允许隔离 MySQL')
assert.equal(process.env.DB_HOST, '127.0.0.1', '本验证仅允许本机回环地址')
assert.ok(Number.isInteger(port) && port >= 30000 && port <= 65000, '本验证仅允许随机高位端口')
assert.match(databaseName, /^ylink_identifier_import_verify_[a-f0-9]{8}$/, '本验证仅允许随机专用库名')
assert.ok(expectedDataDir, '缺少临时 MySQL datadir 归属证明')
assert.ok(path.resolve(expectedDataDir).startsWith(`${runtimeRoot}${path.sep}identifier-import-mysql-`), 'datadir 不在专用临时目录')
process.env.APP_PROFILE = 'identifier-import-mysql-verify'
process.env.DB_SYNC = 'false'
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

const { AppDataSource } = await import('../src/config/data-source.js')
const { systemConfigService } = await import('../src/services/system-config.service.js')
const { dataMaintenanceService } = await import('../src/services/data-maintenance.service.js')
const { assertDataMaintenanceImportBoundary } = await import('../src/services/data-maintenance-import-boundary.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { SystemConfig } = await import('../src/entities/system-config.entity.js')
const { BaseProduct } = await import('../src/entities/base-product.entity.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
const { O2oPreorderItem } = await import('../src/entities/o2o-preorder-item.entity.js')
const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')

const importTables = [
  'inventory_log', 'o2o_preorder_item', 'o2o_preorder', 'client_user', 'base_product', 'system_configs',
] as const

try {
  await AppDataSource.initialize()
  const [server] = await AppDataSource.query('SELECT @@port AS port, @@datadir AS dataDir, DATABASE() AS dbName') as Array<{
    port: number; dataDir: string; dbName: string
  }>
  assert.equal(Number(server.port), port)
  assert.equal(server.dbName, databaseName)
  assert.equal(path.resolve(server.dataDir), path.resolve(expectedDataDir), '连接目标并非新建的临时 MySQL 数据目录')
  await AppDataSource.synchronize()
  const configRepo = AppDataSource.getRepository(SystemConfig)
  await configRepo.insert({ configKey: 'test.baseline_truncate', configValue: '保留', configGroup: 'verify' })
  await assert.rejects(
    () => AppDataSource.transaction(async (manager) => {
      await manager.getRepository(SystemConfig).clear()
      throw new Error('预期回滚')
    }),
    /预期回滚/,
  )
  assert.equal(await configRepo.count(), 0, '原 TypeORM clear()/TRUNCATE 应复现隐式提交导致行丢失')
  console.log('✅ MySQL 原 clear()/TRUNCATE 的失败事务仍丢失原配置（基线缺陷已复现）')

  await systemConfigService.ensureDefaultConfigs()
  const user = await AppDataSource.getRepository(SysUser).save({
    username: `import_verify_${randomUUID().slice(0, 8)}`,
    passwordHash: 'test-only', displayName: '隔离 MySQL 导入管理员', role: 'admin', status: 'enabled',
  })
  const actor = {
    userId: String(user.id), username: user.username, displayName: user.displayName,
    role: 'admin' as const, permissions: ['data_maintenance:import', 'system_configs:view'],
    status: 'enabled' as const, sessionToken: 'test-only',
  }
  const product = await AppDataSource.getRepository(BaseProduct).save({
    productCode: 'P-IMPORT-VERIFY', productName: '隔离导入商品', defaultPrice: '1.00',
    isActive: true, o2oStatus: 'listed', currentStock: 2, preOrderedStock: 1,
  })
  const client = await AppDataSource.getRepository(ClientUser).save({
    mobile: '13800000001', passwordHash: 'test-only', realName: '隔离导入用户', status: 'enabled',
  })
  const preorder = await AppDataSource.getRepository(O2oPreorder).save({
    preorderNo: 'PRE-W-000075', clientUserId: client.id, verifyCode: 'mysql-import-verify-code',
    status: 'pending', clientOrderType: 'walkin', totalQty: 1,
  })
  await AppDataSource.getRepository(O2oPreorderItem).save({
    orderId: preorder.id, productId: product.id, qty: 1,
  })
  await AppDataSource.getRepository(InventoryLog).save({
    productId: product.id, changeType: 'verify', changeQty: 1,
    beforeCurrentStock: 1, afterCurrentStock: 2,
    beforePreorderedStock: 0, afterPreorderedStock: 1,
  })

  const exportPayload = JSON.parse(JSON.stringify(await dataMaintenanceService.exportJson(actor)))
  assert.ok(exportPayload.tables.systemConfigs.some((row: { configValue: string }) => row.configValue === ''),
    '真实 MySQL 导出夹具应包含空字符串的默认系统配置')
  const legacyPayload = JSON.parse(JSON.stringify(exportPayload))
  legacyPayload.version = 'o2o-preorder-v1'
  legacyPayload.tables.systemConfigs = legacyPayload.tables.systemConfigs.filter((row: { configKey: string }) =>
    !/^(order\.system\.|order\.business\.|o2o\.preorder\.)/.test(row.configKey))
  legacyPayload.tables.preorders = legacyPayload.tables.preorders.map((row: { preorderNo?: string; showNo: string }) => {
    const legacyRow = { ...row }
    delete legacyRow.preorderNo
    return legacyRow
  })
  await dataMaintenanceService.importJson(legacyPayload, actor)
  const identifiers = await systemConfigService.getOrderIdentifierConfigs()
  assert.equal(identifiers.preorder.walkin.current, 75, 'MySQL 旧备份回灌须领养 PRE 物理高水位')
  assert.equal(identifiers.business.walkin.prefix, 'hyyz')
  console.log('✅ MySQL v1 旧备份回灌后六套编号配置可读，PRE 物理高水位为 75')

  const snapshot = async () => {
    const tables = Object.fromEntries(await Promise.all(importTables.map(async (table) => [
      table,
      await AppDataSource.query(`SELECT * FROM ${table} ORDER BY id`),
    ])))
    const sequences = await AppDataSource.query('SELECT * FROM business_sequence ORDER BY sequence_key')
    return JSON.stringify({ tables, sequences })
  }

  await AppDataSource.query(`CREATE TABLE identifier_import_external_cascade (
    client_user_id BIGINT UNSIGNED NOT NULL,
    CONSTRAINT fk_identifier_import_external_cascade_client
      FOREIGN KEY (client_user_id) REFERENCES client_user(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`)
  await AppDataSource.query('INSERT INTO identifier_import_external_cascade (client_user_id) VALUES (?)', [client.id])
  const probeUser = `metadata_probe_${randomUUID().slice(0, 8)}`
  const probeAccount = `'${probeUser}'@'127.0.0.1'`
  await AppDataSource.query(`CREATE USER ${probeAccount} IDENTIFIED BY ''`)
  for (const table of importTables) {
    await AppDataSource.query(`GRANT SELECT, DELETE, TRIGGER ON \`${databaseName}\`.\`${table}\` TO ${probeAccount}`)
  }
  for (const table of ['business_sequence', 'sys_audit_log']) {
    await AppDataSource.query(`GRANT SELECT ON \`${databaseName}\`.\`${table}\` TO ${probeAccount}`)
  }
  const probeDataSource = new DataSource({
    ...AppDataSource.options,
    username: probeUser,
    password: '',
  } as DataSourceOptions)
  try {
    await probeDataSource.initialize()
    const [identity] = await probeDataSource.query('SELECT CURRENT_USER() AS account') as Array<{ account: string }>
    assert.equal(identity.account, `${probeUser}@127.0.0.1`)
    const metadataCount = async () => Number((await probeDataSource.query(`SELECT COUNT(1) AS count
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'client_user'
        AND TABLE_NAME = 'identifier_import_external_cascade'`))[0].count)
    assert.equal(await metadataCount(), 0, '仅六表的表级授权无法看见外部子表 FK')
    await assert.rejects(
      () => probeDataSource.transaction('REPEATABLE READ', (manager) => assertDataMaintenanceImportBoundary(manager)),
      (error: unknown) => (error as { statusCode?: number; message?: string }).statusCode === 409
        && String((error as Error).message).includes('schema 级 SELECT'),
      '外部 FK 元数据不可见时必须先按权限门禁拒绝',
    )
    await AppDataSource.query(`GRANT SELECT ON \`${databaseName}\`.* TO ${probeAccount}`)
    // 数据库级授权对已存在的连接不一定即时生效；重新建立连接后核对元数据。
    await probeDataSource.destroy()
    await probeDataSource.initialize()
    assert.equal(await metadataCount(), 1, 'schema SELECT 应使当前库外部 FK 可见')
    await assert.rejects(
      () => probeDataSource.transaction('REPEATABLE READ', (manager) => assertDataMaintenanceImportBoundary(manager)),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
      '外部 FK 可见后仍须由 CASCADE 数据门禁拒绝',
    )
  } finally {
    if (probeDataSource.isInitialized) await probeDataSource.destroy()
  }
  console.log('✅ MySQL 表级权限看不到外部 FK 时导入拒绝，schema SELECT 后由 CASCADE 门禁拒绝')
  const beforeCascadeAttempt = await snapshot()
  await assert.rejects(
    () => dataMaintenanceService.importJson(legacyPayload, actor),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    '存在六表外 CASCADE 引用时必须拒绝 MySQL 导入',
  )
  assert.equal(Number((await AppDataSource.query('SELECT COUNT(1) AS count FROM identifier_import_external_cascade'))[0].count), 1)
  assert.equal(await snapshot(), beforeCascadeAttempt, '拒绝导入不能改写六表或游标')
  await AppDataSource.query('DELETE FROM identifier_import_external_cascade')
  console.log('✅ MySQL 六表外 CASCADE 引用阻断导入且原数据保留')

  await AppDataSource.query(`CREATE TABLE identifier_import_external_set_null (
    client_user_id BIGINT UNSIGNED NULL,
    CONSTRAINT fk_identifier_import_external_set_null_client
      FOREIGN KEY (client_user_id) REFERENCES client_user(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`)
  await AppDataSource.query('INSERT INTO identifier_import_external_set_null (client_user_id) VALUES (?)', [client.id])
  await assert.rejects(
    () => dataMaintenanceService.importJson(legacyPayload, actor),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    '存在六表外 SET NULL 引用时必须拒绝 MySQL 导入',
  )
  assert.equal(String((await AppDataSource.query('SELECT client_user_id AS clientUserId FROM identifier_import_external_set_null'))[0].clientUserId), String(client.id))
  await AppDataSource.query('DELETE FROM identifier_import_external_set_null')
  console.log('✅ MySQL 六表外 SET NULL 引用阻断导入且原外键值保留')

  const malformedOrder = await AppDataSource.getRepository(BizOutboundOrder).save({
    orderUuid: randomUUID(), systemNo: 'OUT-W-000050', businessNo: 'hyyz1234567',
    idempotencyKey: `identifier-import-malformed-${randomUUID()}`, orderType: 'walkin',
  })
  for (const malformedNo of ['hyyz1234567', 'hyyz9007199254740993']) {
    await AppDataSource.getRepository(BizOutboundOrder).update({ id: malformedOrder.id }, { businessNo: malformedNo })
    const beforeMalformedAttempt = await snapshot()
    await assert.rejects(
      () => dataMaintenanceService.importJson(legacyPayload, actor),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
      `物理订单业务号 ${malformedNo} 不可被导入领养`,
    )
    assert.equal(await snapshot(), beforeMalformedAttempt, '异常物理单号拒绝后六表与游标必须回滚')
  }
  await AppDataSource.getRepository(BizOutboundOrder).delete({ id: malformedOrder.id })
  console.log('✅ MySQL 超位宽或超安全整数的物理业务号拒绝导入并完整回滚')

  const raisedPayload = JSON.parse(JSON.stringify(exportPayload))
  const raisedCurrent = raisedPayload.tables.systemConfigs.find((row: { configKey: string }) =>
    row.configKey === 'order.business.department.current')
  assert.ok(raisedCurrent)
  raisedCurrent.configValue = '500'
  const beforeLateFailure = await snapshot()
  const successfulAuditsBefore = await AppDataSource.query(`SELECT COUNT(1) AS count FROM sys_audit_log
    WHERE action_type = 'data_maintenance.import_json' AND result_status = 'success'`)
  await AppDataSource.query(`CREATE TRIGGER reject_identifier_import_audit_test
    BEFORE INSERT ON sys_audit_log FOR EACH ROW
    BEGIN
      IF NEW.action_type = 'data_maintenance.import_json'
        AND (SELECT current_value FROM business_sequence WHERE sequence_key = 'order.business.department') >= 500 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected late audit failure';
      END IF;
    END`)
  await assert.rejects(() => dataMaintenanceService.importJson(raisedPayload, actor), /injected late audit failure/)
  assert.equal(await snapshot(), beforeLateFailure, '编号领养后审计失败须连同六表和游标完整回滚')
  assert.deepEqual(await AppDataSource.query(`SELECT COUNT(1) AS count FROM sys_audit_log
    WHERE action_type = 'data_maintenance.import_json' AND result_status = 'success'`), successfulAuditsBefore)
  console.log('✅ MySQL 编号领养后审计失败，六表、游标与成功审计均回滚')

  await AppDataSource.query(`CREATE TRIGGER reject_identifier_import_table_trigger
    BEFORE DELETE ON system_configs FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'untrusted table trigger'`)
  await assert.rejects(
    () => dataMaintenanceService.importJson(exportPayload, actor),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    '六张导入表的未知触发器必须在删除前拒绝',
  )
  assert.equal(await snapshot(), beforeLateFailure)
  console.log('✅ MySQL 六表未知触发器阻断导入')
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
}
