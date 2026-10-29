/**
 * 模块说明：真实 MySQL 双连接锁序回归。
 * 文件职责：在生产服务实际 SQL 边界暂停改单，观察登记连接的真实锁等待，再放行两事务。
 * 维护说明：只接受本批随机隔离库；不替换查询结果，不吞死锁，不在 SQLite 执行。
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DataSource, QueryRunner } from 'typeorm'
import type { ClientAuthContext } from '../src/types/client-auth.js'
import type { AuthUserContext } from '../src/types/auth.js'
import { o2oPreorderService as service } from '../src/services/o2o-preorder.service.js'
import { ClientUser } from '../src/entities/client-user.entity.js'
import { SysUser } from '../src/entities/sys-user.entity.js'
import { O2oPreorder } from '../src/entities/o2o-preorder.entity.js'
import { O2oPreorderItem } from '../src/entities/o2o-preorder-item.entity.js'
import { BaseProduct } from '../src/entities/base-product.entity.js'
import { BaseProductSku } from '../src/entities/base-product-sku.entity.js'
import { InventoryLog } from '../src/entities/inventory-log.entity.js'
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 10000) })]) }
  finally { clearTimeout(timer) }
}
export async function verifyMysqlRegistrationEditLockOrder(db: DataSource, auth: ClientAuthContext, orderId: string, item: { productId: string; skuId: string; qty: number }) {
  assert.equal(db.options.type, 'mysql')
  assert.match(String(db.options.database), /^ylink_i177_[a-f0-9]{16}$/)
  const context = new AsyncLocalStorage<'edit' | 'registration'>()
  const acquired = gate(), release = gate(), attempted = gate()
  const ids = new Map<string, number>(), firstLocks = new Map<string, string>()
  const original = db.createQueryRunner
  const accountTable = db.getMetadata(ClientUser).tableName
  const beforeStock = await db.getRepository(BaseProductSku).findOneByOrFail({ id: item.skuId })
  db.createQueryRunner = function (this: DataSource, ...args: Parameters<DataSource['createQueryRunner']>) {
    const runner = original.apply(this, args)
    const role = context.getStore(), query = runner.query.bind(runner)
    if (role) runner.query = (async (...queryArgs: Parameters<QueryRunner['query']>) => {
      const sql = String(queryArgs[0])
      if (/FOR UPDATE/i.test(sql) && !firstLocks.has(role)) {
        firstLocks.set(role, sql)
        const connection = await query('SELECT CONNECTION_ID() AS id')
        ids.set(role, Number(connection[0].id))
        if (role === 'registration') attempted.resolve()
        const result = await query(...queryArgs)
        if (role === 'edit') { acquired.resolve(); await release.promise }
        return result
      }
      return query(...queryArgs)
    }) as QueryRunner['query']
    return runner
  }
  let editing: Promise<unknown> | undefined, registering: Promise<unknown> | undefined
  try {
    editing = context.run('edit', () => service.updateMyOrder(auth, orderId, { items: [item], remark: '真实锁序交错' }))
    // 失败也解除等待，避免锁序回归时脚本自己挂死。
    void editing.catch(() => acquired.resolve())
    await bounded(acquired.promise, '改单未到达实际首锁')
    assert.ok(firstLocks.get('edit')?.includes(accountTable), '改单必须在原预订单前先锁账号')
    const current = await db.getRepository(O2oPreorder).findOneByOrFail({ id: orderId })
    registering = context.run('registration', () => service.updateKingdeeRegistration(orderId, { kingdeeVoucherNo: 'mysql-lock-order', expectedKingdeeVersion: current.kingdeeVersion }, { client: auth }))
    void registering.catch(() => attempted.resolve())
    await bounded(attempted.promise, '登记未尝试账号写锁')
    assert.notEqual(ids.get('edit'), ids.get('registration'), '必须使用真实不同连接')
    assert.ok(firstLocks.get('registration')?.includes(accountTable))
    // 观察真实 InnoDB 等待边 B→A；不能仅用延时/Promise 未完成冒充数据库锁证据。
    let observed = false
    for (let index = 0; index < 100 && !observed; index += 1) {
      const rows = await db.query(`SELECT 1 FROM performance_schema.data_lock_waits w
        JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID
        JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID
        WHERE r.PROCESSLIST_ID = ? AND b.PROCESSLIST_ID = ?`, [ids.get('registration'), ids.get('edit')])
      observed = rows.length > 0
      if (!observed) await new Promise((done) => setTimeout(done, 20))
    }
    assert.ok(observed, '应观察到登记等待改单账号锁，不能出现反向订单等待环')
    console.log(JSON.stringify({ scene: '真实MySQL双连接账号先锁', editConnection: ids.get('edit'), registrationConnection: ids.get('registration'), observedWait: observed }))
    release.resolve()
    await bounded(Promise.all([editing, registering]), '真实双连接事务未完成')
    const after = await db.getRepository(O2oPreorder).findOneByOrFail({ id: orderId })
    const stock = await db.getRepository(BaseProductSku).findOneByOrFail({ id: item.skuId })
    assert.equal(after.kingdeeVoucherNo, 'mysql-lock-order'); assert.equal(after.updateCount, 1)
    assert.equal(Number(stock.currentStock), Number(beforeStock.currentStock)); assert.equal(Number(stock.preOrderedStock), Number(beforeStock.preOrderedStock))
    for (const inactive of [{ status: 'disabled' as const }, { status: 'enabled' as const, deactivatedAt: new Date(), restoredAt: null }]) {
      await db.getRepository(ClientUser).update(auth.userId, inactive)
      await assert.rejects(() => service.updateMyOrder(auth, orderId, { items: [item], remark: '不应保存' }), /停用|注销/)
    }
  } finally {
    release.resolve()
    await Promise.allSettled([editing, registering].filter((value): value is Promise<unknown> => Boolean(value)))
    db.createQueryRunner = original
    await db.getRepository(ClientUser).update(auth.userId, { status: 'enabled', deactivatedAt: null, restoredAt: null })
  }
}

/** 两个方向都暂停赢家的真实账号写锁；另一个真实服务事务必须先等账号，不能先占原单。 */
export async function verifyMysqlOnsiteEditLockOrder(
  db: DataSource, client: ClientAuthContext, admin: AuthUserContext, orderId: string,
  item: { productId: string; skuId: string; qty: number }, first: 'client' | 'onsite',
) {
  assert.equal(db.options.type, 'mysql')
  assert.match(String(db.options.database), /^ylink_i177_[a-f0-9]{16}$/)
  assert.equal(item.qty, 1)
  const second = first === 'client' ? 'onsite' : 'client'
  const context = new AsyncLocalStorage<'client' | 'onsite'>()
  const acquired = gate(), release = gate(), attempted = gate()
  const ids = new Map<string, number>(), locks = new Map<string, string[]>()
  const original = db.createQueryRunner
  const accountTable = db.getMetadata(ClientUser).tableName
  const adminTable = db.getMetadata(SysUser).tableName
  const orderTable = db.getMetadata(O2oPreorder).tableName
  const touches = (sql: string, table: string) => sql.includes('`' + table + '`')
  const beforeOrder = await db.getRepository(O2oPreorder).findOneByOrFail({ id: orderId })
  const beforeProduct = await db.getRepository(BaseProduct).findOneByOrFail({ id: item.productId })
  const beforeSku = await db.getRepository(BaseProductSku).findOneByOrFail({ id: item.skuId })
  const logRepo = db.getRepository(InventoryLog)
  const logWhere = { refType: 'o2o_preorder', refId: orderId }
  const beforeLogs = new Set((await logRepo.find({ where: logWhere })).map((row) => String(row.id)))
  db.createQueryRunner = function (this: DataSource, ...args: Parameters<DataSource['createQueryRunner']>) {
    const runner = original.apply(this, args), query = runner.query.bind(runner), role = context.getStore()
    if (role) runner.query = (async (...queryArgs: Parameters<QueryRunner['query']>) => {
      const sql = String(queryArgs[0])
      if (/FOR UPDATE/i.test(sql)) {
        const sequence = locks.get(role) ?? []; sequence.push(sql); locks.set(role, sequence)
        if (!ids.has(role)) ids.set(role, Number((await query('SELECT CONNECTION_ID() AS id'))[0].id))
        if (role === second && touches(sql, accountTable)) attempted.resolve()
        // 只暂停已经由MySQL成功取得的账号锁，所有SQL和结果均保持生产执行。
        const result = await query(...queryArgs)
        if (role === first && touches(sql, accountTable)) { acquired.resolve(); await release.promise }
        return result
      }
      return query(...queryArgs)
    }) as QueryRunner['query']
    return runner
  }
  const tasks: Array<Promise<Awaited<ReturnType<typeof service.updateMyOrder>>>> = []
  const invoke = (role: 'client' | 'onsite', qty: number) => context.run(role, () => role === 'client'
    ? service.updateMyOrder(client, orderId, { items: [{ ...item, qty }], remark: '真实客户端与现场锁序交错' })
    : service.updateOrderOnsite(admin, { orderId, items: [{ ...item, qty }], remark: '真实现场与客户端锁序交错' }))
  try {
    tasks.push(invoke(first, 2)); void tasks[0]!.catch(() => acquired.resolve())
    await bounded(acquired.promise, '领先事务未取得真实客户账号锁')
    tasks.push(invoke(second, 1)); void tasks[1]!.catch(() => attempted.resolve())
    await bounded(attempted.promise, '等待事务未尝试真实客户账号锁')
    assert.notEqual(ids.get(first), ids.get(second), '两次保存必须来自不同MySQL连接')
    let waitRows: Array<{ requestingConnection: number; blockingConnection: number; lockedTable: string; requestedMode: string }> = []
    for (let index = 0; index < 100 && waitRows.length === 0; index += 1) {
      waitRows = await db.query(`SELECT r.PROCESSLIST_ID AS requestingConnection, b.PROCESSLIST_ID AS blockingConnection,
        l.OBJECT_NAME AS lockedTable, l.LOCK_MODE AS requestedMode FROM performance_schema.data_lock_waits w
        JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID
        JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID
        JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE = w.ENGINE
        WHERE r.PROCESSLIST_ID = ? AND b.PROCESSLIST_ID = ? AND l.OBJECT_NAME = ?`, [ids.get(second), ids.get(first), accountTable])
      if (waitRows.length === 0) await new Promise((done) => setTimeout(done, 20))
    }
    assert.ok(waitRows.length > 0, '必须观察到真实客户账号锁等待，不能用定时或未完成Promise代替')
    assert.ok(!locks.get(second)?.some((sql) => touches(sql, orderTable)), '等待客户账号时不得已锁原预订单')
    console.log(JSON.stringify({ scene: '现场与客户端真实锁等待', first, second, waitRows }))
    release.resolve()
    const results = await bounded(Promise.all(tasks), '现场与客户端真实双保存未完成，不能吞掉1213或锁超时')
    assert.equal(results[0]!.order.totalQty, 2); assert.equal(results[1]!.order.totalQty, 1)
    for (const role of ['client', 'onsite'] as const) {
      const sequence = locks.get(role) ?? []
      const accountIndex = sequence.findIndex((sql) => touches(sql, accountTable))
      const orderIndex = sequence.findIndex((sql) => touches(sql, orderTable))
      assert.ok(accountIndex >= 0 && orderIndex > accountIndex, '真实保存必须先锁客户账号再锁原单')
      if (role === 'onsite') assert.ok(touches(sequence[0] ?? '', adminTable), '现场管理员账号锁必须保留')
    }
    const after = await db.getRepository(O2oPreorder).findOneByOrFail({ id: orderId })
    const afterItem = await db.getRepository(O2oPreorderItem).findOneByOrFail({ orderId, skuId: item.skuId })
    const product = await db.getRepository(BaseProduct).findOneByOrFail({ id: item.productId })
    const sku = await db.getRepository(BaseProductSku).findOneByOrFail({ id: item.skuId })
    assert.equal(after.status, 'pending'); assert.equal(after.totalQty, 1); assert.equal(afterItem.qty, 1)
    assert.equal(after.updateCount, Number(beforeOrder.updateCount) + 1, '仅客户端保存增加改单次数')
    assert.equal(after.kingdeeVersion, beforeOrder.kingdeeVersion)
    assert.equal(after.kingdeeVoucherNo, beforeOrder.kingdeeVoucherNo)
    for (const [actual, before] of [[product, beforeProduct], [sku, beforeSku]] as const) {
      assert.equal(Number(actual.currentStock), Number(before.currentStock))
      assert.equal(Number(actual.preOrderedStock), Number(before.preOrderedStock), '1→2→1必须完整回补预占')
    }
    const logs = (await logRepo.find({ where: logWhere, order: { id: 'ASC' } })).filter((row) => !beforeLogs.has(String(row.id)))
    assert.equal(logs.length, 2)
    assert.deepEqual(logs.map((row) => row.changeType), ['preorder_hold', 'preorder_release'])
    assert.deepEqual(logs.map((row) => row.operatorType), [first === 'onsite' ? 'admin' : 'client', second === 'onsite' ? 'admin' : 'client'])
    for (const row of logs) assert.equal(row.changeQty, 1)
    assert.equal(Number(logs[0]!.beforePreorderedStock), Number(beforeProduct.preOrderedStock))
    assert.equal(Number(logs[0]!.afterPreorderedStock), Number(beforeProduct.preOrderedStock) + 1)
    assert.equal(Number(logs[1]!.beforePreorderedStock), Number(beforeProduct.preOrderedStock) + 1)
    assert.equal(Number(logs[1]!.afterPreorderedStock), Number(beforeProduct.preOrderedStock))
    console.log(JSON.stringify({ scene: '现场与客户端双保存完成', first, finalQty: after.totalQty, updateCount: after.updateCount, stockUnchanged: true, inventoryLogCount: logs.length, deadlocks: 0 }))
  } finally {
    release.resolve()
    await Promise.allSettled(tasks)
    db.createQueryRunner = original
  }
}

/** 在真实发现读取后改变来源夹具，证明正式订单锁后的归属复核会回滚，不能使用旧快照保存。 */
export async function verifyMysqlOnsiteSourceRecheck(db: DataSource, admin: AuthUserContext, orderId: string, otherClientId: string, item: { productId: string; skuId: string; qty: number }) {
  assert.equal(db.options.type, 'mysql')
  assert.match(String(db.options.database), /^ylink_i177_[a-f0-9]{16}$/)
  const context = new AsyncLocalStorage<boolean>(), acquired = gate(), release = gate()
  const original = db.createQueryRunner, adminTable = db.getMetadata(SysUser).tableName
  const orders = db.getRepository(O2oPreorder), before = await orders.findOneByOrFail({ id: orderId })
  const logsBefore = await db.getRepository(InventoryLog).count({ where: { refType: 'o2o_preorder', refId: orderId } })
  db.createQueryRunner = function (this: DataSource, ...args: Parameters<DataSource['createQueryRunner']>) {
    const runner = original.apply(this, args), query = runner.query.bind(runner), active = context.getStore()
    if (active) runner.query = (async (...queryArgs: Parameters<QueryRunner['query']>) => {
      const result = await query(...queryArgs)
      if (/FOR UPDATE/i.test(String(queryArgs[0])) && String(queryArgs[0]).includes('`' + adminTable + '`')) { acquired.resolve(); await release.promise }
      return result
    }) as QueryRunner['query']
    return runner
  }
  const saving = context.run(true, () => service.updateOrderOnsite(admin, { orderId, items: [item], remark: '来源已变化不应保存' }))
  void saving.catch(() => acquired.resolve())
  try {
    await bounded(acquired.promise, '现场保存未到达发现来源后的管理员锁')
    await orders.update(orderId, { clientUserId: otherClientId })
    release.resolve()
    await assert.rejects(bounded(saving, '来源复核未完成'), /预订单归属已变化/)
    const after = await orders.findOneByOrFail({ id: orderId })
    assert.equal(after.totalQty, before.totalQty); assert.equal(after.updateCount, before.updateCount)
    assert.equal(await db.getRepository(InventoryLog).count({ where: { refType: 'o2o_preorder', refId: orderId } }), logsBefore)
    console.log(JSON.stringify({ scene: '真实来源变更后现场保存拒绝旧快照', rejected: true, inventoryLogCountUnchanged: true }))
  } finally {
    release.resolve(); await Promise.allSettled([saving]); db.createQueryRunner = original
    await orders.update(orderId, { clientUserId: before.clientUserId })
  }
}
