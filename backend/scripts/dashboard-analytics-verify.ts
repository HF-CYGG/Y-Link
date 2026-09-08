/**
 * 文件说明：backend/scripts/dashboard-analytics-verify.ts
 * 文件职责：验证工作台首页区间分析接口的区间边界、商品榜合并/细分口径、Top N 截断顺序、饼图占比口径与非法入参反馈。
 * 实现逻辑：
 * - 直接用仓储写入出库主单与明细，从而精确控制 createdAt 与 productNameSnapshot，
 *   模拟 O2O 核销写入的“商品名（规格）”快照与手工开单写入的纯商品名两种真实数据形态；
 * - 断言全部围绕 issue #60 的验收标准展开：跨年区间边界、合并数量等于各规格之和、先聚合再截断、空区间与非法区间反馈。
 * 维护说明：若调整看板统计口径、区间上限或规格解析规则，请同步更新本脚本断言。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeDatabaseSchemaIfNeeded } from '../src/config/database-bootstrap.js'
import { AppDataSource } from '../src/config/data-source.js'
import { env } from '../src/config/env.js'
import { BizOutboundOrder } from '../src/entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../src/entities/biz-outbound-order-item.entity.js'
import { dashboardService } from '../src/services/dashboard.service.js'
import { productService } from '../src/services/product.service.js'
import { systemConfigService } from '../src/services/system-config.service.js'

function pass(title: string) {
  console.log(`✅ ${title}`)
}

const currentFilePath = fileURLToPath(import.meta.url)
const backendRoot = path.resolve(path.dirname(currentFilePath), '..')

const RANGE_START = '2025-12-01'
const RANGE_END = '2026-08-31'

function resetVerifyDatabase() {
  if (env.DB_TYPE !== 'sqlite') {
    return
  }

  const verifyDatabasePath = path.resolve(backendRoot, env.SQLITE_DB_PATH)
  fs.mkdirSync(path.dirname(verifyDatabasePath), { recursive: true })
  if (fs.existsSync(verifyDatabasePath)) {
    fs.rmSync(verifyDatabasePath, { force: true })
  }
}

let orderSequence = 0

interface SeedItemInput {
  productId: string
  /** 出库明细名称快照：带“（规格）”后缀即模拟 O2O 核销单，纯商品名即模拟手工开单。 */
  nameSnapshot: string
  qty: number
  unitPrice: number
}

/**
 * 直接写入一张出库单：
 * - createdAt 由 @CreateDateColumn 自动生成，因此写入后再显式回写为目标时刻；
 * - 时刻使用本地时区构造，用于验证趋势分桶不会因 UTC 转换把凌晨单据算到前一天。
 */
async function seedOutboundOrder(input: {
  createdAt: Date
  orderType: 'walkin' | 'department'
  departmentName?: string
  items: SeedItemInput[]
}) {
  orderSequence += 1
  const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
  const itemRepo = AppDataSource.getRepository(BizOutboundOrderItem)

  const totalQty = input.items.reduce((sum, item) => sum + item.qty, 0)
  const totalAmount = input.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0)

  const order = await orderRepo.save(
    orderRepo.create({
      orderUuid: globalThis.crypto.randomUUID(),
      showNo: `DA-VERIFY-${String(orderSequence).padStart(5, '0')}`,
      orderType: input.orderType,
      issuerName: '区间分析验证',
      customerDepartmentName: input.departmentName ?? null,
      customerName: input.orderType === 'walkin' ? '区间分析散客' : null,
      idempotencyKey: `dashboard-analytics-verify-${orderSequence}`,
      totalQty: totalQty.toFixed(2),
      totalAmount: totalAmount.toFixed(2),
      isDeleted: false,
    }),
  )

  await orderRepo
    .createQueryBuilder()
    .update(BizOutboundOrder)
    .set({ createdAt: input.createdAt })
    .where('id = :id', { id: order.id })
    .execute()

  await itemRepo.save(
    input.items.map((item, index) =>
      itemRepo.create({
        orderId: order.id,
        lineNo: index + 1,
        productId: item.productId,
        productNameSnapshot: item.nameSnapshot,
        qty: item.qty.toFixed(2),
        unitPrice: item.unitPrice.toFixed(2),
        lineAmount: (item.qty * item.unitPrice).toFixed(2),
      }),
    ),
  )

  return order
}

async function main() {
  resetVerifyDatabase()

  await AppDataSource.initialize()
  await initializeDatabaseSchemaIfNeeded(AppDataSource)
  await systemConfigService.ensureDefaultConfigs()

  try {
    const canvasBag = await productService.create({
      productName: '帆布包',
      defaultPrice: 20,
      isActive: true,
    })
    const mug = await productService.create({
      productName: '马克杯',
      defaultPrice: 30,
      isActive: true,
    })

    // ---- 区间边界数据：下界前一天与上界后一天都必须被排除 ----
    await seedOutboundOrder({
      createdAt: new Date(2025, 10, 30, 10, 0, 0),
      orderType: 'walkin',
      items: [{ productId: canvasBag.id, nameSnapshot: '帆布包', qty: 100, unitPrice: 20 }],
    })
    await seedOutboundOrder({
      createdAt: new Date(2026, 8, 1, 10, 0, 0),
      orderType: 'walkin',
      items: [{ productId: canvasBag.id, nameSnapshot: '帆布包', qty: 200, unitPrice: 20 }],
    })

    // ---- 区间内数据：同一商品三种规格快照，分别落在首月首日、中间月、末月末日 ----
    await seedOutboundOrder({
      createdAt: new Date(2025, 11, 1, 9, 0, 0),
      orderType: 'department',
      departmentName: '行政部',
      items: [{ productId: canvasBag.id, nameSnapshot: '帆布包', qty: 3, unitPrice: 20 }],
    })
    await seedOutboundOrder({
      createdAt: new Date(2026, 2, 5, 1, 0, 0),
      orderType: 'department',
      departmentName: '行政部',
      items: [{ productId: canvasBag.id, nameSnapshot: '帆布包（红色）', qty: 5, unitPrice: 20 }],
    })
    await seedOutboundOrder({
      createdAt: new Date(2026, 7, 31, 23, 0, 0),
      orderType: 'walkin',
      items: [{ productId: canvasBag.id, nameSnapshot: '帆布包（蓝色）', qty: 7, unitPrice: 20 }],
    })
    await seedOutboundOrder({
      createdAt: new Date(2026, 4, 20, 12, 0, 0),
      orderType: 'department',
      departmentName: '教务处',
      items: [{ productId: mug.id, nameSnapshot: '马克杯', qty: 4, unitPrice: 30 }],
    })

    const baseRange = { startDate: RANGE_START, endDate: RANGE_END }

    // ---- 1. 跨年区间边界 ----
    const mergedAnalytics = await dashboardService.getAnalytics({ ...baseRange })
    const mergedCanvas = mergedAnalytics.topProducts.find((item) => item.productId === canvasBag.id)
    assert.ok(mergedCanvas, '合并模式应返回帆布包')
    assert.equal(mergedCanvas.totalQty, '15.00', '合并数量必须只统计区间内的 3+5+7，不能含区间外的 100/200')
    assert.equal(mergedCanvas.specLabel, null, '合并模式不应下发规格文本')
    assert.equal(mergedCanvas.nameSnapshot, null, '合并模式不应下发名称快照')
    assert.equal(mergedAnalytics.range.startDate, RANGE_START)
    assert.equal(mergedAnalytics.range.endDate, RANGE_END)
    assert.equal(mergedAnalytics.range.isDefault, false)
    pass('跨年区间 2025-12-01 ~ 2026-08-31 准确覆盖首末月边界，且排除区间外单据')

    // ---- 2. 合并 / 细分规格 ----
    const specAnalytics = await dashboardService.getAnalytics({ ...baseRange, productSpecMode: 'spec' })
    const specCanvasRows = specAnalytics.topProducts.filter((item) => item.productId === canvasBag.id)
    assert.equal(specCanvasRows.length, 3, '细分模式下帆布包应按三种规格拆成三行')
    const specLabels = specCanvasRows.map((item) => item.specLabel).sort()
    assert.deepEqual(specLabels, ['默认规格', '红色', '蓝色'].sort(), '规格文本应从名称快照解析')
    const specQtySum = specCanvasRows.reduce((sum, item) => sum + Number(item.totalQty), 0)
    assert.equal(specQtySum.toFixed(2), mergedCanvas.totalQty, '同一区间内合并数量必须等于全部规格数量之和')
    assert.equal(new Set(specCanvasRows.map((item) => item.rankKey)).size, 3, '细分模式各行 rankKey 必须唯一')
    specCanvasRows.forEach((item) => {
      assert.ok(item.nameSnapshot, '细分模式必须下发名称快照供下钻精确过滤')
    })
    pass('商品榜默认按商品合并，开启细分规格后可按款式区分且总量守恒')

    // ---- 3. 先完整聚合再截断 Top N ----
    for (let index = 0; index < 12; index += 1) {
      const fillerProduct = await productService.create({
        productName: `填充商品${index + 1}`,
        defaultPrice: 5,
        isActive: true,
      })
      await seedOutboundOrder({
        createdAt: new Date(2026, 1, 10, 10, 0, 0),
        orderType: 'walkin',
        items: [{ productId: fillerProduct.id, nameSnapshot: `填充商品${index + 1}`, qty: 1, unitPrice: 5 }],
      })
    }

    const topFive = await dashboardService.getAnalytics({ ...baseRange, topN: 5 })
    assert.equal(topFive.topProducts.length, 5, '分组数超过 Top N 时应恰好返回 Top N 行')
    assert.equal(topFive.topProducts[0]?.productId, canvasBag.id, '合并后数量最高的商品应排在第一')
    assert.equal(topFive.topProducts[0]?.totalQty, '15.00', '榜首数量应为该商品全部规格之和，而不是被截断后的单一规格')
    const topTwenty = await dashboardService.getAnalytics({ ...baseRange, topN: 20 })
    assert.equal(topTwenty.topProducts.length, 14, 'Top 20 应返回区间内全部 14 个商品')
    pass('Top N 截断发生在完整聚合之后，切换 5/10/20 均生效')

    // ---- 4. 指定商品筛选与 Top N 兜底 ----
    const singleProduct = await dashboardService.getAnalytics({
      ...baseRange,
      productId: canvasBag.id,
      productSpecMode: 'spec',
    })
    assert.equal(singleProduct.topProducts.length, 3, '锁定单个商品后应只返回该商品的各规格')
    assert.equal(
      singleProduct.topProducts.every((item) => item.productId === canvasBag.id),
      true,
      '锁定单个商品后不应混入其他商品',
    )
    const clampedTopN = await dashboardService.getAnalytics({ ...baseRange, topN: 999 })
    assert.equal(clampedTopN.range.topN, 5, '非法 Top N 应回落到默认值 5')
    pass('支持锁定单个商品与规格模式组合，非法 Top N 会被兜底')

    // ---- 5. 趋势分桶：按月连续补零 + 按日使用本地时区 ----
    const monthlyTrend = await dashboardService.getAnalytics({ ...baseRange, granularity: 'month' })
    assert.equal(monthlyTrend.trend.length, 9, '2025-12 至 2026-08 应产生 9 个月桶')
    assert.equal(monthlyTrend.trend[0]?.date, '2025-12')
    assert.equal(monthlyTrend.trend[8]?.date, '2026-08')
    assert.equal(monthlyTrend.range.granularity, 'month')

    const dailyTrend = await dashboardService.getAnalytics({
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      granularity: 'day',
    })
    assert.equal(dailyTrend.trend.length, 31, '三月按日应产生 31 个桶')
    const march5Bucket = dailyTrend.trend.find((point) => point.date === '2026-03-05')
    assert.ok(march5Bucket, '按日趋势应包含 2026-03-05')
    assert.equal(march5Bucket.orderCount, 1, '凌晨 01:00 的单据必须落在本地日期当天，而不是被 UTC 转换算到前一天')
    pass('趋势分桶按区间连续补零，且使用本地时区避免凌晨单据串日')

    // ---- 6. 空区间与非法入参 ----
    const emptyRange = await dashboardService.getAnalytics({ startDate: '2024-01-01', endDate: '2024-01-31' })
    assert.deepEqual(emptyRange.topProducts, [], '空区间应返回空榜单而不是报错')
    assert.deepEqual(emptyRange.topCustomers, [])
    assert.equal(emptyRange.trend.length, 31, '空区间仍应返回补零后的完整桶')

    await assert.rejects(
      () => dashboardService.getAnalytics({ startDate: '2026-08-31', endDate: '2025-12-01' }),
      /开始日期不能晚于结束日期/,
    )
    await assert.rejects(() => dashboardService.getAnalytics({ startDate: RANGE_START }), /需同时提供开始日期与结束日期/)
    await assert.rejects(
      () => dashboardService.getAnalytics({ startDate: '2025/12/01', endDate: RANGE_END }),
      /格式不正确/,
    )
    await assert.rejects(
      () => dashboardService.getAnalytics({ startDate: '2024-01-01', endDate: '2026-08-31' }),
      /统计区间最长支持/,
    )
    await assert.rejects(
      () => dashboardService.getAnalytics({ ...baseRange, orderType: 'unknown' }),
      /orderType 非法/,
    )

    // JS 的 Date 对“日越界”会静默进位（2026-02-31 -> 2026-03-03、2026-04-31 -> 2026-05-01），
    // 只靠正则校验会让这类输入悄悄查到错误区间，因此必须回写比对后拒绝。
    await assert.rejects(
      () => dashboardService.getAnalytics({ startDate: '2026-02-31', endDate: RANGE_END }),
      /不是有效日期/,
    )
    await assert.rejects(
      () => dashboardService.getAnalytics({ startDate: RANGE_START, endDate: '2026-04-31' }),
      /不是有效日期/,
    )
    // 饼图与下钻共用同一套日期解析，同样不能放过越界日期。
    await assert.rejects(
      () => dashboardService.getDashboardPieData({ startDate: '2025-11-31', endDate: RANGE_END }),
      /不是有效日期/,
    )
    // 闰年合法日期不能被误伤。
    const leapDayRange = await dashboardService.getAnalytics({ startDate: '2028-02-29', endDate: '2028-02-29' })
    assert.equal(leapDayRange.range.startDate, '2028-02-29', '闰年 2 月 29 日属于合法日期，不应被拒绝')
    pass('空区间返回空榜单，非法起止时间、越界日历日期与非法订单类型均有明确反馈')

    // ---- 7. 饼图：商品维度合并 + “其他”补齐总额与占比 ----
    const pieData = await dashboardService.getDashboardPieData({ ...baseRange })
    const canvasSlices = pieData.productPie.filter((slice) => slice.key === canvasBag.id)
    assert.equal(canvasSlices.length, 1, '商品占比必须按商品合并，同一商品不得因规格裂成多片')
    assert.equal(canvasSlices[0]?.label, '帆布包', '合并后的分片应展示商品主名称而不是带规格的快照')
    const otherSlice = pieData.productPie.find((slice) => slice.key === '__other__')
    assert.ok(otherSlice, '分组数超过 8 时应补一片“其他”')

    const pieValueSum = pieData.productPie.reduce((sum, slice) => sum + Number(slice.value), 0)
    // 区间内金额：帆布包 15*20 + 马克杯 4*30 + 12 个填充商品各 1*5 = 300 + 120 + 60
    assert.equal(pieValueSum.toFixed(2), '480.00', '各分片金额之和应等于区间真实总额')
    const pieRatioSum = pieData.productPie.reduce((sum, slice) => sum + Number(slice.ratio), 0)
    assert.ok(Math.abs(pieRatioSum - 100) <= 0.05, `各分片占比之和应约等于 100%，实际为 ${pieRatioSum.toFixed(2)}`)
    assert.equal(pieData.range.startDate, RANGE_START)
    assert.equal(pieData.range.endDate, RANGE_END)
    pass('饼图按商品合并统计，“其他”分片保证总额与占比口径一致')

    // ---- 8. 下钻继承区间与规格 ----
    const specRow = specCanvasRows.find((item) => item.specLabel === '红色')
    assert.ok(specRow?.nameSnapshot)
    const specDrilldown = await dashboardService.getProductRankDrilldown({
      productId: canvasBag.id,
      nameSnapshot: specRow.nameSnapshot,
      ...baseRange,
    })
    assert.equal(specDrilldown.totalQty, '5.00', '细分下钻应只统计该规格的数量')
    const mergedDrilldown = await dashboardService.getProductRankDrilldown({
      productId: canvasBag.id,
      ...baseRange,
    })
    assert.equal(mergedDrilldown.totalQty, '15.00', '合并下钻应统计该商品全部规格，并受区间约束')
    pass('下钻明细继承当前统计区间，并可按规格精确过滤')

    // ---- 9. 概览接口瘦身回归 ----
    const stats = await dashboardService.getStats()
    assert.equal(typeof stats.todayOrderCount, 'number')
    assert.equal(typeof stats.totalProductCount, 'number')
    assert.equal(Array.isArray(stats.recentActivities), true)
    assert.equal('topProducts' in stats, false, '区间相关榜单已迁移到 /dashboard/analytics，概览接口不应再返回')
    assert.equal('trend7Days' in stats, false, '区间相关趋势已迁移到 /dashboard/analytics，概览接口不应再返回')
    pass('概览接口只保留四宫格与近期动态，区间统计统一由分析接口提供')
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy()
    }
  }
}

try {
  await main()
  console.log('\n首页区间分析自动化验证全部通过。')
} catch (error) {
  console.error('\n首页区间分析自动化验证失败：', error)
  process.exit(1)
}
