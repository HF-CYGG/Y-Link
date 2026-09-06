/** 仅接受无控制字符、无反斜杠的站内绝对路径，避免 URL 规范化绕过回跳校验。 */
export const resolveSafeLocalRedirect = (value: unknown): string | null => {
  if (typeof value !== 'string' || /[\\\u0000-\u001F\u007F]/.test(value)) {
    return null
  }
  const normalized = value.trim()
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    return null
  }
  return normalized
}
