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
