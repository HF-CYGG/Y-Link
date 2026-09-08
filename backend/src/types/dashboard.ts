/**
 * 模块说明：`backend/src/types/dashboard.ts`
 * 文件职责：收敛看板服务可复用的原始聚合类型与数值联合类型，避免服务内重复声明。
 * 实现逻辑：
 * 1. 聚合结果中的数值字段统一使用 NumericLike，兼容数据库返回 string/number/null；
 * 2. 明细、排行与饼图原始行类型集中管理，便于其他服务或路由复用；
 * 3. 类型文件只承载结构定义，不包含业务逻辑。
 */

export type DashboardOptionalNumericLike = string | number | null | undefined
export type DashboardNumericLike = string | number | null

export interface DashboardProductDetailRaw {
  orderId: string | number
  showNo: string | null
  orderType: string | null
  createdAt: Date | string
  customerName: string | null
  customerDepartmentName: string | null
  issuerName: string | null
  qty: DashboardNumericLike
  amount: DashboardNumericLike
}

export interface DashboardCustomerSummaryRaw {
  totalQty?: DashboardNumericLike
  totalAmount?: DashboardNumericLike
  orderCount?: DashboardNumericLike
}

export interface DashboardCustomerDetailRaw {
  orderId: string | number
  showNo: string | null
  orderType: string | null
  createdAt: Date | string
  customerName: string | null
  customerDepartmentName: string | null
  issuerName: string | null
  qty: DashboardNumericLike
  amount: DashboardNumericLike
}

export interface DashboardTagAggregateRaw {
  totalQuantity?: DashboardNumericLike
  totalAmount?: DashboardNumericLike
  orderCount?: DashboardNumericLike
  productCount?: DashboardNumericLike
}

export interface DashboardPieProductRowRaw {
  key: string | number
  label: string | null
  masterLabel?: string | null
  value: DashboardNumericLike
}

export interface DashboardRankProductRowRaw {
  productId: string | number
  masterName: string | null
  snapshotName: string | null
  totalQty: DashboardNumericLike
}

export interface DashboardRankCustomerRowRaw {
  customerName: string | null
  totalAmount: DashboardNumericLike
  orderCount: DashboardNumericLike
}

export interface DashboardTrendOrderRowRaw {
  createdAt: Date | string
  totalAmount: DashboardNumericLike
  totalQty: DashboardNumericLike
}

export interface DashboardAmountSumRaw {
  totalValue?: DashboardNumericLike
}

export interface DashboardPieCustomerRowRaw {
  key: string | null
  label: string | null
  value: DashboardNumericLike
}

export interface DashboardPieOrderTypeRowRaw {
  orderType: string | null
  value: DashboardNumericLike
}
