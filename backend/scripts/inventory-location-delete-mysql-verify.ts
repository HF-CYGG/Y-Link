/**
 * 文件职责：在独占 MySQL 上验证库位删除与按库位盘点建单的两种提交顺序。
 * 实现逻辑：两个真实事务分别等待同一个盘点范围互斥，同步屏障只暂停 SQL 返回，不替换查询结果。
 * 维护说明：必须在自有 MySQL 容器中创建随机验证库，再导入应用模块。
 */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuthUserContext } from '../src/types/auth.js'
import { readOwnedMysqlContext } from './owned-mysql-fixture.mjs'
import { createOwnedVerificationDatabase, verificationDatabaseName } from './owned-verification-database.js'
import { createVerificationIsolation } from './verification-isolation.js'

const isolation = createVerificationIsolation('inventory-location-delete')
let owned: Awaited<ReturnType<typeof createOwnedVerificationDatabase>> | undefined
let source: (typeof import('../src/config/data-source.js'))['AppDataSource'] | undefined
const failures: unknown[] = []

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitForBarrier(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('库位并发验证事务同步超时')), 10_000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

try {
  const config = readOwnedMysqlContext()
  owned = await createOwnedVerificationDatabase(config, verificationDatabaseName('inventory_location_delete'))
  await owned.assertEmpty()
  isolation.seal({ type: 'mysql', ...config, database: owned.database })
  Object.assign(process.env, { NODE_ENV: 'test', DB_SYNC: 'false', DB_POOL_SIZE: '8' })
  const [{ AppDataSource }, { runInTransaction }, { resolvePermissionsByRole }, { SysUser }, { BaseStorageLocation },
    { InvStocktake }, { SysAuditLog }, { inventoryMasterDataService }, { productService }, { stocktakeService },
    { acquireSequenceMutex }, { readStocktakeLocationIds, STOCKTAKE_SCOPE_MUTEX_KEY }] = await Promise.all([
    import('../src/config/data-source.js'), import('../src/config/transaction-runner.js'), import('../src/constants/auth-permissions.js'),
    import('../src/entities/sys-user.entity.js'), import('../src/entities/base-storage-location.entity.js'),
    import('../src/entities/inv-stocktake.entity.js'), import('../src/entities/sys-audit-log.entity.js'),
    import('../src/services/inventory-master-data.service.js'), import('../src/services/product.service.js'),
    import('../src/services/stocktake.service.js'), import('../src/services/inventory-sequence.service.js'),
    import('../src/services/stocktake-scope.js'),
  ])
  source = AppDataSource
  await isolation.assertTarget(AppDataSource)
  await AppDataSource.initialize()
  await isolation.assertTarget(AppDataSource)
  const [server] = await AppDataSource.query('SELECT VERSION() AS version, @@transaction_isolation AS isolationLevel')
  assert.match(server.version, /^8\.(?:0|4)\./)
  assert.equal(server.isolationLevel, 'REPEATABLE-READ', '必须覆盖建单默认 RR 的历史快照')
  await AppDataSource.synchronize()

  const createActor = async (username: string): Promise<AuthUserContext> => {
    const account = await AppDataSource.getRepository(SysUser).save({
      username, displayName: username, passwordHash: 'verify-only-hash', role: 'operator', status: 'enabled',
    })
    return {
      userId: String(account.id), username: account.username, displayName: account.displayName,
      role: account.role, status: 'enabled', permissions: resolvePermissionsByRole(account.role),
      sessionToken: 'verify-only', authSource: 'bearer',
    }
  }
  const creator = await createActor('verify-stocktake-create')
  const deleter = await createActor('verify-location-delete')
  const stocked = await inventoryMasterDataService.createLocation({ locationCode: 'RACE-STOCKED' }, deleter)
  await productService.create({
    productName: '库位并发验证商品', currentStock: 2, defaultSku: { locationId: stocked.id },
  }, deleter)
  // 确保等待方经过真实的无锁存在查询，进而建立 MySQL RR 快照。
  await runInTransaction((manager) => acquireSequenceMutex(manager, STOCKTAKE_SCOPE_MUTEX_KEY))

  const context = new AsyncLocalStorage<'first' | 'waiting'>()
  const contend = async <A, B>(startFirst: () => Promise<A>, startWaiting: () => Promise<B>) => {
    const held = deferred()
    const snapshot = deferred()
    const release = deferred()
    const connectionIds = new Map<'first' | 'waiting', number>()
    const createRunner = AppDataSource.createQueryRunner
    AppDataSource.createQueryRunner = function (...args) {
      const runner = createRunner.apply(this, args)
      const query = runner.query.bind(runner)
      runner.query = async (...args: Parameters<typeof runner.query>) => {
        const result = await query(...args)
        const phase = context.getStore()
        const isScopeQuery = runner.isTransactionActive && /^\s*SELECT\b/i.test(args[0])
          && /\bbusiness_sequence\b/i.test(args[0]) && args[1]?.includes(STOCKTAKE_SCOPE_MUTEX_KEY)
        if (phase && isScopeQuery && !connectionIds.has(phase)) {
          const locksScope = /\bFOR\s+UPDATE\b/i.test(args[0])
          if ((phase === 'first' && locksScope) || (phase === 'waiting' && !locksScope)) {
            const [connection] = await query('SELECT CONNECTION_ID() AS id')
            connectionIds.set(phase, Number(connection.id))
            if (phase === 'waiting') snapshot.resolve()
            else {
              held.resolve()
              await waitForBarrier(release.promise)
            }
          }
        }
        return result
      }
      return runner
    }
    const first = context.run('first', startFirst)
    // 无论业务操作还是屏障先失败，都要消费 Promise 并放行阻塞，避免遗留写事务。
    void first.catch(held.resolve)
    let waiting: Promise<B> | undefined
    try {
      await waitForBarrier(held.promise)
      if (!connectionIds.has('first')) await first
      assert.ok(connectionIds.has('first'), '第一个事务必须已取得范围互斥')
      waiting = context.run('waiting', startWaiting)
      void waiting.catch(snapshot.resolve)
      await waitForBarrier(snapshot.promise)
      if (!connectionIds.has('waiting')) await waiting
      assert.ok(connectionIds.has('waiting'), '第二个事务必须先执行真实普通读')
      assert.notEqual(connectionIds.get('first'), connectionIds.get('waiting'), '必须使用两条真实连接')
      release.resolve()
      return await Promise.allSettled([first, waiting] as const)
    } finally {
      release.resolve()
      await Promise.allSettled(waiting ? [first, waiting] : [first])
      AppDataSource.createQueryRunner = createRunner
    }
  }

  const startStocktake = (id: string) => stocktakeService.create({
    scopeType: 'location', locationIds: [id, stocked.id], blindMode: false,
  }, creator)
  const locationRepo = AppDataSource.getRepository(BaseStorageLocation)
  const stocktakeRepo = AppDataSource.getRepository(InvStocktake)
  const auditRepo = AppDataSource.getRepository(SysAuditLog)

  await assert.rejects(
    () => stocktakeService.create({ scopeType: 'location', locationIds: [`${stocked.id}失效`] }, creator),
    { statusCode: 400, message: '存在无效的库位' },
  )
  assert.equal(await stocktakeRepo.count(), 0, '无效库位不应被数据库隐式转换后建单')

  const removed = await inventoryMasterDataService.createLocation({ locationCode: 'RACE-DELETED' }, deleter)
  const [deletion, lateStocktake] = await contend(
    () => inventoryMasterDataService.deleteLocation(removed.id, deleter),
    () => startStocktake(removed.id),
  )
  assert.equal(deletion.status, 'fulfilled')
  assert.equal(lateStocktake.status, 'rejected')
  assert.equal(lateStocktake.reason.statusCode, 400)
  assert.match(lateStocktake.reason.message, /无效的库位/)
  assert.equal(await locationRepo.existsBy({ id: removed.id }), false)
  assert.equal(await stocktakeRepo.count(), 0, '删除先提交后不能留下引用已删除库位的盘点单')
  assert.equal(await auditRepo.countBy({ actionType: 'product.location.delete', targetId: removed.id }), 1)

  const retained = await inventoryMasterDataService.createLocation({ locationCode: 'RACE-RETAINED' }, deleter)
  const [stocktake, lateDeletion] = await contend(
    () => startStocktake(`00${retained.id}`),
    () => inventoryMasterDataService.deleteLocation(retained.id, deleter),
  )
  assert.equal(stocktake.status, 'fulfilled')
  assert.equal(lateDeletion.status, 'rejected')
  assert.equal(lateDeletion.reason.statusCode, 409)
  assert.match(lateDeletion.reason.message, /盘点单引用/)
  assert.equal(await locationRepo.existsBy({ id: retained.id }), true)
  const row = await stocktakeRepo.findOneByOrFail({ id: stocktake.value.id })
  assert.deepEqual(JSON.parse(row.scopeJson).locationIds.sort(), [stocked.id, retained.id].sort(), '新单写入实际库位 ID')
  assert.equal(await auditRepo.countBy({ actionType: 'product.location.delete', targetId: retained.id }), 0)
  const historical = await inventoryMasterDataService.createLocation({ locationCode: 'LEGACY-SCOPE' }, deleter)
  await stocktakeRepo.update({ id: row.id }, { scopeJson: JSON.stringify({ locationIds: [stocked.id, `+00${historical.id}.0`] }) })
  assert.deepEqual(readStocktakeLocationIds((await stocktakeRepo.findOneByOrFail({ id: row.id })).scopeJson), [stocked.id, historical.id])
  await assert.rejects(() => inventoryMasterDataService.deleteLocation(historical.id, deleter), { statusCode: 409 })
  assert.equal(await locationRepo.existsBy({ id: historical.id }), true)
  assert.equal(await auditRepo.countBy({ actionType: 'product.location.delete', targetId: historical.id }), 0)
  console.log('[inventory-location-delete-mysql] 两种提交顺序均通过，未出现悬空盘点引用')
} catch (error) {
  failures.push(error)
} finally {
  try { if (source?.isInitialized) await source.destroy() } catch (error) { failures.push(error) }
  try { await owned?.cleanup() } catch (error) { failures.push(error) }
  try { isolation.cleanup() } catch (error) { failures.push(error) }
}
if (failures.length) throw new AggregateError(failures, 'MySQL 库位删除并发验证失败')
