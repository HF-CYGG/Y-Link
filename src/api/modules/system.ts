import { request } from '@/api/http'

/**
 * 系统健康检查接口：
 * 用于验证前后端链路是否联通，便于本地开发快速自检。
 */
export const getHealth = () => request<{ status: string }>({ method: 'GET', url: '/health' })
