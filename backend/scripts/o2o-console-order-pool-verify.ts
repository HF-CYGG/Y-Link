/**
 * 文件说明：backend/scripts/o2o-console-order-pool-verify.ts
 * 文件职责：管理端订单池服务端分页专项验收（Issue #70）。
 * 实现逻辑：
 * 1. 使用临时 SQLite 构造待核销、已完成、已取消、带退货申请与已软删除的预订单；
 * 2. 断言各分栏数量为服务端统计总数且退货分栏与主状态交叉、分页按订单 ID 倒序且翻页不重复不遗漏；
 * 3. 断言越界页码收敛到最后有效页、筛选（账号类型、工号、关键字）同时作用于计数与列表、空结果处理；
 * 4. 断言新单提醒基准 latestOrderId / newOrderCount 与旧数组接口 listConsoleOrders 保持可用。
 * 维护说明：调整订单池分栏口径或分页契约时，必须同步更新本脚本与订单池页面。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runId = `${process.pid}-${Date.now()}`
const runtimeDir = path.join(os.tmpdir(), `ylink-order-pool-${runId}`)
const sqlitePath = path.join(runtimeDir, 'order-pool.sqlite')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `order-pool-${runId}`
process.env.DB_TYPE = 'sqlite'
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DATA_DIR = runtimeDir

fs.mkdirSync(runtimeDir, { recursive: true })

const main = async () => {
  const { AppDataSource } = await import('../src/config/data-source.js')
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
  const { O2oReturnRequest } = await import('../src/entities/o2o-return-request.entity.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')

  prepareDatabaseRuntime()
  await AppDataSource.initialize()
  await initializeDatabaseInfrastructure(AppDataSource)
  await initializeDatabaseSchemaIfNeeded(AppDataSource)

  const clientRepo = AppDataSource.getRepository(ClientUser)
  const preorderRepo = AppDataSource.getRepository(O2oPreorder)
  const returnRepo = AppDataSource.getRepository(O2oReturnRequest)
  const client = await clientRepo.save(clientRepo.create({
    realName: '订单池验收客户',
    passwordHash: 'order-pool-verify-hash',
    mobile: '13800000070',
    accountType: 'personal',
    status: 'enabled',
  }))

  let sequence = 0
  const createPreorder = async (
    status: 'pending' | 'verified' | 'cancelled',
    overrides: Partial<InstanceType<typeof O2oPreorder>> = {},
  ) => {
    sequence += 1
    const code = `${String(sequence).padStart(3, '0')}`
    return preorderRepo.save(preorderRepo.create({
      showNo: `POOL${code}`,
      clientUserId: client.id,
      verifyCode: `pool-verify-${runId}-${code}`,
      status,
      clientOrderType: 'walkin',
      totalQty: 1,
      timeoutAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      isDeleted: false,
      ...overrides,
    }))
  }

  const pendingOrders = []
  for (let index = 0; index < 7; index += 1) pendingOrders.push(await createPreorder('pending'))
  const verifiedOrders = []
  for (let index = 0; index < 4; index += 1) {
    verifiedOrders.push(await createPreorder('verified', {
      clientOrderType: 'department',
      departmentNameSnapshot: '订单池验收部门',
      staffNoSnapshot: 'T070',
    }))
  }
  const cancelledOrders = []
  for (let index = 0; index < 3; index += 1) cancelledOrders.push(await createPreorder('cancelled'))
  const deletedOrder = await createPreorder('pending', { isDeleted: true })

  for (const [index, order] of [verifiedOrders[0]!, cancelledOrders[0]!].entries()) {
    await returnRepo.save(returnRepo.create({
      returnNo: `POOLRT${index}`,
      orderId: order.id,
      clientUserId: client.id,
      verifyCode: `pool-return-${runId}-${index}`,
      status: 'pending',
      sourceOrderStatus: order.status,
      reason: '订单池退货分栏验收',
      totalQty: 1,
    }))
  }

  const visibleIds = [...pendingOrders, ...verifiedOrders, ...cancelledOrders]
    .map((order) => Number(order.id))
    .sort((left, right) => right - left)

  const firstPage = await o2oPreorderService.listConsoleOrderPool({})
  assert.deepEqual(firstPage.poolCounts, { all: 14, pending: 7, completed: 4, cancelled: 3, returns: 2 }, '分栏数量必须为服务端统计总数，退货分栏与主状态交叉，软删除订单不计入')
  assert.equal(firstPage.pageSize, 10, '订单池默认每页 10 条')
  assert.equal(firstPage.page, 1)
  assert.equal(firstPage.total, 14)
  assert.equal(firstPage.list.length, 10, '当前页只返回对应数量的订单')
  assert.deepEqual(firstPage.list.map((item) => Number(item.id)), visibleIds.slice(0, 10), '订单池必须按订单 ID 倒序分页')

  const secondPage = await o2oPreorderService.listConsoleOrderPool({ page: 2 })
  assert.deepEqual(secondPage.list.map((item) => Number(item.id)), visibleIds.slice(10), '翻页结果必须不重复、不遗漏')
  assert.ok(!secondPage.list.some((item) => String(item.id) === String(deletedOrder.id)), '软删除订单不得出现在订单池')

  const overflowPage = await o2oPreorderService.listConsoleOrderPool({ page: 99 })
  assert.equal(overflowPage.page, 2, '越界页码必须收敛到最后有效页')
  assert.equal(overflowPage.list.length, 4)

  const pendingPage = await o2oPreorderService.listConsoleOrderPool({ pool: 'pending', page: 2, pageSize: 5 })
  assert.equal(pendingPage.total, 7)
  assert.equal(pendingPage.list.length, 2)
  assert.ok(pendingPage.list.every((item) => item.status === 'pending'), '待核销分栏只返回待核销订单')

  const returnsPage = await o2oPreorderService.listConsoleOrderPool({ pool: 'returns' })
  assert.deepEqual(
    returnsPage.list.map((item) => String(item.id)).sort(),
    [String(verifiedOrders[0]!.id), String(cancelledOrders[0]!.id)].sort(),
    '退货分栏必须按是否存在退货申请筛选',
  )

  const cancelledPage = await o2oPreorderService.listConsoleOrderPool({ pool: 'cancelled' })
  assert.ok(cancelledPage.list.every((item) => item.status === 'cancelled'))
  const completedPage = await o2oPreorderService.listConsoleOrderPool({ pool: 'completed' })
  assert.ok(completedPage.list.every((item) => item.status === 'verified'))

  const departmentPage = await o2oPreorderService.listConsoleOrderPool({ accountType: 'department' })
  assert.deepEqual(departmentPage.poolCounts, { all: 4, pending: 0, completed: 4, cancelled: 0, returns: 1 }, '账号类型筛选必须同时作用于分栏计数')
  const staffNoPage = await o2oPreorderService.listConsoleOrderPool({ pool: 'completed', staffNo: 'T070', pageSize: 3 })
  assert.equal(staffNoPage.total, 4)
  assert.equal(staffNoPage.list.length, 3)
  const keywordPage = await o2oPreorderService.listConsoleOrderPool({ keyword: pendingOrders[2]!.showNo })
  assert.equal(keywordPage.total, 1, '关键字筛选必须同时作用于总数与列表')

  const emptyPage = await o2oPreorderService.listConsoleOrderPool({ keyword: 'not-exists-order', page: 3 })
  assert.equal(emptyPage.total, 0)
  assert.equal(emptyPage.page, 1, '空结果时页码必须回到第 1 页')
  assert.deepEqual(emptyPage.list, [])
  assert.deepEqual(emptyPage.poolCounts, { all: 0, pending: 0, completed: 0, cancelled: 0, returns: 0 })

  assert.equal(firstPage.latestOrderId, String(visibleIds[0]), '新单基准必须为当前筛选下的最大未删除订单 ID')
  assert.equal(firstPage.newOrderCount, 0, '未传新单基准时不统计新单数量')
  const newOrder = await createPreorder('pending')
  const afterNewOrder = await o2oPreorderService.listConsoleOrderPool({ pool: 'completed', sinceOrderId: firstPage.latestOrderId! })
  assert.equal(afterNewOrder.newOrderCount, 1, '停留在其他分栏时也必须统计到新增待核销订单')
  assert.equal(afterNewOrder.latestOrderId, String(newOrder.id))
  assert.equal(afterNewOrder.list.length, 4, '新单提醒不得追加当前分栏以外的订单')

  const legacyList = await o2oPreorderService.listConsoleOrders({ limit: 200 })
  assert.ok(Array.isArray(legacyList), '旧订单查询接口必须保持数组契约')
  assert.equal(legacyList.length, 15)

  await AppDataSource.destroy()
  console.log('OK 订单池服务端分页、分栏计数、越界收敛、筛选口径与新单提醒基准验收通过')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })
