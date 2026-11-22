/** 供应方录入送货单无需读取 SKU 的售价、折扣、成本或库存。 */
export const supplierSkuFieldMask = {
  costPrice: null,
  defaultPrice: '0.00',
  discountRate: '10.0',
  currentStock: 0,
  preOrderedStock: 0,
}
