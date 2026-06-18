import { showAppError, showAppWarning } from '@/utils/app-alert'
import type { RuntimeErrorClassification } from '@/utils/runtime-error-guard'

const RUNTIME_ALERT_DEDUP_MS = 30_000
const CHUNK_STALE_MESSAGE = '页面资源已更新，请刷新当前页面后继续操作'
const APP_RUNTIME_ERROR_MESSAGE = '页面遇到异常，请刷新后重试'

const latestRuntimeAlertAt = new Map<string, number>()

const showRuntimeAlertOnce = (key: string, notify: () => void) => {
  const now = Date.now()
  const latestAt = latestRuntimeAlertAt.get(key) ?? 0
  if (now - latestAt < RUNTIME_ALERT_DEDUP_MS) {
    return
  }

  latestRuntimeAlertAt.set(key, now)
  notify()
}

const buildLogPayload = (scope: string, classification: RuntimeErrorClassification) => {
  return {
    scope,
    category: classification.category,
    reason: classification.reason,
    sourceText: classification.sourceText,
  }
}

export const reportRuntimeError = (
  scope: string,
  classification: RuntimeErrorClassification,
  detail?: unknown,
) => {
  const logPayload = buildLogPayload(scope, classification)
  const logDetail = detail ?? classification.value

  if (classification.category === 'ignore') {
    console.debug('[runtime-ignore]', logPayload, logDetail)
    return
  }

  if (classification.category === 'chunk-stale') {
    console.warn('[runtime-chunk-stale]', logPayload, logDetail)
    showRuntimeAlertOnce('chunk-stale', () => showAppWarning(CHUNK_STALE_MESSAGE))
    return
  }

  console.error('[runtime-error]', logPayload, logDetail)
  showRuntimeAlertOnce('app-error', () => showAppError(APP_RUNTIME_ERROR_MESSAGE))
}
