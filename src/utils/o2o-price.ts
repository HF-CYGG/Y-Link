/**
 * 模块说明：src/utils/o2o-price.ts
 * 文件职责：统一前端 O2O 商品折扣、折后价和展示文案的计算规则。
 * 实现逻辑：
 * - 折扣按 1.0 到 10.0 折处理，缺省或非法值统一视为 10 折；
 * - 金额以分为单位做整数运算，减少浮点误差对购物车、结算页和订单详情的影响；
 * - 10 折只展示当前价，非 10 折展示折后价、原价和折扣文案。
 * 维护说明：
 * - 后端同名规则位于 backend/src/utils/discount-price.ts，调整折扣口径时必须同步两端；
 * - 历史缓存可能没有折扣字段，调用方应保留 10 折兼容默认值。
 */

export interface O2oPriceSource {
  defaultPrice?: string | number | null
  originalPrice?: string | number | null
  discountRate?: string | number | null
  discountedPrice?: string | number | null
  unitPrice?: string | number | null
}

export interface O2oPriceView {
  originalPrice: string
  discountRate: string
  discountedPrice: string
  unitPrice: string
  isDiscounted: boolean
  discountLabel: string
}

export const parsePriceToCents = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined || value === '') return 0
  const matched = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim())
  if (!matched) return 0
  return Number(matched[1]) * 100 + Number((matched[2] ?? '').padEnd(2, '0'))
}

export const formatCentsToPrice = (cents: number): string => {
  const normalized = Math.max(0, Math.round(Number.isFinite(cents) ? cents : 0))
  return `${Math.floor(normalized / 100)}.${String(normalized % 100).padStart(2, '0')}`
}

export const normalizeDiscountRateText = (value: string | number | null | undefined): string => {
  const parsed = Number(value ?? 10)
  if (!Number.isFinite(parsed)) return '10.0'
  return (Math.round(Math.min(10, Math.max(1, parsed)) * 10) / 10).toFixed(1)
}

export const calculateDiscountedPriceText = (
  originalPrice: string | number | null | undefined,
  discountRate: string | number | null | undefined,
): string => {
  const originalCents = parsePriceToCents(originalPrice)
  const discountTenths = Math.round(Number(normalizeDiscountRateText(discountRate)) * 10)
  return formatCentsToPrice(Math.round((originalCents * discountTenths) / 100))
}

export const resolveO2oPriceView = (source: O2oPriceSource): O2oPriceView => {
  const originalPrice = formatCentsToPrice(parsePriceToCents(source.originalPrice ?? source.defaultPrice))
  const discountRate = normalizeDiscountRateText(source.discountRate)
  const discountedPrice = formatCentsToPrice(
    parsePriceToCents(source.discountedPrice ?? source.unitPrice)
    || parsePriceToCents(calculateDiscountedPriceText(originalPrice, discountRate)),
  )
  const isDiscounted = Number(discountRate) < 10
  return {
    originalPrice,
    discountRate,
    discountedPrice,
    unitPrice: discountedPrice,
    isDiscounted,
    discountLabel: `${discountRate.replace(/\.0$/, '')}折`,
  }
}
