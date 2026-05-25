/**
 * 模块说明：backend/src/types/api.ts
 * 文件职责：后端 API 通用类型定义，约束分页、响应壳与通用 DTO 结构。
 * 实现逻辑：
 * - 集中定义跨路由复用的类型别名；
 * - 保证服务层与路由层在同一返回契约下协作。
 * 维护说明：
 * - 类型字段变更需同步检查前端解析与脚本断言。
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
