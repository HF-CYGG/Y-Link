/**
 * 模块说明：src/api/modules/dashboard.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { request, type RequestConfig } from '@/api/http'

export interface DashboardStats {
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

export interface DashboardTrendPoint {
  date: string
  label: string
  amount: string | number
  orderCount: number
  totalQty: string | number
}

export interface DashboardTopProduct {
  productId: string
  productName: string
  totalQty: string | number
}

export interface DashboardTopCustomer {
  customerName: string
  totalAmount: string | number
  orderCount: number
}

export interface DashboardRecentActivity {
  id: string
  actionType: 'order.create' | 'order.delete' | 'order.restore'
  actionLabel: string
  showNo: string
  actorDisplayName: string
  customerName: string
  totalAmount: string | number
  totalQty: string | number
  createdAt: string
}

export interface DashboardDateFilterQuery {
  dateRange?: [string, string] | null
  orderType?: 'department' | 'walkin'
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
  query: DashboardDateFilterQuery = {},
  requestConfig: RequestConfig = {},
) => {
  return request<ProductDrilldownResult>({
    ...requestConfig,
    url: '/dashboard/drilldown/products',
    method: 'GET',
    params: {
      productId,
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
