/**
 * 文件职责：在 owned MySQL 8.4 中，以两个真实事务验证不同账号的全局幂等键回放及库存提前拒绝。
 * 实现逻辑：真实首查均 miss 后暂停 B，待 A 耗尽库存并提交再继续 B；不替换数据库查询结果。
 * 维护说明：仅由既有 owned MySQL fixture 派生，应用导入前固化随机空库和全部持久路径；不运行容量测试。
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import type { AuthUserContext } from '../src/types/auth.js'
import type { QueryRunner } from 'typeorm'
import { createVerificationIsolation } from './verification-isolation.js'
import { createOwnedVerificationDatabase, verificationDatabaseName } from './owned-verification-database.js'
import { readOwnedMysqlContext } from './owned-mysql-fixture.mjs'

const isolation = createVerificationIsolation('manual-outbound-idempotency')
let owned: Awaited<ReturnType<typeof createOwnedVerificationDatabase>> | undefined
let source: (typeof import('../src/config/data-source.js'))['AppDataSource'] | undefined
const failures: unknown[] = []
try {
  const config = readOwnedMysqlContext() // 核对容器名/owner、真实回环高位端口，不接受通用业务数据库。
  owned = await createOwnedVerificationDatabase(config, verificationDatabaseName('manual_outbound_replay'))
  await owned.assertEmpty()
  isolation.seal({ type: 'mysql', ...config, database: owned.database })
  Object.assign(process.env, { NODE_ENV: 'test', DB_SYNC: 'false', DB_POOL_SIZE: '20' })
  const [dataSource, { SysUser }, { BaseProduct }, { BaseProductSku }, { BizOutboundOrder },
    { BizOutboundOrderItem }, { InventoryLog }, { orderService }, { orderSerialService },
    { orderBusinessNoService }, { systemConfigService }, { BizError }] = await Promise.all([
    import('../src/config/data-source.js'), import('../src/entities/sys-user.entity.js'),
    import('../src/entities/base-product.entity.js'), import('../src/entities/base-product-sku.entity.js'),
    import('../src/entities/biz-outbound-order.entity.js'), import('../src/entities/biz-outbound-order-item.entity.js'),
    import('../src/entities/inventory-log.entity.js'), import('../src/services/order.service.js'),
    import('../src/services/order-serial.service.js'), import('../src/services/order-business-no.service.js'),
    import('../src/services/system-config.service.js'), import('../src/utils/errors.js'),
  ])
  source = dataSource.AppDataSource
  const db = source
  await isolation.assertTarget(db)
  await db.initialize()
  await isolation.assertTarget(db)
  const [server] = await db.query('SELECT VERSION() AS version, @@transaction_isolation AS isolationLevel')
  assert.match(server.version, /^8\.4\.10(?:\D|$)/)
  assert.equal(server.isolationLevel, 'REPEATABLE-READ', '必须真实覆盖 RR 首查快照，不改隔离级别')
  await db.synchronize()
  await systemConfigService.ensureDefaultConfigs()
  const seed = randomBytes(6).toString('hex')
  const actors: AuthUserContext[] = []
  for (const label of ['a', 'b']) {
    const account = await db.getRepository(SysUser).save({ username: `stock_${label}_${seed}`,
      displayName: `库存回归${label}`, passwordHash: 'test-only-hash', role: 'admin', status: 'enabled' })
    actors.push({ userId: account.id, username: account.username, displayName: account.displayName,
      role: 'admin', status: 'enabled', permissions: ['orders:create', 'orders:view'],
      sessionToken: `fixture-${label}-${seed}`, authSource: 'bearer' })
  }
  const context = new AsyncLocalStorage<'A' | 'B'>()
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }
  const wait = async (promise: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('真实事务屏障超时')), 10_000)
      })])
    } finally { clearTimeout(timer) }
  }

  for (const sharedKey of [true, false]) {
    const suffix = sharedKey ? 'same' : 'different'
    const product = await db.getRepository(BaseProduct).save({ productCode: `REPLAY-${suffix}-${seed}`,
      productName: `回放库存${suffix}`, pinyinAbbr: 'REPLAY', defaultPrice: '10.00', discountRate: '10.0',
      currentStock: 1, preOrderedStock: 0, isActive: true })
    const sku = await db.getRepository(BaseProductSku).save({ productId: product.id, skuCode: `REPLAY-SKU-${suffix}-${seed}`,
      specValuesJson: '{}', specText: '默认规格', defaultPrice: '10.00', discountRate: '10.0',
      currentStock: 1, preOrderedStock: 0, isActive: true, isCurrent: true, sortOrder: 0 })
    const key = `stock-replay-${suffix}-${seed}`
    const bothMissed = deferred(), releaseB = deferred()
    const initial = new Map<string, QueryRunner>(), connectionIds = new Map<string, number>()
    let bAllocations = 0, bOrderWrites = 0, freshReplayRead = false
    const createRunner = db.createQueryRunner
    const generateNumber = orderSerialService.generateSystemNo
    const allocateNumber = orderBusinessNoService.allocate
    orderSerialService.generateSystemNo = function (...args) {
      if (context.getStore() === 'B') bAllocations += 1
      return generateNumber.apply(this, args)
    }
    orderBusinessNoService.allocate = function (...args) {
      if (context.getStore() === 'B') bAllocations += 1
      return allocateNumber.apply(this, args)
    }
    db.createQueryRunner = function (...args) {
      const runner = createRunner.apply(this, args), query = runner.query.bind(runner)
      runner.query = async (...args: Parameters<typeof runner.query>) => {
        const label = context.getStore(), sql = args[0]
        if (label === 'B' && /^\s*(?:INSERT INTO|UPDATE)\s+`?biz_outbound_order(?:_item)?`?(?:\s|\()/i.test(sql)) bOrderWrites += 1
        const isKeyRead = /^\s*SELECT\b/i.test(sql) && /FROM\s+`?biz_outbound_order`?\s/i.test(sql)
          && /WHERE[\s\S]*idempotency_key/i.test(sql)
        if (label && isKeyRead && !runner.isTransactionActive) {
          assert.equal(initial.get(label)?.isReleased, true, '事务外回放必须先释放原事务连接，不能锁内再租第二条')
          if (label === 'B') freshReplayRead = true
        }
        const result = await query(...args)
        if (label && isKeyRead && runner.isTransactionActive && !initial.has(label)) {
          const rows = Array.isArray(result) ? result : result.records
          assert.equal(rows.length, 0, '两账号的真实普通首查必须均 miss')
          initial.set(label, runner)
          const [connection] = await query('SELECT CONNECTION_ID() AS id')
          connectionIds.set(label, Number(connection.id))
          if (initial.size === 2) bothMissed.resolve()
          await wait(bothMissed.promise)
          if (label === 'B') await wait(releaseB.promise)
        }
        return result
      }
      return runner
    }
    const submit = (actor: AuthUserContext, idempotencyKey: string) => orderService.submit({
      idempotencyKey, orderType: 'walkin', customerName: '库存幂等回归',
      items: [{ productId: product.id, skuId: sku.id, qty: 1, unitPrice: 10 }],
    }, actor)
    const a = context.run('A', () => submit(actors[0]!, key))
    const b = context.run('B', () => submit(actors[1]!, sharedKey ? key : `${key}-b`))
    // A 完整提交后才放行 B 的锁内当前读；失败也解除测试屏障，不能遗弃事务阻碍清理。
    void a.then(releaseB.resolve, () => { bothMissed.resolve(); releaseB.resolve() })
    void b.catch(() => bothMissed.resolve())
    const settled = Promise.allSettled([a, b])
    try {
      const [first, second] = await settled
      assert.equal(initial.size, 2)
      assert.notEqual(connectionIds.get('A'), connectionIds.get('B'), '必须是两条真实 MySQL 事务连接')
      assert.equal(first.status, 'fulfilled')
      if (first.status !== 'fulfilled') throw first.reason
      assert.equal(first.value.idempotentReplay, false)
      if (sharedKey) {
        assert.equal(second.status, 'fulfilled')
        if (second.status !== 'fulfilled') throw second.reason
        assert.equal(second.value.idempotentReplay, true)
        assert.equal(second.value.order.id, first.value.order.id)
        assert.equal(second.value.inventory.deductedQty, 0)
      } else {
        assert.equal(second.status, 'rejected')
        if (second.status !== 'rejected') throw new Error('不同键库存不足不得成功')
        assert.ok(second.reason instanceof BizError)
        assert.equal(second.reason.statusCode, 409)
        assert.match(second.reason.message, /SKU .*可用库存不足/)
        assert.doesNotMatch(second.reason.message, /订单处理中/)
        assert.equal(await db.getRepository(BizOutboundOrder).countBy({ idempotencyKey: `${key}-b` }), 0)
      }
      assert.equal(freshReplayRead, true)
      assert.equal(bAllocations, 0)
      assert.equal(bOrderWrites, 0)
      assert.equal(await db.getRepository(BizOutboundOrder).countBy({ idempotencyKey: key }), 1)
      assert.equal(await db.getRepository(BizOutboundOrderItem).countBy({ orderId: first.value.order.id }), 1)
      const logs = await db.getRepository(InventoryLog).findBy({ refType: 'biz_outbound_order', refId: first.value.order.id })
      assert.equal(logs.length, 1)
      assert.equal(String(logs[0]!.operatorId), String(actors[0]!.userId))
      assert.equal((await db.getRepository(BaseProduct).findOneByOrFail({ id: product.id })).currentStock, 0)
      assert.equal((await db.getRepository(BaseProductSku).findOneByOrFail({ id: sku.id })).currentStock, 0)
      console.log(`PASS real MySQL RR two-account ${suffix}-key: initial miss, transaction released, no extra allocation/write`)
    } finally {
      bothMissed.resolve(); releaseB.resolve(); await settled
      db.createQueryRunner = createRunner
      orderSerialService.generateSystemNo = generateNumber
      orderBusinessNoService.allocate = allocateNumber
    }
  }
} catch (error) { failures.push(error) }
finally {
  try { if (source?.isInitialized) await source.destroy() } catch (error) { failures.push(error) }
  try { await owned?.cleanup() } catch (error) { failures.push(error) }
  try { isolation.cleanup() } catch (error) { failures.push(error) }
}
if (failures.length) throw new AggregateError(failures, '手工库存幂等回归失败（包含原异常及资源清理错误）')
