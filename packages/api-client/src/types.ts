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
  /** access 为默认值；none 用于登录、注册与 refresh 等公开认证端点。 */
  auth?: 'access' | 'none'
}

export interface HttpAdapter {
  request<T>(config: HttpRequestConfig): Promise<T>
}

/** 业务 API module 允许调用方控制的传输选项；不能覆盖 method/path/body。 */
export type ApiRequestOptions = Pick<
  HttpRequestConfig,
  'signal' | 'headers' | 'timeoutMs' | 'idempotencyKey'
>
