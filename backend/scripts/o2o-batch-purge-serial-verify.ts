/**
 * 批量删除流水回归：使用独立 SQLite 验证双类型尾号回拨、占用保护及失败事务回滚。
 * 只调用测试库中的真实服务，不读取或清理本地业务库。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-batch-serial-'))
process.env.APP_PROFILE = 'batch-serial-verify'
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'false'
process.env.SQLITE_DB_PATH = path.join(runtimeDir, 'verification.sqlite')
process.env.Y_LINK_DATA_DIR = runtimeDir
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'

const { AppDataSource } = await import('../src/config/data-source.js')
const { prepareDatabaseRuntime, initializeDatabaseSchemaIfNeeded } = await import('../src/config/database-bootstrap.js')
const { systemConfigService } = await import('../src/services/system-config.service.js')
const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')
const { orderSerialService } = await import('../src/services/order-serial.service.js')
const { ClientUser } = await import('../src/entities/client-user.entity.js')
const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
const { BusinessSequence } = await import('../src/entities/business-sequence.entity.js')
const { SystemConfig } = await import('../src/entities/system-config.entity.js')
const { SysAuditLog } = await import('../src/entities/sys-audit-log.entity.js')

try {
  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()
  const user = await AppDataSource.getRepository(ClientUser).save({ realName: '流水回归', passwordHash: 'test-only', status: 'enabled' })
  const actor = { userId: '1', username: 'test-admin', displayName: '测试管理员', role: 'admin' as const, permissions: [], status: 'enabled' as const, sessionToken: 'test-only' }
  const repo = AppDataSource.getRepository(O2oPreorder)
  const create = async (clientOrderType: 'walkin' | 'department', status: 'pending' | 'cancelled' = 'cancelled') => repo.save({
    clientUserId: user.id,
    showNo: await orderSerialService.generateOrderNo(clientOrderType),
    verifyCode: randomUUID(), clientOrderType, status, cancelReason: status === 'cancelled' ? 'manual' as const : null,
  })
  const purge = (orders: Array<{ id: string; showNo: string }>) => o2oPreorderService.batchPurgeCancelledOrders({
    orders: orders.map((order) => ({ id: String(order.id), confirmShowNo: order.showNo })), actor,
  })
  const current = async (type: string) => {
    const sequenceKey = `order.serial.${type}`
    const sequence = await AppDataSource.getRepository(BusinessSequence).findOneByOrFail({ sequenceKey })
    const config = await AppDataSource.getRepository(SystemConfig).findOneByOrFail({ configKey: `${sequenceKey}.current` })
    assert.equal(Number(sequence.currentValue), Number(config.configValue), '序列表与管理配置镜像必须一致')
    return Number(sequence.currentValue)
  }

  for (const type of ['walkin', 'department'] as const) {
    const occupied = await create(type, 'pending')
    const baseline = await current(type)
    const tailOne = await create(type)
    const tailTwo = await create(type)
    const result = await purge([tailOne, tailTwo, occupied])
    assert.equal(result.summary.deleted, 2)
    assert.equal(result.summary.skipped, 1)
    assert.equal(await current(type), baseline, `${type} 批删尾部订单应回拨到仍存在的占用流水`)
    assert.equal(await repo.countBy({ id: occupied.id }), 1)
    assert.equal(await orderSerialService.generateOrderNo(type), tailOne.showNo, '下一笔单号应复用释放的连续尾号')
  }

  const lower = await create('walkin')
  const higher = await create('walkin', 'pending')
  const beforeNonTail = await current('walkin')
  assert.equal((await purge([lower])).summary.deleted, 1)
  assert.equal(await current('walkin'), beforeNonTail, '删除非尾部订单不能覆盖后续仍占用的流水')
  assert.equal(await repo.countBy({ id: higher.id }), 1)

  const rollbackOrder = await create('walkin')
  const beforeRollback = await current('walkin')
  const originalRecalibrate = orderSerialService.recalibrateCurrentFromOccupancy.bind(orderSerialService)
  orderSerialService.recalibrateCurrentFromOccupancy = async (...args) => {
    await originalRecalibrate(...args)
    throw new Error('测试注入：流水校准后事务失败')
  }
  try {
    assert.equal((await purge([rollbackOrder])).summary.failed, 1)
  } finally {
    orderSerialService.recalibrateCurrentFromOccupancy = originalRecalibrate
  }
  assert.equal(await repo.countBy({ id: rollbackOrder.id }), 1, '流水校准失败必须回滚删除')
  assert.equal(await current('walkin'), beforeRollback, '回滚必须恢复序列及配置镜像')
  assert.equal(await AppDataSource.getRepository(SysAuditLog).countBy({ actionType: 'o2o.preorder.purge_cancelled', targetId: String(rollbackOrder.id) }), 0, '回滚不得留下单笔删除成功审计')
  console.log('OK 批删双类型流水回拨、占用保护、序列镜像与审计事务回滚全部通过')
} finally {
  if (AppDataSource.isInitialized) await AppDataSource.destroy()
  fs.rmSync(runtimeDir, { recursive: true, force: true })
}
