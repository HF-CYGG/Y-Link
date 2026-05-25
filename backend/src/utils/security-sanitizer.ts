const FULL_REDACTED_TEXT = '[REDACTED]'
const PARTIAL_REDACTED_TEXT = '[MASKED]'

const SENSITIVE_KEY_PATTERN = /(password|passwd|pwd|captcha|verificationcode|verification_code|code|token|authorization|csrf|cookie|secret|session)/i
const CONTACT_KEY_PATTERN = /(mobile|phone|tel|email|mail)/i

const normalizeKey = (key: string) => key.replaceAll(/[\s_\-]/g, '').toLowerCase()

const isSensitiveKey = (key: string) => {
  return SENSITIVE_KEY_PATTERN.test(normalizeKey(key))
}

const isContactKey = (key: string) => {
  return CONTACT_KEY_PATTERN.test(normalizeKey(key))
}

export function maskPhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 7) {
    return PARTIAL_REDACTED_TEXT
  }
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

export function maskEmailAddress(value: string): string {
  const normalized = value.trim()
  const separatorIndex = normalized.indexOf('@')
  if (separatorIndex <= 1) {
    return PARTIAL_REDACTED_TEXT
  }
  return `${normalized.slice(0, 1)}***${normalized.slice(separatorIndex)}`
}

function looksLikePhoneNumber(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 20
}

function looksLikeEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function sanitizeScalarValue(value: unknown, keyHint?: string): unknown {
  if (typeof value !== 'string') {
    return value
  }

  if (keyHint && isSensitiveKey(keyHint)) {
    return FULL_REDACTED_TEXT
  }

  if (keyHint && isContactKey(keyHint)) {
    if (looksLikeEmailAddress(value)) {
      return maskEmailAddress(value)
    }
    if (looksLikePhoneNumber(value)) {
      return maskPhoneNumber(value)
    }
    return PARTIAL_REDACTED_TEXT
  }

  if (looksLikeEmailAddress(value)) {
    return maskEmailAddress(value)
  }

  if (looksLikePhoneNumber(value)) {
    return maskPhoneNumber(value)
  }

  return value
}

function sanitizeObjectLike(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[key] = sanitizeUnknown(value, key)
  }
  return result
}

export function sanitizeUnknown(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, keyHint))
  }

  if (typeof value === 'object') {
    return sanitizeObjectLike(value as Record<string, unknown>)
  }

  return sanitizeScalarValue(value, keyHint)
}

export function sanitizeAuditDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) {
    return null
  }
  return sanitizeObjectLike(detail)
}

export function sanitizeAuditTargetCode(targetCode: string | null | undefined): string | null {
  if (!targetCode) {
    return null
  }
  const sanitized = sanitizeScalarValue(targetCode)
  return typeof sanitized === 'string' ? sanitized : String(sanitized)
}

export function sanitizeLogPayload<T>(payload: T): T {
  return sanitizeUnknown(payload) as T
}
