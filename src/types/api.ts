/**
 * 模块说明：F:/Y-Link/src/types/api.ts
 * 文件职责：前端 API 通用类型定义。
 * 实现逻辑：统一响应壳、分页查询参数与分页结果类型，约束 API 模块返回结构并减少页面重复定义。
 * 维护说明：若调整分页或响应结构字段，需同步检查 API 模块、列表页解析与相关测试。
 */
export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

/**
 * 统一分页查询参数：
 * - 与后端约定保持一致，统一使用 page / pageSize；
 * - 用于前端列表页、分页工具与接口模块共享。
 */
export interface PaginationQuery {
  page: number
  pageSize: number
}

/**
 * 分页查询入参：
 * - 页面初始查询通常允许部分字段缺省；
 * - 由页面或工具在真正请求前补齐默认值。
 */
export interface PaginationQueryInput {
  page?: number
  pageSize?: number
}

/**
 * 统一分页结果结构：
 * - records 为当前页数据；
 * - total 为总条数；
 * - page / pageSize 回显服务端最终采用的分页参数。
 */
export interface PaginationResult<T> extends PaginationQuery {
  total: number
  records: T[]
}
