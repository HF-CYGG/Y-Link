/**
 * 模块说明：真实 MySQL 双连接锁序回归。
 * 文件职责：在生产服务实际 SQL 边界暂停改单，观察登记连接的真实锁等待，再放行两事务。
 * 维护说明：只接受本批随机隔离库；不替换查询结果，不吞死锁，不在 SQLite 执行。
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DataSource, QueryRunner } from 'typeorm'
import type { ClientAuthContext } from '../src/types/client-auth.js'
import { o2oPreorderService as service } from '../src/services/o2o-preorder.service.js'
import { ClientUser } from '../src/entities/client-user.entity.js'
import { O2oPreorder } from '../src/entities/o2o-preorder.entity.js'
import { BaseProductSku } from '../src/entities/base-product-sku.entity.js'
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
