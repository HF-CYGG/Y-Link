/**
 * 模块说明：`backend/src/types/api.ts`
 * 文件职责：定义后端接口通用响应结构与分页查询结果类型，供路由层和服务层在返回数据时保持统一约定。
 * 实现逻辑：
 * 1. `ApiResponse` 约束所有接口统一返回 `code`、`message`、`data` 三段结构；
 * 2. `PaginationQuery` 约束分页入参的基础字段，便于列表接口复用；
 * 3. `PaginationResult` 统一描述分页结果页码、总数与列表数据，减少重复类型声明。
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
