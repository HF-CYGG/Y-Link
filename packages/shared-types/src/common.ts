/** 后端统一 JSON 响应信封。 */
export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

/** 服务端最终采用的分页坐标。 */
export interface PaginationQuery {
  page: number
  pageSize: number
}

/** 调用方可按需提供的分页查询参数。 */
export interface PaginationQueryInput {
  page?: number
  pageSize?: number
}

/** 现有 Web 列表层使用的标准 records 分页结构。 */
export interface PaginationResult<T> extends PaginationQuery {
  total: number
  records: T[]
}

/** 当前后端 O2O/反馈列表接口直接返回的 list 分页结构。 */
export interface PaginationListResult<T> extends PaginationQuery {
  total: number
  list: T[]
}
