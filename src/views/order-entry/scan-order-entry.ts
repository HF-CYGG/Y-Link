/**
 * 出库开单扫码入单规则：只接受当前加载的启用商品和当前启用规格，避免扫码服务的历史命中绕过开单候选。
 * 同 SKU 多行时只复用唯一普通默认价行，保留人工价格与备注的独立语义。
 */
import type { ProductLookupResult } from '@/api/modules/inventory'
import type { ProductRecord } from '@/api/modules/product'
import { getSelectableProductSkus, type OrderItemRow } from './types'

export interface ScanOrderRowsResult {
  rows: OrderItemRow[] | null
  rowUid: string | null
  qty: number | null
  productName: string | null
  error: string | null
}

const rejected = (error: string): ScanOrderRowsResult => ({ rows: null, rowUid: null, qty: null, productName: null, error })

export function addScannedSkuToOrderRows(
  rows: OrderItemRow[],
  products: ProductRecord[],
  lookup: ProductLookupResult,
  createUid: () => string,
): ScanOrderRowsResult {
  if (!lookup.product.isActive) return rejected(`商品“${lookup.product.productName}”已停用，不能扫码入单`)
  if (!lookup.sku.isCurrent) return rejected('扫码规格已退役，不能入单')
  if (!lookup.sku.isActive) return rejected('扫码规格已停用，不能入单')

  const product = products.find((item) => item.id === lookup.product.id && item.isActive === true)
  const sku = getSelectableProductSkus(product).find((item) => item.id === lookup.sku.id)
  if (!product || !sku) return rejected('条码对应商品或规格不在当前可选候选中，请刷新商品资料后重试')

  const defaultPrice = Number(sku.defaultPrice)
  const price = Number.isFinite(defaultPrice) ? defaultPrice : 0
  const matches = rows.filter((row) => row.productId === product.id && row.skuId === sku.id)
  const ordinary = matches.filter((row) => row.unitPrice === price && row.remark === '')
  const target = matches.length === 1 ? matches[0] : ordinary.length === 1 ? ordinary[0] : undefined
  if (target) {
    const previousQty = target.qty ?? 0
    if (!Number.isSafeInteger(previousQty) || previousQty < 0 || !Number.isSafeInteger(previousQty + 1)) {
      return rejected('现有明细数量无效或超过上限，请先修正')
    }
    return {
      rows: rows.map((row) => row.uid === target.uid ? { ...row, qty: previousQty + 1 } : row),
      rowUid: target.uid,
      qty: previousQty + 1,
      productName: product.productName,
      error: null,
    }
  }

  const blank = rows.find((row) => row.productId === '' && row.skuId === '' && row.qty === null && row.unitPrice === null && row.remark === '')
  const rowUid = blank?.uid ?? createUid()
  const scannedRow: OrderItemRow = {
    uid: rowUid, productId: product.id, skuId: sku.id ?? '', qty: 1, unitPrice: price, remark: '',
  }
  return {
    rows: blank ? rows.map((row) => row.uid === rowUid ? scannedRow : row) : [...rows, scannedRow],
    rowUid,
    qty: 1,
    productName: product.productName,
    error: null,
  }
}
