import { ApiClientError } from './errors.ts'
import type {
  HttpAdapter,
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

const appendParamValue = (
  searchParams: URLSearchParams,
  key: string,
  value: string | number | boolean | null | undefined,
) => {
  if (value !== null && value !== undefined) {
    searchParams.append(key, String(value))
  }
}

const buildRequestUrl = (
  baseUrl: string,
  requestUrl: string,
  params?: HttpRequestConfig['params'],
) => {
  const normalizedBaseUrl = `${baseUrl.replace(/\/+$/, '')}/`
  const normalizedRequestUrl = requestUrl.replace(/^\/+/, '')
  const url = new URL(normalizedRequestUrl, normalizedBaseUrl)

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      appendParamValue(url.searchParams, key, value)
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

const awaitWithAbort = <T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    return Promise.reject(signal.reason)
  }

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      reject(signal.reason)
    }
    const cleanup = () => {
      signal.removeEventListener('abort', handleAbort)
    }

    signal.addEventListener('abort', handleAbort, { once: true })
    Promise.resolve(value).then(
      (result) => {
        cleanup()
        resolve(result)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
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
      let terminationKind: 'aborted' | 'timeout' | undefined
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const terminate = (kind: 'aborted' | 'timeout', reason: unknown) => {
        if (terminationKind) {
          return
        }

        terminationKind = kind
        if (kind === 'aborted' && timeoutId) {
          clearTimeout(timeoutId)
        }
        controller.abort(reason)
      }

      const handleExternalAbort = () => {
        terminate('aborted', config.signal?.reason)
      }

      if (config.signal) {
        if (config.signal.aborted) {
          handleExternalAbort()
        } else {
          config.signal.addEventListener('abort', handleExternalAbort, { once: true })
        }
      }

      if (!terminationKind) {
        const timeoutMs = config.timeoutMs ?? defaultTimeoutMs
        timeoutId = setTimeout(() => {
          terminate('timeout', new DOMException('请求超时', 'TimeoutError'))
        }, timeoutMs)
      }

      try {
        const headers = new Headers(config.headers)
        const accessToken = await awaitWithAbort(options.getAccessToken?.(), controller.signal)
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
        if (config.data !== undefined) {
          if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json')
          }
          requestInit.body = JSON.stringify(config.data)
        }

        const response = await awaitWithAbort(
          fetchImplementation(
            buildRequestUrl(options.baseUrl, config.url, config.params),
            requestInit,
          ),
          controller.signal,
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
        if (terminationKind === 'timeout') {
          throw new ApiClientError('请求超时', {
            kind: 'timeout',
            cause: error,
          })
        }
        if (terminationKind === 'aborted') {
          throw new ApiClientError('请求已取消', {
            kind: 'aborted',
            cause: error,
          })
        }
        if (error instanceof ApiClientError) {
          throw error
        }
        throw new ApiClientError('网络请求失败', {
          kind: 'network',
          cause: error,
        })
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
        config.signal?.removeEventListener('abort', handleExternalAbort)
      }
    },
  }
}
