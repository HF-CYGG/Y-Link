import type { ProductRecord } from '@/api/modules/product'

/**
 * 明细编辑焦点字段：
 * - 与桌面端键盘流顺序保持一致；
 * - 供表格编辑器和 composable 共享类型约束。
 */
export type FocusField = 'product' | 'qty' | 'unitPrice' | 'remark'

/**
 * 订单明细行模型：
 * - uid 仅用于前端渲染与焦点定位；
 * - productId 在 allow-create 场景下既可能是产品主键，也可能是待自动建档的产品名称。
 */
export interface OrderItemRow {
  uid: string
  productId: string
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
