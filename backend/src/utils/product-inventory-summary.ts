/**
 * 商品库存读取口径：只聚合仍属于当前规格矩阵且启用的 SKU；若不存在当前 SKU，回退商品主表。
 * 该函数无状态且不访问数据库，供商品视图与库存报表共享，避免两个出口再次出现数值分叉。
 */

export interface ProductInventoryValueSource {
  currentStock?: unknown
  preOrderedStock?: unknown
}

export interface ProductInventorySkuSource extends ProductInventoryValueSource {
  isActive?: unknown
  isCurrent?: unknown
}

export interface ProductInventorySummary {
  currentStock: number
  preOrderedStock: number
  availableStock: number
}

export const isDatabaseFlagEnabled = (value: unknown): boolean => {
  return value !== false && value !== 0 && value !== '0' && value !== 'false'
}

export const normalizeSkuInventoryQuantity = (value: unknown): number => {
  return Math.max(0, Number(value ?? 0))
}

export const summarizeProductInventory = (
  product: ProductInventoryValueSource,
  skus: ProductInventorySkuSource[],
): ProductInventorySummary => {
  const currentSkus = skus.filter((sku) => isDatabaseFlagEnabled(sku.isCurrent))
  const activeCurrentSkus = currentSkus.filter((sku) => isDatabaseFlagEnabled(sku.isActive))
  const currentStock = currentSkus.length > 0
    ? activeCurrentSkus.reduce((sum, sku) => sum + normalizeSkuInventoryQuantity(sku.currentStock), 0)
    : Number(product.currentStock ?? 0)
  const preOrderedStock = currentSkus.length > 0
    ? activeCurrentSkus.reduce((sum, sku) => sum + normalizeSkuInventoryQuantity(sku.preOrderedStock), 0)
    : Number(product.preOrderedStock ?? 0)

  return {
    currentStock,
    preOrderedStock,
    availableStock: Math.max(0, currentStock - preOrderedStock),
  }
}
