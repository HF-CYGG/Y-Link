/**
 * 模块说明：src/views/order-entry/types.ts
 * 文件职责：集中维护开单页主单、明细、焦点流与编辑抽屉共用的类型定义和工具方法。
 * 实现逻辑：
 * - 页面壳层、明细编辑器和组合式函数共用同一套类型口径，避免字段在多处重复声明；
 * - 与商品、SKU 选择、数量编辑、草稿恢复相关的结构定义统一放在这里，便于后续继续拆分组件。
 * 维护说明：
 * - 若开单流程新增字段，优先先补这里的类型和默认值，再回看页面与组件接线；SKU 候选始终只取当前且启用项；
 * - 焦点流和编辑态字段一旦调整，需要同步确认桌面端键盘录入体验是否仍然连贯。
 */

import type { ProductRecord, ProductSkuRecord } from '@/api/modules/product'

/**
 * 明细编辑焦点字段：
 * - 与桌面端键盘流顺序保持一致；
 * - 供表格编辑器和 composable 共享类型约束。
 */
export type FocusField = 'product' | 'sku' | 'qty' | 'unitPrice' | 'remark'

/**
 * 订单明细行模型：
 * - uid 仅用于前端渲染与焦点定位；
 * - productId 只保存已建档且当前可用于出库的产品主键；旧草稿中的失效值会在提交前被拒绝。
 */
export interface OrderItemRow {
  uid: string
  productId: string
  skuId: string
  qty: number | null
  unitPrice: number | null
  remark: string
}

/**
 * 主单表单模型：
 * - customerName 与 remark 均为选填；
 * - 使用对象模型便于在多个展示组件间共享响应式引用。
 */
export interface OrderHeaderForm {
  orderType: 'department' | 'walkin'
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  issuerName: string
  customerDepartmentName: string
  /** 选自系统部门配置时的节点 ID；空字符串表示手动录入。 */
  customerDepartmentNodeId: string
  customerName: string
  remark: string
}

/**
 * 移动端抽屉草稿模型：
 * - 与 OrderItemRow 结构保持一致；
 * - 通过独立草稿避免半编辑状态直接污染原始行数据。
 */
export interface OrderEntryDrawerForm {
  productId: string
  skuId: string
  qty: number | null
  unitPrice: number | null
  remark: string
}

/**
 * 产品选择项标签：
 * - 统一桌面表格与移动端抽屉的展示文案；
 * - 保持产品名 / 编码 / 拼音首字母组合格式一致。
 */
export const getProductOptionLabel = (product: ProductRecord): string => {
  return `${product.productName}（${product.productCode}/${product.pinyinAbbr || '-'}）`
}

export const getSelectableProductSkus = (product: ProductRecord | undefined): ProductSkuRecord[] => {
  return (product?.skus ?? []).filter((sku) => Boolean(sku.id) && sku.isActive === true && sku.isCurrent === true)
}

/**
 * 兼容旧版 allow-create 草稿中的商品名称：
 * - 已是当前候选商品 ID 时原样保留；
 * - 只有名称唯一且完全相等时才迁移为真实 ID；
 * - 未知或重名值保持原样，由提交前校验给出业务提示，不做猜测映射。
 */
export const resolveLegacyOrderEntryProductValue = (
  value: string,
  products: Array<Pick<ProductRecord, 'id' | 'productName'>>,
): string => {
  if (products.some((product) => product.id === value)) {
    return value
  }

  const exactMatches = products.filter((product) => product.productName === value)
  return exactMatches.length === 1 ? exactMatches[0]?.id ?? value : value
}

export const getProductSkuOptionLabel = (sku: ProductSkuRecord): string => {
  return `${sku.specText || '默认规格'}（${sku.skuCode || sku.id || '-'}）`
}

/**
 * SKU 可用库存（物理库存 - 预订占用）：
 * - 优先使用服务端返回的 availableStock，缺失时按同一口径推导；
 * - 仅用于开单页展示与提交前预检，最终以服务端事务内校验为准。
 */
export const getSkuAvailableStock = (sku: ProductSkuRecord | undefined): number | null => {
  if (!sku) return null
  if (typeof sku.availableStock === 'number' && Number.isFinite(sku.availableStock)) return sku.availableStock
  const current = Number(sku.currentStock)
  const reserved = Number(sku.preOrderedStock ?? 0)
  return Number.isFinite(current) ? current - (Number.isFinite(reserved) ? reserved : 0) : null
}
