/**
 * 模块说明：src/views/order-list/order-voucher-aggregation.ts
 * 文件职责：为正式出库单生成只读展示聚合行，不改变订单明细、库存、核销、删除恢复或审计的 SKU 粒度。
 * 实现逻辑：
 * - 仅以有效 productId 作为商品合并键；缺失身份的历史行逐条保留，避免同名或空身份数据被错误合并；
 * - 规格仍嵌在历史商品名快照中，因此合并时保留各完整快照，不截断或剥除括号文本；
 * - 数量和小计分别按原始字段的两位小数相加，单价只在全部原始行一致时展示，绝不由数量反推单价。
 */

type VoucherPrimitive = string | number | null | undefined

export interface OrderVoucherSourceItem {
  id?: VoucherPrimitive
  productId?: VoucherPrimitive
  productName?: VoucherPrimitive
  qty?: VoucherPrimitive
  unitPrice?: VoucherPrimitive
  subTotal?: VoucherPrimitive
  remark?: VoucherPrimitive
}

export interface OrderVoucherDisplayItem {
  key: string
  productName: string
  qty: string
  unitPrice: string
  subTotal: string
  remark: string | null
}

interface MutableVoucherDisplayItem {
  key: string
  names: Set<string>
  remarks: Set<string>
  qtyCents: number
  subTotalCents: number
  priceCents: number | null
  multiplePrices: boolean
  invalidQty: boolean
  invalidSubTotal: boolean
  invalidPrice: boolean
}

const PLACEHOLDER_TEXT_SET = new Set(['undefined', 'null', 'nan', '-'])
const DECIMAL_SCALE = 2

const normalizeDisplayText = (value: VoucherPrimitive): string => {
  const normalizedValue = String(value ?? '').trim()
  return normalizedValue && !PLACEHOLDER_TEXT_SET.has(normalizedValue.toLowerCase()) ? normalizedValue : ''
}

/**
 * 将两位小数字段转换成整数单位再求和，避免 0.1 + 0.2 这类浮点展示误差。
 * 非法、负数或超出安全整数范围的历史值返回 null，交由展示层显式标记为“—”。
 */
const parseDecimalToCents = (value: VoucherPrimitive): number | null => {
  const normalizedValue = normalizeDisplayText(value)
  const matchedValue = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(normalizedValue)
  if (!matchedValue) {
    return null
  }

  const integerPart = matchedValue[1]
  const fractionalPart = (matchedValue[2] ?? '').padEnd(DECIMAL_SCALE, '0')
  const cents = Number(`${integerPart}${fractionalPart}`)
  return Number.isSafeInteger(cents) ? cents : null
}

/**
 * 不通过浮点除法格式化整数分值，避免接近 Number.MAX_SAFE_INTEGER 时最后一分被二进制浮点舍入。
 */
const formatCents = (value: number): string => {
  return String(value).padStart(DECIMAL_SCALE + 1, '0').replace(/(..)$/, '.$1')
}

const createMutableItem = (key: string): MutableVoucherDisplayItem => ({
  key,
  names: new Set<string>(),
  remarks: new Set<string>(),
  qtyCents: 0,
  subTotalCents: 0,
  priceCents: null,
  multiplePrices: false,
  invalidQty: false,
  invalidSubTotal: false,
  invalidPrice: false,
})

const appendDistinctText = (items: Set<string>, value: string) => {
  if (value) {
    items.add(value)
  }
}

const appendSum = (
  item: MutableVoucherDisplayItem,
  value: VoucherPrimitive,
  sumField: 'qtyCents' | 'subTotalCents',
  invalidField: 'invalidQty' | 'invalidSubTotal',
) => {
  const parsedValue = parseDecimalToCents(value)
  if (parsedValue === null || parsedValue > Number.MAX_SAFE_INTEGER - item[sumField]) {
    item[invalidField] = true
    return
  }
  item[sumField] += parsedValue
}

const appendUnitPrice = (item: MutableVoucherDisplayItem, value: VoucherPrimitive) => {
  const parsedValue = parseDecimalToCents(value)
  if (parsedValue === null) {
    item.invalidPrice = true
  } else if (item.priceCents === null) {
    item.priceCents = parsedValue
  } else if (item.priceCents !== parsedValue) {
    item.multiplePrices = true
  }
}

/**
 * 聚合正式出库单的展示行：
 * - 有效 productId 只生成一个产品行；
 * - 缺 productId 的行使用原始行索引形成独立键，避免历史脏数据误合并；
 * - 同组商品名与备注均保留各个不同的完整历史文本。
 */
export const aggregateOrderVoucherItems = (items: readonly OrderVoucherSourceItem[]): OrderVoucherDisplayItem[] => {
  const aggregatedItems = new Map<string, MutableVoucherDisplayItem>()

  items.forEach((sourceItem, index) => {
    const productId = normalizeDisplayText(sourceItem.productId)
    const sourceId = normalizeDisplayText(sourceItem.id)
    const key = productId ? `product:${productId}` : `item:${sourceId || 'unknown'}:${index}`
    const targetItem = aggregatedItems.get(key) ?? createMutableItem(key)

    appendDistinctText(targetItem.names, normalizeDisplayText(sourceItem.productName))
    appendDistinctText(targetItem.remarks, normalizeDisplayText(sourceItem.remark))
    appendSum(targetItem, sourceItem.qty, 'qtyCents', 'invalidQty')
    appendSum(targetItem, sourceItem.subTotal, 'subTotalCents', 'invalidSubTotal')
    appendUnitPrice(targetItem, sourceItem.unitPrice)
    aggregatedItems.set(key, targetItem)
  })

  return [...aggregatedItems.values()].map((item) => {
    const unitPrice = item.invalidPrice || item.priceCents === null
      ? '—'
      : item.multiplePrices
        ? '多价'
        : formatCents(item.priceCents)

    return {
      key: item.key,
      productName: [...item.names].join(' / ') || '未记录商品名称',
      qty: item.invalidQty ? '—' : formatCents(item.qtyCents),
      unitPrice,
      subTotal: item.invalidSubTotal ? '—' : formatCents(item.subTotalCents),
      remark: [...item.remarks].join('；') || null,
    }
  })
}
