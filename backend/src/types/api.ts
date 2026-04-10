/**
 * 模块说明：backend/src/types/api.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

export interface PaginationQuery {
  page?: number
  pageSize?: number
}

export interface PaginationResult<T> {
  page: number
  pageSize: number
  total: number
  list: T[]
}
