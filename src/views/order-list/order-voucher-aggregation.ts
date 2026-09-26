/**
 * 模块说明：src/views/order-list/order-voucher-aggregation.ts
 * 文件职责：按商品归组正式出库单的只读展示数据，保留原始明细的规格、单价、备注和金额。
 * 实现逻辑：有有效 productId 时仅按商品归组；历史无商品身份的行独立展示，所有求和使用整数分。
 */

type VoucherPrimitive = string | number | null | undefined

export interface OrderVoucherSourceItem {
  id?: VoucherPrimitive
  productId?: VoucherPrimitive
  sourceOrderId?: VoucherPrimitive
  skuId?: VoucherPrimitive
  productName?: VoucherPrimitive
  specText?: VoucherPrimitive
  qty?: VoucherPrimitive
  unitPrice?: VoucherPrimitive
  subTotal?: VoucherPrimitive
  remark?: VoucherPrimitive
}

export interface OrderVoucherDetailItem {
  key: string
  sourceOrderId: string | null
  nameSnapshot: string
  showNameSnapshot: boolean
  specText: string | null
  qty: string
  unitPrice: string
  subTotal: string
  remark: string | null
}

export interface OrderVoucherDisplayItem {
  key: string
  productName: string
  qty: string
  subTotal: string
  details: OrderVoucherDetailItem[]
}

interface MutableVoucherSums {
  qtyCents: number
  subTotalCents: number
  invalidQty: boolean
  invalidSubTotal: boolean
}

interface MutableVoucherDetailItem extends MutableVoucherSums {
  key: string
  sourceOrderId: string | null
  nameSnapshot: string
  specText: string | null
  priceCents: number | null
  remark: string | null
}

interface MutableVoucherDisplayItem extends MutableVoucherSums {
  key: string
  names: Set<string>
  details: MutableVoucherDetailItem[]
  detailBySnapshot: Map<string, MutableVoucherDetailItem>
}

const PLACEHOLDER_TEXT_SET = new Set(['undefined', 'null', 'nan', '-'])
const normalizeDisplayText = (value: VoucherPrimitive): string => {
  const text = String(value ?? '').trim()
  return text && !PLACEHOLDER_TEXT_SET.has(text.toLowerCase()) ? text : ''
}

/** 数量和金额最多接收两位小数；非法历史值显示占位符，不参与不可信合计。 */
const parseCents = (value: VoucherPrimitive): number | null => {
  const text = normalizeDisplayText(value)
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) return null
  const cents = Number(`${match[1]}${(match[2] ?? '').padEnd(2, '0')}`)
  return Number.isSafeInteger(cents) ? cents : null
}

const formatCents = (value: number): string => String(value).padStart(3, '0').replace(/(..)$/, '.$1')
const formatQtyCents = (value: number): string => formatCents(value).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
const formatMoney = (value: number | null): string => value === null ? '—' : formatCents(value)

/** 只有商品名末尾与独立规格快照完全一致时才拆名；其它历史名称原样保留。 */
const getBaseProductName = (name: string, spec: string): string => {
  if (!spec) return name
  for (const suffix of [`（${spec}）`, `(${spec})`]) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length).trim() || name
  }
  return name
}

const addCents = (item: MutableVoucherSums, value: number | null, field: 'qtyCents' | 'subTotalCents', invalid: 'invalidQty' | 'invalidSubTotal') => {
  if (value === null || value > Number.MAX_SAFE_INTEGER - item[field]) {
    item[invalid] = true
  } else {
    item[field] += value
  }
}

export const aggregateOrderVoucherItems = (items: readonly OrderVoucherSourceItem[]): OrderVoucherDisplayItem[] => {
  const groups = new Map<string, MutableVoucherDisplayItem>()
  items.forEach((source, index) => {
    const productId = normalizeDisplayText(source.productId)
    const key = productId ? `product:${productId}` : `item:${normalizeDisplayText(source.id) || 'unknown'}:${index}`
    const group = groups.get(key) ?? {
      key,
      names: new Set<string>(),
      details: [],
      detailBySnapshot: new Map<string, MutableVoucherDetailItem>(),
      qtyCents: 0,
      subTotalCents: 0,
      invalidQty: false,
      invalidSubTotal: false,
    }
    const name = normalizeDisplayText(source.productName)
    const spec = normalizeDisplayText(source.specText)
    const baseName = getBaseProductName(name, spec)
    if (baseName) group.names.add(baseName)
    const qty = parseCents(source.qty)
    const price = parseCents(source.unitPrice)
    const amount = parseCents(source.subTotal)
    const remark = normalizeDisplayText(source.remark) || null
    const sourceOrderId = normalizeDisplayText(source.sourceOrderId) || null
    const snapshotKey = JSON.stringify([
      sourceOrderId, normalizeDisplayText(source.skuId), name, spec,
      price === null ? `invalid:${normalizeDisplayText(source.unitPrice)}` : price,
      remark,
    ])
    let detail = group.detailBySnapshot.get(snapshotKey)
    if (!detail) {
      detail = {
        key: `${key}:detail:${index}`,
        sourceOrderId,
        nameSnapshot: name || '未记录商品名称',
        specText: spec || null,
        priceCents: price,
        remark,
        qtyCents: 0,
        subTotalCents: 0,
        invalidQty: false,
        invalidSubTotal: false,
      }
      group.detailBySnapshot.set(snapshotKey, detail)
      group.details.push(detail)
    }
    addCents(detail, qty, 'qtyCents', 'invalidQty')
    addCents(detail, amount, 'subTotalCents', 'invalidSubTotal')
    addCents(group, qty, 'qtyCents', 'invalidQty')
    addCents(group, amount, 'subTotalCents', 'invalidSubTotal')
    groups.set(key, group)
  })
  return [...groups.values()].map((group) => ({
    key: group.key,
    productName: [...group.names].join(' / ') || '未记录商品名称',
    qty: group.invalidQty ? '—' : formatQtyCents(group.qtyCents),
    subTotal: group.invalidSubTotal ? '—' : formatCents(group.subTotalCents),
    details: group.details.map((detail) => ({
      key: detail.key,
      sourceOrderId: detail.sourceOrderId,
      nameSnapshot: detail.nameSnapshot,
      showNameSnapshot: group.names.size > 1,
      specText: detail.specText,
      qty: detail.invalidQty ? '—' : formatQtyCents(detail.qtyCents),
      unitPrice: formatMoney(detail.priceCents),
      subTotal: detail.invalidSubTotal ? '—' : formatCents(detail.subTotalCents),
      remark: detail.remark,
    })),
  }))
}
