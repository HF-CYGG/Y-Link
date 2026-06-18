/**
 * 模块说明：src/utils/error.ts
 * 文件职责：统一归一化前端请求异常，收口后端业务错误、权限错误、网络异常与请求取消等提示口径。
 * 实现逻辑：
 * - 通过 `AppRequestError` 承载业务码、HTTP 状态码与原始异常，方便页面层稳定提取可展示文案；
 * - 对 Axios、后端返回体和原生 Error 做统一归一化，避免页面各自判断 400/401/403/409/超时/断网；
 * - 对已知通道错误优先映射成最终用户可理解的中文提示，同时保留服务端业务文案优先级。
 * 维护说明：
 * - 若后续新增新的业务状态码或网络错误口径，应优先在本文件扩展，而不是回到页面散点判断；
 * - 页面侧如需展示错误信息，请优先复用 `extractErrorMessage` 与 `normalizeRequestError`。
 */

import axios, { type AxiosError } from 'axios'
import type { ApiResponse } from '@/types/api'

interface AppRequestErrorOptions {
  code?: number
  status?: number
  cause?: unknown
}

export interface RequestErrorDisplayInfo {
  title: string
  message: string
  suggestion: string
  status?: number
  code?: number
  method?: string
  url?: string
  diagnosticText: string
}

/**
 * 已知 HTTP 状态码提示映射：
 * - 只覆盖用户侧能稳定理解的共性错误；
 * - 若后端返回了更具体的业务文案，仍以服务端文案优先。
 */
const KNOWN_STATUS_MESSAGE_MAP: Partial<Record<number, string>> = {
  400: '提交数据不合法，请检查后重试',
  401: '登录状态已失效，请重新登录',
  403: '当前账号没有权限执行此操作',
  404: '请求的数据不存在或已被删除',
  408: '请求超时，请稍后重试',
  409: '数据状态已变化，请刷新后重试',
  422: '提交数据校验未通过，请检查后重试',
  429: '操作过于频繁，请稍后再试',
  500: '服务暂时不可用，请稍后重试',
  502: '服务暂时不可用，请稍后重试',
  503: '服务暂时不可用，请稍后重试',
  504: '服务响应超时，请稍后重试',
}

/**
 * 统一识别“通道层默认报错文案”：
 * - Axios 会产出英文默认错误，如 `Network Error`、`Request failed with status code 403`；
 * - 这类文案不适合直接暴露给最终用户，需要优先翻译成中文提示。
 */
const TRANSPORT_LAYER_MESSAGE_PATTERN = /^(Network Error|canceled|Request failed with status code \d+|timeout of \d+ms exceeded)$/i

const normalizeMessageText = (message: unknown): string => {
  return typeof message === 'string' ? message.trim() : ''
}

const isTransportLayerMessage = (message: string) => {
  return TRANSPORT_LAYER_MESSAGE_PATTERN.test(message)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const redactSensitiveText = (value: string) => {
  return value
    .replace(/https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+/g, '[飞书 Webhook 已隐藏]')
    .replace(/((?:token|secret|password|authorization|cookie|access_token|webhook)[=:]\s*)[^&\s,;]+/gi, '$1[已隐藏]')
}

const sanitizeRequestUrl = (url?: string) => {
  const normalizedUrl = normalizeMessageText(url)
  if (!normalizedUrl) {
    return undefined
  }

  return redactSensitiveText(normalizedUrl.replace(/\?.*$/, '?…'))
}

const pickApiResponseLikeMessage = (value: unknown) => {
  if (!isRecord(value)) {
    return ''
  }

  return normalizeMessageText(value.message)
}

const pickApiResponseLikeCode = (value: unknown) => {
  if (!isRecord(value)) {
    return undefined
  }

  return typeof value.code === 'number' ? value.code : undefined
}

const extractCauseBusinessMessage = (cause: unknown) => {
  if (axios.isAxiosError<ApiResponse<unknown>>(cause)) {
    return normalizeMessageText(cause.response?.data?.message)
  }

  return pickApiResponseLikeMessage(cause)
}

const extractCauseStatus = (cause: unknown) => {
  if (axios.isAxiosError(cause)) {
    return cause.response?.status
  }

  if (cause instanceof AppRequestError) {
    return cause.status
  }

  return undefined
}

const extractCauseCode = (cause: unknown) => {
  if (axios.isAxiosError<ApiResponse<unknown>>(cause)) {
    return cause.response?.data?.code
  }

  if (cause instanceof AppRequestError) {
    return cause.code
  }

  return pickApiResponseLikeCode(cause)
}

const extractAxiosCause = (cause: unknown): AxiosError<ApiResponse<unknown>> | null => {
  if (axios.isAxiosError<ApiResponse<unknown>>(cause)) {
    return cause
  }

  if (cause instanceof AppRequestError) {
    return extractAxiosCause(cause.cause)
  }

  if (cause instanceof Error && 'cause' in cause) {
    return extractAxiosCause((cause as Error & { cause?: unknown }).cause)
  }

  return null
}

const resolveStatusMessage = (status?: number) => {
  return status ? KNOWN_STATUS_MESSAGE_MAP[status] || '' : ''
}

const resolveTransportMessage = (transportCode?: string, message?: string) => {
  if (transportCode === 'ERR_NETWORK') {
    return '网络异常，请检查网络连接后重试'
  }

  if (transportCode === 'ECONNABORTED' || transportCode === 'ETIMEDOUT') {
    return '请求超时，请稍后重试'
  }

  if (transportCode === 'ERR_CANCELED') {
    return '请求已取消'
  }

  if (/timeout/i.test(message || '')) {
    return '请求超时，请稍后重试'
  }

  if (/network error/i.test(message || '')) {
    return '网络异常，请检查网络连接后重试'
  }

  return ''
}

/**
 * 统一计算最终展示文案：
 * - 优先展示服务端明确返回的业务提示；
 * - 其次将权限、超时、断网等通道错误翻译为中文；
 * - 最后才退回页面传入的兜底文案。
 */
const resolveRequestErrorMessage = (options: {
  message?: string
  status?: number
  code?: number
  transportCode?: string
  cause?: unknown
  fallback: string
}) => {
  const fallbackMessage = normalizeMessageText(options.fallback) || '请求失败，请稍后重试'
  const currentMessage = normalizeMessageText(options.message)
  const causeMessage = extractCauseBusinessMessage(options.cause)
  const statusMessage = resolveStatusMessage(options.status ?? extractCauseStatus(options.cause))
  const transportMessage = resolveTransportMessage(options.transportCode, currentMessage)
  const resolvedCode = options.code ?? extractCauseCode(options.cause)

  if (causeMessage) {
    return causeMessage
  }

  if (currentMessage && !isTransportLayerMessage(currentMessage) && currentMessage !== fallbackMessage) {
    return currentMessage
  }

  if (transportMessage) {
    return transportMessage
  }

  if (statusMessage) {
    return statusMessage
  }

  if (resolvedCode !== undefined && currentMessage && !isTransportLayerMessage(currentMessage)) {
    return currentMessage
  }

  if (currentMessage && !isTransportLayerMessage(currentMessage)) {
    return currentMessage
  }

  return fallbackMessage
}

/**
 * 自定义应用请求异常类：
 * - 携带统一的状态码与业务错误码，便于调用侧识别；
 * - 聚合 cause 保留原始错误栈信息，有助于联调与排查。
 */
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
  return normalizeRequestError(error, fallback).message
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
    const normalizedStatus = error.status ?? extractCauseStatus(error.cause)
    const normalizedCode = error.code ?? extractCauseCode(error.cause)
    const normalizedMessage = resolveRequestErrorMessage({
      message: error.message,
      status: normalizedStatus,
      code: normalizedCode,
      cause: error.cause,
      fallback,
    })

    if (normalizedMessage === error.message && normalizedStatus === error.status && normalizedCode === error.code) {
      return error
    }

    return new AppRequestError(normalizedMessage, {
      code: normalizedCode,
      status: normalizedStatus,
      cause: error.cause,
    })
  }

  if (axios.isAxiosError<ApiResponse<unknown>>(error)) {
    const normalizedMessage = resolveRequestErrorMessage({
      message: error.message,
      status: error.response?.status,
      code: error.response?.data?.code,
      transportCode: error.code,
      cause: error,
      fallback,
    })

    return new AppRequestError(normalizedMessage, {
      code: error.response?.data?.code,
      status: error.response?.status,
      cause: error,
    })
  }

  if (error instanceof Error) {
    const normalizedMessage = resolveRequestErrorMessage({
      message: error.message,
      cause: (error as Error & { cause?: unknown }).cause,
      fallback,
    })

    return new AppRequestError(normalizedMessage, {
      cause: error,
    })
  }

  return new AppRequestError(fallback, {
    cause: error,
  })
}

const resolveErrorTitle = (status?: number) => {
  if (!status) {
    return '网络或请求异常'
  }
  if (status === 401) {
    return '登录状态已失效'
  }
  if (status === 403) {
    return '权限不足'
  }
  if (status === 409) {
    return '数据状态冲突'
  }
  if (status === 422 || status === 400) {
    return '提交内容未通过校验'
  }
  if (status === 429) {
    return '操作过于频繁'
  }
  if (status >= 500) {
    return '服务暂时不可用'
  }
  return '操作失败'
}

const resolveErrorSuggestion = (normalizedError: AppRequestError) => {
  const status = normalizedError.status
  const message = normalizedError.message

  if (!status && /网络|连接|Network/i.test(message)) {
    return '请检查当前网络连接，确认服务可访问后再重试。'
  }
  if (!status || /超时|timeout/i.test(message)) {
    return '请稍后重试；如果连续失败，请刷新页面后再次操作。'
  }
  if (status === 401) {
    return '请重新登录后再继续操作。'
  }
  if (status === 403) {
    return '请确认当前账号拥有该功能权限；如需继续操作，请联系管理员处理。'
  }
  if (status === 409) {
    return '当前数据可能已被其他操作更新，请刷新页面后再提交。'
  }
  if (status === 400 || status === 422) {
    return '请按提示检查表单内容，修正后重新提交。'
  }
  if (status === 429) {
    return '请等待提示中的冷却时间结束后再试，避免连续重复提交。'
  }
  if (status >= 500) {
    return '服务端暂时无法完成请求，请稍后重试；若持续失败，请保留排查信息反馈给维护人员。'
  }
  return '请检查当前页面输入与网络状态后重试。'
}

export const buildRequestErrorDisplayInfo = (
  error: unknown,
  fallback = '请求失败，请稍后重试',
  context: { title?: string; operation?: string } = {},
): RequestErrorDisplayInfo => {
  const normalizedError = normalizeRequestError(error, fallback)
  const axiosCause = extractAxiosCause(normalizedError.cause)
  const method = axiosCause?.config?.method?.toUpperCase()
  const url = sanitizeRequestUrl(axiosCause?.config?.url)
  const title = context.title || resolveErrorTitle(normalizedError.status)
  const displayMessage = redactSensitiveText(normalizedError.message)
  const diagnosticParts = [
    context.operation ? `操作：${context.operation}` : '',
    normalizedError.status ? `HTTP：${normalizedError.status}` : '',
    normalizedError.code !== undefined ? `业务码：${normalizedError.code}` : '',
    method ? `方法：${method}` : '',
    url ? `地址：${url}` : '',
    `原因：${displayMessage}`,
  ].filter(Boolean)

  return {
    title,
    message: displayMessage,
    suggestion: resolveErrorSuggestion(normalizedError),
    status: normalizedError.status,
    code: normalizedError.code,
    method,
    url,
    diagnosticText: diagnosticParts.join('\n'),
  }
}
