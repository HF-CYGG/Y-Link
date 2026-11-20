/** 建单、追加规格与删除库位共用的盘点范围互斥键。 */
export const STOCKTAKE_SCOPE_MUTEX_KEY = 'inv_stocktake.scope_mutex'

const DECIMAL_LOCATION_ID = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/
const MAX_MYSQL_LOCATION_ID = 18_446_744_073_709_551_615n
const MAX_SQLITE_LOCATION_ID = 9_223_372_036_854_775_807n

/** 归一前导零、正号及等价小数/指数，保留无法精确解释的历史文本。 */
export function normalizeStocktakeLocationId(id: string): string {
  const text = id.trim()
  const match = DECIMAL_LOCATION_ID.exec(text)
  if (!match) return text
  const [, integer = '', fractional = '', fractionalOnly, exponent = '0'] = match
  const fraction = fractionalOnly ?? fractional
  const digits = (integer + fraction).replace(/^0+/, '')
  if (!digits) return '0'
  const shift = BigInt(exponent) - BigInt(fraction.length)
  if (shift >= 0n) {
    return BigInt(digits.length) + shift <= 20n ? digits + '0'.repeat(Number(shift)) : text
  }
  if (-shift >= BigInt(digits.length)) return text
  const wholeLength = digits.length + Number(shift)
  return /^0+$/.test(digits.slice(wholeLength)) ? digits.slice(0, wholeLength) : text
}

export function isCanonicalStocktakeLocationId(id: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(id)
}

export function isInStocktakeLocationIdRange(id: string, mysql: boolean): boolean {
  return isCanonicalStocktakeLocationId(id) && id.length <= 20
    && BigInt(id) <= (mysql ? MAX_MYSQL_LOCATION_ID : MAX_SQLITE_LOCATION_ID)
}

/** 仅读取结构化的库位 ID 数组，兼容存量 JSON 中的字符串与数字表示。 */
export function readStocktakeLocationIds(scopeJson: string): string[] {
  try {
    // Node 22 可提供数字的原始 JSON 文本，避免读入 BIGINT 时先舍入成双精度数。
    const scope = JSON.parse(scopeJson, (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' ? context?.source ?? (Number.isSafeInteger(value) ? String(value) : null) : value,
    ) as { locationIds?: unknown } | null
    if (!Array.isArray(scope?.locationIds)) return []
    const ids = scope.locationIds
      .filter((id): id is string => typeof id === 'string')
      .map(normalizeStocktakeLocationId)
      .filter(Boolean)
    return [...new Set(ids)]
  } catch {
    return []
  }
}
