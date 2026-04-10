/**
 * 模块说明：src/api/modules/system.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { request } from '@/api/http'

/**
 * 系统健康检查接口：
 * 用于验证前后端链路是否联通，便于本地开发快速自检。
 */
export const getHealth = () => request<{ status: string }>({ method: 'GET', url: '/health' })
