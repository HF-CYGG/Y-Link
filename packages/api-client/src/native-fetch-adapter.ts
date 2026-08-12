import { ApiClientError } from './errors.ts'
import type {
  HttpAdapter,
  HttpQueryValue,
  HttpRequestConfig,
} from './types.ts'

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface NativeFetchAdapterOptions {
  baseUrl: string
  fetch?: FetchImplementation
  defaultTimeoutMs?: number
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>
}

interface ApiEnvelope<T> {
  code: number
  message: string
  data: T
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const isApiEnvelope = <T>(value: unknown): value is ApiEnvelope<T> => {
  return isRecord(value)
    && typeof value.code === 'number'
    && typeof value.message === 'string'
    && 'data' in value
}

const appendQueryValue = (searchParams: URLSearchParams, key: string, value: HttpQueryValue) => {
  const values = Array.isArray(value) ? value : [value]
  for (const item of values) {
    if (item !== null && item !== undefined) {
      searchParams.append(key, String(item))
    }
  }
}

const buildRequestUrl = (
  baseUrl: string,
  path: string,
  query?: HttpRequestConfig['query'],
) => {
  const normalizedBaseUrl = `${baseUrl.replace(/\/+$/, '')}/`
  const normalizedPath = path.replace(/^\/+/, '')
  const url = new URL(normalizedPath, normalizedBaseUrl)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      appendQueryValue(url.searchParams, key, value)
    }
  }

  return url.toString()
}

const parseResponsePayload = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  if (!text) {
    return undefined
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

const pickHttpErrorDetails = (payload: unknown, response: Response) => {
  if (isRecord(payload)) {
    return {
      code: typeof payload.code === 'number' ? payload.code : undefined,
      message: typeof payload.message === 'string' && payload.message.trim()
        ? payload.message
        : `HTTP 请求失败（${response.status}）`,
    }
  }

  return {
    code: undefined,
    message: typeof payload === 'string' && payload.trim()
      ? payload
      : `HTTP 请求失败（${response.status}）`,
  }
}

export const createNativeFetchAdapter = (options: NativeFetchAdapterOptions): HttpAdapter => {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  return {
    async request<T>(config: HttpRequestConfig): Promise<T> {
      const controller = new AbortController()
      let timedOut = false
      let externallyCanceled = config.signal?.aborted ?? false

      const handleExternalAbort = () => {
        externallyCanceled = true
        controller.abort(config.signal?.reason)
      }

      if (config.signal) {
        if (config.signal.aborted) {
          handleExternalAbort()
        } else {
          config.signal.addEventListener('abort', handleExternalAbort, { once: true })
        }
      }

      const timeoutMs = config.timeoutMs ?? defaultTimeoutMs
      const timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort(new DOMException('请求超时', 'TimeoutError'))
      }, timeoutMs)

      try {
        const headers = new Headers(config.headers)
        const accessToken = await options.getAccessToken?.()
        if (accessToken && !headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${accessToken}`)
        }
        if (config.idempotencyKey) {
          headers.set('Idempotency-Key', config.idempotencyKey)
        }

        if (controller.signal.aborted) {
          throw controller.signal.reason
        }

        const requestInit: RequestInit = {
          method: config.method,
          headers,
          signal: controller.signal,
        }
        if (config.body !== undefined) {
          if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json')
          }
          requestInit.body = JSON.stringify(config.body)
        }

        const response = await fetchImplementation(
          buildRequestUrl(options.baseUrl, config.path, config.query),
          requestInit,
        )
        const payload = await parseResponsePayload(response)

        if (!response.ok) {
          const details = pickHttpErrorDetails(payload, response)
          if (response.status === 401) {
            // TODO(mobile-auth): 由移动端鉴权层决定后续会话恢复策略；此处不刷新、不重放、不退出。
          }
          throw new ApiClientError(details.message, {
            kind: 'http',
            status: response.status,
            code: details.code,
            cause: payload,
          })
        }

        if (isApiEnvelope<T>(payload)) {
          if (payload.code !== 0) {
            throw new ApiClientError(payload.message || '业务请求失败', {
              kind: 'business',
              status: response.status,
              code: payload.code,
              cause: payload,
            })
          }
          return payload.data
        }

        return payload as T
      } catch (error) {
        if (error instanceof ApiClientError) {
          throw error
        }
        if (timedOut) {
          throw new ApiClientError('请求超时', {
            kind: 'timeout',
            cause: error,
          })
        }
        if (externallyCanceled || config.signal?.aborted) {
          throw new ApiClientError('请求已取消', {
            kind: 'canceled',
            cause: error,
          })
        }
        throw new ApiClientError('网络请求失败', {
          kind: 'network',
          cause: error,
        })
      } finally {
        clearTimeout(timeoutId)
        config.signal?.removeEventListener('abort', handleExternalAbort)
      }
    },
  }
}
