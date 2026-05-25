/**
 * 模块说明：backend/src/utils/security-sanitizer.ts
 * 文件职责：提供审计明细与日志载荷的统一脱敏工具，阻断密码、令牌、手机号、邮箱等敏感信息外泄。
 * 实现逻辑：
 * - 先按 key 命中敏感字段规则，敏感凭证直接全量替换；
 * - 联系方式字段按邮箱/手机号格式做部分掩码；
 * - 对数组和对象递归遍历，确保嵌套结构也会被清洗。
 * 维护说明：新增敏感字段时应优先扩展 key 规则，而不是在业务代码里手写脱敏分支。
 */

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

// 审计 detail 专用入口：统一返回对象或 null，便于直接写入 JSON 字段。
export function sanitizeAuditDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) {
    return null
  }
  return sanitizeObjectLike(detail)
}

// 审计 targetCode 也可能携带手机号/邮箱，写库前同样做脱敏兜底。
export function sanitizeAuditTargetCode(targetCode: string | null | undefined): string | null {
  if (!targetCode) {
    return null
  }
  const sanitized = sanitizeScalarValue(targetCode)
  return typeof sanitized === 'string' ? sanitized : String(sanitized)
}

// 日志场景的泛型入口：保持原始类型签名，便于在调用点无缝替换。
export function sanitizeLogPayload<T>(payload: T): T {
  return sanitizeUnknown(payload) as T
}
