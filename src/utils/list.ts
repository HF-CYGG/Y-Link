/**
 * 模块说明：src/utils/list.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
