/**
 * 模块说明：src/utils/error.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import axios from 'axios'
import type { ApiResponse } from '@/types/api'

interface AppRequestErrorOptions {
  code?: number
  status?: number
  cause?: unknown
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class AppRequestError extends Error {
  code?: number
  status?: number
  cause?: unknown

  constructor(message: string, options: AppRequestErrorOptions = {}) {
    super(message)
    this.name = 'AppRequestError'
    this.code = options.code
    this.status = options.status
    this.cause = options.cause
  }
}

/**
 * 统一解包后端返回体：
 * - 成功时直接返回 data，避免业务层重复判断 code；
 * - 失败时抛出统一 AppRequestError，便于页面层稳定提取错误文案。
 */
export const unwrapApiResponse = <T>(
  payload: ApiResponse<T>,
  options: Pick<AppRequestErrorOptions, 'status'> & { fallback?: string } = {},
): T => {
  const fallback = options.fallback || '请求失败，请稍后重试'

  if (payload.code !== 0) {
    throw new AppRequestError(payload.message || fallback, {
      code: payload.code,
      status: options.status,
      cause: payload,
    })
  }

  return payload.data
}

export const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof AppRequestError && error.message) {
    return error.message
  }

  if (axios.isAxiosError<ApiResponse<unknown>>(error)) {
    const responseMessage = error.response?.data?.message
    if (responseMessage) {
      return responseMessage
    }

    if (error.message) {
      return error.message
    }
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

/**
 * 判断请求是否由主动取消触发：
 * - Axios 在 AbortController 中止时会返回 ERR_CANCELED；
 * - 统一抽成工具函数，供“仅保留最后一次请求结果”的页面逻辑复用。
 */
export const isRequestCanceled = (error: unknown) => {
  if (axios.isCancel(error)) {
    return true
  }

  if (axios.isAxiosError(error)) {
    return error.code === 'ERR_CANCELED'
  }

  if (error instanceof AppRequestError) {
    const normalizedCause = error.cause
    if (axios.isCancel(normalizedCause)) {
      return true
    }

    if (axios.isAxiosError(normalizedCause)) {
      return normalizedCause.code === 'ERR_CANCELED'
    }
  }

  return error instanceof DOMException && error.name === 'AbortError'
}

export const normalizeRequestError = (error: unknown, fallback = '请求失败，请稍后重试'): AppRequestError => {
  if (error instanceof AppRequestError) {
    return error
  }

  if (axios.isAxiosError<ApiResponse<unknown>>(error)) {
    const responseMessage = error.response?.data?.message
    return new AppRequestError(responseMessage || error.message || fallback, {
      code: error.response?.data?.code,
      status: error.response?.status,
      cause: error,
    })
  }

  if (error instanceof Error) {
    return new AppRequestError(error.message || fallback, {
      cause: error,
    })
  }

  return new AppRequestError(fallback, {
    cause: error,
  })
}
