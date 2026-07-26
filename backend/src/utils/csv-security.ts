/** 中和导出到电子表格的公式载荷，同时保留正常文本。 */
export function normalizeCsvCell(value: unknown): string {
  const cleaned = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  return /^\s*[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned
}

export function escapeCsvCell(value: unknown): string {
  return `"${normalizeCsvCell(value).replaceAll('"', '""')}"`
}
