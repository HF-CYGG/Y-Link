/**
 * 模块说明：系统级通用 API 模块。
 * 文件职责：封装系统健康检查接口，供前后端联通性与运行状态快速探测。
 * 维护说明：维护时重点关注健康检查返回结构稳定性与上层调用容错处理策略。
 */

import { request } from '@/api/http'

/**
 * 系统健康检查接口：
 * 用于验证前后端链路是否联通，便于本地开发快速自检。
 */
export const getHealth = () => request<{ status: string }>({ method: 'GET', url: '/health' })
