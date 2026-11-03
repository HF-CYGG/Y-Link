/**
 * 文件说明：Issue #186 入库、分库位当前读与历史 SKU 退货的真实服务专项。
 * 执行：backend 目录 node --import tsx scripts/issue186-inventory-consistency-verify.ts [--mysql]。
 * 默认使用自建随机 SQLite；MySQL 要求 ISSUE186_MYSQL_CONFIRM_TEST_SERVER=true、
 * ISSUE186_MYSQL_HOST/PORT/USER/PASSWORD，仅接受本机高位端口的独立 MySQL 8.4。
 * 只创建/删除本次随机库，不继承业务 DB_*；交错仅暂停真实锁查询，不替换数据库结果。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Connection } from 'mysql2/promise'
import type { AuthUserContext } from '../src/types/auth.js'
import type { ClientAuthContext } from '../src/types/client-auth.js'

const mysql = process.argv.includes('--mysql')
const mode = mysql ? 'mysql' : 'sqlite'
const owner = randomUUID()
const allowedRoot = path.resolve(process.env.ISSUE186_VERIFY_ROOT ?? os.tmpdir())
fs.mkdirSync(allowedRoot, { recursive: true })
const tempRoot = fs.mkdtempSync(path.join(allowedRoot, 'issue186-'))
fs.writeFileSync(path.join(tempRoot, '.owner'), owner)
const databaseName = 'y_link_issue186_' + owner.replaceAll('-', '')
const emptyEnv = path.join(tempRoot, 'verify.env')
fs.writeFileSync(emptyEnv, '')
const permanentPassword = 'Verify_' + owner + '_Aa1!'
Object.assign(process.env, {
  ENV_FILE: emptyEnv, APP_PROFILE: databaseName, NODE_ENV: 'test',
  Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true', Y_LINK_DATA_DIR: tempRoot,
  DB_TYPE: mode, DB_SYNC: 'false', SQLITE_DB_PATH: path.join(tempRoot, 'verify.sqlite'),
  REDIS_URL: '', Y_LINK_MULTI_INSTANCE: 'false',
  INIT_ADMIN_PASSWORD: 'Admin_' + owner + '_Aa1!', PERMANENT_DELETE_PASSWORD: permanentPassword,
})
let admin: Connection | undefined
let databaseCreated = false
let closeSource: (() => Promise<void>) | undefined

try {
  if (mysql) {
    assert.equal(process.env.ISSUE186_MYSQL_CONFIRM_TEST_SERVER, 'true')
    const host = process.env.ISSUE186_MYSQL_HOST
    const port = Number(process.env.ISSUE186_MYSQL_PORT)
    const user = process.env.ISSUE186_MYSQL_USER
    assert.equal(host, '127.0.0.1')
    assert.ok(Number.isInteger(port) && port >= 10_000 && port <= 65_535)
    assert.ok(user)
    const password = process.env.ISSUE186_MYSQL_PASSWORD ?? ''
    const { createConnection } = await import('mysql2/promise')
    admin = await createConnection({ host, port, user, password, multipleStatements: false })
    const [version] = await admin.query('SELECT VERSION() AS version')
    assert.match((version as Array<{ version: string }>)[0]!.version, /^8\.4(?:\.|-)/)
    await admin.query('CREATE DATABASE ' + databaseName + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    databaseCreated = true
    await admin.query('USE ' + databaseName)
    const [selected] = await admin.query('SELECT DATABASE() AS name')
    assert.equal((selected as Array<{ name: string }>)[0]!.name, databaseName)
    Object.assign(process.env, { DB_HOST: host, DB_PORT: String(port), DB_USER: user,
      DB_PASSWORD: password, DB_NAME: databaseName, DB_SSL_MODE: 'disabled' })
    console.log('[issue186] 随机库归属=' + databaseName)
  }
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { runInTransaction } = await import('../src/config/transaction-runner.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { BaseStorageLocation } = await import('../src/entities/base-storage-location.entity.js')
  const { InvSkuLocationStock } = await import('../src/entities/inv-sku-location-stock.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { BizInboundOrder } = await import('../src/entities/biz-inbound-order.entity.js')
  const { BizInboundOrderItem } = await import('../src/entities/biz-inbound-order-item.entity.js')
  const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
  const { O2oPreorderItem } = await import('../src/entities/o2o-preorder-item.entity.js')
  const { O2oReturnRequest } = await import('../src/entities/o2o-return-request.entity.js')
  const { O2oReturnRequestItem } = await import('../src/entities/o2o-return-request-item.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
  const { inboundService: inbound } = await import('../src/services/inbound.service.js')
  const { inventoryDocService } = await import('../src/services/inventory-doc.service.js')
  const { inventoryMasterDataService: master } = await import('../src/services/inventory-master-data.service.js')
  const { applyInventoryDeltas, loadLockedSkuTargets } = await import('../src/services/inventory-ledger.service.js')
  const { setSkuMainLocation } = await import('../src/services/sku-location-stock.service.js')
  const { o2oPreorderService: o2o } = await import('../src/services/o2o-preorder.service.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { auditService } = await import('../src/services/audit.service.js')
  const sql: string[] = []
  const normalize = (text: string) => text.replaceAll(String.fromCharCode(96), '').replaceAll('"', '')
  AppDataSource.setOptions({ logging: ['query'], logger: {
    logQuery(query) { sql.push(normalize(query)) },
    logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {},
  } })
  await AppDataSource.initialize()
  closeSource = () => AppDataSource.destroy()
  await AppDataSource.synchronize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
  const products = AppDataSource.getRepository(BaseProduct)
  const skus = AppDataSource.getRepository(BaseProductSku)
  const locations = AppDataSource.getRepository(BaseStorageLocation)
  const rows = AppDataSource.getRepository(InvSkuLocationStock)
  const logs = AppDataSource.getRepository(InventoryLog)
  const inboundOrders = AppDataSource.getRepository(BizInboundOrder)
  const inboundItems = AppDataSource.getRepository(BizInboundOrderItem)
  const orderItems = AppDataSource.getRepository(O2oPreorderItem)
  const requests = AppDataSource.getRepository(O2oReturnRequest)
  const requestItems = AppDataSource.getRepository(O2oReturnRequestItem)
  const actors: AuthUserContext[] = []
  for (const role of ['admin', 'admin', 'supplier'] as const) {
    const user = await AppDataSource.getRepository(SysUser).save({
      username: 'issue186-' + actors.length, displayName: '库存一致性验收' + actors.length,
      passwordHash: 'test-only-unused', role, status: 'enabled',
    })
    actors.push({ userId: String(user.id), username: user.username, displayName: user.displayName,
      role, status: 'enabled', permissions: resolvePermissionsByRole(role), sessionToken: 'test-only', authSource: 'bearer' })
  }
  const actor = actors[0]!, actorB = actors[1]!, supplier = actors[2]!
  await systemConfigService.updateO2oRuleConfigs({ ...await systemConfigService.getO2oRuleConfigs(),
    autoCancelEnabled: false, limitEnabled: false }, actor)
  const client = await AppDataSource.getRepository(ClientUser).save({
    mobile: '13900000186', realName: '库存验收客户', passwordHash: 'test-only-unused',
    accountType: 'personal', status: 'enabled', mobileVerifiedAt: new Date(),
  })
  const auth: ClientAuthContext = { userId: String(client.id), account: client.mobile!, mobile: client.mobile!,
    email: '', realName: client.realName, accountType: 'personal', staffNo: null, sessionToken: 'test-only', authSource: 'bearer' }
  let sequence = 0
  const createProduct = async (count = 1, stock = 10) => {
    const code = 'ISSUE186-' + ++sequence
    const product = await products.save({ productCode: code, productName: code, currentStock: count * stock,
      preOrderedStock: 0, defaultPrice: '10.00', discountRate: '10.0', isActive: true, o2oStatus: 'listed', limitPerUser: 100 })
    const variants = []
    for (let i = 0; i < count; i++) variants.push(await skus.save({ productId: String(product.id),
      skuCode: code + '-' + i, specValuesJson: JSON.stringify({ variant: i }), specText: '规格' + i,
      currentStock: stock, preOrderedStock: 0, defaultPrice: '10.00', discountRate: '10.0',
      costPrice: '3.00', isActive: true, isCurrent: true, sortOrder: i }))
    return { product, variants }
  }
  type Fixture = Awaited<ReturnType<typeof createProduct>>
  const stock = async (f: Fixture) => ({
    product: Number((await products.findOneByOrFail({ id: f.product.id })).currentStock),
    sku: await Promise.all(f.variants.map(async s => Number((await skus.findOneByOrFail({ id: s.id })).currentStock))),
  })
  const conflict = (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 409)
    return true
  }
  const adjust = (f: Fixture, qty: number) => inventoryDocService.create({ docType: 'adjust',
    reasonCode: 'entry_error', clientRequestId: randomUUID(), items: [{ skuId: f.variants[0]!.id, qty }] }, actorB)
  const deliver = (f: Fixture, qty = 1) => inbound.submitSupplierDelivery(supplier, {
    expectedArrivalAt: new Date(Date.now() + 3_600_000).toISOString(),
    items: [{ productId: f.product.id, skuId: f.variants[0]!.id, qty }],
  })
  const reverse = (order: { id: string; showNo: string }) => inbound.deleteVerifiedSupplierDelivery(supplier, order.id,
    { confirmShowNo: order.showNo, permanentDeletePassword: permanentPassword })

  // 只暂停 A 的首个商品锁查询。B 在门闩外启动，使用另一账号和真实事务，不继承 A 的事务上下文。
  const interleave = async (action: () => Promise<unknown>, concurrent: () => Promise<unknown>) => {
    if (!mysql) { await concurrent(); return action() }
    let reached!: () => void, release!: () => void
    const arrived = new Promise<void>(r => { reached = r }), wait = new Promise<void>(r => { release = r })
    let armed = true
    const original = AppDataSource.createQueryRunner.bind(AppDataSource)
    AppDataSource.createQueryRunner = (...args) => {
      const runner = original(...args), query = runner.query.bind(runner)
      runner.query = async (...queryArgs: Parameters<typeof query>) => {
        const statement = normalize(queryArgs[0])
        if (armed && /\bFROM base_product\b/i.test(statement) && /\bFOR UPDATE\b/i.test(statement)) {
          armed = false; reached(); await wait
        }
        return query(...queryArgs)
      }
      return runner
    }
    const running = runInTransaction(async manager => {
      const isolation = await manager.query('SELECT @@session.transaction_isolation AS isolation') as Array<{ isolation: string }>
      assert.equal(isolation[0]!.isolation, 'REPEATABLE-READ')
      await manager.getRepository(BaseProduct).count()
      return action()
    }, { mysqlIsolationLevel: 'REPEATABLE READ' }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    let timer: ReturnType<typeof setTimeout> | undefined, schedulingError: unknown
    try {
      await Promise.race([arrived, running.then(outcome => { throw outcome.error ?? new Error('未到达真实商品锁暂停点') }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('锁暂停点超时')), 10_000) })])
      await concurrent()
    } catch (error) { schedulingError = error }
    finally { clearTimeout(timer); armed = false; release(); AppDataSource.createQueryRunner = original }
    const outcome = await running
    if (schedulingError) throw schedulingError
    if (outcome.error) throw outcome.error
    return outcome.value
  }
  if (mysql) {
    const f = await createProduct(), runner = AppDataSource.createQueryRunner()
    await runner.connect(); await runner.startTransaction('REPEATABLE READ')
    try {
      await runner.manager.getRepository(BaseProduct).findOneByOrFail({ id: f.product.id })
      await runner.manager.getRepository(BaseProductSku).findOneByOrFail({ id: f.variants[0]!.id })
      await adjust(f, -1)
      const product = await runner.manager.getRepository(BaseProduct).findOneOrFail({ where: { id: f.product.id }, lock: { mode: 'pessimistic_write' } })
      const sku = await runner.manager.getRepository(BaseProductSku).findOneOrFail({ where: { id: f.variants[0]!.id }, lock: { mode: 'pessimistic_write' } })
      assert.equal(Number(product.currentStock), 9); assert.equal(Number(sku.currentStock), 9)
      product.currentStock = 10; sku.currentStock = 10
      await runner.manager.getRepository(BaseProduct).save(product)
      await runner.manager.getRepository(BaseProductSku).save(sku)
      const stored = await runner.manager.getRepository(BaseProductSku).findOneOrFail({ where: { id: sku.id }, lock: { mode: 'pessimistic_write' } })
      const storedProduct = await runner.manager.getRepository(BaseProduct).findOneOrFail({ where: { id: product.id }, lock: { mode: 'pessimistic_write' } })
      assert.equal(Number(stored.currentStock), 9); assert.equal(Number(storedProduct.currentStock), 9)
      console.log('[issue186] MySQL RR save 旧快照负对照已真实复现')
    } finally { await runner.rollbackTransaction(); await runner.release() }
  }
  for (const kind of ['verify', 'reverse'] as const) {
    const f = await createProduct(1, kind === 'verify' ? 10 : 9), delivery = await deliver(f)
    await products.update(f.product.id, { preOrderedStock: 2 })
    await skus.update(f.variants[0]!.id, { preOrderedStock: 2 })
    if (kind === 'reverse') await inbound.verifyInbound(delivery.order.verifyCode, actor)
    const before = await stock(f)
    assert.equal(before.product, 10)
    await interleave(() => kind === 'verify' ? inbound.verifyInbound(delivery.order.verifyCode, actor) : reverse(delivery.order),
      () => adjust(f, kind === 'verify' ? -1 : 1))
    assert.deepEqual(await stock(f), before, kind + ' 目标必须恰好回到 A 旧快照的 10')
    const event = await logs.findOneByOrFail({ refId: delivery.order.id, changeType: kind === 'verify' ? 'inbound_sys' : 'inbound_reverse' })
    assert.equal(Number(event.beforeCurrentStock), kind === 'verify' ? 9 : 11)
    assert.equal(Number(event.afterCurrentStock), 10)
    assert.equal(Number(event.beforeSkuCurrentStock), kind === 'verify' ? 9 : 11)
    assert.equal(Number(event.afterSkuCurrentStock), 10)
    const order = await inboundOrders.findOneByOrFail({ id: delivery.order.id })
    assert.equal(order.status, 'verified'); assert.equal(Number(order.isDeleted), kind === 'reverse' ? 1 : 0)
    assert.equal(Number((await products.findOneByOrFail({ id: f.product.id })).preOrderedStock), 2)
    assert.equal(Number((await skus.findOneByOrFail({ id: f.variants[0]!.id })).preOrderedStock), 2)
    await assert.rejects(kind === 'verify' ? inbound.verifyInbound(order.verifyCode, actor) : reverse(order), conflict)
    assert.deepEqual(await stock(f), before)
    console.log('[issue186] ' + mode + ' 入库 ' + kind + ' 库存/流水/重复门禁通过')
  }

  const locationA = await locations.save({ locationCode: 'A-186', isActive: true })
  const locationB = await locations.save({ locationCode: 'B-186', isActive: true })
  const locationC = await locations.save({ locationCode: 'C-186', isActive: true })
  const located = async (other = 5) => {
    const f = await createProduct(1, 15)
    await skus.update(f.variants[0]!.id, { locationId: locationA.id })
    if (other) await rows.save({ skuId: f.variants[0]!.id, locationId: locationB.id, qty: other })
    return f
  }
  const transfer = (f: Fixture, fromQty: number, operator = actorB) => master.transferSkuStock(String(locationB.id), String(f.variants[0]!.id), {
    fromLocationId: String(locationA.id), qty: 2, expectedFromQty: fromQty, expectedMainLocationId: String(locationA.id),
  }, operator)
  const fTransfer = await located()
  await assert.rejects(interleave(() => transfer(fTransfer, 10, actor), () => transfer(fTransfer, 10)), conflict)
  const distribution = await master.getSkuLocationDistribution(String(fTransfer.variants[0]!.id))
  assert.equal(distribution.mainQty, 8); assert.equal(distribution.others[0]!.qty, 7)
  assert.deepEqual(await stock(fTransfer), { product: 15, sku: [15] })
  assert.equal(await AppDataSource.getRepository(SysAuditLog).countBy({ actionType: 'product.location.transfer', targetId: String(fTransfer.variants[0]!.id) }), 1)
  sql.length = 0
  await master.getSkuLocationDistribution(String(fTransfer.variants[0]!.id))
  assert.ok(sql.every(q => !/FOR UPDATE|^(?:UPDATE|INSERT|DELETE)\b/i.test(q)), 'GET 必须保持普通只读')

  const adjustAt = (f: Fixture) => runInTransaction(async manager => {
    const target = (await loadLockedSkuTargets(manager, [String(f.variants[0]!.id)])).get(String(f.variants[0]!.id))!
    return applyInventoryDeltas(manager, { deltas: [{ ...target, stockDelta: 1, locationId: String(locationB.id) }],
      changeType: 'stock_adjust', refType: 'issue186_verify', refId: randomUUID(),
      operator: { type: 'admin', id: actor.userId, name: actor.displayName }, buildRemark: () => '指定库位真实调账' })
  })
  for (const initialOther of [5, 0]) {
    const f = await located(initialOther)
    await interleave(() => adjustAt(f), () => transfer(f, 15 - initialOther))
    const after = await master.getSkuLocationDistribution(String(f.variants[0]!.id))
    assert.equal(after.others[0]!.qty, initialOther + 3, 'upsert 必须使用 B 提交后的旧行/新行')
    assert.equal(after.mainQty, 13 - initialOther)
    assert.deepEqual(await stock(f), { product: 16, sku: [16] })
  }
  for (const action of ['assign', 'remove'] as const) {
    const f = await located()
    await interleave(() => master.changeSkuLocation(String(locationB.id), String(f.variants[0]!.id),
      { action, expectedLocationId: String(locationA.id) }, actor), () => transfer(f, 10))
    const after = await master.getSkuLocationDistribution(String(f.variants[0]!.id))
    assert.equal(after.mainLocationId, String(action === 'assign' ? locationB.id : locationA.id))
    assert.equal(after.mainQty, 15); assert.deepEqual(after.others, [])
  }
  const fMain = await located()
  await interleave(() => runInTransaction(async manager => {
    const target = (await loadLockedSkuTargets(manager, [String(fMain.variants[0]!.id)])).get(String(fMain.variants[0]!.id))!
    await setSkuMainLocation(manager, target.sku, String(locationB.id))
  }), () => transfer(fMain, 10))
  const afterMain = await master.getSkuLocationDistribution(String(fMain.variants[0]!.id))
  assert.equal(afterMain.mainQty, 7); assert.equal(afterMain.others[0]!.qty, 8)
  console.log('[issue186] ' + mode + ' 拨转409、GET只读、旧行/缺行调账与主库位操作通过')

  const batch = await createProduct(2)
  const delivery = await inbound.submitSupplierDelivery(supplier, {
    expectedArrivalAt: new Date(Date.now() + 3_600_000).toISOString(),
    items: batch.variants.map((s, i) => ({ productId: batch.product.id, skuId: s.id, qty: i === 0 ? 3 : 2 })),
  })
  const first = await inboundItems.findOneByOrFail({ orderId: delivery.order.id, skuId: batch.variants[0]!.id })
  await inboundItems.update(first.id, { qty: '2' })
  const { id: omitted, ...split } = first; void omitted
  await inboundItems.save({ ...split, qty: '1' })
  sql.length = 0
  await inbound.verifyInbound(delivery.order.verifyCode, actor)
  const verifySql = [...sql]
  assert.equal(verifySql.filter(q => /^UPDATE base_product SET /i.test(q)).length, 1)
  assert.equal(verifySql.filter(q => /^UPDATE base_product_sku SET /i.test(q)).length, 2)
  const originalLogs = await logs.find({ where: { refId: delivery.order.id, changeType: 'inbound_sys' }, order: { id: 'ASC' } })
  assert.deepEqual(originalLogs.map(l => [Number(l.beforeCurrentStock), Number(l.afterCurrentStock)]), [[20, 22], [22, 23], [23, 25]])
  await rows.save([{ skuId: batch.variants[0]!.id, locationId: locationB.id, qty: 12 },
    { skuId: batch.variants[0]!.id, locationId: locationC.id, qty: 1 }, { skuId: batch.variants[1]!.id, locationId: locationB.id, qty: 12 }])
  sql.length = 0
  await reverse(delivery.order)
  const reverseSql = [...sql]
  assert.equal(reverseSql.filter(q => /^UPDATE base_product SET /i.test(q)).length, 1)
  assert.equal(reverseSql.filter(q => /^UPDATE base_product_sku SET /i.test(q)).length, 2)
  assert.equal(reverseSql.filter(q => /^SELECT\b.*\bFROM inv_sku_location_stock\b/is.test(q)).length, 1)
  assert.ok([...verifySql, ...reverseSql].filter(q => /^UPDATE base_product(?:_sku)? SET /i.test(q)).every(q => !/pre_ordered_stock|product_name|cost_price|thumbnail/.test(q)))
  const reversedLogs = await logs.find({ where: { refId: delivery.order.id, changeType: 'inbound_reverse' }, order: { id: 'ASC' } })
  assert.deepEqual(reversedLogs.map(l => [Number(l.beforeCurrentStock), Number(l.afterCurrentStock)]), [[25, 23], [23, 22], [22, 20]])
  assert.deepEqual(reversedLogs.map(l => [Number(l.beforeSkuCurrentStock), Number(l.afterSkuCurrentStock)]), [[13, 11], [11, 10], [12, 10]])
  assert.ok(reversedLogs[0]!.remark!.includes('B-186×2')); assert.ok(reversedLogs[1]!.remark!.includes('B-186×1'))
  assert.deepEqual(await stock(batch), { product: 20, sku: [10, 10] })

  const makeReturn = async (count: number) => {
    const f = await createProduct(count)
    const order = await o2o.submit(auth, { clientRequestId: randomUUID(), pickupContact: '验收领取人', isSystemApplied: false,
      items: f.variants.map(s => ({ productId: f.product.id, skuId: s.id, qty: 1 })) })
    await o2o.verifyByCode(order.order.verifyCode, actor)
    const request = await o2o.createReturnRequest(auth, order.order.id, { reason: '历史规格退货验收',
      items: f.variants.map(s => ({ productId: f.product.id, skuId: s.id, qty: 1 })) })
    return { f, order, request }
  }
  const history = await makeReturn(3)
  await skus.update(history.f.variants[1]!.id, { isActive: false })
  await skus.update(history.f.variants[2]!.id, { isCurrent: false, isActive: false })
  await products.update(history.f.product.id, { currentStock: 9 }) // 模拟规格维护后只有一个在用 SKU 计入商品。
  await o2o.verifyByCode(history.request.verifyCode, actor)
  assert.deepEqual(await stock(history.f), { product: 10, sku: [10, 10, 10] })
  const historyLogs = await logs.find({ where: { refId: history.request.id, changeType: 'preorder_return_inbound' }, order: { id: 'ASC' } })
  assert.equal(historyLogs.length, 3)
  assert.ok(historyLogs.every(l => Number(l.beforeSkuCurrentStock) === 9 && Number(l.afterSkuCurrentStock) === 10))
  assert.equal(historyLogs.filter(l => Number(l.afterCurrentStock) - Number(l.beforeCurrentStock) === 1).length, 1)
  assert.equal(historyLogs.filter(l => Number(l.afterCurrentStock) === Number(l.beforeCurrentStock)).length, 2)
  for (let i = 1; i < historyLogs.length; i++) assert.equal(Number(historyLogs[i]!.beforeCurrentStock), Number(historyLogs[i - 1]!.afterCurrentStock))
  await assert.rejects(o2o.verifyByCode(history.request.verifyCode, actor), conflict)

  const snapshotReturn = async (value: Awaited<ReturnType<typeof makeReturn>>) => ({
    stock: await stock(value.f), request: (await requests.findOneByOrFail({ id: value.request.id })).status,
    order: (await AppDataSource.getRepository(O2oPreorder).findOneByOrFail({ id: value.order.order.id })).totalQty,
    items: (await orderItems.find({ where: { orderId: value.order.order.id }, order: { id: 'ASC' } })).map(i => [i.id, i.qty, i.skuId]),
    reservations: [Number((await products.findOneByOrFail({ id: value.f.product.id })).preOrderedStock),
      ...await Promise.all(value.f.variants.map(async s => Number((await skus.findOneByOrFail({ id: s.id })).preOrderedStock)))],
    locations: await Promise.all(value.f.variants.map(s => rows.find({ where: { skuId: s.id }, order: { id: 'ASC' } }))),
    logs: await logs.count(), audits: await AppDataSource.getRepository(SysAuditLog).count(),
  })
  for (const kind of ['null', 'missing', 'foreign'] as const) {
    const value = await makeReturn(2), second = value.f.variants[1]!
    const line = await requestItems.findOneByOrFail({ returnRequestId: value.request.id, skuId: second.id })
    const source = await orderItems.findOneByOrFail({ orderId: value.order.order.id, skuId: second.id })
    const foreign = kind === 'foreign' ? await createProduct() : null
    const invalidId = kind === 'null' ? null : kind === 'foreign' ? String(foreign!.variants[0]!.id) : '2147483000'
    if (kind === 'missing') assert.equal(await skus.existsBy({ id: invalidId! }), false)
    // 非空孤儿只可能来自历史坏引用：仅在本次随机库的专用连接临时关闭 FK 构造夹具，随后恢复并回读。
    const runner = AppDataSource.createQueryRunner(); await runner.connect()
    try {
      if (kind === 'missing') await runner.query(mysql ? 'SET FOREIGN_KEY_CHECKS = 0' : 'PRAGMA foreign_keys = OFF')
      await runner.manager.getRepository(O2oReturnRequestItem).update(line.id, { skuId: invalidId })
      await runner.manager.getRepository(O2oPreorderItem).update(source.id, { skuId: invalidId })
    } finally {
      if (kind === 'missing') {
        await runner.query(mysql ? 'SET FOREIGN_KEY_CHECKS = 1' : 'PRAGMA foreign_keys = ON')
        const enabled = await runner.query(mysql ? 'SELECT @@foreign_key_checks AS enabled' : 'PRAGMA foreign_keys') as Array<Record<string, number>>
        assert.equal(Number(Object.values(enabled[0]!)[0]), 1)
      }
      await runner.release()
    }
    const before = await snapshotReturn(value), foreignBefore = foreign ? await stock(foreign) : null
    await assert.rejects(o2o.verifyByCode(value.request.verifyCode, actor), conflict)
    assert.deepEqual(await snapshotReturn(value), before, '第二项 ' + kind + ' 必须使前项及整单回滚')
    if (foreign) assert.deepEqual(await stock(foreign), foreignBefore)
    // 留存的 null 历史行仍可由普通查询读取，拒绝的是库存写入。
    const storedSkuId = (await requestItems.findOneByOrFail({ id: line.id })).skuId
    assert.equal(storedSkuId == null ? null : String(storedSkuId), invalidId)
  }
  const failAudit = async (actionType: string, action: () => Promise<unknown>) => {
    const original = auditService.record
    auditService.record = async (...args: Parameters<typeof original>) => {
      if (args[0].actionType === actionType) throw new Error('ISSUE186_AUDIT_FAILURE')
      return original.apply(auditService, args)
    }
    try { await assert.rejects(action(), /ISSUE186_AUDIT_FAILURE/) }
    finally { auditService.record = original }
  }
  const rollback = await makeReturn(2), returnBefore = await snapshotReturn(rollback)
  await failAudit('o2o.return_request.verify', () => o2o.verifyByCode(rollback.request.verifyCode, actor))
  assert.deepEqual(await snapshotReturn(rollback), returnBefore)
  const failedInbound = await createProduct(), failedDelivery = await deliver(failedInbound), inboundBefore = await stock(failedInbound)
  const logCount = await logs.count()
  await failAudit('inbound.admin.verify', () => inbound.verifyInbound(failedDelivery.order.verifyCode, actor))
  assert.deepEqual(await stock(failedInbound), inboundBefore); assert.equal(await logs.count(), logCount)
  assert.equal((await inboundOrders.findOneByOrFail({ id: failedDelivery.order.id })).status, 'pending')
  await inbound.verifyInbound(failedDelivery.order.verifyCode, actor)
  await rows.save({ skuId: failedInbound.variants[0]!.id, locationId: locationB.id, qty: 11 })
  const reverseBefore = { stock: await stock(failedInbound), logs: await logs.count(),
    rows: await rows.find({ where: { skuId: failedInbound.variants[0]!.id } }) }
  sql.length = 0
  await failAudit('inbound.supplier.delete_verified', () => reverse(failedDelivery.order))
  assert.ok(sql.some(q => /^UPDATE inv_sku_location_stock SET /i.test(q)), '失败前应真实执行库位规整写入')
  assert.deepEqual(await stock(failedInbound), reverseBefore.stock)
  assert.equal(await logs.count(), reverseBefore.logs)
  assert.deepEqual(await rows.find({ where: { skuId: failedInbound.variants[0]!.id } }), reverseBefore.rows)
  assert.equal(Number((await inboundOrders.findOneByOrFail({ id: failedDelivery.order.id })).isDeleted), 0)
  assert.equal(await AppDataSource.getRepository(SysAuditLog).countBy({ targetId: failedDelivery.order.id,
    actionType: 'inbound.supplier.delete_verified', resultStatus: 'success' }), 0, '事务内成功审计回滚；事务外失败审计允许保留')
  console.log('[issue186] ' + mode + ' 逐明细批量持久化、历史SKU汇总、坏第二项与审计失败回滚通过')
  console.log('[issue186] ' + mode + ' 全部专项完成；SQLite 不证明 RR 交错')
} finally {
  try { await closeSource?.() }
  finally {
    try { if (databaseCreated) await admin!.query('DROP DATABASE ' + databaseName) }
    finally {
      await admin?.end()
      const relative = path.relative(allowedRoot, tempRoot)
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      assert.equal(fs.readFileSync(path.join(tempRoot, '.owner'), 'utf8'), owner)
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  }
}
