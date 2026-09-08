/**
 * 模块说明：`src/api/modules/dashboard.ts`
 * 文件职责：封装管理端工作台统计、区间分析、排行、近期动态与下钻查询接口。
 * 实现逻辑：
 * 1. 统一声明看板接口返回结构，保证页面与组件消费同一份类型契约；
 * 2. 最近动态字段显式包含真实订单ID与展示名称，供工作台点击跳单与文案展示复用；
 * 3. 日期范围与订单类型筛选统一在模块内组装，避免页面层重复处理查询参数。
 */

import { request, type RequestConfig } from '@/api/http'

export interface DashboardStats {
  todayOrderCount: number
  todayOrderAmount: string | number
  totalProductCount: number
  monthOrderCount: number
  monthOrderAmount: string | number
  recentActivities: DashboardRecentActivity[]
}

export interface DashboardTrendPoint {
  date: string
  label: string
  amount: string | number
  orderCount: number
  totalQty: string | number
}

export interface DashboardTopProduct {
  /** 榜单行唯一键：合并模式为 productId，细分模式为 `productId::名称快照`。 */
  rankKey: string
  productId: string
  productName: string
  /** 合并模式为 null；细分模式为解析出的规格文本（无规格时为“默认规格”）。 */
  specLabel: string | null
  /** 细分模式下该行对应的出库明细名称快照，供下钻精确过滤；合并模式为 null。 */
  nameSnapshot: string | null
  totalQty: string | number
}

export interface DashboardTopCustomer {
  customerName: string
  totalAmount: string | number
  orderCount: number
}

export interface DashboardRecentActivity {
  id: string
  orderId: string
  actionType: 'order.create' | 'order.delete' | 'order.restore' | 'order.purge'
  actionLabel: string
  showNo: string
  actorDisplayName: string
  displayName: string
  customerName: string
  totalAmount: string | number
  totalQty: string | number
  createdAt: string
}

export interface DashboardDateFilterQuery {
  dateRange?: [string, string] | null
  orderType?: 'department' | 'walkin'
}

export type DashboardTrendGranularity = 'day' | 'month'
export type DashboardProductSpecMode = 'merged' | 'spec'

export interface DashboardAnalyticsQuery extends DashboardDateFilterQuery {
  granularity?: DashboardTrendGranularity
  productSpecMode?: DashboardProductSpecMode
  productId?: string
  topN?: number
}

export interface DashboardAnalyticsRange {
  startDate: string
  endDate: string
  granularity: DashboardTrendGranularity
  orderType: 'department' | 'walkin' | null
  productSpecMode: DashboardProductSpecMode
  productId: string | null
  topN: number
  isDefault: boolean
}

export interface DashboardAnalyticsResult {
  range: DashboardAnalyticsRange
  trend: DashboardTrendPoint[]
  topProducts: DashboardTopProduct[]
  topCustomers: DashboardTopCustomer[]
}

export interface DashboardDrilldownOrderRecord {
  orderId: string
  showNo: string
  orderType: 'department' | 'walkin'
  createdAt: string
  customerName: string
  customerDepartmentName: string
  issuerName: string
  qty: string | number
  amount: string | number
}

export interface ProductDrilldownResult {
  productId: string
  productName: string
  totalQty: string | number
  totalAmount: string | number
  orderCount: number
  records: DashboardDrilldownOrderRecord[]
}

export interface CustomerDrilldownResult {
  customerName: string
  totalQty: string | number
  totalAmount: string | number
  orderCount: number
  records: DashboardDrilldownOrderRecord[]
}

export interface TagAggregateResult {
  tagId: string
  tagName: string
  totalQuantity: string | number
  totalAmount: string | number
  orderCount: number
  productCount: number
}

export interface DashboardPieSlice {
  key: string
  label: string
  value: string | number
  ratio: string | number
}

export interface DashboardPieDataResult {
  productPie: DashboardPieSlice[]
  customerPie: DashboardPieSlice[]
  orderTypePie: DashboardPieSlice[]
  range: {
    startDate: string
    endDate: string
    orderType: 'department' | 'walkin' | null
    isDefault: boolean
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const buildDashboardDateFilterParams = (query: DashboardDateFilterQuery) => {
  const params: Record<string, string> = {}
  if (query.orderType) {
    params.orderType = query.orderType
  }
  if (query.dateRange?.length === 2) {
    const [startDate, endDate] = query.dateRange
    if (startDate) {
      params.startDate = startDate
    }
    if (endDate) {
      params.endDate = endDate
    }
    params.dateRange = `${startDate},${endDate}`
  }
  return params
}

/**
 * 获取工作台数据看板的核心统计指标与图表数据：
 * - 包含今日/本月订单量、销售额、七日趋势、商品与客户排行及最近活动。
 */
export const getDashboardStats = (requestConfig: RequestConfig = {}) => {
  return request<DashboardStats>({
    ...requestConfig,
    url: '/dashboard/stats',
    method: 'GET',
  })
}

/**
 * 下钻查询商品维度的订单详情：
 * - 用户在点击商品排行榜某一项时触发。
 */
export const getProductDrilldown = (
  productId: string,
  query: DashboardDateFilterQuery & { nameSnapshot?: string } = {},
  requestConfig: RequestConfig = {},
) => {
  const nameSnapshot = query.nameSnapshot?.trim()
  return request<ProductDrilldownResult>({
    ...requestConfig,
    url: '/dashboard/drilldown/products',
    method: 'GET',
    params: {
      productId,
      ...(nameSnapshot ? { nameSnapshot } : {}),
      ...buildDashboardDateFilterParams(query),
    },
  })
}

/**
 * 下钻查询客户维度的订单详情：
 * - 用户在点击客户排行榜某一项时触发。
 */
export const getCustomerDrilldown = (
  customerName: string,
  query: DashboardDateFilterQuery = {},
  requestConfig: RequestConfig = {},
) => {
  return request<CustomerDrilldownResult>({
    ...requestConfig,
    url: '/dashboard/drilldown/customers',
    method: 'GET',
    params: {
      customerName,
      ...buildDashboardDateFilterParams(query),
    },
  })
}

/**
 * 获取工作台各标签类型的订单与销售聚合数据：
 * - 用于渲染标签分布饼图或聚合卡片。
 */
export const getTagAggregate = (
  tagId: string,
  query: DashboardDateFilterQuery = {},
  requestConfig: RequestConfig = {},
) => {
  return request<TagAggregateResult>({
    ...requestConfig,
    url: '/dashboard/tags/aggregate',
    method: 'GET',
    params: {
      tagId,
      ...buildDashboardDateFilterParams(query),
    },
  })
}

/**
 * 获取首页区间分析数据：
 * - 由“结构占比”筛选栏统一驱动趋势图、热门商品榜与部门榜；
 * - 商品榜默认按商品合并，可切换细分规格并锁定单个商品做款式对比。
 */
export const getDashboardAnalytics = (
  query: DashboardAnalyticsQuery = {},
  requestConfig: RequestConfig = {},
) => {
  const params: Record<string, string | number> = {
    ...buildDashboardDateFilterParams(query),
  }
  if (query.granularity) {
    params.granularity = query.granularity
  }
  if (query.productSpecMode) {
    params.productSpecMode = query.productSpecMode
  }
  if (query.productId?.trim()) {
    params.productId = query.productId.trim()
  }
  if (query.topN) {
    params.topN = query.topN
  }

  return request<DashboardAnalyticsResult>({
    ...requestConfig,
    url: '/dashboard/analytics',
    method: 'GET',
    params,
  })
}

/**
 * 获取基于各标签类型的饼图数据：
 * - 由后端直接返回格式化后的 PieSlice 结构，供 ECharts 消费。
 */
export const getDashboardPieData = (query: DashboardDateFilterQuery = {}, requestConfig: RequestConfig = {}) => {
  return request<DashboardPieDataResult>({
    ...requestConfig,
    url: '/dashboard/pie',
    method: 'GET',
    params: buildDashboardDateFilterParams(query),
  })
}
