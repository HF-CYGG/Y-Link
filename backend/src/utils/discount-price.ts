/**
 * 模块说明：backend/src/utils/discount-price.ts
 * 文件职责：统一计算商品折扣、折后价和 O2O 订单行金额快照。
 * 实现逻辑：
 * - 折扣按“几折”口径存储，范围为 1.0 到 10.0，保留一位小数；
 * - 金额先转换为分再做整数运算，减少浮点误差对订单金额的影响；
 * - 订单行快照同时保留原价、折扣、折后单价和行金额，保证历史订单不受商品改价影响。
 * 维护说明：
 * - 前后端折扣展示规则必须保持一致，调整这里时需要同步 `src/utils/o2o-price.ts`；
 * - 10 折是默认原价口径，但仍会写入快照，方便历史数据统一回查。
 */

export interface DiscountPriceSnapshot {
  originalPrice: string
  discountRate: string
  unitPrice: string
  lineAmount: string
}

const DISCOUNT_RATE_MIN_TENTHS = 10
const DISCOUNT_RATE_MAX_TENTHS = 100

export const formatMoneyFromCents = (cents: number) => {
  const normalizedCents = Number.isFinite(cents) ? Math.round(cents) : 0
  const sign = normalizedCents < 0 ? '-' : ''
  const absoluteCents = Math.abs(normalizedCents)
  const integerPart = Math.floor(absoluteCents / 100)
  const decimalPart = String(absoluteCents % 100).padStart(2, '0')
  return `${sign}${integerPart}.${decimalPart}`
}

export const parseMoneyToCents = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === '') {
    return 0
  }
  const raw = String(value).trim()
  const matched = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw)
  if (!matched) {
    return 0
  }
  const sign = matched[1] === '-' ? -1 : 1
  const integerPart = Number(matched[2] ?? '0')
  const decimalPart = (matched[3] ?? '').padEnd(2, '0')
  return sign * (integerPart * 100 + Number(decimalPart))
}

export const normalizeDiscountRate = (value: string | number | null | undefined, fallback = '10.0') => {
  const raw = value === null || value === undefined || value === '' ? fallback : String(value).trim()
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  const tenths = Math.min(DISCOUNT_RATE_MAX_TENTHS, Math.max(DISCOUNT_RATE_MIN_TENTHS, Math.round(parsed * 10)))
  return (tenths / 10).toFixed(1)
}

export const assertDiscountRateInRange = (value: string | number | null | undefined, label = '折扣') => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label}必须为数字`)
  }
  const tenths = Math.round(parsed * 10)
  if (Math.abs(parsed * 10 - tenths) > 0.000001) {
    throw new Error(`${label}最多保留一位小数`)
  }
  if (tenths < DISCOUNT_RATE_MIN_TENTHS || tenths > DISCOUNT_RATE_MAX_TENTHS) {
    throw new Error(`${label}必须在 1.0 到 10.0 之间`)
  }
  return (tenths / 10).toFixed(1)
}

export const calculateDiscountedPrice = (
  originalPrice: string | number | null | undefined,
  discountRate: string | number | null | undefined,
) => {
  const originalCents = Math.max(0, parseMoneyToCents(originalPrice))
  const discountTenths = Math.round(Number(normalizeDiscountRate(discountRate)) * 10)
  return formatMoneyFromCents(Math.round((originalCents * discountTenths) / 100))
}

export const buildDiscountPriceSnapshot = (
  originalPrice: string | number | null | undefined,
  discountRate: string | number | null | undefined,
  qty: string | number | null | undefined,
): DiscountPriceSnapshot => {
  const originalPriceText = formatMoneyFromCents(Math.max(0, parseMoneyToCents(originalPrice)))
  const discountRateText = normalizeDiscountRate(discountRate)
  const unitPriceText = calculateDiscountedPrice(originalPriceText, discountRateText)
  const normalizedQty = Math.max(0, Math.floor(Number(qty ?? 0)))
  const lineAmount = formatMoneyFromCents(parseMoneyToCents(unitPriceText) * normalizedQty)
  return {
    originalPrice: originalPriceText,
    discountRate: discountRateText,
    unitPrice: unitPriceText,
    lineAmount,
  }
}
