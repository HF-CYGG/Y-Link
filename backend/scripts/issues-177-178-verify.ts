/**
 * 模块说明：#177/#178 真实服务隔离验证。
 * 文件职责：覆盖登记 CAS、清空/重放/旧入口保护、待办、库存不变量与分级标签投影。
 * 维护说明：仅自建 ASCII 临时 SQLite；不能以此代替真实 MySQL 并发与浏览器验收。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ClientAuthContext } from '../src/types/client-auth.js'
import type { AuthUserContext } from '../src/types/auth.js'

const base = path.resolve(process.env.YLINK_ISSUES_VERIFY_ROOT ?? (process.platform === 'win32' ? 'C:/Windows/Temp' : '/tmp'))
assert.match(base, /^[\x20-\x7e]+$/, 'SQLite 隔离验证目录必须使用纯英文绝对路径')
const runtime = fs.mkdtempSync(path.join(base, 'ylink-issues-177-178-'))
Object.assign(process.env, { NODE_ENV: 'test', APP_PROFILE: 'issues-177-178', DB_TYPE: 'sqlite', DB_SYNC: 'true', SQLITE_DB_PATH: path.join(runtime, 'verify.sqlite'), Y_LINK_DATA_DIR: runtime, Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true' })
const mysqlMode = process.env.YLINK_ISSUES_VERIFY_MYSQL_DATABASE
if (mysqlMode) {
  assert.match(mysqlMode, /^ylink_i177_[a-f0-9]{16}$/)
  assert.equal(process.env.YLINK_ISSUES_MYSQL_CONFIRM_TEST_SERVER, 'true')
  process.env.DB_TYPE = 'mysql'; process.env.DB_NAME = mysqlMode; process.env.DB_HOST = '127.0.0.1'
}
const { AppDataSource: db } = await import('../src/config/data-source.js')
try {
  const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { BaseStorageLocation } = await import('../src/entities/base-storage-location.entity.js')
  const { InvSkuLocationStock } = await import('../src/entities/inv-sku-location-stock.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { o2oPreorderService: service } = await import('../src/services/o2o-preorder.service.js')
  const { productService } = await import('../src/services/product.service.js')
  const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
  const { normalizeKingdeeVoucherNo, kingdeeRegistrationView } = await import('../src/utils/kingdee-registration.js')
  const { validateExportPayload, EXPORT_VERSION } = await import('../src/services/data-maintenance.shared.js')
  prepareDatabaseRuntime(); await db.initialize()
  if (mysqlMode) {
    await db.synchronize()
    // MySQL自建新库的结构与默认业务配置都需初始化，不能以SQLite启动补种代替。
    const { systemConfigService } = await import('../src/services/system-config.service.js')
    await systemConfigService.ensureDefaultConfigs()
  } else await initializeDatabaseSchemaIfNeeded(db)
  const clientRepo = db.getRepository(ClientUser)
  const client = await clientRepo.save(clientRepo.create({ username: 'kingdee-client', realName: '验证教师', mobile: '13800000177', passwordHash: 'isolated-only', accountType: 'department', departmentName: '验证部门', staffNo: '177', status: 'enabled' }))
  const other = await clientRepo.save(clientRepo.create({ username: 'kingdee-other', realName: '其他教师', mobile: '13800000178', passwordHash: 'isolated-only', accountType: 'department', departmentName: '其他部门', staffNo: '178', status: 'enabled' }))
  const auth: ClientAuthContext = { userId: String(client.id), account: client.username!, realName: client.realName, mobile: client.mobile!, email: '', accountType: 'department', staffNo: '177', sessionToken: 'isolated', authSource: 'bearer' }
  const userRepo = db.getRepository(SysUser)
  const user = await userRepo.save(userRepo.create({ username: 'kingdee-admin', passwordHash: 'isolated-only', displayName: '验证管理员', role: 'admin', status: 'enabled' }))
  const admin: AuthUserContext = { userId: String(user.id), username: user.username, displayName: user.displayName, role: 'admin', status: 'enabled', permissions: resolvePermissionsByRole('admin'), sessionToken: 'isolated', authSource: 'bearer' }
  const orders = db.getRepository(O2oPreorder)
  let sequence = 0
  const make = async (overrides: Partial<O2oPreorder> = {}) => {
    sequence += 1
    return orders.save(orders.create({ preorderNo: `PRE-D-${String(900000 + sequence).padStart(6, '0')}`, verifyCode: `isolated-${sequence}`, clientUserId: client.id, clientOrderType: 'department', status: 'pending', isSystemApplied: false, kingdeeVersion: 0, kingdeeVoucherNo: null, totalQty: 0, ...overrides }))
  }
  assert.equal(normalizeKingdeeVoucherNo('  001-AbC  '), '001-AbC')
  assert.equal(normalizeKingdeeVoucherNo('   '), null)
  assert.throws(() => normalizeKingdeeVoucherNo('A\nB'), /控制字符/)
  assert.throws(() => normalizeKingdeeVoucherNo('A'.repeat(129)), /128/)
  const historical = await make()
  assert.equal(kingdeeRegistrationView(historical).kingdeeStatus, 'unknown')
  const beforeLogs = await db.getRepository(InventoryLog).count()
  const first = await service.updateKingdeeRegistration(String(historical.id), { kingdeeVoucherNo: ' 001-AbC ', expectedKingdeeVersion: 0 }, { client: auth })
  assert.equal(first.order.kingdeeVoucherNo, '001-AbC'); assert.equal(first.order.kingdeeVersion, 1); assert.equal(first.order.isSystemApplied, true)
  await assert.rejects(() => service.updateKingdeeRegistration(String(historical.id), { kingdeeVoucherNo: '001-AbC', expectedKingdeeVersion: 0 }, { client: auth }), /刷新/)
  const same = await service.updateKingdeeRegistration(String(historical.id), { kingdeeVoucherNo: '001-AbC', expectedKingdeeVersion: 1 }, { client: auth })
  assert.equal(same.order.kingdeeVersion, 1)
  const cleared = await service.updateKingdeeRegistration(String(historical.id), { kingdeeVoucherNo: null, expectedKingdeeVersion: 1 }, { admin })
  assert.equal(cleared.order.kingdeeStatus, 'applied_pending'); assert.equal(cleared.order.kingdeeVersion, 2)
  const race = await Promise.allSettled([
    service.updateKingdeeRegistration(String(historical.id), { kingdeeVoucherNo: 'race-A', expectedKingdeeVersion: 2 }, { admin }),
    service.updateKingdeeRegistration(String(historical.id), { kingdeeVoucherNo: 'race-B', expectedKingdeeVersion: 2 }, { client: auth }),
  ])
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
  // SQLite会话实体ID可能为数字，真实认证上下文不能被字符串严格比较误判为他人。
  const afterCas = await orders.findOneByOrFail({ id: historical.id })
  const numericOwner = await service.updateKingdeeRegistration(String(historical.id), { kingdeeVoucherNo: afterCas.kingdeeVoucherNo, expectedKingdeeVersion: 3 }, { client: { ...auth, userId: Number(auth.userId) as unknown as string } })
  assert.equal(numericOwner.order.kingdeeVersion, 3)

  await assert.rejects(() => service.updateComplianceFlagsByAdmin({ orderId: String(historical.id), isSystemApplied: false }, admin), /刷新/)
  await assert.rejects(() => service.updateComplianceFlagsByAdmin({ orderId: String(historical.id), isSystemApplied: false, expectedKingdeeVersion: 3 }, admin), /已有金蝶编号/)
  await assert.rejects(() => service.updateKingdeeRegistration(String(historical.id), { kingdeeVoucherNo: 'other', expectedKingdeeVersion: 3 }, { client: { ...auth, userId: String(other.id) } }), /不存在/)
  const expired = await make({ timeoutAt: new Date(Date.now() - 60_000) })
  const verified = await make({ status: 'verified', timeoutAt: new Date(Date.now() - 60_000) })
  const cancelled = await make({ status: 'cancelled' })
  const deleted = await make({ isDeleted: true })
  const todos = await service.listMyKingdeeTodos(auth, { page: 1, pageSize: 50 })
  assert.ok(todos.list.some((row) => row.id === String(verified.id)))
  for (const row of [expired, cancelled, deleted]) assert.ok(!todos.list.some((todo) => todo.id === String(row.id)))
  assert.equal((await orders.findOneByOrFail({ id: expired.id })).status, 'pending', 'GET 不应取消或释放库存')
  assert.equal(await db.getRepository(InventoryLog).count(), beforeLogs)
  const { dataMaintenanceService } = await import('../src/services/data-maintenance.service.js')
  // 经实际 JSON 传输边界往返，Date 按生产下载响应转为 ISO 文本。
  const exportPayload = JSON.parse(JSON.stringify(await dataMaintenanceService.exportJson(admin))) as Awaited<ReturnType<typeof dataMaintenanceService.exportJson>>
  const originalRegistration = exportPayload.tables.preorders.find((row) => String(row.id) === String(historical.id))!
  assert.equal(originalRegistration.kingdeeVersion, 3)
  await orders.update(historical.id, { kingdeeVoucherNo: '临时变更', kingdeeVersion: 4 })
  await dataMaintenanceService.importJson(exportPayload, admin)
  const imported = await orders.findOneByOrFail({ id: historical.id })
  assert.equal(imported.kingdeeVoucherNo, originalRegistration.kingdeeVoucherNo)
  assert.equal(imported.kingdeeVersion, 3)
  // 账号资料不属于本专项 JSON 断言，恢复后续下单所需的部门夹具。
  await clientRepo.update(client.id, { accountType: 'department', staffNo: '177', departmentName: '验证部门' })
  const locationRepo = db.getRepository(BaseStorageLocation)
  const main = await locationRepo.save(locationRepo.create({ locationCode: 'A-01', isActive: true }))
  const extra = await locationRepo.save(locationRepo.create({ locationCode: 'B-01', isActive: true }))
  const disabled = await locationRepo.save(locationRepo.create({ locationCode: 'C-01', isActive: false }))
  const product = await productService.create({ productName: '隔离标签商品', defaultPrice: 1, currentStock: 10, skus: [{ specValues: {}, currentStock: 10, locationId: String(main.id) }] }, admin)
  const sku = product.skus[0]!
  const stockRepo = db.getRepository(InvSkuLocationStock)
  await stockRepo.save(stockRepo.create({ skuId: sku.id, locationId: String(extra.id), qty: 3 }))
  await stockRepo.save(stockRepo.create({ skuId: sku.id, locationId: String(disabled.id), qty: 7 }))
  const [full] = await productService.listLabels([sku.id], 'full')
  assert.equal(full!.printLocations.capability, 'full')
  if (full!.printLocations.capability !== 'full') throw new Error('完整能力缺失')
  assert.equal(full!.printLocations.options.find((option) => option.isMain)?.qty, 0)
  assert.ok(!full!.printLocations.options.some((option) => option.locationId === String(disabled.id)))
  const [limited] = await productService.listLabels([sku.id], 'main_only')
  assert.equal(limited!.locationCode, 'A-01')
  assert.ok(!JSON.stringify(limited!.printLocations).includes('qty'))
  assert.ok(!('distributionKey' in limited!.printLocations)); assert.equal(limited!.printLocations.options.length, 1)
  await stockRepo.update({ skuId: sku.id, locationId: String(disabled.id) }, { qty: 6 })
  const [changed] = await productService.listLabels([sku.id], 'full')
  assert.notEqual(changed!.printLocations.capability === 'full' && changed!.printLocations.distributionKey, full!.printLocations.distributionKey)
  const [sameLimited] = await productService.listLabels([sku.id], 'main_only')
  assert.deepEqual(sameLimited, limited, '其他分布变化不能影响 main_only')
  const inventory = await db.getRepository(BaseProductSku).findOneByOrFail({ id: sku.id })
  assert.equal(Number(inventory.currentStock), 10)
  await db.getRepository(BaseProduct).update(product.id, { o2oStatus: 'listed' })
  const pickupAt = new Date(Date.now() + 30 * 60_000).toISOString()
  const request = { clientRequestId: 'isolated-new-177-178', isSystemApplied: true, pickupContact: '验证教师', pickupAt, items: [{ productId: product.id, skuId: sku.id, qty: 1 }] }
  await assert.rejects(() => service.submit(auth, request), /必须填写金蝶/)
  const replayHash = createHash('sha256').update(JSON.stringify({ isSystemApplied: true, pickupContact: '验证教师', remark: null, items: [{ productId: String(product.id), skuId: String(sku.id), qty: 1 }], pickupAt })).digest('hex')
  const replay = await make({ clientRequestId: request.clientRequestId, clientRequestHash: replayHash, isSystemApplied: true })
  assert.equal((await service.submit(auth, request)).order.id, String(replay.id), '新建必填规则不能拒绝历史幂等重放')
  const newOrder = await service.submit(auth, { ...request, isSystemApplied: false, clientRequestId: 'isolated-verify-race-177-178' })
  assert.equal(newOrder.order.kingdeeVersion, 1)
  assert.equal(newOrder.order.kingdeeStatus, 'not_applied')
  // 现场仍可处理停用/注销客户；系统操作员状态、客户端自身门禁与改单次数保持原规则。
  const onsiteStockBefore = await db.getRepository(BaseProductSku).findOneByOrFail({ id: sku.id })
  try {
    for (const inactive of [{ status: 'disabled' as const }, { status: 'enabled' as const, deactivatedAt: new Date(), restoredAt: null }]) {
      await clientRepo.update(client.id, inactive)
      await assert.rejects(() => service.updateMyOrder(auth, newOrder.order.id, { items: request.items }), /停用|注销/)
      const enlarged = await service.updateOrderOnsite(admin, { orderId: newOrder.order.id, items: [{ ...request.items[0]!, qty: 2 }] })
      assert.equal(enlarged.order.totalQty, 2); assert.equal(enlarged.order.updateCount, 0)
      const restored = await service.updateOrderOnsite(admin, { orderId: newOrder.order.id, items: request.items })
      assert.equal(restored.order.totalQty, 1); assert.equal(restored.order.updateCount, 0)
    }
    await userRepo.update(user.id, { status: 'disabled' })
    await assert.rejects(() => service.updateOrderOnsite(admin, { orderId: newOrder.order.id, items: request.items }), /停用|注销/)
  } finally {
    await userRepo.update(user.id, { status: 'enabled' })
    await clientRepo.update(client.id, { status: 'enabled', deactivatedAt: null, restoredAt: null })
  }
  const onsiteStockAfter = await db.getRepository(BaseProductSku).findOneByOrFail({ id: sku.id })
  assert.equal(Number(onsiteStockAfter.currentStock), Number(onsiteStockBefore.currentStock))
  assert.equal(Number(onsiteStockAfter.preOrderedStock), Number(onsiteStockBefore.preOrderedStock))
  await assert.rejects(() => service.updateOrderOnsite(admin, { orderId: String(verified.id), items: request.items }), /已核销/)
  if (mysqlMode) {
    const { verifyMysqlRegistrationEditLockOrder, verifyMysqlOnsiteEditLockOrder, verifyMysqlOnsiteSourceRecheck } = await import('./issues-177-178-mysql-lock-order.js')
    const editable = await service.submit(auth, { ...request, isSystemApplied: false, clientRequestId: 'isolated-mysql-edit-lock' })
    await verifyMysqlRegistrationEditLockOrder(db, auth, editable.order.id, request.items[0]!)
    for (const first of ['onsite', 'client'] as const) {
      const concurrent = await service.submit(auth, { ...request, isSystemApplied: false, clientRequestId: `isolated-mysql-onsite-${first}` })
      await verifyMysqlOnsiteEditLockOrder(db, auth, admin, concurrent.order.id, request.items[0]!, first)
    }
    await verifyMysqlOnsiteSourceRecheck(db, admin, editable.order.id, String(other.id), request.items[0]!)
  }
  await Promise.all([
    service.updateKingdeeRegistration(newOrder.order.id, { kingdeeVoucherNo: 'verify-race-177', expectedKingdeeVersion: 1 }, { client: auth }),
    service.verifyByCode(newOrder.order.verifyCode, admin),
  ])
  const afterVerify = await orders.findOneByOrFail({ id: newOrder.order.id })
  assert.equal(afterVerify.status, 'verified'); assert.equal(afterVerify.kingdeeVoucherNo, 'verify-race-177')
  const { orderService } = await import('../src/services/order.service.js')
  const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
  const outbound = await db.getRepository(BizOutboundOrder).findOneByOrFail({ sourceDocType: 'o2o_preorder', sourceDocId: newOrder.order.id })
  const outboundDetail = await orderService.detailById(String(outbound.id), admin)
  assert.equal(outboundDetail.order.sourcePreorderRegistrations[0]?.kingdeeVoucherNo, 'verify-race-177')
  assert.equal(outboundDetail.order.isSystemApplied, true)
  const unregistered = []
  for (let index = 0; index < 2; index += 1) {
    const created = await service.submit(auth, { ...request, isSystemApplied: false, clientRequestId: `isolated-merge-177-178-${index}` })
    await service.verifyByCode(created.order.verifyCode, admin)
    unregistered.push({ preorder: created.order, outbound: await db.getRepository(BizOutboundOrder).findOneByOrFail({ sourceDocType: 'o2o_preorder', sourceDocId: created.order.id }) })
  }
  const target = unregistered[0]!, source = unregistered[1]!
  await orderService.commitMerge({ target: { orderId: String(target.outbound.id), editVersion: Number(target.outbound.editVersion) }, sources: [{ orderId: String(source.outbound.id), editVersion: Number(source.outbound.editVersion) }], reason: '验证逐来源金蝶登记', idempotencyKey: 'isolated-merge-177-178' }, admin)
  await service.updateKingdeeRegistration(source.preorder.id, { kingdeeVoucherNo: 'source-only-177', expectedKingdeeVersion: 1 }, { admin })
  const merged = await orderService.detailById(String(target.outbound.id), admin)
  assert.equal(merged.order.sourcePreorderRegistrations.length, 2)
  assert.equal(merged.order.sourcePreorderRegistrations.find((row) => row.sourcePreorderId === source.preorder.id)?.kingdeeVoucherNo, 'source-only-177')
  assert.equal(merged.order.sourcePreorderRegistrations.find((row) => row.sourcePreorderId === target.preorder.id)?.kingdeeStatus, 'not_applied')
  assert.equal(merged.order.isSystemApplied, true)
  // 报表按真实明细来源投影；替换/清空不增加行、金额或破坏主键游标导出。
  const { reportService } = await import('../src/services/report.service.js')
  const reportBefore = await reportService.query('kingdee', { pageSize: 100 })
  assert.ok(reportBefore.list.some((row) => row.kingdeeVoucherNo === 'source-only-177' && row.kingdeeStatus === '已登记'))
  assert.ok(reportBefore.list.some((row) => row.kingdeeStatus === '未申请'))
  const legacy = await reportService.query('kingdee', { fields: ['isSystemApplied', 'amount'], pageSize: 100 })
  assert.equal(legacy.total, reportBefore.total); assert.deepEqual(legacy.summary, reportBefore.summary)
  assert.ok(legacy.fields.some((field) => field.key === 'isSystemApplied'))
  await service.updateComplianceFlagsByAdmin({ orderId: target.preorder.id, isSystemApplied: true, expectedKingdeeVersion: 1 }, admin)
  const pendingReport = await reportService.query('kingdee', { pageSize: 100 })
  assert.ok(pendingReport.list.some((row) => row.kingdeeStatus === '已申请待补编号' && row.kingdeeVoucherNo === ''))
  const sourceBefore = await orders.findOneByOrFail({ id: source.preorder.id })
  await service.updateKingdeeRegistration(source.preorder.id, { kingdeeVoucherNo: 'source-replaced', expectedKingdeeVersion: sourceBefore.kingdeeVersion }, { admin })
  const replaced = await reportService.query('kingdee', { pageSize: 100 })
  assert.ok(replaced.list.some((row) => row.kingdeeVoucherNo === 'source-replaced'))
  await service.updateKingdeeRegistration(source.preorder.id, { kingdeeVoucherNo: null, expectedKingdeeVersion: sourceBefore.kingdeeVersion + 1 }, { admin })
  const clearedReport = await reportService.query('kingdee', { pageSize: 100 })
  assert.ok(!clearedReport.list.some((row) => row.kingdeeVoucherNo === 'source-replaced'))
  // 自建旧数据模拟合法历史来源缺失，保留实际O2O身份；两种身份字段分别覆盖。
  const formalRepo = db.getRepository(BizOutboundOrder)
  await formalRepo.update(source.outbound.id, { sourceDocId: null })
  const missing = await reportService.query('kingdee', { pageSize: 100 })
  assert.ok(missing.list.some((row) => row.kingdeeStatus === '待确认' && row.kingdeeVoucherNo === ''))
  await formalRepo.update(source.outbound.id, { sourceDocType: null })
  const legacySource = await reportService.query('kingdee', { pageSize: 100 })
  assert.ok(legacySource.list.some((row) => row.kingdeeStatus === '待确认'))
  await formalRepo.update(source.outbound.id, { inventoryMode: 'manual_applied' })
  const manual = await reportService.query('kingdee', { pageSize: 100 })
  assert.ok(manual.list.some((row) => row.kingdeeStatus === '不适用' && row.kingdeeVoucherNo === ''))
  for (const report of [pendingReport, replaced, clearedReport, missing, legacySource, manual]) {
    assert.equal(report.total, reportBefore.total); assert.deepEqual(report.summary, reportBefore.summary)
    assert.equal(report.list.length, reportBefore.list.length)
  }
  await formalRepo.update(source.outbound.id, { inventoryMode: 'o2o_preapplied' })
  const { PassThrough } = await import('node:stream')
  const { loadExcelJs } = await import('../src/utils/exceljs-loader.js')
  const stream = new PassThrough(), chunks: Buffer[] = []
  stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  const exported = await reportService.exportExcel('kingdee', { fields: ['kingdeeVoucherNo', 'kingdeeStatus', 'isSystemApplied', 'amount'] }, stream, undefined, admin.userId)
  assert.equal(exported.rowCount, reportBefore.total)
  const ExcelJS = await loadExcelJs(), workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.concat(chunks))
  const text = JSON.stringify(workbook.worksheets[0]!.getSheetValues())
  for (const label of ['金蝶单据编号', '金蝶状态', '是否系统申请', '待确认', '已申请待补编号']) {
    assert.ok(text.includes(label), `导出应保留${label}`)
  }
  // 验证 JSON 白名单归一化不丢失登记字段；真正 import/export 往返另在独立验收库执行。
  const payload = { version: EXPORT_VERSION, exportedAt: new Date().toISOString(), tables: { systemConfigs: [], products: [], clientUsers: [], preorders: [], preorderItems: [], inventoryLogs: [] } }
  assert.deepEqual(validateExportPayload(payload).tables.preorders, [])
  console.log(`通过：${mysqlMode ? '真实 MySQL' : '隔离 SQLite'} 服务场景；HTTP 权限和浏览器仍须单独验收`)
} finally {
  if (db.isInitialized) await db.destroy()
  const resolved = path.resolve(runtime)
  assert.ok(resolved.startsWith(base + path.sep) && path.basename(resolved).startsWith('ylink-issues-177-178-'))
  fs.rmSync(resolved, { recursive: true, force: true })
}
