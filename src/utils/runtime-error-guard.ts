/**
 * 模块说明：src/utils/runtime-error-guard.ts
 * 文件职责：统一分类全局运行时异常，避免把表单校验、取消操作、扩展脚本或资源加载失败误报为页面脚本异常。
 * 实现逻辑：入口、路由和 Vue errorHandler 共用同一套判断规则，只让真实应用异常进入用户可见错误提示。
 */

import { isRequestCanceled } from '@/utils/error'

export type RuntimeErrorCategory = 'ignore' | 'chunk-stale' | 'app-error'

export interface RuntimeErrorClassification {
  category: RuntimeErrorCategory
  reason: string
  value: unknown
  sourceText: string
}

const USER_CANCEL_MESSAGES = new Set(['cancel', 'close'])
const EXTERNAL_SCRIPT_SOURCE_PATTERN =
  /(userscript\.html|chrome-extension:\/\/|moz-extension:\/\/|safari-extension:\/\/|tampermonkey|violentmonkey|greasemonkey|content-script|injected-script|extension-script)/i
const CHUNK_STALE_ERROR_PATTERN =
  /(ChunkLoadError|Loading chunk \d+ failed|Loading CSS chunk \d+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS)/i
const HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>`]+/gi

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const normalizeRuntimeText = (value: unknown) => {
  return typeof value === 'string' ? value.trim() : ''
}

const collectRecordSourceText = (value: Record<string, unknown>) => {
  const config = isRecord(value.config) ? value.config : null
  const request = isRecord(value.request) ? value.request : null

  return [
    normalizeRuntimeText(value.message),
    normalizeRuntimeText(value.stack),
    normalizeRuntimeText(value.filename),
    normalizeRuntimeText(value.sourceURL),
    normalizeRuntimeText(value.url),
    normalizeRuntimeText(value.href),
    normalizeRuntimeText(value.src),
    normalizeRuntimeText(config?.url),
    normalizeRuntimeText(request?.responseURL),
  ].filter(Boolean).join('\n')
}

const collectRuntimeSourceText = (value: unknown) => {
  const recordSourceText = isRecord(value) ? collectRecordSourceText(value) : ''

  if (value instanceof Error) {
    return [value.name, value.message, value.stack, recordSourceText].filter(Boolean).join('\n')
  }

  return recordSourceText || normalizeRuntimeText(value)
}

const collectSourceText = (value: unknown, extraSource = '') => {
  return [extraSource, collectRuntimeSourceText(value)].filter(Boolean).join('\n')
}

const isUserCancelRuntimeError = (value: unknown) => {
  if (typeof value === 'string') {
    return USER_CANCEL_MESSAGES.has(value.trim().toLowerCase())
  }
  if (value instanceof Error) {
    return USER_CANCEL_MESSAGES.has(value.message.trim().toLowerCase())
  }
  if (isRecord(value)) {
    return USER_CANCEL_MESSAGES.has(normalizeRuntimeText(value.message).toLowerCase())
  }
  return false
}

const isAbortRuntimeError = (value: unknown) => {
  if (typeof DOMException !== 'undefined' && value instanceof DOMException) {
    return value.name === 'AbortError'
  }
  if (value instanceof Error) {
    return value.name === 'AbortError'
  }
  if (isRecord(value)) {
    return normalizeRuntimeText(value.name) === 'AbortError'
  }
  return false
}

const isElementFormValidationItem = (value: unknown) => {
  return isRecord(value)
    && typeof value.message === 'string'
    && (typeof value.field === 'string' || 'fieldValue' in value)
}

const isElementFormValidationErrorList = (value: unknown) => {
  return Array.isArray(value) && value.length > 0 && value.every(isElementFormValidationItem)
}

const isElementFormValidationPayload = (value: unknown) => {
  if (!isRecord(value) || value instanceof Error) {
    return false
  }

  const fieldErrors = Object.values(value)
  return fieldErrors.length > 0 && fieldErrors.every(isElementFormValidationErrorList)
}

const isExternalScriptRuntimeError = (value: unknown, extraSource = '') => {
  const sourceText = collectSourceText(value, extraSource)
  return EXTERNAL_SCRIPT_SOURCE_PATTERN.test(sourceText) || hasExternalHttpSource(sourceText)
}

const isChunkStaleRuntimeError = (value: unknown, extraSource = '') => {
  return CHUNK_STALE_ERROR_PATTERN.test(collectSourceText(value, extraSource))
}

const normalizeRuntimeUrl = (value: string) => {
  return value.replace(/[),.;\]]+$/g, '')
}

const getCurrentOrigin = () => {
  return typeof window === 'undefined' ? '' : window.location.origin
}

const hasExternalHttpSource = (sourceText: string) => {
  const currentOrigin = getCurrentOrigin()
  if (!currentOrigin) {
    return false
  }

  for (const match of sourceText.matchAll(HTTP_URL_PATTERN)) {
    try {
      const url = new URL(normalizeRuntimeUrl(match[0]))
      if (url.origin !== currentOrigin) {
        return true
      }
    } catch {
      // 忽略无法解析的异常片段，保留后续规则判断。
    }
  }

  return false
}

const pickResourceTargetUrl = (target: EventTarget | null) => {
  if (!target || !isRecord(target)) {
    return ''
  }

  return [
    normalizeRuntimeText(target.currentSrc),
    normalizeRuntimeText(target.src),
    normalizeRuntimeText(target.href),
    normalizeRuntimeText(target.data),
  ].find(Boolean) ?? ''
}

const isResourceLoadErrorEvent = (event: Event) => {
  const hasErrorEvent = typeof ErrorEvent !== 'undefined'
  if (hasErrorEvent && event instanceof ErrorEvent) {
    return false
  }

  return event.target !== globalThis.window
}

const getResourceLoadReason = (event: Event) => {
  const target = event.target
  const tagName = target && 'tagName' in target
    ? String((target as Element).tagName).toLowerCase()
    : 'resource'
  const resourceUrl = pickResourceTargetUrl(target)
  return resourceUrl ? `${tagName} 资源加载失败：${resourceUrl}` : `${tagName} 资源加载失败`
}

export const classifyRuntimeError = (value: unknown, extraSource = ''): RuntimeErrorClassification => {
  const sourceText = collectSourceText(value, extraSource)

  if (isUserCancelRuntimeError(value) || isAbortRuntimeError(value) || isRequestCanceled(value)) {
    return { category: 'ignore', reason: '用户取消或请求主动中止', value, sourceText }
  }

  if (isElementFormValidationPayload(value)) {
    return { category: 'ignore', reason: 'Element Plus 表单校验对象', value, sourceText }
  }

  if (isChunkStaleRuntimeError(value, extraSource)) {
    return { category: 'chunk-stale', reason: '前端资源版本已更新或动态分包加载失败', value, sourceText }
  }

  if (isExternalScriptRuntimeError(value, extraSource)) {
    return { category: 'ignore', reason: '浏览器扩展、用户脚本或第三方资源异常', value, sourceText }
  }

  return { category: 'app-error', reason: '应用运行时异常', value, sourceText }
}

export const classifyWindowErrorEvent = (event: ErrorEvent | Event): RuntimeErrorClassification => {
  if (isResourceLoadErrorEvent(event)) {
    const reason = getResourceLoadReason(event)
    return { category: 'ignore', reason, value: event, sourceText: reason }
  }

  const errorEvent = event as ErrorEvent
  return classifyRuntimeError(errorEvent.error || errorEvent.message, errorEvent.filename)
}
