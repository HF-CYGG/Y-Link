/**
 * 模块说明：Issue #110 编号分离审查修复专项验证。
 * 文件职责：覆盖删除尾号回收、业务号游标、保留幂等键、旧配置停写、重启回灌与合并搜索命中元数据。
 */

import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const sliceMethodSource = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0 && end > start, `无法定位方法源码：${startMarker}`)
  return source.slice(start, end)
}

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-identifier-review-'))
process.env.APP_PROFILE = 'identifier-review-verify'
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = path.join(runtimeDir, 'verification.sqlite')
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

const { AppDataSource } = await import('../src/config/data-source.js')
const {
  prepareDatabaseRuntime,
  initializeDatabaseSchemaIfNeeded,
  backfillSqliteOrderAmendmentData,
} = await import('../src/config/database-bootstrap.js')
const { systemConfigService } = await import('../src/services/system-config.service.js')
const { orderSerialService } = await import('../src/services/order-serial.service.js')
const { orderBusinessNoService } = await import('../src/services/order-business-no.service.js')
const { orderService } = await import('../src/services/order.service.js')
const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
const { BusinessSequence } = await import('../src/entities/business-sequence.entity.js')
const { SystemConfig } = await import('../src/entities/system-config.entity.js')
const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const { SysUser } = await import('../src/entities/sys-user.entity.js')
const { OrderMergeOperation } = await import('../src/entities/order-merge-operation.entity.js')
const { OrderMergeRelation } = await import('../src/entities/order-merge-relation.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
const { resolvePendingMysqlOrderIdentifierNamespaces } = await import('../src/config/mysql-migration-runner.js')
const { projectSystemIdentifiersForRole } = await import('../src/utils/system-identifier-visibility.js')

type OrderType = 'department' | 'walkin'
type IdentifierKind = 'system' | 'preorder'
type IdentifierRollbackApi = {
  rollbackDeletedIdentifierBatch(
    kind: IdentifierKind,
    orderType: OrderType,
    deletedIdentifiers: string[],
    manager?: typeof AppDataSource.manager,
  ): Promise<{ beforeCurrent: number; current: number; rolledBack: boolean }>
}

const expectBizError = async (action: () => Promise<unknown>, statusCode: number, message: RegExp) => {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal((error as Error & { statusCode?: number }).statusCode, statusCode, error.message)
    assert.match(error.message, message)
    return true
  })
}

try {
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()

  const cachedProjectionSource = {
    order: {
      systemNo: 'OUT-W-009999',
      showNo: 'OUT-W-009999',
      businessNo: 'hyyz009999',
      matchedIdentifierType: 'systemNo',
      matchedIdentifierValue: 'OUT-W-009999',
    },
  }
  const operatorProjection = projectSystemIdentifiersForRole(cachedProjectionSource, 'operator') as {
    order: Record<string, unknown>
  }
  assert.equal('systemNo' in operatorProjection.order, false, '普通账号统一响应投影不得保留 systemNo')
  assert.equal('showNo' in operatorProjection.order, false, '普通账号统一响应投影不得保留旧 showNo 别名')
  assert.equal(operatorProjection.order.matchedIdentifierType, null, '普通账号统一响应投影不得保留 systemNo 命中类型')
  assert.equal(operatorProjection.order.matchedIdentifierValue, null, '普通账号统一响应投影不得保留 systemNo 命中值')
  assert.equal(cachedProjectionSource.order.systemNo, 'OUT-W-009999', '响应投影不得原地污染服务缓存或复用对象')
  assert.deepEqual(projectSystemIdentifiersForRole(cachedProjectionSource, 'admin'), cachedProjectionSource, '管理员必须保留 canonical 与兼容字段')

  const configRepo = AppDataSource.getRepository(SystemConfig)
  const sequenceRepo = AppDataSource.getRepository(BusinessSequence)
  const setCursor = async (sequenceKey: string, currentKey: string, current: number) => {
    await configRepo.update({ configKey: currentKey }, { configValue: String(current) })
    await sequenceRepo.save(sequenceRepo.create({ sequenceKey, currentValue: current }))
  }
  const readCursor = async (sequenceKey: string) => Number(
    (await sequenceRepo.findOneByOrFail({ sequenceKey })).currentValue,
  )

  const rollbackApi = orderSerialService as unknown as Partial<IdentifierRollbackApi>
  assert.equal(
    typeof rollbackApi.rollbackDeletedIdentifierBatch,
    'function',
    'RED：缺少按锁定游标单步回收连续删除后缀的统一入口',
  )
  if (!rollbackApi.rollbackDeletedIdentifierBatch) throw new Error('缺少编号删除尾号回收入口')

  await setCursor('order.system.walkin', 'order.system.walkin.current', 10)
  await rollbackApi.rollbackDeletedIdentifierBatch('system', 'walkin', ['OUT-W-000009'])
  assert.equal(await readCursor('order.system.walkin'), 10, '删除非尾号 systemNo 不得降低游标')
  await rollbackApi.rollbackDeletedIdentifierBatch('system', 'walkin', ['OUT-W-000010'])
  assert.equal(await readCursor('order.system.walkin'), 9, '删除当前尾号 systemNo 只能单步回退')
  await setCursor('order.system.walkin', 'order.system.walkin.current', 11)
  await rollbackApi.rollbackDeletedIdentifierBatch('system', 'walkin', ['OUT-W-000010', 'OUT-W-000011'])
  assert.equal(await readCursor('order.system.walkin'), 9, 'systemNo 批量删除必须按倒序回收连续后缀')

  await setCursor('o2o.preorder.walkin', 'o2o.preorder.walkin.current', 10)
  await rollbackApi.rollbackDeletedIdentifierBatch('preorder', 'walkin', ['PRE-W-000009'])
  assert.equal(await readCursor('o2o.preorder.walkin'), 10, '删除非尾号 preorderNo 不得降低游标')
  await rollbackApi.rollbackDeletedIdentifierBatch('preorder', 'walkin', ['PRE-W-000010'])
  assert.equal(await readCursor('o2o.preorder.walkin'), 9, '删除当前尾号 preorderNo 只能单步回退')
  await setCursor('o2o.preorder.walkin', 'o2o.preorder.walkin.current', 11)
  await rollbackApi.rollbackDeletedIdentifierBatch('preorder', 'walkin', ['PRE-W-000010', 'PRE-W-000011'])
  assert.equal(await readCursor('o2o.preorder.walkin'), 9, 'preorderNo 批量删除必须按倒序回收连续后缀')

  await setCursor('order.business.department', 'order.business.department.current', 5)
  await configRepo.update({ configKey: 'order.business.department.current' }, { configValue: '100' })
  await AppDataSource.transaction((manager) => orderBusinessNoService.reserveConfirmed(
    'hyyzjd000010',
    'department',
    randomUUID(),
    '审查回归',
    manager,
  ))
  assert.equal(await readCursor('order.business.department'), 100, '确认低号不得把 sequence 从配置高水位 100 降到 10')
  assert.equal(
    (await configRepo.findOneByOrFail({ configKey: 'order.business.department.current' })).configValue,
    '100',
    '确认低号不得降低 business current 配置镜像',
  )

  const actorRow = await AppDataSource.getRepository(SysUser).save({
    username: `identifier_review_${Date.now()}`,
    passwordHash: 'test-only',
    displayName: '编号审查管理员',
    role: 'admin',
    status: 'enabled',
  })
  const actor = {
    userId: String(actorRow.id),
    username: actorRow.username,
    displayName: actorRow.displayName,
    role: 'admin' as const,
    permissions: ['orders:view', 'orders:create', 'orders:update', 'orders:delete', 'system_configs:view', 'system_configs:update'],
    status: 'enabled' as const,
    sessionToken: 'identifier-review-test',
  }
  const operatorActor = {
    ...actor,
    role: 'operator' as const,
    username: 'identifier_review_operator',
    displayName: '编号审查普通操作员',
  }

  const systemConfigRouteSource = fs.readFileSync(
    path.join(backendRoot, 'src/routes/system-config.routes.ts'),
    'utf8',
  )
  const systemConfigServiceSource = fs.readFileSync(
    path.join(backendRoot, 'src/services/system-config.service.ts'),
    'utf8',
  )
  const orderSerialServiceSource = fs.readFileSync(
    path.join(backendRoot, 'src/services/order-serial.service.ts'),
    'utf8',
  )
  const canonicalUpdateSource = sliceMethodSource(
    systemConfigServiceSource,
    '  async updateOrderIdentifierConfigs(',
    '  /**\n   * 写时失效',
  )
  assert.match(
    systemConfigServiceSource,
    /ORDER_IDENTIFIER_LOCK_ORDER\s*=\s*\[\s*\{\s*orderType:\s*'walkin',\s*kind:\s*'system'\s*\}[\s\S]*\{\s*orderType:\s*'department',\s*kind:\s*'business'\s*\}[\s\S]*\]\s*as const/,
    '多 namespace canonical 更新必须固定使用 walkin→department、system→preorder→business 锁序',
  )
  assert.match(canonicalUpdateSource, /const lockedActor = await lockActiveSysAccountForBusiness/, 'canonical 更新必须在事务内锁后重验管理员账号')
  assert.match(canonicalUpdateSource, /lockedActor\.role !== 'admin'[\s\S]*actor\.permissions\.includes\('system_configs:update'\)/, 'canonical 更新必须在锁后重验角色与配置写权限')
  const canonicalSequenceLockIndex = canonicalUpdateSource.indexOf('const lockedSequences')
  const canonicalDefaultRepairIndex = canonicalUpdateSource.indexOf('ensureOrderIdentifierDefaultsForUpdate')
  const canonicalConfigLockIndex = canonicalUpdateSource.indexOf('const configQuery')
  assert.ok(
    canonicalSequenceLockIndex >= 0
      && canonicalSequenceLockIndex < canonicalDefaultRepairIndex
      && canonicalDefaultRepairIndex < canonicalConfigLockIndex,
    'canonical 更新必须先按稳定顺序锁定全部 sequence，再补默认配置并锁定 config',
  )
  assert.match(canonicalUpdateSource, /orderBy\('config\.configKey', 'ASC'\)[\s\S]*setLock\('pessimistic_write'\)/, '同 namespace 的 config 行必须按 configKey 固定顺序加锁')

  for (const [startMarker, endMarker, label] of [
    ['  private async rollbackDeletedIdentifierBatchWithManager(', '  private async generateIdentifierNo(', '删除回收'],
    ['  private async generateIdentifierNoWithManager(', '  private async loadIdentifierMaxSerial(', '编号生成'],
  ] as const) {
    const methodSource = sliceMethodSource(orderSerialServiceSource, startMarker, endMarker)
    const sequenceLockIndex = methodSource.indexOf('loadSequenceForUpdate')
    const lockedConfigReadIndex = methodSource.indexOf('loadSerialConfig(rule.configKeyPrefix, manager, true)')
    assert.ok(
      sequenceLockIndex >= 0 && sequenceLockIndex < lockedConfigReadIndex,
      `${label}必须先锁 sequence，再重新 FOR UPDATE 读取并校验 config`,
    )
  }
  assert.doesNotMatch(
    systemConfigRouteSource,
    /updateOrderSerialConfigsSchema|systemConfigService\.updateOrderSerialConfigs/,
    '旧 PUT /order-serial 不得继续解析旧结构或进入不可达服务层写方法',
  )
  assert.match(
    systemConfigRouteSource,
    /systemConfigRouter\.put\([\s\S]*?'\/order-serial'[\s\S]*?throw new BizError\([^\n]*410\)/,
    '旧 PUT /order-serial 必须在权限门禁后由路由直接返回 410',
  )
  assert.doesNotMatch(
    systemConfigServiceSource,
    /async updateOrderSerialConfigs\(/,
    '服务层不得继续暴露已弃用的旧流水写方法',
  )

  const canonicalConfigApi = systemConfigService as unknown as {
    getOrderIdentifierConfigs?: () => Promise<unknown>
    updateOrderIdentifierConfigs?: (input: unknown, currentActor: typeof actor) => Promise<unknown>
  }
  assert.equal(typeof canonicalConfigApi.getOrderIdentifierConfigs, 'function', '缺少三套编号 canonical 读取契约')
  assert.equal(typeof canonicalConfigApi.updateOrderIdentifierConfigs, 'function', '缺少三套编号 canonical 写入契约')
  if (!canonicalConfigApi.getOrderIdentifierConfigs || !canonicalConfigApi.updateOrderIdentifierConfigs) {
    throw new Error('缺少三套编号 canonical 读写契约')
  }
  type CanonicalIdentifierConfigs = Record<'system' | 'preorder' | 'business', Record<OrderType, {
    prefix: string
    start: number
    current: number
    width: number
  }>>
  const readCanonicalConfigs = async () => canonicalConfigApi.getOrderIdentifierConfigs!() as Promise<CanonicalIdentifierConfigs>
  const toCanonicalInput = (configs: CanonicalIdentifierConfigs) => Object.fromEntries(
    Object.entries(configs).map(([kind, group]) => [kind, Object.fromEntries(
      Object.entries(group).map(([orderType, value]) => [orderType, {
        start: value.start,
        current: value.current,
        width: value.width,
      }]),
    )]),
  ) as Record<'system' | 'preorder' | 'business', Record<OrderType, { start: number; current: number; width: number }>>

  const permissionRecheckInput = toCanonicalInput(await readCanonicalConfigs())
  await expectBizError(
    () => canonicalConfigApi.updateOrderIdentifierConfigs!(permissionRecheckInput, {
      ...actor,
      permissions: actor.permissions.filter((permission) => permission !== 'system_configs:update'),
    }),
    403,
    /无权/,
  )
  await AppDataSource.getRepository(SysUser).update({ id: actor.userId }, { role: 'operator' })
  await expectBizError(
    () => canonicalConfigApi.updateOrderIdentifierConfigs!(permissionRecheckInput, actor),
    403,
    /无权/,
  )
  await AppDataSource.getRepository(SysUser).update({ id: actor.userId }, { role: 'admin' })

  await configRepo.update({ configKey: 'order.business.department.start' }, { configValue: '7' })
  await configRepo.update({ configKey: 'order.business.department.width' }, { configValue: '8' })
  await configRepo.update({ configKey: 'order.business.department.current' }, { configValue: '100' })
  await sequenceRepo.update({ sequenceKey: 'order.business.department' }, { currentValue: 100 })
  const historicalShape = await readCanonicalConfigs()
  assert.equal(historicalShape.business.department.start, 7, '必须忠实回显历史 business start')
  assert.equal(historicalShape.business.department.width, 8, '必须忠实回显历史 business width')
  const unchangedHistoricalResult = await canonicalConfigApi.updateOrderIdentifierConfigs(
    toCanonicalInput(historicalShape),
    actor,
  ) as { changed: boolean }
  assert.equal(unchangedHistoricalResult.changed, false, '忠实回传历史 business shape 不应被误判为变更')

  const changedBusinessInput = toCanonicalInput(historicalShape)
  changedBusinessInput.business.department.current += 1
  await expectBizError(
    () => canonicalConfigApi.updateOrderIdentifierConfigs!(changedBusinessInput, actor),
    400,
    /business.*只读|业务号.*只读/i,
  )
  assert.equal((await readCanonicalConfigs()).business.department.current, 100, '不得通过 canonical PUT 提升 business current')

  const overflowInput = toCanonicalInput(await readCanonicalConfigs())
  overflowInput.system.walkin.current = 1_000_000
  await expectBizError(
    () => canonicalConfigApi.updateOrderIdentifierConfigs!(overflowInput, actor),
    400,
    /位宽|上限/,
  )
  const unsafeInput = toCanonicalInput(await readCanonicalConfigs())
  unsafeInput.system.walkin.current = Number.MAX_SAFE_INTEGER + 1
  await expectBizError(
    () => canonicalConfigApi.updateOrderIdentifierConfigs!(unsafeInput, actor),
    400,
    /安全整数|非负整数/,
  )

  const mirrorBefore = await readCanonicalConfigs()
  const mirrorTarget = mirrorBefore.system.walkin.current
  assert.ok(mirrorTarget > 0, '镜像修复用例需要正数高水位')
  await configRepo.update({ configKey: 'order.system.walkin.current' }, { configValue: String(mirrorTarget - 1) })
  const mirrorResult = await canonicalConfigApi.updateOrderIdentifierConfigs(
    toCanonicalInput(await readCanonicalConfigs()),
    actor,
  ) as { changed: boolean }
  assert.equal(mirrorResult.changed, true, '目标等于有效高水位但双镜像分叉时必须自愈')
  assert.equal(
    (await configRepo.findOneByOrFail({ configKey: 'order.system.walkin.current' })).configValue,
    String(mirrorTarget),
    '镜像修复必须回写 config current',
  )
  const mirrorAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'system_config.update_order_identifiers' },
    order: { id: 'DESC' },
  })
  const mirrorAuditDetail = JSON.parse(mirrorAudit.detailJson ?? '{}') as {
    changes?: Record<string, { mode?: string }>
  }
  assert.equal(mirrorAuditDetail.changes?.['order.system.walkin']?.mode, 'mirror_repair', '审计必须区分镜像修复与流水提升')

  const concurrencyBefore = await readCanonicalConfigs()
  const concurrentTarget = toCanonicalInput(concurrencyBefore)
  concurrentTarget.system.department.current += 5
  concurrentTarget.preorder.walkin.current += 5
  const concurrentResult = await Promise.race([
    Promise.all([
      canonicalConfigApi.updateOrderIdentifierConfigs(concurrentTarget, actor),
      orderSerialService.generateSystemNo('department'),
      orderSerialService.generatePreorderNo('walkin'),
    ]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('canonical 配置更新与开单流水并发超时')), 5_000)),
  ])
  assert.match(concurrentResult[1], /^OUT-D-\d{6}$/, '并发 systemNo 生成结果格式必须保持不变')
  assert.match(concurrentResult[2], /^PRE-W-\d{6}$/, '并发 preorderNo 生成结果格式必须保持不变')
  const concurrencyAfter = await readCanonicalConfigs()
  for (const [kind, orderType, target] of [
    ['system', 'department', concurrentTarget.system.department.current],
    ['preorder', 'walkin', concurrentTarget.preorder.walkin.current],
  ] as const) {
    const keyPrefix = kind === 'system' ? `order.system.${orderType}` : `o2o.preorder.${orderType}`
    const sequenceCurrent = Number((await sequenceRepo.findOneByOrFail({ sequenceKey: keyPrefix })).currentValue)
    const configCurrent = Number((await configRepo.findOneByOrFail({ configKey: `${keyPrefix}.current` })).configValue)
    assert.equal(sequenceCurrent, configCurrent, `${kind}.${orderType} 并发后 sequence/config 镜像必须一致`)
    assert.equal(concurrencyAfter[kind][orderType].current, sequenceCurrent, `${kind}.${orderType} canonical 读取必须以并发后 sequence 为真源`)
    assert.ok(sequenceCurrent >= target && sequenceCurrent <= target + 1, `${kind}.${orderType} 并发调号与生成不得丢失或重复推进高水位`)
  }

  await configRepo.delete({ configKey: 'order.system.walkin.width' })
  ;(systemConfigService as unknown as { defaultConfigsEnsured: boolean }).defaultConfigsEnsured = false
  await expectBizError(
    () => canonicalConfigApi.getOrderIdentifierConfigs!(),
    500,
    /编号配置缺失|配置不完整/,
  )
  assert.equal(await configRepo.exist({ where: { configKey: 'order.system.walkin.width' } }), false, 'canonical GET 必须保持纯读，不得自动补配置')
  await configRepo.save(configRepo.create({
    configKey: 'order.system.walkin.width',
    configValue: '6',
    configGroup: 'order_identifier',
    remark: '正式出库单散客系统号位宽',
  }))
  ;(systemConfigService as unknown as { defaultConfigsEnsured: boolean }).defaultConfigsEnsured = true

  const invalidCurrentBefore = (await configRepo.findOneByOrFail({ configKey: 'o2o.preorder.walkin.current' })).configValue
  const invalidSequenceBefore = (await sequenceRepo.findOneByOrFail({ sequenceKey: 'o2o.preorder.walkin' })).currentValue
  await configRepo.update({ configKey: 'o2o.preorder.walkin.current' }, { configValue: '1000000' })
  await sequenceRepo.update({ sequenceKey: 'o2o.preorder.walkin' }, { currentValue: 1_000_000 })
  await expectBizError(
    () => canonicalConfigApi.getOrderIdentifierConfigs!(),
    500,
    /位宽|上限|非法/,
  )
  assert.equal((await configRepo.findOneByOrFail({ configKey: 'o2o.preorder.walkin.current' })).configValue, '1000000', '读取非法高水位不得静默降低')
  await configRepo.update({ configKey: 'o2o.preorder.walkin.current' }, { configValue: invalidCurrentBefore })
  await sequenceRepo.update({ sequenceKey: 'o2o.preorder.walkin' }, { currentValue: invalidSequenceBefore })

  await configRepo.update({ configKey: 'order.serial.department.start' }, { configValue: '3' })
  await configRepo.update({ configKey: 'order.serial.department.width' }, { configValue: '8' })
  await configRepo.update({ configKey: 'order.serial.department.current' }, { configValue: '700000' })
  await sequenceRepo.save(sequenceRepo.create({ sequenceKey: 'order.serial.department', currentValue: 990_000 }))
  await AppDataSource.getRepository(BizOutboundOrder).save({
    orderUuid: randomUUID(),
    systemNo: 'OUT-D-880099',
    businessNo: 'hyyzjd880099',
    idempotencyKey: `identifier-migration-physical-${randomUUID()}`,
    inventoryMode: 'legacy_none',
    orderType: 'department',
    status: 'active',
  })
  await configRepo.update({ configKey: 'order.business.department.start' }, { configValue: '1' })
  await configRepo.update({ configKey: 'order.business.department.width' }, { configValue: '6' })
  await configRepo.update({ configKey: 'order.business.department.current' }, { configValue: '0' })
  await configRepo.delete({ configKey: 'order.business.department.migration.055' })
  await sequenceRepo.update({ sequenceKey: 'order.business.department' }, { currentValue: 100 })
  await backfillSqliteOrderAmendmentData(AppDataSource)
  const firstBusinessMigration = await readCanonicalConfigs()
  assert.equal(firstBusinessMigration.business.department.start, 3, 'marker 缺失时必须以合法 legacy start 覆盖完整但错误的新值')
  assert.equal(firstBusinessMigration.business.department.width, 8, 'marker 缺失时必须以合法 legacy width 覆盖完整但错误的新值')
  assert.equal(firstBusinessMigration.business.department.current, 990_000, '首次迁移必须纳入 legacy business_sequence 高水位')
  assert.equal(await readCursor('order.business.department'), 990_000, '首次迁移必须同步 legacy sequence 高水位')

  await configRepo.update({ configKey: 'order.serial.department.start' }, { configValue: '4' })
  await configRepo.update({ configKey: 'order.serial.department.width' }, { configValue: '9' })
  await configRepo.update({ configKey: 'order.serial.department.current' }, { configValue: '999999' })
  await sequenceRepo.update({ sequenceKey: 'order.serial.department' }, { currentValue: 9_999_999 })
  const changesBeforeNoopReplay = await AppDataSource.query('SELECT total_changes() AS total') as Array<{ total: number }>
  await backfillSqliteOrderAmendmentData(AppDataSource)
  const changesAfterNoopReplay = await AppDataSource.query('SELECT total_changes() AS total') as Array<{ total: number }>
  assert.equal(
    Number(changesAfterNoopReplay[0]?.total),
    Number(changesBeforeNoopReplay[0]?.total),
    '完整 namespace 重放必须零写且不得刷新 updated_at',
  )
  const replayedBusinessMigration = await readCanonicalConfigs()
  assert.equal(replayedBusinessMigration.business.department.start, 3, 'marker 已存在后不得再次回灌 legacy start')
  assert.equal(replayedBusinessMigration.business.department.width, 8, '新 business config 已存在后不得再次回灌 legacy width')
  assert.equal(await readCursor('order.business.department'), 990_000, '后续启动不得从旧 order.serial.* sequence 回灌 business sequence')
  assert.equal(
    (await configRepo.findOneByOrFail({ configKey: 'order.business.department.current' })).configValue,
    '990000',
    '后续启动不得从旧 order.serial.* 回灌 business current',
  )

  const migrationSqlSource = fs.readFileSync(path.join(backendRoot, 'sql/055_order_identifier_namespaces.sql'), 'utf8')
  const databaseBootstrapSource = fs.readFileSync(path.join(backendRoot, 'src/config/database-bootstrap.ts'), 'utf8')
  const mysqlMigrationRunnerSource = fs.readFileSync(path.join(backendRoot, 'src/config/mysql-migration-runner.ts'), 'utf8')
  const canonicalNamespaceLockOrder = [
    'order.system.walkin',
    'o2o.preorder.walkin',
    'order.business.walkin',
    'order.system.department',
    'o2o.preorder.department',
    'order.business.department',
  ] as const
  const assertKeysInOrder = (source: string, keys: readonly string[], label: string) => {
    let previousIndex = -1
    for (const key of keys) {
      const currentIndex = source.indexOf(`'${key}'`)
      assert.ok(currentIndex > previousIndex, `${label} 必须按 canonical 顺序输出 ${key}`)
      previousIndex = currentIndex
    }
  }
  for (const orderType of ['department', 'walkin'] as const) {
    assert.match(
      migrationSqlSource,
      new RegExp(`@order_business_${orderType}_config_complete\\s*=\\s*\\(\\s*SELECT COUNT\\(1\\)[\\s\\S]*?IN \\(\\s*'order\\.business\\.${orderType}\\.start',[\\s\\S]*?'order\\.business\\.${orderType}\\.current',[\\s\\S]*?'order\\.business\\.${orderType}\\.width'[\\s\\S]*?\\)\\s*=\\s*3`, 'i'),
      `055 必须独立校验 ${orderType} namespace 三项配置完整性`,
    )
    assert.match(
      migrationSqlSource,
      new RegExp(`sequence_key.{0,40}order\\.serial\\.${orderType}`, 'is'),
      `055 首迁高水位必须纳入 legacy order.serial.${orderType} sequence`,
    )
    assert.match(
      migrationSqlSource,
      new RegExp(`@order_business_${orderType}_current\\s*=\\s*GREATEST\\([\\s\\S]*?IF\\(CAST\\(@order_business_${orderType}_start AS UNSIGNED\\) > 0,[\\s\\S]*?CAST\\(@order_business_${orderType}_start AS UNSIGNED\\) - 1`, 'i'),
      `055 高水位必须纳入 ${orderType} business start - 1`,
    )
    assert.match(
      migrationSqlSource,
      new RegExp(`order\\.business\\.${orderType}\\.migration\\.055`, 'i'),
      `055 必须为 ${orderType} business namespace 写入可靠迁移 marker`,
    )
    assert.match(
      migrationSqlSource,
      new RegExp(`@order_business_${orderType}_needs_migration`, 'i'),
      `055 必须按 ${orderType} namespace 独立决定是否迁移`,
    )
    assert.match(
      migrationSqlSource,
      new RegExp(`SET @order_business_${orderType}_start\\s*=\\s*COALESCE\\(\\s*IF\\([\\s\\S]*?@order_business_${orderType}_marker_complete\\s*=\\s*0[\\s\\S]*?order\\.serial\\.${orderType}\\.start[\\s\\S]*?order\\.business\\.${orderType}\\.start`, 'i'),
      `055 marker 缺失时必须让合法 legacy ${orderType} start 优先于现有新值`,
    )
    assert.match(
      migrationSqlSource,
      new RegExp(`VALUES\\(\\x60config_key\\x60\\) IN \\('order\\.business\\.${orderType}\\.start', 'order\\.business\\.${orderType}\\.width'\\)[\\s\\S]*?@order_business_${orderType}_marker_complete\\s*=\\s*0[\\s\\S]*?THEN VALUES\\(\\x60config_value\\x60\\)`, 'i'),
      `055 首迁 upsert 必须覆盖 ${orderType} 已存在但错误的 business shape`,
    )
  }
  assert.ok(
    migrationSqlSource.indexOf('INSERT INTO `business_sequence`') < migrationSqlSource.indexOf('INSERT INTO `system_configs`'),
    '055 必须与业务分配统一为 sequence -> config 锁顺序',
  )
  const businessSequenceStatement = migrationSqlSource.slice(
    migrationSqlSource.indexOf('INSERT INTO `business_sequence`'),
    migrationSqlSource.indexOf('INSERT INTO `system_configs`'),
  )
  assertKeysInOrder(businessSequenceStatement, canonicalNamespaceLockOrder, '055 sequence')
  assert.match(businessSequenceStatement, /ORDER BY\s+`lock_order`/i, '055 sequence 输出必须显式按 lock_order 排序')
  const identifierConfigStatement = migrationSqlSource.slice(
    migrationSqlSource.indexOf('INSERT INTO `system_configs`'),
    migrationSqlSource.indexOf('-- marker 最后写入'),
  )
  assertKeysInOrder(
    identifierConfigStatement,
    canonicalNamespaceLockOrder.flatMap((key) => [`${key}.current`, `${key}.start`, `${key}.width`]),
    '055 config',
  )
  assert.match(identifierConfigStatement, /ORDER BY\s+`lock_order`/i, '055 config 输出必须显式按 lock_order 排序')
  const markerStatement = migrationSqlSource.slice(migrationSqlSource.indexOf('-- marker 最后写入'))
  assertKeysInOrder(markerStatement, [
    'order.business.walkin.migration.055',
    'order.business.department.migration.055',
  ], '055 marker')
  assert.match(markerStatement, /ORDER BY\s+`lock_order`/i, '055 marker 输出必须显式按 lock_order 排序')
  assert.match(
    migrationSqlSource,
    /`updated_at`\s*=\s*IF\(\s*VALUES\(`current_value`\)\s*>\s*`business_sequence`\.`current_value`,\s*UTC_TIMESTAMP\(6\),\s*`business_sequence`\.`updated_at`\s*\)/i,
    '055 sequence 无高水位变化时不得改写 updated_at',
  )
  assert.match(mysqlMigrationRunnerSource, /export async function reconcileMysqlOrderIdentifierNamespaces\(/, '缺少 DB_AUTO_MIGRATE=false 也会执行的 MySQL 编号领养入口')
  assert.match(mysqlMigrationRunnerSource, /055_order_identifier_namespaces\.sql/, 'MySQL 启动领养必须复用 055 真源')
  assert.match(mysqlMigrationRunnerSource, /startTransaction\(\)[\s\S]*055_order_identifier_namespaces[\s\S]*commitTransaction\(\)/, 'MySQL 启动领养必须在事务内原子执行 055')
  assert.match(mysqlMigrationRunnerSource, /pendingNamespaces[\s\S]*pendingNamespaces\.length\s*===\s*0[\s\S]*return/, '完整 namespace 启动必须只读预检后零写返回')
  assert.match(databaseBootstrapSource, /appliedFiles\.includes\('055_order_identifier_namespaces\.sql'\)[\s\S]*reconcileMysqlOrderIdentifierNamespaces/, 'DB_AUTO_MIGRATE=true 当次已执行 055 后不得双跑 reconcile')
  assert.match(databaseBootstrapSource, /assertMysqlRequiredSchemaExists\(dataSource\)[\s\S]*reconcileMysqlOrderIdentifierNamespaces\(dataSource\)[\s\S]*migrateClientUserDepartmentGovernance/, 'DB_AUTO_MIGRATE=false 时必须在补默认配置前完成 MySQL 编号领养')
  assert.match(
    databaseBootstrapSource,
    /SQLITE_ORDER_IDENTIFIER_NAMESPACE_LOCK_ORDER\s*=\s*\[\s*'order\.system\.walkin',\s*'o2o\.preorder\.walkin',\s*'order\.business\.walkin',\s*'order\.system\.department',\s*'o2o\.preorder\.department',\s*'order\.business\.department',?\s*\]\s*as const/,
    'SQLite 编号命名空间必须与 canonical 六 key 锁序静态一致',
  )
  assert.deepEqual(resolvePendingMysqlOrderIdentifierNamespaces({
    departmentConfigCount: 3,
    departmentMarkerCount: 1,
    departmentSequenceCount: 1,
    walkinConfigCount: 3,
    walkinMarkerCount: 1,
    walkinSequenceCount: 1,
  }), [], '完整 namespace 启动必须判定为零写')
  assert.deepEqual(resolvePendingMysqlOrderIdentifierNamespaces({
    departmentConfigCount: 3,
    departmentMarkerCount: 1,
    departmentSequenceCount: 1,
    walkinConfigCount: 2,
    walkinMarkerCount: 0,
    walkinSequenceCount: 1,
  }), ['walkin'], '部分 namespace 未完成时只能迁移对应 namespace')
  assert.deepEqual(resolvePendingMysqlOrderIdentifierNamespaces({
    departmentConfigCount: 0,
    departmentMarkerCount: 0,
    departmentSequenceCount: 0,
    walkinConfigCount: 0,
    walkinMarkerCount: 0,
    walkinSequenceCount: 0,
  }), ['walkin', 'department'], 'MySQL reconcile 多 namespace 必须与 canonical 顺序统一为 walkin -> department')

  type SimulatedBusinessMigrationState = Partial<Record<'start' | 'current' | 'width', number>> & { sequence?: number; marker?: boolean }
  const simulateBusinessMigration = (
    state: SimulatedBusinessMigrationState,
    input: { legacyStart: number; legacyCurrent: number; legacyWidth: number; legacySequence: number; occupancy: number; physical: number },
  ): SimulatedBusinessMigrationState => {
    const absorbLegacy = state.marker !== true
    const start = absorbLegacy && input.legacyStart > 0 ? input.legacyStart : state.start ?? 1
    const width = absorbLegacy && input.legacyWidth >= 1 && input.legacyWidth <= 12 ? input.legacyWidth : state.width ?? 6
    return {
      start,
      width,
      current: Math.max(start - 1, state.current ?? 0, state.sequence ?? 0, input.occupancy, input.physical, absorbLegacy ? input.legacyCurrent : 0, absorbLegacy ? input.legacySequence : 0),
      sequence: Math.max(start - 1, state.sequence ?? 0, state.current ?? 0, input.occupancy, input.physical, absorbLegacy ? input.legacyCurrent : 0, absorbLegacy ? input.legacySequence : 0),
      marker: true,
    }
  }
  const simulatedFirstReplay = simulateBusinessMigration(
    { start: 1, current: 90, width: 6, sequence: 110 },
    { legacyStart: 3, legacyCurrent: 120, legacyWidth: 8, legacySequence: 130, occupancy: 125, physical: 128 },
  )
  assert.deepEqual(simulatedFirstReplay, { start: 3, current: 130, width: 8, sequence: 130, marker: true }, '055 首次模拟重放必须用 legacy shape 覆盖完整错误新值并取全来源高水位')
  const simulatedSecondReplay = simulateBusinessMigration(
    simulatedFirstReplay,
    { legacyStart: 4, legacyCurrent: 999, legacyWidth: 9, legacySequence: 999, occupancy: 125, physical: 128 },
  )
  assert.deepEqual(simulatedSecondReplay, simulatedFirstReplay, '055 第二次模拟重放不得重新吸收 legacy shape/highwater')

  await expectBizError(
    () => orderService.submit({
      idempotencyKey: `o2o-preorder-verify:${randomUUID()}`,
      orderType: 'walkin',
      customerName: '恶意保留前缀',
      items: [],
    }, actor),
    400,
    /保留|O2O/i,
  )
  const linkedResolver = orderService as unknown as {
    resolveLinkedO2oPreorderId(order: {
      idempotencyKey: string
      sourceDocType?: string | null
      sourceDocId?: string | null
    }): string | null
  }
  const forgedPreorderId = randomUUID()
  assert.equal(linkedResolver.resolveLinkedO2oPreorderId({
    idempotencyKey: `o2o-preorder-verify:${forgedPreorderId}`,
    sourceDocType: null,
    sourceDocId: null,
  }), null, '仅伪造保留 idempotencyKey 不得建立 O2O 关联')
  assert.equal(linkedResolver.resolveLinkedO2oPreorderId({
    idempotencyKey: 'ordinary-manual-key',
    sourceDocType: 'o2o_preorder',
    sourceDocId: forgedPreorderId,
  }), forgedPreorderId, 'O2O 关联必须以 sourceDocType/sourceDocId 为准')

  const client = await AppDataSource.getRepository(ClientUser).save({
    realName: '合并搜索客户',
    passwordHash: 'test-only',
    status: 'enabled',
    accountType: 'personal',
  })

  const createPreorder = (preorderNo: string, status: 'cancelled' | 'verified' = 'cancelled') => (
    AppDataSource.getRepository(O2oPreorder).save({
      preorderNo,
      clientUserId: client.id,
      verifyCode: randomUUID(),
      status,
      clientOrderType: 'walkin',
    })
  )
  const createOutbound = (input: {
    systemNo: string
    businessNo: string
    isDeleted?: boolean
    idempotencyKey?: string
    sourceDocType?: 'o2o_preorder' | null
    sourceDocId?: string | null
    sourceDocNo?: string | null
    inventoryMode?: 'legacy_none' | 'o2o_preapplied'
  }) => AppDataSource.getRepository(BizOutboundOrder).save({
    orderUuid: randomUUID(),
    systemNo: input.systemNo,
    businessNo: input.businessNo,
    idempotencyKey: input.idempotencyKey ?? `identifier-review-${randomUUID()}`,
    sourceDocType: input.sourceDocType ?? null,
    sourceDocId: input.sourceDocId ?? null,
    sourceDocNo: input.sourceDocNo ?? null,
    inventoryMode: input.inventoryMode ?? 'legacy_none',
    orderType: 'walkin',
    status: 'active',
    isDeleted: input.isDeleted ?? false,
  })

  const forgedReplayPreorder = await createPreorder('PRE-W-770001', 'verified')
  await createOutbound({
    systemNo: 'OUT-W-770001',
    businessNo: 'hyyz770001',
    idempotencyKey: `o2o-preorder-verify:${forgedReplayPreorder.id}`,
  })
  const createVerifiedOutboundOrder = o2oPreorderService as unknown as {
    createOutboundOrderFromVerifiedPreorder(
      manager: typeof AppDataSource.manager,
      input: { preorder: typeof forgedReplayPreorder; items: never[]; productMap: Map<string, never>; actor: typeof actor },
    ): Promise<unknown>
  }
  await expectBizError(
    () => AppDataSource.transaction((manager) => createVerifiedOutboundOrder.createOutboundOrderFromVerifiedPreorder(manager, {
      preorder: forgedReplayPreorder,
      items: [],
      productMap: new Map(),
      actor,
    })),
    409,
    /不匹配|占用/,
  )

  const prefixTarget = await createPreorder('PRE-W-770002')
  const structuredTarget = await createPreorder('PRE-W-770003')
  const conflictingLink = await createOutbound({
    systemNo: 'OUT-W-770002',
    businessNo: 'hyyz770002',
    idempotencyKey: `o2o-preorder-verify:${prefixTarget.id}`,
    sourceDocType: 'o2o_preorder',
    sourceDocId: structuredTarget.id,
    sourceDocNo: structuredTarget.preorderNo,
    inventoryMode: 'o2o_preapplied',
  })
  await orderService.softDeleteById(String(conflictingLink.id), actor, conflictingLink.businessNo)
  assert.equal(Boolean((await AppDataSource.getRepository(O2oPreorder).findOneByOrFail({ id: prefixTarget.id })).isDeleted), false, '删除同步不得信任幂等键中的伪造预订单 ID')
  assert.equal(Boolean((await AppDataSource.getRepository(O2oPreorder).findOneByOrFail({ id: structuredTarget.id })).isDeleted), true, '删除同步必须命中结构化来源预订单')
  const customerIdentifierMap = await (o2oPreorderService as unknown as {
    resolveCustomerOrderIdentifierMap(ids: string[]): Promise<Map<string, unknown>>
  }).resolveCustomerOrderIdentifierMap([String(prefixTarget.id), String(structuredTarget.id)])
  assert.equal(customerIdentifierMap.has(String(prefixTarget.id)), false, '跨账号/伪造幂等前缀不得产生客户单据关联')
  assert.equal(customerIdentifierMap.has(String(structuredTarget.id)), false, '已软删除正式单不得向客户暴露关联')

  const systemGapNine = await createOutbound({ systemNo: 'OUT-W-000029', businessNo: 'hyyz779929', isDeleted: true })
  const systemGapTen = await createOutbound({ systemNo: 'OUT-W-000030', businessNo: 'hyyz779930', isDeleted: true })
  await setCursor('order.system.walkin', 'order.system.walkin.current', 30)
  await orderService.purgeById(String(systemGapNine.id), actor, systemGapNine.businessNo)
  assert.equal(await readCursor('order.system.walkin'), 30, '实际单笔永久删除非尾号 systemNo 不得回退')
  await orderService.purgeById(String(systemGapTen.id), actor, systemGapTen.businessNo)
  assert.equal(await readCursor('order.system.walkin'), 29, '实际单笔永久删除尾号 systemNo 只能回退一位')

  const preorderBatchNine = await createPreorder('PRE-W-000029')
  const preorderBatchTen = await createPreorder('PRE-W-000030')
  await setCursor('o2o.preorder.walkin', 'o2o.preorder.walkin.current', 30)
  const batchResult = await o2oPreorderService.batchPurgeCancelledOrders({
    orders: [
      { id: String(preorderBatchNine.id), confirmPreorderNo: preorderBatchNine.preorderNo },
      { id: String(preorderBatchTen.id), confirmPreorderNo: preorderBatchTen.preorderNo },
    ],
    actor,
  })
  assert.equal(batchResult.summary.deleted, 2)
  assert.equal(await readCursor('o2o.preorder.walkin'), 28, '实际批量删除必须倒序回收连续 preorderNo 后缀')

  const preorderGapNine = await createPreorder('PRE-W-000039')
  const preorderGapTen = await createPreorder('PRE-W-000040')
  await setCursor('o2o.preorder.walkin', 'o2o.preorder.walkin.current', 40)
  await o2oPreorderService.deleteConsoleOrder({ orderId: String(preorderGapNine.id), confirmPreorderNo: preorderGapNine.preorderNo }, actor)
  assert.equal(await readCursor('o2o.preorder.walkin'), 40, '实际单笔删除非尾号 preorderNo 不得回退')
  await o2oPreorderService.deleteConsoleOrder({ orderId: String(preorderGapTen.id), confirmPreorderNo: preorderGapTen.preorderNo }, actor)
  assert.equal(await readCursor('o2o.preorder.walkin'), 39, '实际单笔删除尾号 preorderNo 只能回退一位')

  const auditPreorder = await createPreorder('PRE-W-000050', 'verified')
  const auditOutbound = await createOutbound({
    systemNo: 'OUT-W-000050',
    businessNo: 'hyyz779950',
    idempotencyKey: `o2o-preorder-verify:${auditPreorder.id}`,
    sourceDocType: 'o2o_preorder',
    sourceDocId: auditPreorder.id,
    sourceDocNo: auditPreorder.preorderNo,
    inventoryMode: 'o2o_preapplied',
  })
  await o2oPreorderService.deleteConsoleOrder({ orderId: String(auditPreorder.id), confirmPreorderNo: auditPreorder.preorderNo }, actor)
  const purgeAudit = await AppDataSource.getRepository(SysAuditLog).findOneOrFail({
    where: { actionType: 'o2o.preorder.delete' },
    order: { id: 'DESC' },
  })
  assert.equal(purgeAudit.targetId, null, 'O2O 永久删除审计不得保留已删除主键')
  assert.match(purgeAudit.targetCode ?? '', /^o2o:deleted:[0-9a-f-]{36}$/, 'O2O 永久删除审计只保留随机脱敏标识')
  assert.doesNotMatch(purgeAudit.detailJson ?? '', new RegExp(auditPreorder.preorderNo, 'i'))
  assert.doesNotMatch(purgeAudit.detailJson ?? '', new RegExp(auditOutbound.businessNo, 'i'))

  const sourcePreorder = await AppDataSource.getRepository(O2oPreorder).save({
    preorderNo: 'PRE-D-880001',
    clientUserId: client.id,
    verifyCode: randomUUID(),
    status: 'verified',
    clientOrderType: 'department',
  })
  const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
  const parent = await orderRepo.save({
    orderUuid: randomUUID(),
    systemNo: 'OUT-D-880001',
    businessNo: 'hyyzjd880001',
    idempotencyKey: `merge-parent-${randomUUID()}`,
    inventoryMode: 'legacy_none',
    orderType: 'department',
    status: 'active',
  })
  const child = await orderRepo.save({
    orderUuid: randomUUID(),
    systemNo: 'OUT-D-880002',
    businessNo: 'hyyzjd880002',
    idempotencyKey: `o2o-preorder-verify:${sourcePreorder.id}`,
    sourceDocType: 'o2o_preorder',
    sourceDocId: sourcePreorder.id,
    sourceDocNo: sourcePreorder.preorderNo,
    inventoryMode: 'o2o_preapplied',
    orderType: 'department',
    status: 'merged',
  })
  const operation = await AppDataSource.getRepository(OrderMergeOperation).save({
    operationUuid: randomUUID(),
    idempotencyKey: `merge-operation-${randomUUID()}`,
    requestHash: randomUUID().replaceAll('-', ''),
    targetOrderId: parent.id,
    targetOrderUuid: parent.orderUuid,
    targetEditVersion: 1,
    mergedSourceOrderIdsJson: JSON.stringify([String(child.id)]),
    resultJson: '{}',
    reason: '编号命中验证',
    actorUserId: actor.userId,
    actorUsername: actor.username,
    actorDisplayName: actor.displayName,
  })
  await AppDataSource.getRepository(OrderMergeRelation).save({
    operationId: operation.id,
    parentOrderId: parent.id,
    parentOrderUuid: parent.orderUuid,
    parentBusinessNoSnapshot: parent.businessNo,
    sourceOrderId: child.id,
    sourceOrderUuid: child.orderUuid,
    sourceBusinessNoSnapshot: child.businessNo,
  })
  for (const [keyword, expectedType] of [
    [child.businessNo, 'businessNo'],
    [child.systemNo, 'systemNo'],
    [sourcePreorder.preorderNo, 'preorderNo'],
  ] as const) {
    const result = await orderService.list({ page: 1, pageSize: 20, keyword }, actor)
    const matched = result.list.find((item) => item.id === String(parent.id))
    assert.equal(matched?.matchedIdentifierType, expectedType, `合并子单 ${expectedType} 搜索必须返回准确命中类型`)
    assert.equal(matched?.matchedIdentifierValue, keyword, `合并子单 ${expectedType} 搜索必须返回准确命中值`)
  }

  const operatorBusinessResult = await orderService.list({ page: 1, pageSize: 20, keyword: parent.businessNo }, operatorActor)
  const operatorBusinessOrder = operatorBusinessResult.list.find((item) => item.id === String(parent.id)) as Record<string, unknown> | undefined
  assert.ok(operatorBusinessOrder, '普通操作员仍应能按 businessNo 查询正式订单')
  assert.equal('systemNo' in operatorBusinessOrder, false, '普通操作员正式订单列表不得返回 systemNo')
  assert.equal('showNo' in operatorBusinessOrder, false, '普通操作员正式订单列表不得返回旧 systemNo 别名 showNo')
  const operatorSystemResult = await orderService.list({ page: 1, pageSize: 20, keyword: parent.systemNo }, operatorActor)
  assert.equal(operatorSystemResult.total, 0, '普通操作员不得按 systemNo 搜索正式订单')
  const actorlessSystemResult = await orderService.list({ page: 1, pageSize: 20, keyword: parent.systemNo })
  assert.equal(actorlessSystemResult.total, 0, '未提供管理员 actor 时不得按 systemNo 搜索正式订单')

  const adminDetail = await orderService.detailById(String(parent.id), actor)
  assert.equal(adminDetail.order.systemNo, parent.systemNo, '管理员正式订单详情必须保留 systemNo')
  assert.equal(adminDetail.order.showNo, parent.systemNo, '管理员正式订单详情必须保留一周期 showNo 兼容别名')
  const operatorDetail = await orderService.detailById(String(parent.id), operatorActor)
  assert.equal('systemNo' in operatorDetail.order, false, '普通操作员正式订单详情不得返回 systemNo')
  assert.equal('showNo' in operatorDetail.order, false, '普通操作员正式订单详情不得返回旧 systemNo 别名 showNo')
  const actorlessDetail = await orderService.detailById(String(parent.id))
  assert.equal('systemNo' in actorlessDetail.order, false, '未提供管理员 actor 时正式订单详情不得返回 systemNo')
  assert.equal('showNo' in actorlessDetail.order, false, '未提供管理员 actor 时正式订单详情不得返回旧 systemNo 别名')

  const clientAuth = {
    userId: String(client.id),
    account: client.account,
    mobile: client.mobile ?? '',
    email: client.email ?? '',
    realName: client.realName,
    accountType: client.accountType,
    staffNo: client.staffNo ?? null,
    sessionToken: 'identifier-review-session',
    authSource: 'bearer' as const,
  }
  for (const [keyword, expectedType] of [
    [child.businessNo, 'businessNo'],
    [child.systemNo, 'systemNo'],
  ] as const) {
    const consoleRows = await o2oPreorderService.listConsoleOrders({ keyword, limit: 20 }, actor)
    const consoleMatched = consoleRows.find((item) => item.id === String(sourcePreorder.id))
    assert.equal(consoleMatched?.matchedIdentifierType, expectedType, `console 合并原子单 ${expectedType} 必须返回准确命中类型`)
    assert.equal(consoleMatched?.matchedIdentifierValue, keyword, `console 合并原子单 ${expectedType} 必须返回准确命中值`)

    const poolRows = await o2oPreorderService.listConsoleOrderPool({ keyword, pool: 'all', page: 1, pageSize: 20 }, actor)
    const poolMatched = poolRows.list.find((item) => item.id === String(sourcePreorder.id))
    assert.equal(poolMatched?.matchedIdentifierType, expectedType, `pool 合并原子单 ${expectedType} 必须返回准确命中类型`)
    assert.equal(poolMatched?.matchedIdentifierValue, keyword, `pool 合并原子单 ${expectedType} 必须返回准确命中值`)

    if (expectedType === 'businessNo') {
      const clientRows = await o2oPreorderService.listMyOrders(clientAuth, { keyword, page: 1, pageSize: 20 })
      const clientMatched = clientRows.list.find((item) => item.id === String(sourcePreorder.id)) as Record<string, unknown> | undefined
      assert.equal(clientMatched?.matchedIdentifierType, expectedType, '客户端仍应能按关联正式单 businessNo 搜索')
      assert.equal(clientMatched?.matchedIdentifierValue, keyword, '客户端 businessNo 搜索必须返回准确命中值')
      assert.equal('customerOrderSystemNo' in clientMatched, false, '客户端摘要不得返回 customerOrderSystemNo')
      assert.equal('customerOrderShowNo' in clientMatched, false, '客户端摘要不得返回旧 systemNo 别名 customerOrderShowNo')
      assert.equal('originalCustomerOrderSystemNo' in clientMatched, false, '客户端摘要不得返回原正式单 systemNo')
      assert.equal('originalCustomerOrderShowNo' in clientMatched, false, '客户端摘要不得返回原正式单旧 showNo 别名')
      assert.equal('showNo' in clientMatched, false, '客户端摘要不得返回旧 preorderNo 别名 showNo')
    } else {
      const clientRows = await o2oPreorderService.listMyOrders(clientAuth, { keyword, page: 1, pageSize: 20 })
      assert.equal(clientRows.total, 0, '客户端不得按正式单 systemNo 搜索预订单')
      const operatorRows = await o2oPreorderService.listConsoleOrders({ keyword, limit: 20 }, operatorActor)
      assert.equal(operatorRows.length, 0, '普通管理账号不得按正式单 systemNo 搜索 O2O 订单')
    }
  }

  const adminConsoleDetail = await o2oPreorderService.detailById(String(sourcePreorder.id), actor)
  assert.equal(adminConsoleDetail.order.customerOrderSystemNo, parent.systemNo, '管理员 O2O 详情必须保留当前关联正式单 systemNo')
  assert.equal(adminConsoleDetail.order.customerOrderShowNo, parent.systemNo, '管理员 O2O 详情必须保留当前正式单一周期旧别名')
  assert.equal(adminConsoleDetail.order.originalCustomerOrderSystemNo, child.systemNo, '管理员 O2O 详情必须保留原正式单 systemNo')
  const operatorConsoleDetail = await o2oPreorderService.detailById(String(sourcePreorder.id), operatorActor)
  assert.equal('customerOrderSystemNo' in operatorConsoleDetail.order, false, '普通管理账号 O2O 详情不得返回关联正式单 systemNo')
  assert.equal('customerOrderShowNo' in operatorConsoleDetail.order, false, '普通管理账号 O2O 详情不得返回关联正式单旧 showNo 别名')
  const actorlessConsoleRows = await o2oPreorderService.listConsoleOrders({ keyword: child.systemNo, limit: 20 })
  assert.equal(actorlessConsoleRows.length, 0, '未提供管理员 actor 时不得按正式单 systemNo 搜索 O2O 订单')
  const actorlessConsoleDetail = await o2oPreorderService.detailById(String(sourcePreorder.id))
  assert.equal('customerOrderSystemNo' in actorlessConsoleDetail.order, false, '未提供管理员 actor 时 O2O 详情不得返回关联正式单 systemNo')
  assert.equal('customerOrderShowNo' in actorlessConsoleDetail.order, false, '未提供管理员 actor 时 O2O 详情不得返回旧 systemNo 别名')
  const clientDetail = await o2oPreorderService.getMyOrderDetail(clientAuth, String(sourcePreorder.id))
  assert.equal('customerOrderSystemNo' in clientDetail.order, false, '客户端 O2O 详情不得返回关联正式单 systemNo')
  assert.equal('customerOrderShowNo' in clientDetail.order, false, '客户端 O2O 详情不得返回关联正式单旧 showNo 别名')
  assert.equal('showNo' in clientDetail.order, false, '客户端 O2O 详情不得返回旧 preorderNo 别名 showNo')

  const orderRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/order.routes.ts'), 'utf8')
  assert.match(
    orderRouteSource,
    /'\/system-no\/:systemNo',[\s\S]*?requirePermission\('orders:view'\),[\s\S]*?requireRole\('admin'\)/,
    'canonical systemNo 详情路由必须同时要求 orders:view 与 admin',
  )

  const dashboardRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/dashboard.routes.ts'), 'utf8')
  for (const dashboardMethod of [
    'getStats',
    'getAnalytics',
    'getProductRankDrilldown',
    'getCustomerRankDrilldown',
    'getTagAggregate',
    'getDashboardPieData',
  ]) {
    assert.match(
      dashboardRouteSource,
      new RegExp(`dashboardService\\.${dashboardMethod}\\([\\s\\S]*?authReq\\.auth`),
      `Dashboard 路由 ${dashboardMethod} 必须显式向服务传递登录角色`,
    )
  }

  const o2oRouteSource = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/o2o.routes.ts'), 'utf8')
  const verifyRouteStart = o2oRouteSource.indexOf("  '/verify',")
  const verifyRouteEnd = o2oRouteSource.indexOf("  '/inbound',", verifyRouteStart)
  const verifyRouteSource = o2oRouteSource.slice(verifyRouteStart, verifyRouteEnd)
  assert.doesNotMatch(verifyRouteSource, /customerOrder(?:SystemNo|ShowNo)/, '核销路由不得从已裁剪的外部响应反取正式单技术号写审计')
  assert.doesNotMatch(verifyRouteSource, /auditService\.record/, '核销审计必须在拥有内部快照的服务事务内完成')
  assert.match(
    orderRouteSource,
    /'\/show-no\/:showNo',[\s\S]*?requirePermission\('orders:view'\),[\s\S]*?requireRole\('admin'\)/,
    'legacy showNo 详情路由必须同时要求 orders:view 与 admin',
  )
  assert.match(
    orderRouteSource,
    /'\/show-no\/:showNo',[\s\S]*?(旧 systemNo|systemNo)[\s\S]*?(兼容|废弃|deprecated)/i,
    'legacy /show-no 注释必须明确它是旧 systemNo 别名且已废弃',
  )

  const routeSource = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/system-config.routes.ts'), 'utf8')
  assert.match(routeSource, /\/order-identifiers/, 'system-config 路由缺少 canonical 三套编号读写契约')

  console.log('OK Issue #110 审查修复专项验证通过')
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  fs.rmSync(runtimeDir, { recursive: true, force: true })
}
