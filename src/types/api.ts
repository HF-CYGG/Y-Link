/**
 * 模块说明：src/types/api.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

/**
 * 通用后端返回体定义：
 * - code: 业务状态码；
 * - message: 人类可读消息；
 * - data: 真实载荷。
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
