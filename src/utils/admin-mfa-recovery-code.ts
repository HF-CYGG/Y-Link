/** 管理端恢复码输入只接受一次粘贴一条；批量备份内容不能被单行输入框静默截断。 */
const RECOVERY_CODE_CHARS = /^[2-9A-HJ-NP-Z]+$/u
const RECOVERY_CODE_CANDIDATE = /(?:[2-9A-HJ-NP-Z]{4}-){2}[2-9A-HJ-NP-Z]{4}|[2-9A-HJ-NP-Z]{12}/gu

export const containsMultipleRecoveryCodes = (text: string): boolean => {
  const upper = text.toUpperCase()
  // 兼容单条码中的分组空格或换行；两条完整码连续粘贴时才阻止。
  const compact = upper.replace(/[\s,;，；-]/gu, '')
  if (compact.length >= 24 && compact.length % 12 === 0 && RECOVERY_CODE_CHARS.test(compact)) return true
  return (upper.match(RECOVERY_CODE_CANDIDATE)?.length ?? 0) >= 2
}

export const guardRecoveryCodePaste = (event: ClipboardEvent, warn: (message: string) => void): void => {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!containsMultipleRecoveryCodes(text)) return
  event.preventDefault()
  warn('一次只能输入一个恢复码，请从备份中单独复制一条')
}
