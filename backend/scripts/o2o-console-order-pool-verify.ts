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
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runId = `${process.pid}-${Date.now()}`
const runtimeDir = path.join(os.tmpdir(), `ylink-order-pool-${runId}`)
const sqlitePath = path.join(runtimeDir, 'order-pool.sqlite')

process.env.NODE_ENV = 'test'
process.env.APP_PROFILE = `order-pool-${runId}`
// MySQL 仅允许 QA 显式准备的空隔离库；不得连接业务库，版本门禁保持 8.4。
const mysql = process.env.ORDER_POOL_TEST_MYSQL === 'true'
if (mysql && !/^ylink_order_pool_verify_[a-z0-9_]+$/.test(process.env.DB_NAME ?? '')) {
  throw new Error('MySQL 验收必须使用 ylink_order_pool_verify_ 前缀的独立空库')
}
process.env.DB_TYPE = mysql ? 'mysql' : 'sqlite'
process.env.Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE = 'true'
delete process.env.ENV_FILE
process.env.DB_SYNC = 'true'
process.env.SQLITE_DB_PATH = sqlitePath
process.env.Y_LINK_DATA_DIR = runtimeDir

fs.mkdirSync(runtimeDir, { recursive: true })
const previousCwd = process.cwd()
process.chdir(runtimeDir)
let cleanupDataSource: { isInitialized: boolean; destroy(): Promise<void> } | undefined

const main = async () => {
  const { AppDataSource } = await import('../src/config/data-source.js')
  cleanupDataSource = AppDataSource
  const { initializeDatabaseSchemaIfNeeded, prepareDatabaseRuntime } = await import('../src/config/database-bootstrap.js')
  const { initializeDatabaseInfrastructure } = await import('../src/database/database-strategy.js')
  const { ClientUser } = await import('../src/entities/client-user.entity.js')
  const { O2oPreorder } = await import('../src/entities/o2o-preorder.entity.js')
  const { O2oReturnRequest } = await import('../src/entities/o2o-return-request.entity.js')
  const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
  const { o2oPreorderService } = await import('../src/services/o2o-preorder.service.js')

  prepareDatabaseRuntime()
  if (mysql) AppDataSource.setOptions({ synchronize: false })
  await AppDataSource.initialize()
  if (mysql) {
    const version = await AppDataSource.query('SELECT VERSION() AS version')
    assert.match(String(version[0].version), /^8\.4\./, 'MySQL 验收必须使用 8.4')
    const tables = await AppDataSource.query('SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = DATABASE()')
    assert.equal(Number(tables[0].total), 0, 'MySQL 验收库必须为空，禁止覆盖既存数据')
    await AppDataSource.synchronize()
  }
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
    const orderType = overrides.clientOrderType ?? 'walkin'
    const typePrefix = orderType === 'department' ? 'D' : 'W'
    return preorderRepo.save(preorderRepo.create({
      preorderNo: `PRE-${typePrefix}-${String(sequence).padStart(6, '0')}`,
      clientUserId: client.id,
      verifyCode: `pool-verify-${runId}-${code}`,
      status,
      clientOrderType: orderType,
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
  assert.ok(verifiedOrders.every((order) => /^PRE-D-\d{6}$/.test(order.preorderNo)), '部门预订单夹具必须使用 PRE-D 编号')
  assert.ok([...pendingOrders, ...cancelledOrders, deletedOrder].every((order) => /^PRE-W-\d{6}$/.test(order.preorderNo)), '散客预订单夹具必须使用 PRE-W 编号')

  for (const [index, order] of [verifiedOrders[0]!, cancelledOrders[0]!, verifiedOrders[0]!].entries()) {
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
  // 工号按字面量包含匹配；同时验证分栏、分页、软删除、新单基准与旧数组接口使用相同筛选。
  const literalStaffCases = [
    ['POOL%70', 'POOLX70'],
    ['POOL_70', 'POOLX70'],
    [`POOL${String.fromCharCode(92)}70`, 'POOL70'],
    ['POOL!70', 'POOL70'],
  ] as const
  try {
    for (const [literal, decoy] of literalStaffCases) {
      await preorderRepo.update(verifiedOrders[0]!.id, { staffNoSnapshot: literal })
      await preorderRepo.update(verifiedOrders[1]!.id, { staffNoSnapshot: decoy })
      await preorderRepo.update(deletedOrder.id, { staffNoSnapshot: literal })
      const filters = {
        accountType: 'department' as const,
        departmentName: '订单池验收部门',
        staffNo: literal,
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }
      const page = await o2oPreorderService.listConsoleOrderPool({
        ...filters, pool: 'completed', page: 99, pageSize: 1, sinceOrderId: String(verifiedOrders[0]!.id),
      })
      assert.equal(page.total, 1, `工号 ${literal} 必须按字面量匹配，不能命中相似工号`)
      assert.deepEqual(page.list.map((item) => String(item.id)), [String(verifiedOrders[0]!.id)])
      assert.deepEqual(page.poolCounts, { all: 1, pending: 0, completed: 1, cancelled: 0, returns: 1 })
      assert.equal(page.page, 1)
      assert.equal(page.latestOrderId, String(verifiedOrders[0]!.id))
      assert.equal(page.newOrderCount, 0)
      const legacy = await o2oPreorderService.listConsoleOrders({ ...filters, limit: 200 })
      assert.deepEqual(legacy.map((item) => String(item.id)), [String(verifiedOrders[0]!.id)],
        '旧数组接口必须沿用字面量工号筛选')
      const deletedMatch = await o2oPreorderService.listConsoleOrderPool({ staffNo: literal })
      assert.equal(deletedMatch.total, 1, '工号相同的软删除订单不得计数')
    }
  } finally {
    await preorderRepo.update(verifiedOrders[0]!.id, { staffNoSnapshot: 'T070' })
    await preorderRepo.update(verifiedOrders[1]!.id, { staffNoSnapshot: 'T070' })
    await preorderRepo.update(deletedOrder.id, { staffNoSnapshot: null })
  }

  const keywordPage = await o2oPreorderService.listConsoleOrderPool({ keyword: pendingOrders[2]!.preorderNo })
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

  const filtered = await o2oPreorderService.listConsoleOrderPool({
    accountType: 'department', departmentName: '订单池验收部门', staffNo: 'T070',
    startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    endTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(), keyword: verifiedOrders[0]!.preorderNo,
  })
  assert.equal(filtered.total, 1, '账号、部门、工号、日期、关键字必须共同筛选')
  assert.equal(filtered.poolCounts.returns, 1, '重复退货申请不得重复计数')
  assert.equal(filtered.latestOrderId, String(verifiedOrders[0]!.id))
  const personal = await o2oPreorderService.listConsoleOrderPool({ accountType: 'personal' })
  assert.equal(personal.total, 11)

  const legacyList = await o2oPreorderService.listConsoleOrders({ limit: 200 })
  assert.ok(Array.isArray(legacyList), '旧订单查询接口必须保持数组契约')
  assert.equal(legacyList.length, 15)

  // SQLite 与 MySQL 使用同一组字面量断言，不通过 SQL mode 改变搜索语义。
  const assertKeywordMatches = async (
    keyword: string,
    expectedOrders: InstanceType<typeof O2oPreorder>[],
    admin = false,
  ) => {
    const actor = admin ? { role: 'admin' as const } : undefined
    const expectedIds = expectedOrders.map((order) => String(order.id))
      .sort((left, right) => Number(right) - Number(left))
    const page = await o2oPreorderService.listConsoleOrderPool({ keyword, page: 99, pageSize: 1 }, actor)
    assert.equal(page.total, expectedIds.length, `关键字 ${keyword} 必须只命中字面量匹配的订单`)
    assert.equal(page.page, Math.max(1, expectedIds.length))
    assert.deepEqual(page.list.map((item) => String(item.id)), expectedIds.slice(-1))
    assert.deepEqual(page.poolCounts, {
      all: expectedIds.length,
      pending: expectedOrders.filter((order) => order.status === 'pending').length,
      completed: expectedOrders.filter((order) => order.status === 'verified').length,
      cancelled: expectedOrders.filter((order) => order.status === 'cancelled').length,
      returns: expectedIds.filter((id) => [String(verifiedOrders[0]!.id), String(cancelledOrders[0]!.id)].includes(id)).length,
    })
    assert.equal(page.latestOrderId, expectedIds[0] ?? null)
    assert.equal(page.newOrderCount, 0)
    if (expectedIds.length > 1) {
      const first = await o2oPreorderService.listConsoleOrderPool({ keyword, pageSize: 1 }, actor)
      assert.deepEqual(first.list.map((item) => String(item.id)), expectedIds.slice(0, 1),
        '关键字分页必须不重复、不遗漏')
    }
    const legacy = await o2oPreorderService.listConsoleOrders({ keyword, limit: 200 }, actor)
    assert.deepEqual(legacy.map((item) => String(item.id)), expectedIds, '旧数组接口必须沿用相同关键字范围')
  }
  try {
    for (const [literal, decoy] of literalStaffCases) {
      await preorderRepo.update(verifiedOrders[0]!.id, { remark: `前文 ${literal} 后文` })
      await preorderRepo.update(verifiedOrders[2]!.id, { remark: `另一单 ${literal} 后文` })
      await preorderRepo.update(verifiedOrders[1]!.id, { remark: `前文 ${decoy} 后文` })
      await assertKeywordMatches(literal, [verifiedOrders[0]!, verifiedOrders[2]!])
    }
  } finally {
    for (const order of verifiedOrders.slice(0, 3)) await preorderRepo.update(order.id, { remark: null })
  }

  const outboundRepo = AppDataSource.getRepository(BizOutboundOrder)
  const createOutbound = (order: InstanceType<typeof O2oPreorder>, suffix: string) => outboundRepo.save(outboundRepo.create({
    orderUuid: randomUUID(), systemNo: `SYS-POOL-${suffix}`, businessNo: `BUS-POOL-${suffix}`,
    idempotencyKey: `pool-keyword-${runId}-${suffix}`, orderType: 'department',
    sourceDocType: 'o2o_preorder', sourceDocId: order.id, sourceDocNo: order.preorderNo,
    inventoryMode: 'legacy_none', status: 'active', totalQty: '0', totalAmount: '0', isDeleted: false,
  }))
  const targetOutbound = await createOutbound(verifiedOrders[0]!, 'TARGET')
  const decoyOutbound = await createOutbound(verifiedOrders[1]!, 'DECOY')
  try {
    for (const [literal, decoy] of literalStaffCases) {
      const businessPrefix = `BUS-${literal}`
      const systemPrefix = `SYS-${literal}`
      await outboundRepo.update(targetOutbound.id, { businessNo: `${businessPrefix}-END`, systemNo: `${systemPrefix}-END` })
      await outboundRepo.update(decoyOutbound.id, { businessNo: `BUS-${decoy}-END`, systemNo: `SYS-${decoy}-END` })
      await assertKeywordMatches(businessPrefix, [verifiedOrders[0]!])
      await assertKeywordMatches(`${businessPrefix}-END`, [verifiedOrders[0]!])
      await assertKeywordMatches(`${literal}-END`, [])
      await assertKeywordMatches(systemPrefix, [])
      await assertKeywordMatches(systemPrefix, [verifiedOrders[0]!], true)
      await assertKeywordMatches(`${systemPrefix}-END`, [])
      await assertKeywordMatches(`${systemPrefix}-END`, [verifiedOrders[0]!], true)

      // 核销前预留业务号也只按前缀回查，不扩大为包含匹配。
      await preorderRepo.update(verifiedOrders[2]!.id, { status: 'pending', reservedBusinessNo: `RSV-${literal}-END` })
      await preorderRepo.update(verifiedOrders[3]!.id, { status: 'pending', reservedBusinessNo: `RSV-${decoy}-END` })
      await assertKeywordMatches(`RSV-${literal}`, [{ ...verifiedOrders[2]!, status: 'pending' }])
      await assertKeywordMatches(`RSV-${literal}-END`, [{ ...verifiedOrders[2]!, status: 'pending' }])
      await assertKeywordMatches(`${literal}-END`, [])
    }
  } finally {
    for (const order of verifiedOrders.slice(2)) {
      await preorderRepo.update(order.id, { status: 'verified', reservedBusinessNo: null })
    }
  }

  // 只统计订单池的三条基础查询；summary/keyword 依赖的查询有各自覆盖，不混入本预算。
  const logger = AppDataSource.logger
  const originalLogQuery = logger.logQuery
  const statements: string[] = []
  logger.logQuery = (query) => { statements.push(query) }
  AppDataSource.setOptions({ logging: ['query'] })
  const originalNow = Date.now
  const nowMs = Date.UTC(2026, 10, 4, 12)
  const windowStart = nowMs - 30 * 60 * 1000
  try {
    const marker = String(newOrder.id)
    const before = await createPreorder('pending', { createdAt: new Date(windowStart - 1) })
    const at = await createPreorder('pending', { createdAt: new Date(windowStart) })
    const after = await createPreorder('pending', { createdAt: new Date(windowStart + 1) })
    await createPreorder('verified', { createdAt: new Date(windowStart + 1) })
    await createPreorder('pending', { createdAt: new Date(windowStart + 1), isDeleted: true })
    Date.now = () => nowMs
    statements.length = 0
    const boundary = await o2oPreorderService.listConsoleOrderPool({ pool: 'cancelled', sinceOrderId: marker })
    assert.equal(boundary.newOrderCount, 2, '新单窗口 -1ms 排除，等于和 +1ms 包含；仅 pending 且未删除')
    assert.equal(boundary.poolCounts.returns, 2, '跨状态退货且重复申请只计一单')
    const baseQueries = statements.filter((query) => /FROM ["`]o2o_preorder["`] ["`]order["`]/.test(query))
    assert.equal(baseQueries.length, 3, '非空页基础查询必须合并为聚合、退货 EXISTS、分页三条')
    assert.ok(baseQueries.some((query) => /CAST\(MAX\(/.test(query)), 'ID 必须先数值 MAX 后转文本')
    statements.length = 0
    const empty = await o2oPreorderService.listConsoleOrderPool({ departmentName: '不存在部门', page: 99 })
    assert.equal(empty.page, 1)
    assert.equal(empty.latestOrderId, null)
    assert.equal(empty.newOrderCount, 0)
    assert.equal(statements.filter((query) => /FROM ["`]o2o_preorder["`] ["`]order["`]/.test(query)).length, 2,
      '空结果只执行聚合与退货计数，不执行分页')
    assert.equal((await o2oPreorderService.listConsoleOrderPool({ sinceOrderId: String(at.id) })).newOrderCount, 1,
      '新单 ID 必须严格大于基准')
    assert.equal((await o2oPreorderService.listConsoleOrderPool({})).newOrderCount, 0)

    // 使用跨 JS 安全整数边界的两个相邻 MySQL ID，SQLite 保持安全整数。
    const lowId = mysql ? '9007199254740992' : '9007199254740990'
    const highId = mysql ? '9007199254740993' : '9007199254740991'
    await preorderRepo.update(before.id, { id: lowId, createdAt: new Date(windowStart) })
    await preorderRepo.update(after.id, { id: highId })
    const precise = await o2oPreorderService.listConsoleOrderPool({ pool: 'cancelled', sinceOrderId: lowId })
    assert.equal(precise.latestOrderId, highId, 'MAX 转字符串必须保留精确 ID')
    assert.equal(precise.newOrderCount, 1, '大 ID 基准不得经 Number 舍入')
    assert.ok(precise.list.every((row) => row.status === 'cancelled'), 'latest/new 与当前分栏独立')
  } finally {
    Date.now = originalNow
    logger.logQuery = originalLogQuery
    AppDataSource.setOptions({ logging: false })
  }

  await AppDataSource.destroy()
  console.log('OK 订单池服务端分页、分栏计数、越界收敛、筛选口径与新单提醒基准验收通过')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (cleanupDataSource?.isInitialized) await cleanupDataSource.destroy()
    process.chdir(previousCwd)
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  })
