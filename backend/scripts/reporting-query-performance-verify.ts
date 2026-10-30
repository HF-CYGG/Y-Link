/**
 * 模块说明：backend/scripts/reporting-query-performance-verify.ts
 * 文件职责：在隔离 SQLite 或显式确认的本机 MySQL 8.4 测试实例验证 #183 的真实聚合查询。
 * 实现逻辑：分别以上海、纽约时区启动子进程，写入大量订单并观察真实 SQL 返回量与执行计划；
 * 覆盖 DST、日历端点、主单金额快照、去重计数、已知 total 与游标导出不聚合。
 * 维护说明：不替换数据库结果；MySQL 仅创建/删除本次随机库，拒绝继承业务连接与运行时覆盖。
 * 用法（backend 目录）：node --import tsx scripts/reporting-query-performance-verify.ts [--mysql]
 * MySQL 还需 REPORTING_VERIFY_MYSQL_CONFIRM_TEST_SERVER=true、REPORTING_VERIFY_MYSQL_PORT（10000-65535），
 * 以及专项 REPORTING_VERIFY_MYSQL_USER/PASSWORD；不得指向业务实例。
 */
import 'reflect-metadata'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { QueryRunner } from 'typeorm'

const scriptPath = fileURLToPath(import.meta.url)
const mysqlMode = process.argv.includes('--mysql')
if (!process.argv.includes('--child')) {
  for (const zone of ['Asia/Shanghai', 'America/New_York']) {
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', scriptPath, '--child', ...(mysqlMode ? ['--mysql'] : []),
    ], { cwd: path.resolve(path.dirname(scriptPath), '..'), env: { ...process.env, TZ: zone }, stdio: 'inherit', timeout: 180_000 })
    if (child.error || child.status !== 0) {
      console.error(`报表聚合专项失败：${zone}，退出状态 ${child.status ?? child.error?.message}`)
      process.exit(1)
    }
  }
} else {
  await verify().catch((error) => {
    console.error(`报表聚合专项失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

async function verify() {
  const seed = `${Date.now()}_${process.pid}_${Math.random().toString(16).slice(2, 8)}`
  const databaseName = `y_link_reporting_${seed}`
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ylink-reporting-'))
  const sqlitePath = path.join(tempRoot, 'verify.sqlite')
  let mysqlAdmin: import('mysql2/promise').Connection | undefined
  let databaseCreated = false
  let source: (typeof import('../src/config/data-source.js'))['AppDataSource'] | undefined
  try {
    Object.assign(process.env, {
      ENV_FILE: '', APP_PROFILE: `reporting-query-${seed}`, Y_LINK_SKIP_DATABASE_RUNTIME_OVERRIDE: 'true',
      DB_TYPE: mysqlMode ? 'mysql' : 'sqlite', DB_SYNC: 'false', DB_AUTO_MIGRATE: 'false',
      SQLITE_DB_PATH: sqlitePath, Y_LINK_DATA_DIR: tempRoot, REDIS_URL: '', Y_LINK_MULTI_INSTANCE: 'false', DB_SSL_MODE: 'disabled',
    })
    if (mysqlMode) {
      assert.equal(process.env.REPORTING_VERIFY_MYSQL_CONFIRM_TEST_SERVER, 'true', '必须明确确认独立 MySQL 测试实例')
      const port = Number(process.env.REPORTING_VERIFY_MYSQL_PORT)
      assert.ok(Number.isInteger(port) && port >= 10000 && port <= 65535, '只允许指定本机独立测试端口')
      const user = process.env.REPORTING_VERIFY_MYSQL_USER
      assert.ok(user, '必须指定专项 MySQL 测试账号')
      const password = process.env.REPORTING_VERIFY_MYSQL_PASSWORD ?? ''
      const mysql = await import('mysql2/promise')
      mysqlAdmin = await mysql.createConnection({ host: '127.0.0.1', port, user, password, timezone: 'Z' })
      const [version] = await mysqlAdmin.query<import('mysql2/promise').RowDataPacket[]>('SELECT VERSION() AS version')
      assert.match(String(version[0]?.version), /^8\.4\./, '必须使用真实 MySQL 8.4')
      // 名称由本脚本生成，只包含小写字母、数字和下划线，不接受外部数据库名。
      assert.match(databaseName, /^y_link_reporting_[0-9a-f_]+$/)
      await mysqlAdmin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4`)
      databaseCreated = true
      Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: user, DB_PASSWORD: password, DB_NAME: databaseName })
    }
    const { env } = await import('../src/config/env.js')
    assert.equal(env.DB_TYPE, mysqlMode ? 'mysql' : 'sqlite')
    if (mysqlMode) {
      assert.equal(env.DB_NAME, databaseName)
      assert.equal(env.DB_HOST, '127.0.0.1')
    } else assert.equal(path.resolve(env.SQLITE_DB_PATH), sqlitePath)
    const { AppDataSource } = await import('../src/config/data-source.js')
    source = AppDataSource
    const { BizOutboundOrder } = await import('../src/entities/biz-outbound-order.entity.js')
    const { BizOutboundOrderItem } = await import('../src/entities/biz-outbound-order-item.entity.js')
    const { BaseProduct } = await import('../src/entities/base-product.entity.js')
    const { dashboardService } = await import('../src/services/dashboard.service.js')
    const { reportService } = await import('../src/services/report.service.js')
    await source.initialize()
    await source.synchronize()
    const emptyStats = await dashboardService.getStats()
    assert.deepEqual([emptyStats.todayOrderCount, emptyStats.todayOrderAmount, emptyStats.monthOrderCount, emptyStats.monthOrderAmount],
      [0, '0.00', 0, '0.00'], '空库统计必须保留零值与金额格式')
    const orderRepo = source.getRepository(BizOutboundOrder)
    const itemRepo = source.getRepository(BizOutboundOrderItem)
    const product = await source.getRepository(BaseProduct).save({ productCode: 'REPORTING', productName: '聚合专项商品', isActive: true })
    let sequence = 0
    const seedOrder = async (createdAt: Date, options: { isDeleted?: boolean; status?: 'active' | 'merged'; orderType?: string; amount?: string } = {}) => {
      sequence += 1
      return orderRepo.save({
        orderUuid: globalThis.crypto.randomUUID(), systemNo: `OUT-W-${sequence}`, businessNo: `reporting-${sequence}`,
        idempotencyKey: `reporting-${sequence}`, orderType: options.orderType ?? 'walkin',
        customerDepartmentName: '专项部门', totalQty: '2.00', totalAmount: options.amount ?? '0.30',
        createdAt, status: options.status ?? 'active', isDeleted: options.isDeleted ?? false,
      })
    }
    // 不同主键同一时刻，且主单快照故意不同于其明细合计，防止趋势误改为统计明细。
    const reportOrder = await seedOrder(new Date(2024, 2, 10, 0, 0, 0))
    await seedOrder(new Date(2024, 2, 10, 0, 0, 0))
    await seedOrder(new Date(2024, 2, 10, 23, 59, 59, 999))
    await seedOrder(new Date(2024, 2, 9, 23, 59, 59, 999))
    await seedOrder(new Date(2024, 2, 12, 0, 0, 0))
    await seedOrder(new Date(2024, 2, 10, 12), { isDeleted: true, amount: '99.00' })
    await seedOrder(new Date(2024, 2, 10, 12), { status: 'merged', amount: '99.00' })
    await itemRepo.insert([1, 2].map((lineNo) => ({ orderId: reportOrder.id, lineNo, productId: product.id,
      productNameSnapshot: '历史商品', qty: '1.00', unitPrice: '1.25', lineAmount: '1.25' })))
    await seedOrder(new Date(2024, 10, 3, 0, 0, 0))
    await seedOrder(new Date('2024-11-03T05:30:00Z'))
    await seedOrder(new Date('2024-11-03T06:30:00Z'))
    await seedOrder(new Date(2024, 10, 3, 23, 59, 59, 999))
    await seedOrder(new Date(2024, 10, 4, 0, 0, 0))
    await seedOrder(new Date(2023, 11, 31, 23, 59, 59, 999))
    await seedOrder(new Date(2024, 0, 1, 0, 0, 0))
    // 大量主单不带明细，桶聚合必须仍然覆盖，且返回量不随这些订单增长。
    const bulkCount = 12000
    for (let offset = 0; offset < bulkCount; offset += 100) {
      await orderRepo.insert(Array.from({ length: 100 }, () => {
        sequence += 1
        return { orderUuid: globalThis.crypto.randomUUID(), systemNo: `OUT-W-${sequence}`, businessNo: `reporting-${sequence}`,
          idempotencyKey: `reporting-${sequence}`, orderType: 'walkin', totalQty: '1.00', totalAmount: '0.01',
          createdAt: new Date(2024, 2, 10, 12) }
      }))
    }
    const clock = new Date()
    await seedOrder(new Date(clock.getFullYear(), clock.getMonth(), 1), { amount: '2.22' })
    await seedOrder(new Date(clock.getFullYear(), clock.getMonth(), 1, 0, 0, 0, -1), { amount: '3.33' })
    await seedOrder(new Date(clock.getFullYear(), clock.getMonth() + 1, 1), { amount: '4.44' })
    await seedOrder(new Date(), { amount: '1.11' })
    await seedOrder(new Date(), { isDeleted: true, amount: '99.00' })
    await seedOrder(new Date(), { status: 'merged', amount: '99.00' })

    type Observation = { sql: string; parameters: unknown[]; rows: number }
    const observations: Observation[] = []
    const originalFactory = source.createQueryRunner.bind(source)
    const originals = new Map<QueryRunner, QueryRunner['query']>()
    source.createQueryRunner = (...args) => {
      const runner = originalFactory(...args)
      if (!originals.has(runner)) {
        const original = runner.query.bind(runner)
        originals.set(runner, original)
        runner.query = async (sql, parameters, structured) => {
          const result = await original(sql, parameters, structured)
          const rows = Array.isArray(result) ? result : result?.records
          observations.push({ sql, parameters: parameters ?? [], rows: Array.isArray(rows) ? rows.length : 0 })
          return result
        }
      }
      return runner
    }
    try {
      const spring = await dashboardService.getAnalytics({ startDate: '2024-03-10', endDate: '2024-03-11', granularity: 'day' })
      assert.deepEqual(spring.trend.map(({ date, amount, orderCount, totalQty }) => [date, amount, orderCount, totalQty]), [
        ['2024-03-10', '120.90', bulkCount + 3, '12006.00'], ['2024-03-11', '0.00', 0, '0.00'],
      ], '春季 DST、凌晨、同刻多单、删除/合并排除及主单快照必须一致')
      const trendQuery = observations.find((row) => /bucketIndex/.test(row.sql))!
      assert.ok(trendQuery)
      assert.equal(trendQuery.rows, 1, '12003 单只应从数据库返回一个非空桶')
      assert.match(trendQuery.sql, /GROUP BY/i)
      observations.length = 0
      const autumn = await dashboardService.getAnalytics({ startDate: '2024-11-03', endDate: '2024-11-03', granularity: 'day' })
      assert.equal(autumn.trend[0]?.orderCount, 4, '秋季 DST 重复小时与当天末尾都不能丢失或多算次日')
      assert.equal(autumn.trend[0]?.amount, '1.20')
      if (process.env.TZ === 'America/New_York') {
        assert.equal((new Date(2024, 2, 11).getTime() - new Date(2024, 2, 10).getTime()) / 3600000, 23)
        assert.equal((new Date(2024, 10, 4).getTime() - new Date(2024, 10, 3).getTime()) / 3600000, 25)
      }
      observations.length = 0
      const year = await dashboardService.getAnalytics({ startDate: '2024-01-01', endDate: '2024-12-31', granularity: 'day' })
      assert.equal(year.trend.length, 366)
      assert.ok(observations.find((row) => /bucketIndex/.test(row.sql))!.rows <= 366, '最大区间也只能返回桶级结果')
      assert.ok(observations.find((row) => /bucketIndex/.test(row.sql))!.parameters.length < 999, '最大日区间不得超过 SQLite 传统绑定上限')
      await assert.rejects(() => dashboardService.getAnalytics({ startDate: '2024-01-01', endDate: '2025-01-01' }), /最长支持/)
      const monthly = await dashboardService.getAnalytics({ startDate: '2023-12-31', endDate: '2024-01-02', granularity: 'month' })
      assert.deepEqual(monthly.trend.map((point) => [point.date, point.orderCount]), [['2023-12', 1], ['2024-01', 1]])
      const emptyRange = await dashboardService.getAnalytics({ startDate: '2023-01-01', endDate: '2023-01-01' })
      assert.deepEqual(emptyRange.trend.map((point) => [point.amount, point.orderCount, point.totalQty]), [['0.00', 0, '0.00']])
      const partialMonth = await dashboardService.getAnalytics({ startDate: '2024-03-10', endDate: '2024-03-11', granularity: 'month' })
      assert.equal(partialMonth.trend[0]?.orderCount, bulkCount + 3, '月桶首尾仍受请求区间裁剪')
      const department = await dashboardService.getAnalytics({ startDate: '2024-03-10', endDate: '2024-03-11', orderType: 'department' })
      assert.ok(department.trend.every((point) => point.orderCount === 0), '趋势必须继承订单类型过滤')

      // 用原始 getCount + SUM 口径对照合并后的今日/本月统计。
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const month = new Date(today.getFullYear(), today.getMonth(), 1)
      const referenceStats = []
      for (const start of [today, month]) {
        const qb = orderRepo.createQueryBuilder('order').where('order.createdAt >= :start', { start })
          .andWhere('order.isDeleted = :deleted', { deleted: false }).andWhere('order.status = :status', { status: 'active' })
        referenceStats.push({ count: await qb.getCount(), amount: Number((await qb.clone().select('SUM(order.totalAmount)', 'amount').getRawOne())?.amount ?? 0).toFixed(2) })
      }
      observations.length = 0
      const stats = await dashboardService.getStats()
      assert.deepEqual([stats.todayOrderCount, stats.todayOrderAmount, stats.monthOrderCount, stats.monthOrderAmount],
        [referenceStats[0]!.count, referenceStats[0]!.amount, referenceStats[1]!.count, referenceStats[1]!.amount])
      assert.equal(observations.filter((row) => /FROM ["`]biz_outbound_order["`]/.test(row.sql)).length, 1, '工作台统计只能查询一次订单聚合')

      // 补有明细的删除、合并来源与部门单，验证聚合沿用真实联表过滤。
      const excludedOrders = [
        await seedOrder(new Date(2024, 2, 10, 12), { isDeleted: true }),
        await seedOrder(new Date(2024, 2, 10, 12), { status: 'merged' }),
      ]
      const departmentOrder = await seedOrder(new Date(2024, 2, 10, 12), { orderType: 'department' })
      await itemRepo.insert([...excludedOrders, departmentOrder].map((order) => ({
        orderId: order.id, lineNo: 1, productId: product.id, productNameSnapshot: '过滤专项',
        qty: '3.00', unitPrice: '1.10', lineAmount: '3.30',
      })))
      const originalCount = await itemRepo.createQueryBuilder('item')
        .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
        .where('order.isDeleted = :deleted', { deleted: false }).andWhere('order.status = :status', { status: 'active' })
        .andWhere('order.orderType = :type', { type: 'walkin' })
        .andWhere('order.createdAt >= :start', { start: new Date(2024, 2, 10) })
        .andWhere('order.createdAt < :end', { end: new Date(2024, 2, 12) }).getCount()
      observations.length = 0
      const input = { startDate: '2024-03-10', endDate: '2024-03-11', pageSize: 1 }
      const report = await reportService.query('walkin', input)
      assert.equal(report.total, originalCount, '必须与原 TypeORM getCount 的联表去重口径一致')
      assert.equal(report.total, 2, '两行同一主单应按明细主键计数，不能按主单去重')
      assert.equal(report.list.length, 1)
      assert.deepEqual(report.summary, { totalQty: '2.00', totalAmount: '2.50' }, '报表使用明细金额快照，不能读取主单总额')
      assert.equal(observations.filter((row) => /\bSUM\(/i.test(row.sql)).length, 1)
      assert.equal(observations.filter((row) => /\bCOUNT\(/i.test(row.sql)).length, 1)
      assert.match(observations.find((row) => /\bCOUNT\(/i.test(row.sql))!.sql, /COUNT\(DISTINCT/i)
      const kingdee = await reportService.query('kingdee', input)
      assert.equal(kingdee.total, 1)
      assert.deepEqual(kingdee.summary, { totalQty: '3.00', totalAmount: '3.30' })
      const secondPage = await reportService.query('walkin', { ...input, page: 2 })
      assert.deepEqual(secondPage.summary, report.summary)
      assert.equal(secondPage.total, report.total)
      const missing = await reportService.query('walkin', { startDate: '2023-01-01', endDate: '2023-01-01' })
      assert.equal(missing.total, 0)
      assert.deepEqual(missing.summary, { totalQty: '0.00', totalAmount: '0.00' })
      observations.length = 0
      const resolved = reportService['resolveQuery']('walkin', input)
      const known = await reportService['queryOrderItemReport']('walkin', resolved, 123)
      assert.equal(known.total, 123, '已知 total 不得被覆盖或重新计算')
      assert.equal(observations.some((row) => /\bCOUNT\(/i.test(row.sql)), false)
      assert.deepEqual(known.summary, report.summary)
      observations.length = 0
      const exportBatch = await reportService['queryOrderItemReport']('walkin', resolved, undefined, { enabled: true })
      assert.equal(exportBatch.total, 0)
      assert.equal(exportBatch.summary, undefined)
      assert.equal(exportBatch.list.length, 1)
      assert.ok(exportBatch.nextCursor)
      const nextBatch = await reportService['queryOrderItemReport']('walkin', resolved, undefined, { enabled: true, cursor: exportBatch.nextCursor! })
      assert.equal(nextBatch.list.length, 1)
      assert.notEqual(nextBatch.nextCursor, exportBatch.nextCursor)
      assert.equal(observations.some((row) => /\b(?:COUNT|SUM)\(/i.test(row.sql)), false, '游标导出不得执行全量聚合')
      // EXPLAIN 使用同一条真实 SQL/绑定参数；不以 SQLite 或替身结果背书 MySQL。
      const plan = await source.query((mysqlMode ? 'EXPLAIN FORMAT=JSON ' : 'EXPLAIN QUERY PLAN ') + trendQuery.sql, trendQuery.parameters)
      const tablePlans: unknown[] = []
      const walkPlan = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        const record = value as Record<string, unknown>
        if ('table_name' in record) tablePlans.push({ table: record.table_name, access: record.access_type, rowsExamined: record.rows_examined_per_scan })
        Object.values(record).forEach(walkPlan)
      }
      if (mysqlMode) walkPlan(JSON.parse(String(plan[0]?.EXPLAIN)))
      console.log(JSON.stringify({ engine: mysqlMode ? 'MySQL 8.4' : 'SQLite', timezone: process.env.TZ, bulkCount,
        trendDatabaseRows: trendQuery.rows, maxDailyBuckets: year.trend.length, plan: mysqlMode ? tablePlans : plan }))
    } finally {
      source.createQueryRunner = originalFactory
      originals.forEach((query, runner) => { runner.query = query })
    }
  } finally {
    if (source?.isInitialized) await source.destroy()
    if (mysqlAdmin) {
      try { if (databaseCreated) await mysqlAdmin.query(`DROP DATABASE \`${databaseName}\``) }
      finally { await mysqlAdmin.end() }
    }
    // 只清理脚本创建的随机临时目录，绝不接受外部路径。
    assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()), '临时清理路径必须位于系统临时目录直属子级')
    assert.ok(path.basename(tempRoot).startsWith('ylink-reporting-'))
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}
