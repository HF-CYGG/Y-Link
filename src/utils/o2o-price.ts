/**
 * 模块说明：src/utils/o2o-price.ts
 * 文件职责：统一客户端 O2O 价格展示与折扣金额计算口径。
 * 实现逻辑：优先使用后端返回的折后价快照，缺失时按原价和折扣兜底计算，保证旧缓存仍能正常展示。
 * 维护说明：若后端折扣精度或取整规则调整，需同步核对本文件和后端 `discount-price` 工具。
 */

export interface O2oPriceLike {
  defaultPrice?: string | number | null
  originalPrice?: string | number | null
  discountRate?: string | number | null
  discountedPrice?: string | number | null
  unitPrice?: string | number | null
  lineAmount?: string | number | null
  subTotal?: string | number | null
  qty?: string | number | null
}

export const toMoneyNumber = (value: string | number | null | undefined) => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber : 0
}

export const formatMoney = (value: string | number | null | undefined) => {
  return toMoneyNumber(value).toFixed(2)
}

export const formatDiscountRate = (value: string | number | null | undefined) => {
  const normalizedNumber = Number(value ?? 10)
  if (!Number.isFinite(normalizedNumber)) {
    return '10折'
  }
  return `${Number(normalizedNumber.toFixed(2)).toString()}折`
}

export const resolveOriginalPrice = (item: O2oPriceLike) => {
  return formatMoney(item.originalPrice ?? item.defaultPrice ?? 0)
}

export const resolveDiscountedUnitPrice = (item: O2oPriceLike) => {
  const directPrice = item.unitPrice ?? item.discountedPrice
  if (directPrice !== undefined && directPrice !== null && directPrice !== '') {
    return formatMoney(directPrice)
  }
  const originalPrice = toMoneyNumber(item.originalPrice ?? item.defaultPrice)
  const discountRate = Number(item.discountRate ?? 10)
  const normalizedRate = Number.isFinite(discountRate) ? discountRate : 10
  return formatMoney((originalPrice * normalizedRate) / 10)
}

export const resolveLineAmount = (item: O2oPriceLike) => {
  const directAmount = item.lineAmount ?? item.subTotal
  if (directAmount !== undefined && directAmount !== null && directAmount !== '') {
    return formatMoney(directAmount)
  }
  return formatMoney(toMoneyNumber(resolveDiscountedUnitPrice(item)) * Math.max(0, Number(item.qty ?? 0)))
}

export const isDiscountedPrice = (item: O2oPriceLike) => {
  return toMoneyNumber(resolveDiscountedUnitPrice(item)) < toMoneyNumber(resolveOriginalPrice(item))
}
