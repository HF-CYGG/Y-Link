/**
 * 文件说明：O2O 显式库存更新、核销批处理与 RR 快照交错专项。
 * 执行：backend 目录 node --import tsx scripts/o2o-inventory-persistence-verify.ts。
 * MySQL：O2O_INVENTORY_VERIFY_DB=mysql，O2O_INVENTORY_MYSQL_CONFIRM_TEST_SERVER=true，
 * 并提供 O2O_INVENTORY_MYSQL_HOST/PORT/USER/PASSWORD；只接受 127.0.0.1 高位端口的 MySQL 8.4。
 * 只创建随机库；不读取通用 DB_* 连接参数。SQLite/运行文件使用任务专用随机目录。
 * RR 交错暂停实际驱动的锁查询，让另一条真实服务事务先提交；不 mock 数据库结果。
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

const mode = process.env.O2O_INVENTORY_VERIFY_DB ?? 'sqlite'
assert.ok(mode === 'sqlite' || mode === 'mysql')
const owner = randomUUID()
const allowedRoot = path.resolve(process.env.O2O_INVENTORY_VERIFY_ROOT
  ?? (process.platform === 'win32' ? 'F:/Y-Link/.tmp-architecture-review-fixes' : os.tmpdir()))
fs.mkdirSync(allowedRoot, { recursive: true })
const tempRoot = fs.mkdtempSync(path.join(allowedRoot, 'o2o-inventory-'))
fs.writeFileSync(path.join(tempRoot, '.owner'), owner)
const databaseName = 'y_link_o2o_inventory_' + owner.replaceAll('-', '')
const emptyEnv = path.join(tempRoot, 'verify.env')
fs.writeFileSync(emptyEnv, '')
Object.assign(process.env, {
  NODE_ENV: 'test', APP_PROFILE: databaseName, ENV_FILE: emptyEnv,
  Y_LINK_DATA_DIR: tempRoot, Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
  DB_TYPE: mode, DB_SYNC: 'false', SQLITE_DB_PATH: path.join(tempRoot, 'inventory.sqlite'),
  REDIS_URL: '', Y_LINK_MULTI_INSTANCE: 'false', INIT_ADMIN_PASSWORD: 'Verify_' + owner + '_Aa1!',
})
let mysqlAdmin: Connection | undefined
let createdDatabase = false
let closeDataSource: (() => Promise<void>) | undefined

try {
  if (mode === 'mysql') {
    assert.equal(process.env.O2O_INVENTORY_MYSQL_CONFIRM_TEST_SERVER, 'true', '必须确认本任务隔离实例')
    const host = process.env.O2O_INVENTORY_MYSQL_HOST
    const port = Number(process.env.O2O_INVENTORY_MYSQL_PORT)
    const user = process.env.O2O_INVENTORY_MYSQL_USER
    const password = process.env.O2O_INVENTORY_MYSQL_PASSWORD ?? ''
    assert.equal(host, '127.0.0.1')
    assert.ok(Number.isInteger(port) && port >= 10_000 && port <= 65_535)
    assert.ok(user, '缺少专用测试用户')
    const { createConnection } = await import('mysql2/promise')
    mysqlAdmin = await createConnection({ host, port, user, password, multipleStatements: false })
    const [versions] = await mysqlAdmin.query('SELECT VERSION() AS version')
    assert.match((versions as Array<{ version: string }>)[0]!.version, /^8\.4(?:\.|-)/)
    await mysqlAdmin.query('CREATE DATABASE ' + databaseName + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    createdDatabase = true
    await mysqlAdmin.query('USE ' + databaseName)
    const [selectedDatabase] = await mysqlAdmin.query('SELECT DATABASE() AS databaseName')
    assert.equal((selectedDatabase as Array<{ databaseName: string | null }>)[0]?.databaseName,
      databaseName, '负对照连接必须选中本次随机测试库')
    Object.assign(process.env, {
      DB_HOST: host, DB_PORT: String(port), DB_USER: user, DB_PASSWORD: password,
      DB_NAME: databaseName, DB_SSL_MODE: 'disabled',
    })
    console.log('[o2o-inventory] 随机测试库归属=' + databaseName)
  }

  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { runInTransaction } = await import('../src/config/transaction-runner.js')
  const { BaseProduct } = await import('../src/entities/base-product.entity.js')
  const { BaseProductSku } = await import('../src/entities/base-product-sku.entity.js')
  const { BaseStorageLocation } = await import('../src/entities/base-storage-location.entity.js')
  const { InvSkuLocationStock } = await import('../src/entities/inv-sku-location-stock.entity.js')
  const { InventoryLog } = await import('../src/entities/inventory-log.entity.js')
  const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
  const { O2oPreorderItem } = await import('../src/entities/o2o-preorder-item.entity.js')
  const { O2oReturnRequest } = await import('../src/entities/o2o-return-request.entity.js')
  const { O2oReturnRequestItem } = await import('../src/entities/o2o-return-request-item.entity.js')
  const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
  const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')
  const { SysUser } = await import('../src/entities/sys-user.entity.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { resolvePermissionsByRole } = await import('../src/constants/auth-permissions.js')
  const { systemConfigService } = await import('../src/services/system-config.service.js')
  const { o2oPreorderService: service } = await import('../src/services/o2o-preorder.service.js')
  const { auditService } = await import('../src/services/audit.service.js')
  const sql: string[] = []
  const normalizeSql = (value: string) => value.replaceAll(String.fromCharCode(96), '').replaceAll('"', '')
  AppDataSource.setOptions({
    logging: ['query'],
    logger: {
      logQuery(query) { sql.push(normalizeSql(query)) },
      logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {},
    },
  })
  await AppDataSource.initialize()
  closeDataSource = async () => { await AppDataSource.destroy() }
  await AppDataSource.synchronize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
  const products = AppDataSource.getRepository(BaseProduct)
  const skus = AppDataSource.getRepository(BaseProductSku)
  const preorders = AppDataSource.getRepository(O2oPreorder)
  const items = AppDataSource.getRepository(O2oPreorderItem)
  const logs = AppDataSource.getRepository(InventoryLog)
  const locations = AppDataSource.getRepository(BaseStorageLocation)
  const locationStocks = AppDataSource.getRepository(InvSkuLocationStock)
  const outbound = AppDataSource.getRepository(BizOutboundOrder)
  const audits = AppDataSource.getRepository(SysAuditLog)
  const userRepo = AppDataSource.getRepository(SysUser)
  const actors: AuthUserContext[] = []
  for (let index = 0; index < 2; index += 1) {
    const user = await userRepo.save({
      username: 'inventory-admin-' + index, displayName: '库存专项管理员' + index,
      passwordHash: 'test-only-unused', role: 'admin', status: 'enabled',
    })
    actors.push({
      userId: String(user.id), username: user.username, displayName: user.displayName, role: 'admin',
      permissions: resolvePermissionsByRole('admin'), status: 'enabled', sessionToken: 'test-only', authSource: 'bearer',
    })
  }
  const actor = actors[0]!
  const actorB = actors[1]!
  const rules = await systemConfigService.getO2oRuleConfigs()
  await systemConfigService.updateO2oRuleConfigs({
    ...rules, autoCancelEnabled: true, limitEnabled: false,
  }, actor)
  const clients: ClientAuthContext[] = []
  for (let index = 0; index < 2; index += 1) {
    const mobile = '1390000000' + index
    const client = await AppDataSource.getRepository(ClientUser).save({
      mobile, realName: '库存专项客户' + index, passwordHash: 'test-only-unused',
      accountType: 'personal', status: 'enabled', mobileVerifiedAt: new Date(),
    })
    clients.push({
      userId: String(client.id), account: mobile, mobile, email: '', realName: client.realName,
      accountType: 'personal', staffNo: null, sessionToken: 'test-only', authSource: 'bearer',
    })
  }
  let sequence = 0
  const createProduct = async (skuCount = 1) => {
    sequence += 1
    const product = await products.save({
      productCode: 'INV-' + sequence, productName: '库存专项商品' + sequence,
      currentStock: 10 * skuCount, preOrderedStock: 0, defaultPrice: '10.00', discountRate: '10.0',
      isActive: true, o2oStatus: 'listed', limitPerUser: 100,
    })
    const variants = []
    for (let index = 0; index < skuCount; index += 1) {
      variants.push(await skus.save({
        productId: String(product.id), skuCode: 'INV-' + sequence + '-' + index,
        specValuesJson: JSON.stringify({ variant: index }), specText: '规格' + index,
        defaultPrice: '10.00', discountRate: '10.0', currentStock: 10, preOrderedStock: 0,
        isActive: true, isCurrent: true, sortOrder: index, costPrice: '3.00',
      }))
    }
    return { product, variants }
  }
  type Fixture = Awaited<ReturnType<typeof createProduct>>
  const stock = async (fixture: Fixture) => {
    const product = await products.findOneByOrFail({ id: fixture.product.id })
    const variants = await Promise.all(fixture.variants.map((sku) => skus.findOneByOrFail({ id: sku.id })))
    return {
      current: Number(product.currentStock), held: Number(product.preOrderedStock),
      skuCurrent: variants.map((sku) => Number(sku.currentStock)),
      skuHeld: variants.map((sku) => Number(sku.preOrderedStock)),
    }
  }
  const place = (fixture: Fixture, qty = 1, client = clients[0]!) => service.submit(client, {
    clientRequestId: randomUUID(), pickupContact: '库存专项领取人', isSystemApplied: false,
    items: [{ productId: fixture.product.id, skuId: fixture.variants[0]!.id, qty }],
  })
  const verify = (order: Awaited<ReturnType<typeof place>>, operator = actor) => service.verifyByCode(order.order.verifyCode, operator)

  // 拦截点只暂停真实锁查询；快照、行锁、业务 SQL 和并发事务均由真实 MySQL 执行。
  let pendingGate: { reached: () => void; wait: Promise<void> } | undefined
  const originalCreateRunner = AppDataSource.createQueryRunner.bind(AppDataSource)
  AppDataSource.createQueryRunner = (...args) => {
    const runner = originalCreateRunner(...args)
    const originalQuery = runner.query.bind(runner)
    runner.query = async (...queryArgs: Parameters<typeof originalQuery>) => {
      const statement = normalizeSql(queryArgs[0])
      if (pendingGate && /\bFROM base_product\b/i.test(statement) && /\bFOR UPDATE\b/i.test(statement)) {
        const gate = pendingGate
        pendingGate = undefined
        gate.reached()
        await gate.wait
      }
      return originalQuery(...queryArgs)
    }
    return runner
  }
  const interleave = async (action: () => Promise<unknown>, concurrent: () => Promise<void>) => {
    if (mode !== 'mysql') { await concurrent(); return action() }
    let reached!: () => void
    let release!: () => void
    const arrived = new Promise<void>((resolve) => { reached = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    pendingGate = { reached, wait }
    const running = runInTransaction(async (manager) => {
      const isolation = await manager.query('SELECT @@session.transaction_isolation AS isolation') as Array<{ isolation: string }>
      assert.equal(isolation[0]!.isolation, 'REPEATABLE-READ')
      await manager.getRepository(BaseProduct).count() // 明确先建立 RR 普通读快照。
      return action()
    }, { mysqlIsolationLevel: 'REPEATABLE READ' })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        arrived,
        running.then(() => { throw new Error('未遇到库存锁查询') }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('等待库存锁交错超时')), 10_000) }),
      ])
      await concurrent()
    } finally {
      clearTimeout(timer)
      pendingGate = undefined
      release()
      // 即使并发侧失败，也必须先排空 A，才能清理随机库。
      await running
    }
  }

  // 真实 RR 负对照：用未修复的 ORM save 写法证明“目标等于旧快照”会遗漏列。
  if (mode === 'mysql') {
    const control = await createProduct()
    await runInTransaction(async (manager) => {
      const oldProduct = await manager.getRepository(BaseProduct).findOneByOrFail({ id: control.product.id })
      const oldSku = await manager.getRepository(BaseProductSku).findOneByOrFail({ id: control.variants[0]!.id })
      await mysqlAdmin!.execute('UPDATE base_product SET current_stock = current_stock + 1 WHERE id = ?', [oldProduct.id])
      await mysqlAdmin!.execute('UPDATE base_product_sku SET current_stock = current_stock + 1 WHERE id = ?', [oldSku.id])
      const product = await manager.getRepository(BaseProduct).findOneOrFail({
        where: { id: oldProduct.id }, lock: { mode: 'pessimistic_write' },
      })
      const sku = await manager.getRepository(BaseProductSku).findOneOrFail({
        where: { id: oldSku.id }, lock: { mode: 'pessimistic_write' },
      })
      assert.equal(Number(product.currentStock), 11)
      assert.equal(Number(sku.currentStock), 11)
      product.currentStock = Number(oldProduct.currentStock)
      sku.currentStock = Number(oldSku.currentStock)
      await manager.getRepository(BaseProduct).save(product)
      await manager.getRepository(BaseProductSku).save(sku)
    }, { mysqlIsolationLevel: 'REPEATABLE READ' })
    assert.deepEqual(await stock(control), { current: 11, held: 0, skuCurrent: [11], skuHeld: [0] },
      '负对照必须在真实 MySQL 证明 save 未写入目标 10')
    console.log('[o2o-inventory] mysql RR save 旧快照负对照已复现')
  }

  const kinds = ['submit', 'verify', 'cancel', 'admin-cancel', 'timeout', 'update', 'onsite', 'pending-return', 'verified-return', 'delete', 'inbound'] as const
  for (const kind of kinds) {
    const fixture = await createProduct()
    // 历史 pending 回库会锁订单明细范围；先建 B 单，交错时只更新其既有行，
    // 避免测试门闩等待被 A 间隙锁阻断的新 INSERT，仍由真实改单事务增加一件预占。
    const pendingOther = kind === 'pending-return' ? await place(fixture, 1, clients[1]!) : null
    const own = kind === 'submit' || kind === 'inbound' ? null : await place(fixture)
    const other = pendingOther ?? (['submit', 'update', 'onsite', 'verified-return', 'inbound'].includes(kind)
      ? await place(fixture, 1, clients[1]!) : null)
    if (kind === 'verified-return') await verify(own!)
    let returnRequest: { verifyCode: string } | null = null
    if (kind === 'pending-return' || kind === 'verified-return') {
      const returnInput = {
        reason: '库存专项退货', items: [{ productId: fixture.product.id, skuId: fixture.variants[0]!.id, qty: 1 }],
      }
      if (kind === 'pending-return') {
        const beforeDenied = await stock(fixture)
        await assert.rejects(service.createReturnRequest(clients[0]!, own!.order.id, returnInput), (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal((error as Error & { statusCode?: number }).statusCode, 409)
          assert.match(error.message, /订单未核销前.*不支持直接申请退货/)
          return true
        })
        assert.deepEqual(await stock(fixture), beforeDenied, '公开入口拒绝后不得改库存')
        assert.equal(await AppDataSource.getRepository(O2oReturnRequest).countBy({ orderId: own!.order.id }), 0)
        // 沿用 o2o-preorder-verify.ts 的历史待取货申请夹具模式，不放开公开入口。
        const orderLine = await items.findOneByOrFail({ orderId: own!.order.id })
        returnRequest = await runInTransaction(async (manager) => {
          const request = await manager.getRepository(O2oReturnRequest).save({
            returnNo: 'RT-LEGACY-' + randomUUID(), orderId: own!.order.id,
            clientUserId: clients[0]!.userId, verifyCode: randomUUID(),
            status: 'pending', sourceOrderStatus: 'pending', reason: '历史待取货退货申请', totalQty: 1,
          })
          await manager.getRepository(O2oReturnRequestItem).save({
            returnRequestId: request.id, productId: orderLine.productId, skuId: orderLine.skuId,
            skuCodeSnapshot: orderLine.skuCodeSnapshot, specTextSnapshot: orderLine.specTextSnapshot, qty: 1,
          })
          return request
        })
      } else {
        returnRequest = await service.createReturnRequest(clients[0]!, own!.order.id, returnInput)
      }
    }
    if (kind === 'timeout') await preorders.update(own!.order.id, { timeoutAt: new Date(Date.now() - 60_000) })
    const before = await stock(fixture)
    const delta = kind === 'submit' || kind === 'update' || kind === 'onsite' ? [0, 1]
      : kind === 'verify' ? [-1, -1]
      : kind === 'verified-return' || kind === 'inbound' ? [1, 0] : [0, -1]
    const action = async () => {
      if (kind === 'submit') await place(fixture)
      else if (kind === 'verify') await verify(own!)
      else if (kind === 'cancel') await service.cancelMyOrder(clients[0]!, own!.order.id)
      else if (kind === 'admin-cancel') await service.cancelOrderByAdmin({
        orderId: own!.order.id, reason: '库存专项管理员取消', actor,
      })
      else if (kind === 'timeout') await service.cancelTimeoutOrders()
      else if (kind === 'update') await service.updateMyOrder(clients[0]!, own!.order.id, {
        items: [{ productId: fixture.product.id, skuId: fixture.variants[0]!.id, qty: 2 }],
      })
      else if (kind === 'onsite') await service.updateOrderOnsite(actor, {
        orderId: own!.order.id, items: [{ productId: fixture.product.id, skuId: fixture.variants[0]!.id, qty: 2 }],
      })
      else if (kind === 'pending-return' || kind === 'verified-return') await service.verifyByCode(returnRequest!.verifyCode, actor)
      else if (kind === 'delete') await service.deleteConsoleOrder({
        orderId: own!.order.id, confirmPreorderNo: own!.order.preorderNo,
      }, actor)
      else await service.inboundStock(fixture.product.id, 1, actor, '库存专项入库', fixture.variants[0]!.id)
    }
    let expected = before
    await interleave(action, async () => {
      if (kind === 'submit' || kind === 'update' || kind === 'onsite') {
        await service.cancelMyOrder(clients[1]!, other!.order.id)
      } else if (kind === 'pending-return') {
        await service.updateMyOrder(clients[1]!, other!.order.id, {
          items: [{ productId: fixture.product.id, skuId: fixture.variants[0]!.id, qty: 2 }],
        })
      } else if (kind === 'verified-return' || kind === 'inbound') {
        await verify(other!, actorB)
      } else if (kind === 'verify') {
        await service.inboundStock(fixture.product.id, 1, actorB, '交错真实入库', fixture.variants[0]!.id)
      } else {
        await place(fixture, 1, clients[1]!)
      }
      const afterB = await stock(fixture)
      expected = {
        current: afterB.current + delta[0]!, held: afterB.held + delta[1]!,
        skuCurrent: [afterB.skuCurrent[0]! + delta[0]!], skuHeld: [afterB.skuHeld[0]! + delta[1]!],
      }
      const target = delta[0] ? 'current' : 'held'
      assert.equal(expected[target], before[target], kind + ' 必须命中目标值等于旧快照')
    })
    assert.deepEqual(await stock(fixture), expected, kind + ' 商品/SKU 必须与并发结果一致')
    const event = await logs.findOne({ where: { productId: fixture.product.id }, order: { id: 'DESC' } })
    assert.ok(event)
    assert.equal(Number(event.afterCurrentStock), expected.current, kind + ' 现货流水不一致')
    assert.equal(Number(event.afterPreorderedStock), expected.held, kind + ' 预占流水不一致')
    if (kind === 'cancel') await assert.rejects(service.cancelMyOrder(clients[0]!, own!.order.id), /取消|撤回/)
    if (kind === 'admin-cancel') await assert.rejects(service.cancelOrderByAdmin({
      orderId: own!.order.id, reason: '重复管理员取消', actor,
    }), /取消/)
    if (kind === 'pending-return' || kind === 'verified-return') {
      await assert.rejects(service.verifyByCode(returnRequest!.verifyCode, actor), /重复核销/)
    }
    if (kind === 'timeout') assert.equal((await service.cancelTimeoutOrders()).cancelledCount, 0)
    assert.deepEqual(await stock(fixture), expected, kind + ' 重复动作不能再次改库存')
    console.log('[o2o-inventory] ' + mode + ' ' + kind + ' 库存/流水一致')
  }

  // 同商品多 SKU、历史重复明细：两个 SKU 只更新一次，商品只更新一次。
  const batch = await createProduct(2)
  const shelfB = await locations.save({ locationCode: 'B-01', isActive: true })
  const shelfC = await locations.save({ locationCode: 'C-01', isActive: true })
  await locationStocks.save([
    { skuId: batch.variants[0]!.id, locationId: shelfB.id, qty: 8 },
    { skuId: batch.variants[0]!.id, locationId: shelfC.id, qty: 1 },
    { skuId: batch.variants[1]!.id, locationId: shelfB.id, qty: 8 },
  ])
  const input = {
    clientRequestId: randomUUID(), pickupContact: '批量核销领取人', isSystemApplied: false,
    items: batch.variants.map((sku, index) => ({ productId: batch.product.id, skuId: sku.id, qty: index === 0 ? 3 : 2 })),
  }
  const batchOrder = await service.submit(clients[0]!, input)
  const held = await stock(batch)
  assert.equal((await service.submit(clients[0]!, input)).order.id, batchOrder.order.id)
  assert.deepEqual(await stock(batch), held, '幂等重放不重复预占')
  await assert.rejects(service.submit(clients[0]!, { ...input, remark: '不同意图' }), /请求|重复|一致/)
  const firstLine = await items.findOneOrFail({ where: { orderId: batchOrder.order.id, skuId: batch.variants[0]!.id } })
  await items.update(firstLine.id, { qty: 2, lineAmount: '20.00' })
  const { id: ignored, ...splitLine } = firstLine
  void ignored
  await items.save({ ...splitLine, qty: 1, lineAmount: '10.00' })
  const oldDate = new Date('2000-01-01T00:00:00Z')
  await products.update(batch.product.id, { updatedAt: oldDate, thumbnail: '/kept-product.png' })
  await skus.update(batch.variants[0]!.id, { updatedAt: oldDate, thumbnail: '/kept-sku.png' })
  sql.length = 0
  await verify(batchOrder)
  const verifySql = [...sql]
  const batchLogs = await logs.find({ where: { productId: batch.product.id, changeType: 'preorder_verify' }, order: { id: 'ASC' } })
  assert.equal(batchLogs.length, 3)
  assert.deepEqual(batchLogs.map((line) => [Number(line.beforeCurrentStock), Number(line.afterCurrentStock)]), [[20, 18], [18, 16], [16, 15]])
  const firstSkuLogs = batchLogs.filter((line) => String(line.skuId) === String(batch.variants[0]!.id))
  assert.deepEqual(firstSkuLogs.map((line) => [Number(line.beforeSkuCurrentStock), Number(line.afterSkuCurrentStock)]), [[10, 8], [8, 7]])
  assert.ok(firstSkuLogs.every((line) => line.remark === '扣减其他库位 B-01×1'), '重复 SKU 每条明细独立归因')
  assert.deepEqual(await stock(batch), { current: 15, held: 0, skuCurrent: [7, 8], skuHeld: [0, 0] })
  assert.equal(verifySql.filter((query) => /^UPDATE base_product SET /i.test(query)).length, 1)
  assert.equal(verifySql.filter((query) => /^UPDATE base_product_sku SET /i.test(query)).length, 2)
  assert.equal(verifySql.filter((query) => /^SELECT\b.*\bFROM inv_sku_location_stock\b/is.test(query)).length, 1)
  assert.ok(verifySql.filter((query) => /^UPDATE base_product(?:_sku)? SET /i.test(query)).every((query) => !/thumbnail|cost_price|spec_text|product_name/.test(query)))
  const storedProduct = await products.findOneByOrFail({ id: batch.product.id })
  const storedSku = await skus.findOneByOrFail({ id: batch.variants[0]!.id })
  assert.equal(storedProduct.thumbnail, '/kept-product.png')
  assert.equal(storedSku.thumbnail, '/kept-sku.png')
  assert.equal(Number(storedSku.costPrice), 3)
  assert.ok(storedProduct.updatedAt.getTime() > oldDate.getTime())
  assert.ok(storedSku.updatedAt.getTime() > oldDate.getTime())
  assert.equal((await locationStocks.findOneByOrFail({ skuId: storedSku.id, locationId: shelfB.id })).qty, 6)
  const afterVerified = await stock(batch)
  await assert.rejects(verify(batchOrder), /不可核销/)
  assert.deepEqual(await stock(batch), afterVerified)

  // 老记录没有 SKU 时保留原有仅调整商品口径，不推断或污染当前 SKU。
  const legacy = await createProduct()
  const legacyOrder = await place(legacy)
  await items.update({ orderId: legacyOrder.order.id }, { skuId: null })
  await skus.update(legacy.variants[0]!.id, { preOrderedStock: 0 })
  await verify(legacyOrder)
  assert.deepEqual(await stock(legacy), { current: 9, held: 0, skuCurrent: [10], skuHeld: [0] })
  const legacyLog = await logs.findOneByOrFail({ refId: legacyOrder.order.id, changeType: 'preorder_verify' })
  assert.equal(legacyLog.skuId, null)

  // 核销尾部审计失败：库存、库位、流水、主状态和正式单全部真实回滚。
  const failed = await createProduct()
  await locationStocks.save({ skuId: failed.variants[0]!.id, locationId: shelfB.id, qty: 10 })
  const failedOrder = await place(failed)
  const beforeFailure = {
    stock: await stock(failed), rows: await locationStocks.find({ where: { skuId: failed.variants[0]!.id } }),
    logs: await logs.count(), outbound: await outbound.count(), audits: await audits.count(),
  }
  const originalAudit = auditService.record
  auditService.record = async (...args: Parameters<typeof originalAudit>) => {
    if (args[0].actionType === 'o2o.preorder.verify') throw new Error('O2O_VERIFY_AUDIT_FAILURE')
    return originalAudit.apply(auditService, args)
  }
  try { await assert.rejects(verify(failedOrder), /O2O_VERIFY_AUDIT_FAILURE/) }
  finally { auditService.record = originalAudit }
  assert.deepEqual(await stock(failed), beforeFailure.stock)
  assert.deepEqual(await locationStocks.find({ where: { skuId: failed.variants[0]!.id } }), beforeFailure.rows)
  assert.equal(await logs.count(), beforeFailure.logs)
  assert.equal(await outbound.count(), beforeFailure.outbound)
  assert.equal(await audits.count(), beforeFailure.audits)
  assert.equal((await preorders.findOneByOrFail({ id: failedOrder.order.id })).status, 'pending')
  await verify(failedOrder)

  // 两商品逆序输入并发下单、不同操作者并发核销，不扩大到全仓压力测试。
  const left = await createProduct()
  const right = await createProduct()
  const refs = [left, right].map((fixture) => ({ productId: fixture.product.id, skuId: fixture.variants[0]!.id, qty: 1 }))
  const orders = await Promise.all(clients.map((client, index) => service.submit(client, {
    clientRequestId: randomUUID(), pickupContact: '反序核销领取人', isSystemApplied: false,
    items: index === 0 ? refs : [...refs].reverse(),
  })))
  await Promise.all(orders.map((order, index) => verify(order, actors[index]!)))
  for (const fixture of [left, right]) {
    assert.deepEqual(await stock(fixture), { current: 8, held: 0, skuCurrent: [8], skuHeld: [0] })
  }
  console.log('[o2o-inventory] ' + mode + ' 全部定向场景通过；未以 SQLite 证明 RR 行为')
} finally {
  try { await closeDataSource?.() }
  finally {
    try { if (createdDatabase) await mysqlAdmin!.query('DROP DATABASE ' + databaseName) }
    finally {
      await mysqlAdmin?.end()
      const relative = path.relative(allowedRoot, tempRoot)
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '清理范围越界')
      assert.equal(fs.readFileSync(path.join(tempRoot, '.owner'), 'utf8'), owner, '归属标记不符')
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  }
}
