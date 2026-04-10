/**
 * 模块说明：backend/src/services/dashboard.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { AppDataSource } from '../config/data-source.js'
import { BaseTag } from '../entities/base-tag.entity.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { SysAuditLog } from '../entities/sys-audit-log.entity.js'
import { BizError } from '../utils/errors.js'

interface DashboardTrendPoint {
  date: string
  label: string
  amount: string
  orderCount: number
  totalQty: string
}

interface DashboardTopProduct {
  productId: string
  productName: string
  totalQty: string
}

interface DashboardTopCustomer {
  customerName: string
  totalAmount: string
  orderCount: number
}

interface DashboardStatsResult {
  todayOrderCount: number
  todayOrderAmount: string | number
  totalProductCount: number
  monthOrderCount: number
  monthOrderAmount: string | number
  trend7Days: DashboardTrendPoint[]
  topProducts: DashboardTopProduct[]
  topCustomers: DashboardTopCustomer[]
  recentActivities: DashboardRecentActivity[]
}

interface DashboardRecentActivity {
  id: string
  actionType: 'order.create' | 'order.delete' | 'order.restore'
  actionLabel: string
  showNo: string
  actorDisplayName: string
  customerName: string
  totalAmount: string
  totalQty: string
  createdAt: string
}

const DATE_MS = 24 * 60 * 60 * 1000
const ORDER_TYPE_VALUES = ['department', 'walkin'] as const
type DashboardOrderType = (typeof ORDER_TYPE_VALUES)[number]

interface DashboardFilterInput {
  startDate?: string
  endDate?: string
  orderType?: string
}

interface DashboardResolvedFilter {
  startAt?: Date
  endExclusive?: Date
  orderType?: DashboardOrderType
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
}

/**
 * 归一化金额文本：
 * - 仪表盘统一返回两位小数字符串，避免前端在不同组件重复格式化；
 * - 兼容数据库聚合后返回的 string / number / null。
 */
const normalizeAmount = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

/**
 * 归一化数量文本：
 * - 排行榜数量允许保留两位小数，适配非整数数量场景；
 * - 非法值统一回落为 0.00，避免前端出现 NaN。
 */
const normalizeQty = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

const normalizeCount = (value: string | number | null | undefined): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? String(Math.max(0, Math.round(normalizedNumber))) : '0'
}

const normalizeText = (value: string | null | undefined, fallback = ''): string => {
  const normalizedText = String(value ?? '').trim()
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

const parseDateOnlyToStart = (value: string, label: string): Date => {
  const normalized = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new BizError(`${label}格式不正确，应为 YYYY-MM-DD`, 400)
  }
  const parsed = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    throw new BizError(`${label}格式不正确，应为 YYYY-MM-DD`, 400)
  }
  return parsed
}

const resolveDashboardFilter = (input: DashboardFilterInput): DashboardResolvedFilter => {
  const normalizedStartDate = typeof input.startDate === 'string' ? input.startDate.trim() : ''
  const normalizedEndDate = typeof input.endDate === 'string' ? input.endDate.trim() : ''

  if ((normalizedStartDate && !normalizedEndDate) || (!normalizedStartDate && normalizedEndDate)) {
    throw new BizError('dateRange 需同时提供开始日期与结束日期', 400)
  }

  let startAt: Date | undefined
  let endExclusive: Date | undefined
  if (normalizedStartDate && normalizedEndDate) {
    startAt = parseDateOnlyToStart(normalizedStartDate, '开始日期')
    const endAt = parseDateOnlyToStart(normalizedEndDate, '结束日期')
    if (startAt.getTime() > endAt.getTime()) {
      throw new BizError('dateRange 不合法：开始日期不能晚于结束日期', 400)
    }
    endExclusive = new Date(endAt.getTime() + DATE_MS)
  }

  let orderType: DashboardOrderType | undefined
  if (typeof input.orderType === 'string' && input.orderType.trim()) {
    const normalizedOrderType = input.orderType.trim().toLowerCase()
    if (!ORDER_TYPE_VALUES.includes(normalizedOrderType as DashboardOrderType)) {
      throw new BizError('orderType 非法，仅支持 department 或 walkin', 400)
    }
    orderType = normalizedOrderType as DashboardOrderType
  }

  return {
    startAt,
    endExclusive,
    orderType,
  }
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
    const trendStart = new Date(today.getTime() - 6 * DATE_MS)

    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const orderItemRepo = AppDataSource.getRepository(BizOutboundOrderItem)
    const productRepo = AppDataSource.getRepository(BaseProduct)
    const auditLogRepo = AppDataSource.getRepository(SysAuditLog)

    // 今日单数（软删除单据不计入看板）。
    const todayOrderCount = await orderRepo
      .createQueryBuilder('order')
      .where('order.createdAt >= :today', { today })
      .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
      .getCount()

    // 今日总金额（软删除单据不计入看板）。
    const { totalAmount: todayOrderAmountRaw } = await orderRepo
      .createQueryBuilder('order')
      .select('SUM(order.totalAmount)', 'totalAmount')
      .where('order.createdAt >= :today', { today })
      .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
      .getRawOne()

    // 本月累计单据数（用于补充周期维度）。
    const monthOrderCount = await orderRepo
      .createQueryBuilder('order')
      .where('order.createdAt >= :monthStart', { monthStart })
      .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
      .getCount()

    // 本月累计出库金额（用于核心四宫格）。
    const { totalAmount: monthOrderAmountRaw } = await orderRepo
      .createQueryBuilder('order')
      .select('SUM(order.totalAmount)', 'totalAmount')
      .where('order.createdAt >= :monthStart', { monthStart })
      .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
      .getRawOne()

    // 产品总数（仅统计启用产品）。
    const totalProductCount = await productRepo
      .createQueryBuilder('product')
      .where('product.isActive = :isActive', { isActive: true })
      .getCount()

    // 近 7 日趋势：先查最近 7 天有效订单，再在服务层按日聚合，避免数据库方言差异。
    const recentOrders = await orderRepo
      .createQueryBuilder('order')
      .select(['order.createdAt AS createdAt', 'order.totalAmount AS totalAmount', 'order.totalQty AS totalQty'])
      .where('order.createdAt >= :trendStart', { trendStart })
      .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
      .orderBy('order.createdAt', 'ASC')
      .getRawMany<{ createdAt: Date | string; totalAmount: string | number; totalQty: string | number }>()

    const trendMetricsMap = new Map<string, { amount: number; orderCount: number; totalQty: number }>()
    recentOrders.forEach((order) => {
      const createdAtDate = order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt)
      if (Number.isNaN(createdAtDate.getTime())) {
        return
      }
      const dateKey = createdAtDate.toISOString().slice(0, 10)
      const currentMetrics = trendMetricsMap.get(dateKey) ?? {
        amount: 0,
        orderCount: 0,
        totalQty: 0,
      }
      currentMetrics.amount += Number(order.totalAmount ?? 0)
      currentMetrics.orderCount += 1
      currentMetrics.totalQty += Number(order.totalQty ?? 0)
      trendMetricsMap.set(dateKey, currentMetrics)
    })

    const trend7Days: DashboardTrendPoint[] = []
    for (let index = 0; index < 7; index += 1) {
      const currentDate = new Date(trendStart.getTime() + index * DATE_MS)
      const dateKey = currentDate.toISOString().slice(0, 10)
      const currentMetrics = trendMetricsMap.get(dateKey) ?? {
        amount: 0,
        orderCount: 0,
        totalQty: 0,
      }
      trend7Days.push({
        date: dateKey,
        label: dateKey.slice(5).replace('-', '/'),
        amount: normalizeAmount(currentMetrics.amount),
        orderCount: currentMetrics.orderCount,
        totalQty: normalizeQty(currentMetrics.totalQty),
      })
    }

    // 热门文创榜：统计本月有效出库的产品数量 Top5。
    const topProductsRaw = await orderItemRepo
      .createQueryBuilder('item')
      .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
      .select('item.productId', 'productId')
      .addSelect('item.productNameSnapshot', 'productName')
      .addSelect('SUM(item.qty)', 'totalQty')
      .where('order.createdAt >= :monthStart', { monthStart })
      .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
      .groupBy('item.productId')
      .addGroupBy('item.productNameSnapshot')
      .orderBy('SUM(item.qty)', 'DESC')
      .limit(5)
      .getRawMany<{ productId: string; productName: string; totalQty: string | number }>()

    const topProducts: DashboardTopProduct[] = topProductsRaw.map((item) => ({
      productId: String(item.productId ?? '').trim(),
      productName: String(item.productName ?? '').trim() || '未命名文创',
      totalQty: normalizeQty(item.totalQty),
    }))

    const customerLabelExpr = `COALESCE(NULLIF(TRIM(order.customerDepartmentName), ''), '散客')`
    const topCustomersRaw = await orderRepo
      .createQueryBuilder('order')
      .select(customerLabelExpr, 'customerName')
      .addSelect('SUM(order.totalAmount)', 'totalAmount')
      .addSelect('COUNT(order.id)', 'orderCount')
      .where('order.createdAt >= :monthStart', { monthStart })
      .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
      .groupBy(customerLabelExpr)
      .orderBy('SUM(order.totalAmount)', 'DESC')
      .limit(5)
      .getRawMany<{ customerName: string | null; totalAmount: string | number; orderCount: string | number }>()

    const topCustomers: DashboardTopCustomer[] = topCustomersRaw.map((item) => ({
      customerName: normalizeText(item.customerName, '散客'),
      totalAmount: normalizeAmount(item.totalAmount),
      orderCount: Number(item.orderCount ?? 0),
    }))

    // 近期出库动态：聚合最近 10 条“新建/删除/恢复”事件，供首页时间流展示。
    const recentAuditLogs = await auditLogRepo
      .createQueryBuilder('audit')
      .where('audit.actionType IN (:...actionTypes)', {
        actionTypes: ['order.create', 'order.delete', 'order.restore'],
      })
      .orderBy('audit.id', 'DESC')
      .limit(10)
      .getMany()

    const recentActivities: DashboardRecentActivity[] = recentAuditLogs.map((audit) => {
      const detail = parseAuditDetail(audit.detailJson)
      const actionType =
        audit.actionType === 'order.delete' || audit.actionType === 'order.restore' ? audit.actionType : 'order.create'

      return {
        id: String(audit.id),
        actionType,
        actionLabel: normalizeText(audit.actionLabel, '出库单变更'),
        showNo: normalizeText(audit.targetCode, '-'),
        actorDisplayName: normalizeText(audit.actorDisplayName || audit.actorUsername, '系统'),
        customerName: normalizeText(String(detail.customerName ?? ''), '-'),
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
      trend7Days,
      topProducts,
      topCustomers,
      recentActivities,
    }
  },

  async getProductRankDrilldown(
    input: { productId: string } & DashboardFilterInput,
  ): Promise<DashboardProductRankDrilldownResult> {
    const productId = String(input.productId ?? '').trim()
    if (!productId) {
      throw new BizError('productId 不能为空', 400)
    }

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

    this.applyOrderFilter(summaryQb, filter)
    const summaryRaw = await summaryQb.getRawOne<{
      totalQty?: string | number | null
      totalAmount?: string | number | null
      orderCount?: string | number | null
      productName?: string | null
    }>()

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

    this.applyOrderFilter(detailQb, filter)
    const detailRows = await detailQb.getRawMany<{
      orderId: string | number
      showNo: string | null
      orderType: string | null
      createdAt: Date | string
      customerName: string | null
      customerDepartmentName: string | null
      issuerName: string | null
      qty: string | number | null
      amount: string | number | null
    }>()

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
    const summaryRaw = await summaryQb.getRawOne<{
      totalQty?: string | number | null
      totalAmount?: string | number | null
      orderCount?: string | number | null
    }>()

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
    const detailRows = await detailQb.getRawMany<{
      orderId: string | number
      showNo: string | null
      orderType: string | null
      createdAt: Date | string
      customerName: string | null
      customerDepartmentName: string | null
      issuerName: string | null
      qty: string | number | null
      amount: string | number | null
    }>()

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
    const aggregateRaw = await aggregateQb.getRawOne<{
      totalQuantity?: string | number | null
      totalAmount?: string | number | null
      orderCount?: string | number | null
      productCount?: string | number | null
    }>()

    return {
      tagId: String(tag.id),
      tagName: tag.tagName,
      totalQuantity: normalizeQty(aggregateRaw?.totalQuantity),
      totalAmount: normalizeAmount(aggregateRaw?.totalAmount),
      orderCount: Number(aggregateRaw?.orderCount ?? 0),
      productCount: Number(aggregateRaw?.productCount ?? 0),
    }
  },

  async getDashboardPieData(input: DashboardFilterInput): Promise<DashboardPiePayload> {
    const filter = resolveDashboardFilter(input)
    const orderRepo = AppDataSource.getRepository(BizOutboundOrder)
    const itemRepo = AppDataSource.getRepository(BizOutboundOrderItem)

    const productRowsQb = itemRepo
      .createQueryBuilder('item')
      .innerJoin(BizOutboundOrder, 'order', 'order.id = item.orderId')
      .select('item.productId', 'key')
      .addSelect('item.productNameSnapshot', 'label')
      .addSelect('SUM(item.lineAmount)', 'value')
      .where('1=1')
      .groupBy('item.productId')
      .addGroupBy('item.productNameSnapshot')
      .orderBy('SUM(item.lineAmount)', 'DESC')
      .limit(8)
    this.applyOrderFilter(productRowsQb, filter)
    const productRows = await productRowsQb.getRawMany<{ key: string | number; label: string | null; value: string | number | null }>()
    const productPie = this.buildPieSlices(
      productRows.map((row) => ({
        key: String(row.key ?? '').trim(),
        label: normalizeText(row.label, '未命名文创'),
        value: Number(row.value ?? 0),
      })),
    )

    const customerLabelExpr = `COALESCE(NULLIF(TRIM(order.customerDepartmentName), ''), '散客')`
    const customerRowsQb = orderRepo
      .createQueryBuilder('order')
      .select(customerLabelExpr, 'label')
      .addSelect(customerLabelExpr, 'key')
      .addSelect('SUM(order.totalAmount)', 'value')
      .where('1=1')
      .groupBy(customerLabelExpr)
      .orderBy('SUM(order.totalAmount)', 'DESC')
      .limit(8)
    this.applyOrderFilter(customerRowsQb, filter)
    const customerRows = await customerRowsQb.getRawMany<{ key: string | null; label: string | null; value: string | number | null }>()
    const customerPie = this.buildPieSlices(
      customerRows.map((row) => ({
        key: normalizeText(row.key, '散客'),
        label: normalizeText(row.label, '散客'),
        value: Number(row.value ?? 0),
      })),
    )

    const orderTypeRowsQb = orderRepo
      .createQueryBuilder('order')
      .select('order.orderType', 'orderType')
      .addSelect('COUNT(order.id)', 'value')
      .where('1=1')
      .groupBy('order.orderType')
    this.applyOrderFilter(orderTypeRowsQb, filter)
    const orderTypeRows = await orderTypeRowsQb.getRawMany<{ orderType: string | null; value: string | number | null }>()
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
      normalizeCount,
    )

    return {
      productPie,
      customerPie,
      orderTypePie,
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

  buildPieSlices(
    rows: Array<{ key: string; label: string; value: number }>,
    normalizeValue: (value: number) => string = normalizeAmount,
  ): DashboardPieSlice[] {
    const totalValue = rows.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0)
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: normalizeValue(row.value),
      ratio: normalizeRatio(totalValue > 0 ? (row.value / totalValue) * 100 : 0),
    }))
  }
}
