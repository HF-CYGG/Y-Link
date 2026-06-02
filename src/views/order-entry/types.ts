/**
 * 模块说明：src/views/order-entry/types.ts
 * 文件职责：集中维护开单页主单、明细、焦点流与编辑抽屉共用的类型定义和工具方法。
 * 实现逻辑：
 * - 页面壳层、明细编辑器和组合式函数共用同一套类型口径，避免字段在多处重复声明；
 * - 与商品选择、数量编辑、草稿恢复相关的结构定义统一放在这里，便于后续继续拆分组件。
 * 维护说明：
 * - 若开单流程新增字段，优先先补这里的类型和默认值，再回看页面与组件接线；
 * - 焦点流和编辑态字段一旦调整，需要同步确认桌面端键盘录入体验是否仍然连贯。
 */

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
