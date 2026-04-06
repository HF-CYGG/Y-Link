import { request, type RequestConfig } from '@/api/http'

export interface DashboardStats {
  todayOrderCount: number
  todayOrderAmount: string | number
  totalProductCount: number
  monthOrderCount: number
  monthOrderAmount: string | number
  trend7Days: DashboardTrendPoint[]
  topProducts: DashboardTopProduct[]
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

/**
 * 获取控制台统计数据
 */
export const getDashboardStats = (requestConfig: RequestConfig = {}) => {
  return request<DashboardStats>({
    ...requestConfig,
    url: '/dashboard/stats',
    method: 'GET',
  })
}
