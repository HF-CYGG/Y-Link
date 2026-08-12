export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

export type HttpQueryPrimitive = string | number | boolean

export type HttpQueryValue =
  | HttpQueryPrimitive
  | null
  | undefined
  | readonly (HttpQueryPrimitive | null | undefined)[]

export interface HttpRequestConfig {
  method: HttpMethod
  path: string
  query?: Readonly<Record<string, HttpQueryValue>>
  body?: unknown
  headers?: Readonly<Record<string, string>>
  signal?: AbortSignal
  timeoutMs?: number
  idempotencyKey?: string
}

export interface HttpAdapter {
  request<T>(config: HttpRequestConfig): Promise<T>
}
