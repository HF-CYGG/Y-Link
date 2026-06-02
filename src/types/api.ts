/**
 * 模块说明：src/types/api.ts
 * 文件职责：集中定义前端 API 层通用类型契约，统一承接后端标准返回体、分页查询参数与分页结果结构。
 * 实现逻辑：
 * - 把多个接口模块都会复用的公共类型沉淀到独立文件，避免各业务域重复声明相同结构；
 * - 通过统一分页类型约束 API 模块与列表页之间的交互口径，减少字段命名漂移；
 * - 作为请求层和业务 API 层之间的基础类型桥梁，保持上游响应结构表达稳定。
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
