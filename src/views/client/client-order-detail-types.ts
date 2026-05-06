/**
 * 模块说明：src/views/client/client-order-detail-types.ts
 * 文件职责：集中维护客户端订单详情页及其弹层共用的类型、常量与默认值工厂。
 * 实现逻辑：
 * - 将改单、退货、正式出库单弹层共享的结构定义从页面主文件抽离；
 * - 让主页面只保留流程编排，子组件直接复用统一类型口径，避免重复声明。
 * 维护说明：新增会话字段时，优先同步更新这里，再回看父页面与子组件的 props/emit 接线。
 */

export const O2O_RETURN_REASON_MAX_LENGTH = 500
export const O2O_PREORDER_REMARK_MAX_LENGTH = 255

export interface EditableOrderItem {
  productId: string
  productCode: string
  productName: string
  defaultPrice: string
  qty: number
  originalQty: number
  maxQty: number
  unavailableReason: string | null
}

export interface OrderVoucherEditableFields {
  departmentOperator: string
  kingdeeVoucherNo: string
  receiverSignature: string
  issuerSignature: string
  completionSignature: string
}

export type VoucherOrientation = 'portrait' | 'landscape'

export const DEFAULT_VOUCHER_ORIENTATION: VoucherOrientation = 'landscape'

export const createEmptyVoucherEditableFields = (): OrderVoucherEditableFields => ({
  departmentOperator: '',
  kingdeeVoucherNo: '',
  receiverSignature: '',
  issuerSignature: '',
  completionSignature: '',
})
