/**
 * 模块说明：src/utils/list.ts
 * 文件职责：沉淀列表页通用分页查询与状态管理工具，统一管理分页默认值、查询参数归一化和结果回填。
 * 实现逻辑：
 * - 在工具层统一声明分页默认参数，避免不同列表页各自维护 `page/pageSize` 初始值；
 * - 通过通用列表状态结构收口数据、总数和加载态，减少重复样板代码；
 * - 让页面层以更轻量的方式复用常见分页列表逻辑，同时保持具体请求实现可外置。
 */

import type { PaginationQuery, PaginationQueryInput, PaginationResult } from '@/types/api'

/**
 * 统一分页默认值：
 * - page 默认从 1 开始；
 * - pageSize 默认 20，页面可按需覆盖。
 */
export const DEFAULT_PAGINATION_QUERY: PaginationQuery = {
  page: 1,
  pageSize: 20,
}

/**
 * 统一分页列表状态：
 * - loading 维护请求中的加载态；
 * - records / total 维护当前列表与总条数；
 * - query 收敛分页参数，避免页面散落 page / pageSize 多个 ref。
 */
export interface PaginatedListState<T> {
  loading: boolean
  records: T[]
  total: number
  query: PaginationQuery
}

/**
 * 创建统一分页查询对象：
 * - 将页面传入的局部配置补齐为完整 page / pageSize；
 * - 作为接口请求前的最终分页参数来源。
 */
export const createPaginationQuery = (query: PaginationQueryInput = {}): PaginationQuery => ({
  page: query.page ?? DEFAULT_PAGINATION_QUERY.page,
  pageSize: query.pageSize ?? DEFAULT_PAGINATION_QUERY.pageSize,
})

/**
 * 创建统一分页列表状态：
 * - 让带分页页面按同一结构组织数据；
 * - 后续新增列表页时可直接复用。
 */
export const createPaginatedListState = <T>(options: {
  loading?: boolean
  query?: PaginationQueryInput
} = {}): PaginatedListState<T> => ({
  loading: options.loading ?? false,
  records: [],
  total: 0,
  query: createPaginationQuery(options.query),
})

/**
 * 将分页接口结果回填到统一状态：
 * - 统一 records / total 的写入方式；
 * - 同步服务端回显的分页参数，保证分页条与实际结果一致。
 */
export const applyPaginatedResult = <T>(
  state: PaginatedListState<T>,
  result: PaginationResult<T>,
) => {
  state.records = result.records || []
  state.total = result.total || 0
  state.query.page = result.page || state.query.page
  state.query.pageSize = result.pageSize || state.query.pageSize
}
