/**
 * 模块说明：src/views/order-entry/composables/prepare-order-submission.ts
 * 文件职责：仅在用户提交出库单时校验录入态，并构建同一时刻的整单请求载荷。
 * 实现逻辑：保留原有校验顺序、按 SKU 汇总的可用库存预检及单规格行回填；不生成幂等键，也不发起网络请求。
 * 维护说明：此模块由开单 composable 按需加载，业务提示和载荷字段变更须同步核对服务端出库事务。
 */

import type { SubmitOrderPayload } from '@/api/modules/order'
import type { ProductRecord, ProductSkuRecord } from '@/api/modules/product'
import { getSelectableProductSkus, getSkuAvailableStock, type OrderHeaderForm, type OrderItemRow } from '../types'

type SubmissionPayload = Omit<SubmitOrderPayload, 'idempotencyKey'>
type PreparationResult = { error: string; payload?: never } | { error?: never; payload: SubmissionPayload }

const normalizeNumber = (value: number | string | null | undefined): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const normalizeTextValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export const prepareOrderSubmission = (
  headerForm: OrderHeaderForm,
  itemRows: OrderItemRow[],
  products: ProductRecord[],
): PreparationResult => {
  // 调用方在异步模块加载结束后才传入当前状态；以下过程不包含 await，避免混用不同编辑时刻的字段。
  const productMap = new Map(products.map((product) => [product.id, product]))
  const getSelectableSkus = (productId: string): ProductSkuRecord[] => getSelectableProductSkus(productMap.get(productId))
  const getProductLabelById = (productId: string): string => {
    const product = productMap.get(productId)
    if (product) return product.productName
    return `不可用商品：${productId}`
  }

  if (itemRows.some((row) => {
    if (!normalizeTextValue(row.productId)) return false
    const qty = normalizeNumber(row.qty)
    return !Number.isSafeInteger(qty) || qty <= 0
  })) return { error: '数量必须为正整数' }

  const rows = itemRows.filter((row) => normalizeTextValue(row.productId) && normalizeNumber(row.qty) > 0)
  if (!rows.length) {
    return { error: '请至少录入一条有效明细（已选择产品且数量大于 0）' }
  }

  if (rows.some((row) => !productMap.has(normalizeTextValue(row.productId)))) {
    return { error: '存在未建档、已停用或暂无可用规格的商品，请重新选择' }
  }

  const invalidSkuRow = rows.find((row) => productMap.has(row.productId)
    && !getSelectableSkus(row.productId).some((sku) => sku.id === row.skuId))
  if (invalidSkuRow) {
    const candidates = getSelectableSkus(invalidSkuRow.productId)
    return { error: candidates.length > 1 ? '存在多规格商品尚未选择规格' : '存在商品暂无当前启用规格' }
  }

  if (rows.some((row) => normalizeNumber(row.unitPrice) <= 0)) {
    return { error: '存在单价小于等于 0 的明细，请先修正后再保存' }
  }
  if (!headerForm.issuerName.trim()) return { error: '请填写出单人' }
  if (headerForm.orderType === 'department' && !headerForm.customerDepartmentName.trim()) {
    return { error: '部门单必须填写客户部门' }
  }
  if (headerForm.customerDepartmentName.trim().length > 271) {
    return { error: '客户部门名称不能超过 271 个字符' }
  }

  const requiredBySku = new Map<string, { productId: string; qty: number }>()
  for (const row of itemRows) {
    const qty = normalizeNumber(row.qty)
    if (!row.productId || !row.skuId || qty <= 0) continue
    const current = requiredBySku.get(row.skuId)
    requiredBySku.set(row.skuId, { productId: row.productId, qty: (current?.qty ?? 0) + qty })
  }
  for (const [skuId, required] of requiredBySku) {
    const sku = getSelectableSkus(required.productId).find((item) => item.id === skuId)
    const available = getSkuAvailableStock(sku)
    if (available !== null && required.qty > available) {
      return { error: `商品“${getProductLabelById(required.productId)}”规格“${sku?.specText || '默认规格'}”可用库存 ${available}，本单需要 ${required.qty}，请调整数量` }
    }
  }

  const items: SubmitOrderPayload['items'] = []
  for (const row of rows) {
    // 同步前置校验已检查数量和建档状态；这里保留单规格回填与 SKU 最终解析。
    const resolvedProductId = normalizeTextValue(row.productId)
    const candidates = getSelectableSkus(resolvedProductId)
    let selectedSku = candidates.find((sku) => sku.id === row.skuId)
    if (!selectedSku && candidates.length === 1) {
      selectedSku = candidates[0]
      row.skuId = selectedSku?.id ?? ''
    }
    if (!selectedSku) {
      if (candidates.length > 1) {
        throw new Error(`商品“${getProductLabelById(resolvedProductId)}”为多规格商品，请选择规格`)
      }
      throw new Error(`商品“${getProductLabelById(resolvedProductId)}”暂无当前启用规格`)
    }
    items.push({
      productId: resolvedProductId,
      skuId: selectedSku.id,
      qty: normalizeNumber(row.qty),
      unitPrice: normalizeNumber(row.unitPrice),
      remark: row.remark.trim() || undefined,
    })
  }

  const isDepartmentOrder = headerForm.orderType === 'department'
  return {
    payload: {
      orderType: headerForm.orderType,
      hasCustomerOrder: isDepartmentOrder ? headerForm.hasCustomerOrder : false,
      isSystemApplied: isDepartmentOrder ? headerForm.isSystemApplied : false,
      issuerName: headerForm.issuerName.trim(),
      customerDepartmentName: isDepartmentOrder ? headerForm.customerDepartmentName.trim() || undefined : undefined,
      customerDepartmentNodeId: isDepartmentOrder ? headerForm.customerDepartmentNodeId || undefined : undefined,
      customerName: headerForm.customerName.trim() || undefined,
      remark: headerForm.remark.trim() || undefined,
      items,
    },
  }
}
