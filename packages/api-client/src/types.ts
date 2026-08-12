export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface HttpRequestConfig {
  method: HttpMethod
  url: string
  params?: Record<string, string | number | boolean | null | undefined>
  data?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
  timeoutMs?: number
  idempotencyKey?: string
}

export interface HttpAdapter {
  request<T>(config: HttpRequestConfig): Promise<T>
}
