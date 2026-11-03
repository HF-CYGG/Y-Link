import dayjs from 'dayjs'

type Snapshot = Record<string, unknown> | null | undefined

const numberValue = (value: unknown): number | null => {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

const textValue = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

export const revisionActor = (display: unknown, username: unknown) => textValue(display) || textValue(username) || '未记录'
export const revisionTime = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return '未记录时间'
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):?(\d{2}))?)?$/.exec(value)
  if (!parts) return '未记录时间'
  const [, year, month, day, hour = '0', minute = '0', second = '0', , offsetHour = '0', offsetMinute = '0'] = parts
  const yearNumber = Number(year)
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  const leap = yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > (days[monthNumber - 1] ?? 0)
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || Number(offsetHour) > 23 || Number(offsetMinute) > 59) return '未记录时间'
  const date = dayjs(value)
  return date.isValid() ? date.format('YYYY-MM-DD HH:mm:ss') : '未记录时间'
}

// 仅比较已保存的业务明细字段，忽略技术字段与未知字段。
const normalizedItems = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null
  const rows: unknown[][] = []
  for (const raw of value) {
    const item = objectValue(raw)
    if (!item) return null
    const qty = numberValue(item.qty)
    const price = numberValue(item.unitPrice)
    const amount = numberValue(item.lineAmount)
    if (qty === null || price === null || amount === null) return null
    rows.push([item.productId ?? null, item.productNameSnapshot ?? null, item.skuId ?? null,
      item.skuCodeSnapshot ?? null, item.specTextSnapshot ?? null, qty, price, amount, item.remark ?? null])
  }
  return JSON.stringify(rows)
}

export const revisionSummary = (beforeValue: Snapshot, afterValue: Snapshot): string[] => {
  const before = objectValue(beforeValue)
  const after = objectValue(afterValue)
  if (!before || !after) return ['历史快照不完整，修改前或修改后未记录']
  const lines: string[] = []
  let incomplete = false
  const compare = (label: string, left: string | number | null, right: string | number | null, render: (value: string | number) => string = String) => {
    if (left === null || right === null) { incomplete = true; return }
    if (left !== right) lines.push(`${label}：${render(left)} → ${render(right)}`)
  }
  compare('业务单号', textValue(before.businessNo), textValue(after.businessNo))
  compare('总数量', numberValue(before.totalQty), numberValue(after.totalQty))
  compare('合计金额', numberValue(before.totalAmount), numberValue(after.totalAmount), value => `¥${Number(value).toFixed(2)}`)
  const beforeItems = normalizedItems(before.items)
  const afterItems = normalizedItems(after.items)
  if (beforeItems === null || afterItems === null) incomplete = true
  else {
    compare('明细行数', (before.items as unknown[]).length, (after.items as unknown[]).length, value => `${value} 行`)
    if (beforeItems !== afterItems) lines.push('商品明细有调整')
  }
  if (incomplete) lines.push('历史快照不完整，部分内容未记录或无效')
  if (!lines.length) lines.push('已记录的业务摘要未显示变化')
  return lines
}
