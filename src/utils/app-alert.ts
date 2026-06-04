import { ElNotification } from 'element-plus'
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

interface ActiveNotification {
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

const activeNotifications: ActiveNotification[] = []

const trimText = (value: unknown) => {
  return typeof value === 'string' ? value.trim() : ''
}

const resolveAlertTitle = (type: AppAlertType, title?: string) => {
  if (title?.trim()) {
    return title.trim()
  }
  if (type === 'success') return '操作成功'
  if (type === 'warning') return '请注意'
  if (type === 'error') return '操作失败'
  return '提示'
}

const resolveNotificationMessage = (message: string, detail?: string) => {
  const normalizedDetail = trimText(detail)
  return normalizedDetail ? `${message}\n${normalizedDetail}` : message
}

const removeActiveNotification = (id: number) => {
  const index = activeNotifications.findIndex((notification) => notification.id === id)
  if (index >= 0) {
    activeNotifications.splice(index, 1)
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
  const notification = ElNotification({
    title: resolveAlertTitle(options.type, options.title),
    message: resolveNotificationMessage(message, options.detail),
    type: options.type,
    duration,
    position: 'top-right',
    showClose: options.closable ?? true,
    customClass: 'ylink-app-notification',
    onClose: () => removeActiveNotification(id),
  })

  activeNotifications.push({ id, close: notification.close })
  if (activeNotifications.length > MAX_VISIBLE_ALERTS) {
    activeNotifications.shift()?.close()
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
    detail: info.suggestion,
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
