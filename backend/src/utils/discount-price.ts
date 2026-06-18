/**
 * 模块说明：backend/src/utils/discount-price.ts
 * 文件职责：统一商品折扣与折后价计算口径，避免商品、订单和出库单金额各自重算。
 * 实现逻辑：价格按“分”做整数计算，折扣按“几折 * 100”保存精度，最终四舍五入到两位小数。
 * 维护说明：若后续调整折扣精度或取整方式，必须同步核对商品接口、预订单明细和正式出库单金额。
 */

export const DEFAULT_DISCOUNT_RATE = 10
export const DISCOUNT_RATE_MIN = 0.01
export const DISCOUNT_RATE_MAX = 10

export const normalizeDecimalText = (value: string | number | null | undefined, fallback = '0.00'): string => {
  if (value === null || value === undefined || value === '') {
    return fallback
  }

  const normalizedNumber = Number(value)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : fallback
}

export const parseMoneyToCents = (value: string | number | null | undefined): number => {
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

export const formatCentsToMoney = (cents: number): string => {
  const sign = cents < 0 ? '-' : ''
  const absoluteCents = Math.abs(cents)
  const integerPart = Math.floor(absoluteCents / 100)
  const decimalPart = String(absoluteCents % 100).padStart(2, '0')
  return `${sign}${integerPart}.${decimalPart}`
}

export const normalizeDiscountRate = (
  value: string | number | null | undefined,
  fallback = DEFAULT_DISCOUNT_RATE,
): number => {
  if (value === null || value === undefined || value === '') {
    return fallback
  }
  const normalizedNumber = Number(value)
  if (!Number.isFinite(normalizedNumber)) {
    return fallback
  }
  return normalizedNumber
}

export const calculateDiscountedPriceText = (
  originalPrice: string | number | null | undefined,
  discountRate: string | number | null | undefined,
): string => {
  const originalPriceCents = Math.max(0, parseMoneyToCents(originalPrice))
  const discountRateBasis = Math.round(normalizeDiscountRate(discountRate) * 100)
  const discountedCents = Math.round((originalPriceCents * discountRateBasis) / 1000)
  return formatCentsToMoney(discountedCents)
}
