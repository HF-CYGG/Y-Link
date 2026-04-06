import { request, type RequestConfig } from '@/api/http'

export interface DashboardStats {
  todayOrderCount: number
  todayOrderAmount: string | number
  totalProductCount: number
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
