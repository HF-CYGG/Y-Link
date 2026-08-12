export type ApiClientErrorKind = 'http' | 'business' | 'network' | 'timeout' | 'canceled'

export interface ApiClientErrorOptions {
  kind: ApiClientErrorKind
  status?: number | undefined
  code?: number | undefined
  cause?: unknown
}

/** 所有 adapter 向调用方暴露的标准错误。 */
export class ApiClientError extends Error {
  readonly kind: ApiClientErrorKind
  readonly status: number | undefined
  readonly code: number | undefined
  override readonly cause: unknown

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message)
    this.name = 'ApiClientError'
    this.kind = options.kind
    this.status = options.status
    this.code = options.code
    this.cause = options.cause
  }
}
