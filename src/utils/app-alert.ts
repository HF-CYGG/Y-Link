import { ElMessage } from 'element-plus'
import type { MessageHandler } from 'element-plus'
import {
  buildRequestErrorDisplayInfo,
  normalizeRequestError,
  type RequestErrorDisplayInfo,
} from '@/utils/error'

export type AppAlertType = 'primary' | 'success' | 'info' | 'warning' | 'error'

export interface AppAlertOptions {
  type: AppAlertType
  message: string
  title?: string
  duration?: number
  closable?: boolean
  detail?: string
  diagnosticText?: string
}

interface CriticalAppErrorOptions {
  title?: string
  fallback?: string
  operation?: string
}

interface ActiveMessage {
  id: number
  close: () => void
}

const DEFAULT_DURATION_MAP: Record<AppAlertType, number> = {
  primary: 3200,
  success: 2600,
  info: 3200,
  warning: 4200,
  error: 6200,
}

const MAX_VISIBLE_ALERTS = 4

let nextAlertId = 1
let latestAlertKey = ''
let latestAlertAt = 0

const activeMessages: ActiveMessage[] = []

const trimText = (value: unknown) => {
  return typeof value === 'string' ? value.trim() : ''
}

const resolveMessageText = (message: string, title?: string, detail?: string) => {
  const normalizedTitle = trimText(title)
  const normalizedDetail = trimText(detail)
  const body = normalizedDetail ? `${message}\n${normalizedDetail}` : message
  return normalizedTitle ? `${normalizedTitle}：${body}` : body
}

const removeActiveMessage = (id: number) => {
  const index = activeMessages.findIndex((message) => message.id === id)
  if (index >= 0) {
    activeMessages.splice(index, 1)
  }
}

export const showAppAlert = (options: AppAlertOptions) => {
  const message = trimText(options.message)
  if (!message) {
    return 0
  }

  const alertKey = `${options.type}|${options.title ?? ''}|${message}|${options.detail ?? ''}`
  const now = Date.now()
  if (alertKey === latestAlertKey && now - latestAlertAt < 500) {
    return 0
  }
  latestAlertKey = alertKey
  latestAlertAt = now

  const id = nextAlertId++
  const duration = options.duration ?? DEFAULT_DURATION_MAP[options.type]
  const handler: MessageHandler = ElMessage({
    message: resolveMessageText(message, options.title, options.detail),
    type: options.type,
    placement: 'top',
    offset: 16,
    duration,
    showClose: options.closable ?? true,
    onClose: () => removeActiveMessage(id),
  })

  activeMessages.push({ id, close: handler.close })
  if (activeMessages.length > MAX_VISIBLE_ALERTS) {
    activeMessages.shift()?.close()
  }

  return id
}

export const showAppSuccess = (message: string, title?: string) => {
  return showAppAlert({ type: 'success', title, message })
}

export const showAppInfo = (message: string, title?: string) => {
  return showAppAlert({ type: 'info', title, message })
}

export const showAppWarning = (message: string, title?: string) => {
  return showAppAlert({ type: 'warning', title, message })
}

export const showAppError = (errorOrMessage: unknown, fallback = '请求失败，请稍后重试') => {
  const message = typeof errorOrMessage === 'string'
    ? errorOrMessage
    : normalizeRequestError(errorOrMessage, fallback).message
  return showAppAlert({ type: 'error', message: message || fallback })
}

export const showCriticalAppError = (error: unknown, options: CriticalAppErrorOptions = {}) => {
  const info: RequestErrorDisplayInfo = buildRequestErrorDisplayInfo(error, options.fallback, {
    title: options.title,
    operation: options.operation,
  })

  return showAppAlert({
    type: 'error',
    title: info.title,
    message: info.message,
    diagnosticText: info.diagnosticText,
    duration: 0,
  })
}

export const copyAppAlertDiagnostic = async (diagnosticText?: string) => {
  const text = trimText(diagnosticText)
  if (!text) {
    return
  }

  try {
    await navigator.clipboard.writeText(text)
    showAppSuccess('排查信息已复制')
  } catch {
    showAppWarning('复制失败，请手动选中排查信息复制')
  }
}
