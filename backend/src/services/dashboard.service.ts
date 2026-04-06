import { AppDataSource } from '../config/data-source.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { SysAuditLog } from '../entities/sys-audit-log.entity.js'

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

interface DashboardStatsResult {
  todayOrderCount: number
  todayOrderAmount: string | number
  totalProductCount: number
  monthOrderCount: number
  monthOrderAmount: string | number
  trend7Days: DashboardTrendPoint[]
  topProducts: DashboardTopProduct[]
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

const normalizeText = (value: string | null | undefined, fallback = ''): string => {
  const normalizedText = String(value ?? '').trim()
  return normalizedText || fallback
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
      recentActivities,
    }
  }
}
