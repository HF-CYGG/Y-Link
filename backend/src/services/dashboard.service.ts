/**
 * 模块说明：`backend/src/services/dashboard.service.ts`
 * 文件职责：负责聚合管理端工作台所需的统计、区间分析、排行、近期动态与下钻数据。
 * 实现逻辑：
 * 1. 四宫格与近期动态维持“今日/本月”固定口径，区间相关的趋势与排行统一由 getAnalytics 提供；
 * 2. 区间过滤、订单类型过滤、软删除排除全部收敛到 applyOrderFilter，保证各接口口径一致；
 * 3. 商品排行支持“按商品合并 / 按规格细分”两种维度，聚合在 SQL 内先完成再截断 Top N；
 * 4. 时间分桶一律在服务层完成，不使用任何数据库方言日期函数，保证 SQLite 与 MySQL 行为一致。
 */

import { AppDataSource } from '../config/data-source.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { SysAuditLog } from '../entities/sys-audit-log.entity.js'
import type {
  DashboardAmountSumRaw,
  DashboardCustomerDetailRaw,
  DashboardCustomerSummaryRaw,
  DashboardNumericLike,
  DashboardOptionalNumericLike,
  DashboardPieCustomerRowRaw,
  DashboardPieOrderTypeRowRaw,
  DashboardPieProductRowRaw,
  DashboardProductDetailRaw,
  DashboardRankCustomerRowRaw,
  DashboardRankProductRowRaw,
  DashboardTagAggregateRaw,
  DashboardTrendOrderRowRaw,
} from '../types/dashboard.js'
import { BizError } from '../utils/errors.js'

interface DashboardTrendPoint {
  date: string
  label: string
  amount: string
  orderCount: number
  totalQty: string
}

interface DashboardTopProduct {
  rankKey: string
  productId: string
  productName: string
  specLabel: string | null
  /** 细分模式下该行对应的出库明细名称快照，供下钻精确过滤；合并模式为 null。 */
  nameSnapshot: string | null
  totalQty: string
}

interface DashboardTopCustomer {
  customerName: string
  totalAmount: string
  orderCount: number
}

type DashboardAmountAggregateRaw = { totalAmount: string | number | null }

interface DashboardStatsResult {
  todayOrderCount: number
  todayOrderAmount: string | number
  totalProductCount: number
  monthOrderCount: number
  monthOrderAmount: string | number
  recentActivities: DashboardRecentActivity[]
}

interface DashboardRecentActivity {
  id: string
  orderId: string
  actionType: 'order.create' | 'order.delete' | 'order.restore' | 'order.purge'
  actionLabel: string
  showNo: string
  actorDisplayName: string
  displayName: string
  customerName: string
  totalAmount: string
  totalQty: string
  createdAt: string
}

const DATE_MS = 24 * 60 * 60 * 1000
const ORDER_TYPE_VALUES = ['department', 'walkin'] as const
type DashboardOrderType = (typeof ORDER_TYPE_VALUES)[number]

// 区间上限：统计区间最长一年，既覆盖“年末/学期报告”场景，也避免趋势分桶扫描无界行数。
const MAX_RANGE_DAYS = 366
// 超过该天数时趋势默认切换为按月分桶，避免跨年区间画出数百个日点。
const TREND_DAY_BUCKET_MAX_DAYS = 62
// 榜单可选条数，与前端下拉保持一致；非法值一律回落到 5。
const RANK_TOP_N_VALUES = [5, 10, 20] as const
// 饼图最多展示的分片数，超出部分统一并入“其他”。
const PIE_TOP_LIMIT = 8
const PIE_OTHER_SLICE_KEY = '__other__'
const PIE_OTHER_SLICE_LABEL = '其他'
// 金额/数量归一化后保留两位小数，判定“是否还有其他分片”时用半个最小单位做容差。
const PIE_OTHER_EPSILON = 0.005

const PRODUCT_SPEC_MODES = ['merged', 'spec'] as const
type DashboardProductSpecMode = (typeof PRODUCT_SPEC_MODES)[number]

const TREND_GRANULARITIES = ['day', 'month'] as const
type DashboardTrendGranularity = (typeof TREND_GRANULARITIES)[number]

interface DashboardFilterInput {
  startDate?: string
  endDate?: string
  orderType?: string
}

interface DashboardAnalyticsInput extends DashboardFilterInput {
  granularity?: string
  productSpecMode?: string
  productId?: string
  topN?: number | string
}

interface DashboardResolvedFilter {
  startAt?: Date
  endExclusive?: Date
  orderType?: DashboardOrderType
  startDate: string
  endDate: string
  isDefaultRange: boolean
}

interface DashboardAnalyticsResult {
  range: {
    startDate: string
    endDate: string
    granularity: DashboardTrendGranularity
    orderType: DashboardOrderType | null
    productSpecMode: DashboardProductSpecMode
    productId: string | null
    topN: number
    isDefault: boolean
  }
  trend: DashboardTrendPoint[]
  topProducts: DashboardTopProduct[]
  topCustomers: DashboardTopCustomer[]
}

interface DashboardDrilldownOrderRecord {
  orderId: string
  showNo: string
  orderType: DashboardOrderType
  createdAt: string
  customerName: string
  customerDepartmentName: string
  issuerName: string
  qty: string
  amount: string
}

interface DashboardProductRankDrilldownResult {
  productId: string
  productName: string
  totalQty: string
  totalAmount: string
  orderCount: number
  records: DashboardDrilldownOrderRecord[]
}

interface DashboardCustomerRankDrilldownResult {
  customerName: string
  totalQty: string
  totalAmount: string
  orderCount: number
  records: DashboardDrilldownOrderRecord[]
}

interface DashboardTagAggregateResult {
  tagId: string
  tagName: string
  totalQuantity: string
  totalAmount: string
  orderCount: number
  productCount: number
}

interface DashboardPieSlice {
  key: string
  label: string
  value: string
  ratio: string
}

interface DashboardPiePayload {
  productPie: DashboardPieSlice[]
  customerPie: DashboardPieSlice[]
  orderTypePie: DashboardPieSlice[]
  range: {
    startDate: string
    endDate: string
    orderType: DashboardOrderType | null
    isDefault: boolean
  }
}

/**
 * 归一化金额文本：
 * - 仪表盘统一返回两位小数字符串，避免前端在不同组件重复格式化；
 * - 兼容数据库聚合后返回的 string / number / null。
 */
const normalizeAmount = (value: DashboardOptionalNumericLike): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

/**
 * 归一化数量文本：
 * - 排行榜数量允许保留两位小数，适配非整数数量场景；
 * - 非法值统一回落为 0.00，避免前端出现 NaN。
 */
const normalizeQty = (value: DashboardOptionalNumericLike): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

const normalizeCount = (value: DashboardOptionalNumericLike): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? String(Math.max(0, Math.round(normalizedNumber))) : '0'
}

const normalizeText = (value: string | null | undefined, fallback = ''): string => {
  const normalizedText = typeof value === 'string' ? value.trim() : ''
  return normalizedText || fallback
}

const normalizeRatio = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0.00'
  }
  return value.toFixed(2)
}

const normalizeOrderTypeLabel = (orderType: DashboardOrderType): string => {
  if (orderType === 'department') {
    return '部门单'
  }
  return '散客单'
}

const normalizeCustomerName = (value: string | null | undefined): string => {
  const normalized = String(value ?? '').trim()
  return normalized || '未填写客户'
}

/**
 * 近期动态对象名称：
 * - 部门单优先展示部门名，保证首页语义更贴近实际领用主体；
 * - 散客单或历史日志缺少部门信息时，再回退到客户名；
 * - 最终仍为空时展示统一兜底文案，避免界面出现空白字段。
 */
const normalizeRecentActivityDisplayName = (detail: Record<string, unknown>): string => {
  const departmentName = normalizeText(typeof detail.customerDepartmentName === 'string' ? detail.customerDepartmentName : null, '')
  if (departmentName) {
    return departmentName
  }

  const customerName = normalizeText(typeof detail.customerName === 'string' ? detail.customerName : null, '')
  return customerName || '未填写客户'
}

/**
 * 本地日期键：
 * - 容器时区为 Asia/Shanghai，趋势分桶必须使用本地日期而不是 toISOString 的 UTC 日期；
 * - 否则每天 00:00-08:00 的单据会被算进前一天，跨月跨年区间下该偏差会被放大。
 */
const formatLocalDateKey = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatLocalMonthKey = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

const parseDateOnlyToStart = (value: string, label: string): Date => {
  const normalized = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new BizError(`${label}格式不正确，应为 YYYY-MM-DD`, 400)
  }
  const parsed = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    throw new BizError(`${label}格式不正确，应为 YYYY-MM-DD`, 400)
  }
  // JS 的 Date 只对“月份越界”返回 Invalid Date，对“日越界”会静默进位：
  // 2026-02-31 会变成 2026-03-03、2026-04-31 会变成 2026-05-01。
  // 若不回写比对，这类输入会悄悄查到错误区间，结束日越界时还会多算好几天。
  if (formatLocalDateKey(parsed) !== normalized) {
    throw new BizError(`${label}不是有效日期：${normalized}`, 400)
  }
  return parsed
}

/**
 * 解析规格展示文本：
 * - 出库明细表没有 SKU 外键，规格只存在于 productNameSnapshot 中；
 * - O2O 预订核销写入格式为“商品名（规格文本）”，因此优先剥离主商品名前缀再取全角括号内文本；
 * - 手工开单写入的是不含规格的商品名，统一归为“默认规格”。
 */
const resolveSpecLabel = (snapshot: string | null | undefined, masterName: string): string => {
  const normalizedSnapshot = normalizeText(snapshot, '')
  const normalizedMaster = normalizeText(masterName, '')
  if (!normalizedSnapshot || normalizedSnapshot === normalizedMaster) {
    return '默认规格'
  }

  if (normalizedMaster && normalizedSnapshot.startsWith(normalizedMaster)) {
    const remainder = normalizedSnapshot.slice(normalizedMaster.length).trim()
    if (!remainder) {
      return '默认规格'
    }
    const bracketMatched = /^（(.+)）$/.exec(remainder)
    if (bracketMatched?.[1]) {
      return bracketMatched[1].trim() || '默认规格'
    }
    return remainder
  }

  return normalizedSnapshot
}

const resolveProductSpecMode = (value: string | undefined): DashboardProductSpecMode => {
  const normalized = String(value ?? '').trim().toLowerCase()
  return PRODUCT_SPEC_MODES.includes(normalized as DashboardProductSpecMode)
    ? (normalized as DashboardProductSpecMode)
    : 'merged'
}

const resolveTopN = (value: number | string | undefined): number => {
  const normalized = Number(value ?? RANK_TOP_N_VALUES[0])
  if (!Number.isFinite(normalized)) {
    return RANK_TOP_N_VALUES[0]
  }
  const matched = RANK_TOP_N_VALUES.find((candidate) => candidate === Math.trunc(normalized))
  return matched ?? RANK_TOP_N_VALUES[0]
}

/**
 * 解析看板筛选条件：
 * - defaultRange 为 currentMonth 时，未传区间回落到“本月 1 日至今日”，让首页各卡片默认口径一致；
 * - defaultRange 为 all 时保持历史行为（未传区间即全量），供标签聚合等旧调用方继续使用；
 * - 区间统一左闭右开（>= 起始日 00:00，< 结束日次日 00:00），因此结束日整天都会被覆盖。
 */
const resolveDashboardFilter = (
  input: DashboardFilterInput,
  options: { defaultRange?: 'all' | 'currentMonth' } = {},
): DashboardResolvedFilter => {
  const normalizedStartDate = typeof input.startDate === 'string' ? input.startDate.trim() : ''
  const normalizedEndDate = typeof input.endDate === 'string' ? input.endDate.trim() : ''

  if ((normalizedStartDate && !normalizedEndDate) || (!normalizedStartDate && normalizedEndDate)) {
    throw new BizError('dateRange 需同时提供开始日期与结束日期', 400)
  }

  let orderType: DashboardOrderType | undefined
  if (typeof input.orderType === 'string' && input.orderType.trim()) {
    const normalizedOrderType = input.orderType.trim().toLowerCase()
    if (!ORDER_TYPE_VALUES.includes(normalizedOrderType as DashboardOrderType)) {
      throw new BizError('orderType 非法，仅支持 department 或 walkin', 400)
    }
    orderType = normalizedOrderType as DashboardOrderType
  }

  if (!normalizedStartDate && !normalizedEndDate) {
    if (options.defaultRange !== 'currentMonth') {
      return {
        startAt: undefined,
        endExclusive: undefined,
        orderType,
        startDate: '',
        endDate: '',
        isDefaultRange: true,
      }
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    return {
      startAt: monthStart,
      endExclusive: new Date(today.getTime() + DATE_MS),
      orderType,
      startDate: formatLocalDateKey(monthStart),
      endDate: formatLocalDateKey(today),
      isDefaultRange: true,
    }
  }

  const startAt = parseDateOnlyToStart(normalizedStartDate, '开始日期')
  const endAt = parseDateOnlyToStart(normalizedEndDate, '结束日期')
  if (startAt.getTime() > endAt.getTime()) {
    throw new BizError('dateRange 不合法：开始日期不能晚于结束日期', 400)
  }

  const spanDays = Math.round((endAt.getTime() - startAt.getTime()) / DATE_MS) + 1
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BizError(`统计区间最长支持 ${MAX_RANGE_DAYS} 天，请缩小查询范围`, 400)
  }

  return {
    startAt,
    endExclusive: new Date(endAt.getTime() + DATE_MS),
    orderType,
    startDate: formatLocalDateKey(startAt),
    endDate: formatLocalDateKey(endAt),
    isDefaultRange: false,
  }
}

/**
 * 解析趋势分桶粒度：
 * - 显式传入时以调用方为准，用于“按月筛选就按月看趋势”的场景；
 * - 未传入时按区间长度自适应，避免跨年区间在折线图上堆出数百个日点。
 */
const resolveTrendGranularity = (
  value: string | undefined,
  startAt: Date,
  endExclusive: Date,
): DashboardTrendGranularity => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (TREND_GRANULARITIES.includes(normalized as DashboardTrendGranularity)) {
    return normalized as DashboardTrendGranularity
  }

  const spanDays = Math.round((endExclusive.getTime() - startAt.getTime()) / DATE_MS)
  return spanDays > TREND_DAY_BUCKET_MAX_DAYS ? 'month' : 'day'
}

/**
 * 解析审计详情 JSON：
 * - 审计详情可能为空或损坏，需兜底解析；
 * - 失败时回退为空对象，避免影响工作台主流程。
 */
const parseAuditDetail = (detailJson: string | null): Record<string, unknown> => {
  if (!detailJson) {
    return {}
  }

  try {
    const parsed = JSON.parse(detailJson) as Record<string, unknown> | null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export const dashboardService = {
  async getStats(): Promise<DashboardStatsResult> {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)

    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const productRepo = AppDataSource.getRepository(BaseProduct)
    const auditLogRepo = AppDataSource.getRepository(SysAuditLog)

    const [
      todayOrderCount,
      todayOrderAmountResult,
      monthOrderCount,
      monthOrderAmountResult,
      totalProductCount,
      recentAuditLogs,
    ] = await Promise.all([
      // 今日单数（软删除单据不计入看板）。
      orderRepo
        .createQueryBuilder('order')
        .where('order.createdAt >= :today', { today })
        .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
        .getCount(),
      // 今日总金额（软删除单据不计入看板）。
      orderRepo
        .createQueryBuilder('order')
        .select('SUM(order.totalAmount)', 'totalAmount')
        .where('order.createdAt >= :today', { today })
        .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
        .getRawOne<DashboardAmountAggregateRaw>(),
      // 本月累计单据数（用于补充周期维度）。
      orderRepo
        .createQueryBuilder('order')
        .where('order.createdAt >= :monthStart', { monthStart })
        .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
        .getCount(),
      // 本月累计出库金额（用于核心四宫格）。
      orderRepo
        .createQueryBuilder('order')
        .select('SUM(order.totalAmount)', 'totalAmount')
        .where('order.createdAt >= :monthStart', { monthStart })
        .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
        .getRawOne<DashboardAmountAggregateRaw>(),
      // 产品总数（仅统计启用产品）。
      productRepo
        .createQueryBuilder('product')
        .where('product.isActive = :isActive', { isActive: true })
        .getCount(),
      // 近期出库动态：聚合最近 10 条“新建/删除/恢复”事件，供首页时间流展示。
      auditLogRepo
        .createQueryBuilder('audit')
        .where('audit.actionType IN (:...actionTypes)', {
          actionTypes: ['order.create', 'order.delete', 'order.restore', 'order.purge'],
        })
        .orderBy('audit.id', 'DESC')
        .limit(10)
        .getMany(),
    ])
    const todayOrderAmountRaw = todayOrderAmountResult?.totalAmount
    const monthOrderAmountRaw = monthOrderAmountResult?.totalAmount

    const recentActivities: DashboardRecentActivity[] = recentAuditLogs.map((audit) => {
      const detail = parseAuditDetail(audit.detailJson)
      const actionType =
        audit.actionType === 'order.delete' || audit.actionType === 'order.restore' || audit.actionType === 'order.purge'
          ? audit.actionType
          : 'order.create'

      return {
        id: String(audit.id),
        orderId: normalizeText(audit.targetId, String(audit.id)),
        actionType,
        actionLabel: normalizeText(audit.actionLabel, '出库单变更'),
        showNo: normalizeText(audit.targetCode, '-'),
        actorDisplayName: normalizeText(audit.actorDisplayName || audit.actorUsername, '系统'),
        displayName: normalizeRecentActivityDisplayName(detail),
        customerName: normalizeText(typeof detail.customerName === 'string' ? detail.customerName : null, '-'),
        totalAmount: normalizeAmount(detail.totalAmount as string | number | null | undefined),
        totalQty: normalizeQty(detail.totalQty as string | number | null | undefined),
        createdAt: audit.createdAt instanceof Date ? audit.createdAt.toISOString() : String(audit.createdAt),
      }
    })

    return {
      todayOrderCount,
      todayOrderAmount: normalizeAmount(todayOrderAmountRaw),
      totalProductCount,
      monthOrderCount,
      monthOrderAmount: normalizeAmount(monthOrderAmountRaw),
      recentActivities,
    }
  },

  /**
   * 区间分析：
   * - 首页“结构占比”筛选栏统一驱动趋势图、热门商品榜与部门榜；
   * - 商品榜默认按商品合并，可切换为按规格细分，并支持锁定单个商品做款式横向比较；
   * - Top N 截断发生在 SQL 聚合之后，因此合并数量恒等于该商品全部规格数量之和。
   */
  async getAnalytics(input: DashboardAnalyticsInput): Promise<DashboardAnalyticsResult> {
    const filter = resolveDashboardFilter(input, { defaultRange: 'currentMonth' })
    if (!filter.startAt || !filter.endExclusive) {
      throw new BizError('统计区间解析失败，请重新选择起止日期', 400)
    }

    const granularity = resolveTrendGranularity(input.granularity, filter.startAt, filter.endExclusive)
    const productSpecMode = resolveProductSpecMode(input.productSpecMode)
    const topN = resolveTopN(input.topN)
    const productId = normalizeText(input.productId, '')

    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const orderItemRepo = AppDataSource.getRepository(BizOutboundOrderItem)

    // 趋势原始行：只取分桶必需的列，日期分桶放到服务层，避免引入方言日期函数。
    // 必须走 getMany 的实体水合而不是 getRawMany：原始结果会跳过驱动的时间归一化，
    // SQLite 会返回不带时区标记的 UTC 字符串，再被 new Date() 当成本地时间解析，导致整段趋势串日。
    // 主键一并选出，否则 TypeORM 无法区分实体行，会把同一分钟的多张单据折叠成一条。
    const trendRowsQb = orderRepo
      .createQueryBuilder('order')
      .select(['order.id', 'order.createdAt', 'order.totalAmount', 'order.totalQty'])
      .where('1=1')
      .orderBy('order.createdAt', 'ASC')
    this.applyOrderFilter(trendRowsQb, filter)

    // 商品榜：合并模式只按商品分组，细分模式追加名称快照分组以区分规格。
    const productRankQb = orderItemRepo
      .createQueryBuilder('item')
      .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
      .leftJoin(BaseProduct, 'product', 'product.id = item.productId')
      .select('item.productId', 'productId')
      .addSelect('MAX(product.productName)', 'masterName')
      .addSelect('SUM(item.qty)', 'totalQty')
      .where('1=1')
      .groupBy('item.productId')
      .orderBy('SUM(item.qty)', 'DESC')
      .addOrderBy('item.productId', 'ASC')
      .limit(topN)
    if (productSpecMode === 'spec') {
      productRankQb
        .addSelect('item.productNameSnapshot', 'snapshotName')
        .addGroupBy('item.productNameSnapshot')
        .addOrderBy('item.productNameSnapshot', 'ASC')
    } else {
      // MySQL 8 默认开启 ONLY_FULL_GROUP_BY，非分组列必须包在聚合函数里。
      productRankQb.addSelect('MAX(item.productNameSnapshot)', 'snapshotName')
    }
    if (productId) {
      productRankQb.andWhere('item.productId = :rankProductId', { rankProductId: productId })
    }
    this.applyOrderFilter(productRankQb, filter)

    const customerLabelExpr = `COALESCE(NULLIF(TRIM(order.customerDepartmentName), ''), '散客')`
    const customerRankQb = orderRepo
      .createQueryBuilder('order')
      .select(customerLabelExpr, 'customerName')
      .addSelect('SUM(order.totalAmount)', 'totalAmount')
      .addSelect('COUNT(order.id)', 'orderCount')
      .where('1=1')
      .groupBy(customerLabelExpr)
      .orderBy('SUM(order.totalAmount)', 'DESC')
      .addOrderBy(customerLabelExpr, 'ASC')
      .limit(topN)
    this.applyOrderFilter(customerRankQb, filter)

    const [trendRows, productRankRows, customerRankRows] = await Promise.all([
      trendRowsQb.getMany(),
      productRankQb.getRawMany<DashboardRankProductRowRaw>(),
      customerRankQb.getRawMany<DashboardRankCustomerRowRaw>(),
    ])

    const trend = this.buildTrendPoints(trendRows, filter.startAt, filter.endExclusive, granularity)

    const topProducts: DashboardTopProduct[] = productRankRows.map((row) => {
      const normalizedProductId = String(row.productId ?? '').trim()
      const snapshotName = normalizeText(row.snapshotName, '')
      const productName = normalizeText(row.masterName, '') || snapshotName || '未命名文创'
      const specLabel = productSpecMode === 'spec' ? resolveSpecLabel(snapshotName, productName) : null
      return {
        rankKey: productSpecMode === 'spec' ? `${normalizedProductId}::${snapshotName}` : normalizedProductId,
        productId: normalizedProductId,
        productName,
        specLabel,
        nameSnapshot: productSpecMode === 'spec' ? snapshotName : null,
        totalQty: normalizeQty(row.totalQty),
      }
    })

    const topCustomers: DashboardTopCustomer[] = customerRankRows.map((row) => ({
      customerName: normalizeText(row.customerName, '散客'),
      totalAmount: normalizeAmount(row.totalAmount),
      orderCount: Number(row.orderCount ?? 0),
    }))

    return {
      range: {
        startDate: filter.startDate,
        endDate: filter.endDate,
        granularity,
        orderType: filter.orderType ?? null,
        productSpecMode,
        productId: productId || null,
        topN,
        isDefault: filter.isDefaultRange,
      },
      trend,
      topProducts,
      topCustomers,
    }
  },

  async getProductRankDrilldown(
    input: { productId: string; nameSnapshot?: string } & DashboardFilterInput,
  ): Promise<DashboardProductRankDrilldownResult> {
    const productId = String(input.productId ?? '').trim()
    if (!productId) {
      throw new BizError('productId 不能为空', 400)
    }

    const nameSnapshot = normalizeText(input.nameSnapshot, '')
    const filter = resolveDashboardFilter(input)
    const orderItemRepo = AppDataSource.getRepository(BizOutboundOrderItem)
    const productRepo = AppDataSource.getRepository(BaseProduct)

    const summaryQb = orderItemRepo
      .createQueryBuilder('item')
      .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
      .select('SUM(item.qty)', 'totalQty')
      .addSelect('SUM(item.lineAmount)', 'totalAmount')
      .addSelect('COUNT(DISTINCT order.id)', 'orderCount')
      .addSelect('MAX(item.productNameSnapshot)', 'productName')
      .where('item.productId = :productId', { productId })

    this.applyProductSnapshotFilter(summaryQb, nameSnapshot)
    this.applyOrderFilter(summaryQb, filter)
    type DashboardProductSummaryRaw = {
      totalQty?: DashboardNumericLike
      totalAmount?: DashboardNumericLike
      orderCount?: DashboardNumericLike
      productName?: string | null
    }
    const summaryRaw = await summaryQb.getRawOne<DashboardProductSummaryRaw>()

    const detailQb = orderItemRepo
      .createQueryBuilder('item')
      .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
      .select('order.id', 'orderId')
      .addSelect('order.showNo', 'showNo')
      .addSelect('order.orderType', 'orderType')
      .addSelect('order.createdAt', 'createdAt')
      .addSelect('order.customerName', 'customerName')
      .addSelect('order.customerDepartmentName', 'customerDepartmentName')
      .addSelect('order.issuerName', 'issuerName')
      .addSelect('SUM(item.qty)', 'qty')
      .addSelect('SUM(item.lineAmount)', 'amount')
      .where('item.productId = :productId', { productId })
      .groupBy('order.id')
      .addGroupBy('order.showNo')
      .addGroupBy('order.orderType')
      .addGroupBy('order.createdAt')
      .addGroupBy('order.customerName')
      .addGroupBy('order.customerDepartmentName')
      .addGroupBy('order.issuerName')
      .orderBy('order.createdAt', 'DESC')
      .limit(100)

    this.applyProductSnapshotFilter(detailQb, nameSnapshot)
    this.applyOrderFilter(detailQb, filter)
    const detailRows = await detailQb.getRawMany<DashboardProductDetailRaw>()

    const productEntity = await productRepo.findOne({ where: { id: productId } })
    const productName =
      normalizeText(summaryRaw?.productName, '') ||
      normalizeText(productEntity?.productName, '') ||
      '未命名文创'

    return {
      productId,
      productName,
      totalQty: normalizeQty(summaryRaw?.totalQty),
      totalAmount: normalizeAmount(summaryRaw?.totalAmount),
      orderCount: Number(summaryRaw?.orderCount ?? 0),
      records: detailRows.map((row) => this.buildDrilldownOrderRecord(row)),
    }
  },

  async getCustomerRankDrilldown(
    input: { customerName: string } & DashboardFilterInput,
  ): Promise<DashboardCustomerRankDrilldownResult> {
    const customerName = String(input.customerName ?? '').trim()
    if (!customerName) {
      throw new BizError('customerName 不能为空', 400)
    }

    const filter = resolveDashboardFilter(input)
    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)

    const summaryQb = orderRepo
      .createQueryBuilder('order')
      .select('SUM(order.totalQty)', 'totalQty')
      .addSelect('SUM(order.totalAmount)', 'totalAmount')
      .addSelect('COUNT(order.id)', 'orderCount')
      .where('1=1')

    this.applyCustomerFilter(summaryQb, customerName)
    this.applyOrderFilter(summaryQb, filter)
    const summaryRaw = await summaryQb.getRawOne<DashboardCustomerSummaryRaw>()

    const detailQb = orderRepo
      .createQueryBuilder('order')
      .select('order.id', 'orderId')
      .addSelect('order.showNo', 'showNo')
      .addSelect('order.orderType', 'orderType')
      .addSelect('order.createdAt', 'createdAt')
      .addSelect('order.customerName', 'customerName')
      .addSelect('order.customerDepartmentName', 'customerDepartmentName')
      .addSelect('order.issuerName', 'issuerName')
      .addSelect('order.totalQty', 'qty')
      .addSelect('order.totalAmount', 'amount')
      .where('1=1')
      .orderBy('order.createdAt', 'DESC')
      .limit(100)

    this.applyCustomerFilter(detailQb, customerName)
    this.applyOrderFilter(detailQb, filter)
    const detailRows = await detailQb.getRawMany<DashboardCustomerDetailRaw>()

    return {
      customerName,
      totalQty: normalizeQty(summaryRaw?.totalQty),
      totalAmount: normalizeAmount(summaryRaw?.totalAmount),
      orderCount: Number(summaryRaw?.orderCount ?? 0),
      records: detailRows.map((row) => this.buildDrilldownOrderRecord(row)),
    }
  },

  async getTagAggregate(input: { tagId: string } & DashboardFilterInput): Promise<DashboardTagAggregateResult> {
    const tagId = String(input.tagId ?? '').trim()
    if (!tagId) {
      throw new BizError('tagId 不能为空', 400)
    }

    const filter = resolveDashboardFilter(input)
    const tagRepo = AppDataSource.getRepository(BaseTag)
    const relationRepo = AppDataSource.getRepository(RelProductTag)

    const tag = await tagRepo.findOne({ where: { id: tagId } })
    if (!tag) {
      throw new BizError('标签不存在', 404)
    }

    const aggregateQb = relationRepo
      .createQueryBuilder('relation')
      .innerJoin(BizOutboundOrderItem, 'item', 'item.productId = relation.productId')
      .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
      .select('SUM(item.qty)', 'totalQuantity')
      .addSelect('SUM(item.lineAmount)', 'totalAmount')
      .addSelect('COUNT(DISTINCT order.id)', 'orderCount')
      .addSelect('COUNT(DISTINCT item.productId)', 'productCount')
      .where('relation.tagId = :tagId', { tagId })

    this.applyOrderFilter(aggregateQb, filter)
    const aggregateRaw = await aggregateQb.getRawOne<DashboardTagAggregateRaw>()

    return {
      tagId: String(tag.id),
      tagName: tag.tagName,
      totalQuantity: normalizeQty(aggregateRaw?.totalQuantity),
      totalAmount: normalizeAmount(aggregateRaw?.totalAmount),
      orderCount: Number(aggregateRaw?.orderCount ?? 0),
      productCount: Number(aggregateRaw?.productCount ?? 0),
    }
  },

  /**
   * 结构占比饼图：
   * - 商品维度只按商品合并，同一商品的不同规格不再裂成多片；
   * - 分片截断到 Top 8 后补一片“其他”，保证卡片总额等于区间真实总额、占比之和为 100%。
   */
  async getDashboardPieData(input: DashboardFilterInput): Promise<DashboardPiePayload> {
    const filter = resolveDashboardFilter(input, { defaultRange: 'currentMonth' })
    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const itemRepo = AppDataSource.getRepository(BizOutboundOrderItem)

    const productRowsQb = itemRepo
      .createQueryBuilder('item')
      .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
      .leftJoin(BaseProduct, 'product', 'product.id = item.productId')
      .select('item.productId', 'key')
      .addSelect('MAX(product.productName)', 'masterLabel')
      .addSelect('MAX(item.productNameSnapshot)', 'label')
      .addSelect('SUM(item.lineAmount)', 'value')
      .where('1=1')
      .groupBy('item.productId')
      .orderBy('SUM(item.lineAmount)', 'DESC')
      .addOrderBy('item.productId', 'ASC')
      .limit(PIE_TOP_LIMIT)
    this.applyOrderFilter(productRowsQb, filter)

    const productTotalQb = itemRepo
      .createQueryBuilder('item')
      .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
      .select('SUM(item.lineAmount)', 'totalValue')
      .where('1=1')
    this.applyOrderFilter(productTotalQb, filter)

    const customerLabelExpr = `COALESCE(NULLIF(TRIM(order.customerDepartmentName), ''), '散客')`
    const customerRowsQb = orderRepo
      .createQueryBuilder('order')
      .select(customerLabelExpr, 'label')
      .addSelect(customerLabelExpr, 'key')
      .addSelect('SUM(order.totalAmount)', 'value')
      .where('1=1')
      .groupBy(customerLabelExpr)
      .orderBy('SUM(order.totalAmount)', 'DESC')
      .addOrderBy(customerLabelExpr, 'ASC')
      .limit(PIE_TOP_LIMIT)
    this.applyOrderFilter(customerRowsQb, filter)

    const customerTotalQb = orderRepo
      .createQueryBuilder('order')
      .select('SUM(order.totalAmount)', 'totalValue')
      .where('1=1')
    this.applyOrderFilter(customerTotalQb, filter)

    const orderTypeRowsQb = orderRepo
      .createQueryBuilder('order')
      .select('order.orderType', 'orderType')
      .addSelect('COUNT(order.id)', 'value')
      .where('1=1')
      .groupBy('order.orderType')
    this.applyOrderFilter(orderTypeRowsQb, filter)

    const [productRows, productTotalRaw, customerRows, customerTotalRaw, orderTypeRows] = await Promise.all([
      productRowsQb.getRawMany<DashboardPieProductRowRaw>(),
      productTotalQb.getRawOne<DashboardAmountSumRaw>(),
      customerRowsQb.getRawMany<DashboardPieCustomerRowRaw>(),
      customerTotalQb.getRawOne<DashboardAmountSumRaw>(),
      orderTypeRowsQb.getRawMany<DashboardPieOrderTypeRowRaw>(),
    ])

    const productPie = this.buildPieSlices(
      productRows.map((row) => ({
        key: String(row.key ?? '').trim(),
        label: normalizeText(row.masterLabel, '') || normalizeText(row.label, '未命名文创'),
        value: Number(row.value ?? 0),
      })),
      { totalValue: Number(productTotalRaw?.totalValue ?? 0) },
    )

    const customerPie = this.buildPieSlices(
      customerRows.map((row) => ({
        key: normalizeText(row.key, '散客'),
        label: normalizeText(row.label, '散客'),
        value: Number(row.value ?? 0),
      })),
      { totalValue: Number(customerTotalRaw?.totalValue ?? 0) },
    )

    const orderTypeMap = new Map<DashboardOrderType, number>()
    ORDER_TYPE_VALUES.forEach((orderType) => {
      orderTypeMap.set(orderType, 0)
    })
    orderTypeRows.forEach((row) => {
      const orderType = String(row.orderType ?? '').trim().toLowerCase()
      if (!ORDER_TYPE_VALUES.includes(orderType as DashboardOrderType)) {
        return
      }
      orderTypeMap.set(orderType as DashboardOrderType, Number(row.value ?? 0))
    })
    const orderTypePie = this.buildPieSlices(
      ORDER_TYPE_VALUES.map((orderType) => ({
        key: orderType,
        label: normalizeOrderTypeLabel(orderType),
        value: orderTypeMap.get(orderType) ?? 0,
      })),
      { normalizeValue: normalizeCount },
    )

    return {
      productPie,
      customerPie,
      orderTypePie,
      range: {
        startDate: filter.startDate,
        endDate: filter.endDate,
        orderType: filter.orderType ?? null,
        isDefault: filter.isDefaultRange,
      },
    }
  },

  applyOrderFilter(queryBuilder: { andWhere: (sql: string, parameters?: Record<string, unknown>) => unknown }, filter: DashboardResolvedFilter): void {
    queryBuilder.andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
    if (filter.startAt) {
      queryBuilder.andWhere('order.createdAt >= :startAt', { startAt: filter.startAt })
    }
    if (filter.endExclusive) {
      queryBuilder.andWhere('order.createdAt < :endExclusive', { endExclusive: filter.endExclusive })
    }
    if (filter.orderType) {
      queryBuilder.andWhere('order.orderType = :orderType', { orderType: filter.orderType })
    }
  },

  applyCustomerFilter(queryBuilder: { andWhere: (sql: string, parameters?: Record<string, unknown>) => unknown }, customerName: string): void {
    queryBuilder.andWhere(`COALESCE(NULLIF(TRIM(order.customerDepartmentName), ''), '散客') = :customerName`, { customerName })
  },

  /**
   * 规格下钻过滤：
   * - 细分规格模式下点击榜单项时，只看该规格对应的名称快照；
   * - 合并模式不传该参数，保持商品维度的全量下钻。
   */
  applyProductSnapshotFilter(
    queryBuilder: { andWhere: (sql: string, parameters?: Record<string, unknown>) => unknown },
    nameSnapshot: string,
  ): void {
    if (!nameSnapshot) {
      return
    }
    queryBuilder.andWhere('item.productNameSnapshot = :nameSnapshot', { nameSnapshot })
  },

  /**
   * 趋势分桶：
   * - 桶键使用本地日期/月份，避免 toISOString 的 UTC 日期在 +08 时区把凌晨单据算到前一天；
   * - 区间内没有单据的桶补零，保证折线连续且横轴覆盖完整所选区间。
   */
  buildTrendPoints(
    rows: DashboardTrendOrderRowRaw[],
    startAt: Date,
    endExclusive: Date,
    granularity: DashboardTrendGranularity,
  ): DashboardTrendPoint[] {
    const metricsMap = new Map<string, { amount: number; orderCount: number; totalQty: number }>()
    rows.forEach((row) => {
      const createdAtDate = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)
      if (Number.isNaN(createdAtDate.getTime())) {
        return
      }
      const bucketKey = granularity === 'month' ? formatLocalMonthKey(createdAtDate) : formatLocalDateKey(createdAtDate)
      const currentMetrics = metricsMap.get(bucketKey) ?? { amount: 0, orderCount: 0, totalQty: 0 }
      currentMetrics.amount += Number(row.totalAmount ?? 0)
      currentMetrics.orderCount += 1
      currentMetrics.totalQty += Number(row.totalQty ?? 0)
      metricsMap.set(bucketKey, currentMetrics)
    })

    const points: DashboardTrendPoint[] = []
    const appendPoint = (bucketKey: string, label: string) => {
      const currentMetrics = metricsMap.get(bucketKey) ?? { amount: 0, orderCount: 0, totalQty: 0 }
      points.push({
        date: bucketKey,
        label,
        amount: normalizeAmount(currentMetrics.amount),
        orderCount: currentMetrics.orderCount,
        totalQty: normalizeQty(currentMetrics.totalQty),
      })
    }

    if (granularity === 'month') {
      let monthCursor = new Date(startAt.getFullYear(), startAt.getMonth(), 1)
      while (monthCursor.getTime() < endExclusive.getTime()) {
        const bucketKey = formatLocalMonthKey(monthCursor)
        appendPoint(bucketKey, bucketKey.replace('-', '/'))
        monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1)
      }
      return points
    }

    let dayCursor = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate())
    while (dayCursor.getTime() < endExclusive.getTime()) {
      const bucketKey = formatLocalDateKey(dayCursor)
      appendPoint(bucketKey, bucketKey.slice(5).replace('-', '/'))
      dayCursor = new Date(dayCursor.getFullYear(), dayCursor.getMonth(), dayCursor.getDate() + 1)
    }
    return points
  },

  buildDrilldownOrderRecord(row: {
    orderId: string | number
    showNo: string | null
    orderType: string | null
    createdAt: Date | string
    customerName: string | null
    customerDepartmentName: string | null
    issuerName: string | null
    qty: string | number | null
    amount: string | number | null
  }): DashboardDrilldownOrderRecord {
    const normalizedOrderType = String(row.orderType ?? '').trim().toLowerCase()
    const orderType: DashboardOrderType = normalizedOrderType === 'department' ? 'department' : 'walkin'
    return {
      orderId: String(row.orderId ?? '').trim(),
      showNo: normalizeText(row.showNo, '-'),
      orderType,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      customerName: normalizeCustomerName(row.customerName),
      customerDepartmentName: normalizeText(row.customerDepartmentName, '-'),
      issuerName: normalizeText(row.issuerName, '-'),
      qty: normalizeQty(row.qty),
      amount: normalizeAmount(row.amount),
    }
  },

  /**
   * 组装饼图分片：
   * - totalValue 传入区间全量总额时，被 Top N 截断掉的部分会汇总为一片“其他”；
   * - 占比分母始终是全量总额，避免出现“分片加起来不是 100%”的误读。
   */
  buildPieSlices(
    rows: Array<{ key: string; label: string; value: number }>,
    options: { totalValue?: number; normalizeValue?: (value: number) => string } = {},
  ): DashboardPieSlice[] {
    const normalizeValue = options.normalizeValue ?? normalizeAmount
    const rowsTotal = rows.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0)
    const rawTotal = Number(options.totalValue)
    const totalValue = Number.isFinite(rawTotal) && rawTotal > rowsTotal ? rawTotal : rowsTotal
    const slices = rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: normalizeValue(row.value),
      ratio: normalizeRatio(totalValue > 0 ? (row.value / totalValue) * 100 : 0),
    }))

    const otherValue = totalValue - rowsTotal
    if (otherValue > PIE_OTHER_EPSILON) {
      slices.push({
        key: PIE_OTHER_SLICE_KEY,
        label: PIE_OTHER_SLICE_LABEL,
        value: normalizeValue(otherValue),
        ratio: normalizeRatio((otherValue / totalValue) * 100),
      })
    }

    return slices
  }
}
