/**
 * 模块说明：src/constants/inventory.ts
 * 文件职责：库存流水类型、库存单据类型与原因、盘点差异原因与处理方式的前端字典。
 * 维护说明：与 backend/src/constants/inventory-change-types.ts 保持同一口径，新增类型时两边同步。
 */

export const INVENTORY_CHANGE_TYPE_LABELS: Record<string, string> = {
  inbound_sys: '送货单入库',
  inbound_reverse: '送货单入库冲销',
  inbound: '手工补货入库',
  preorder_hold: '预订占用',
  preorder_release: '预订释放',
  preorder_verify: '预订核销出库',
  preorder_return_inbound: '预订退货入库',
  manual_outbound_create: '销售出库',
  manual_outbound_edit: '销售出库改单',
  manual_outbound_delete_release: '销售出库删除回补',
  manual_outbound_restore_apply: '销售出库恢复扣减',
  manual_stock_adjust: '商品资料调整库存',
  stock_initial: '新建商品初始库存',
  stock_purchase_in: '采购入库',
  stock_return_in: '退货入库',
  stock_other_out: '其他出库',
  stock_damage_out: '报损出库',
  stock_adjust: '库存调整',
  stock_doc_void: '库存单据作废冲回',
  stocktake_gain: '盘盈',
  stocktake_loss: '盘亏',
  stocktake_damage: '盘点报损',
}

export type StockDocType = 'purchase_in' | 'return_in' | 'other_out' | 'damage_out' | 'adjust'

export interface StockDocTypeOption {
  value: StockDocType
  label: string
  /** 1 入库、-1 出库、0 调整（数量可正可负）。 */
  direction: 1 | -1 | 0
  reasons: Array<{ value: string; label: string }>
  reasonRequired: boolean
}

export const STOCK_DOC_TYPE_OPTIONS: StockDocTypeOption[] = [
  { value: 'purchase_in', label: '采购入库', direction: 1, reasons: [], reasonRequired: false },
  {
    value: 'other_out',
    label: '其他出库',
    direction: -1,
    reasonRequired: true,
    reasons: [
      { value: 'internal_use', label: '内部领用' },
      { value: 'gift', label: '赠送' },
      { value: 'sample', label: '样品' },
      { value: 'transfer', label: '调出' },
      { value: 'other', label: '其他' },
    ],
  },
  {
    value: 'return_in',
    label: '退货入库',
    direction: 1,
    reasonRequired: false,
    reasons: [
      { value: 'customer_return', label: '顾客退货' },
      { value: 'exchange', label: '换货退回' },
      { value: 'other', label: '其他' },
    ],
  },
  {
    value: 'damage_out',
    label: '报损出库',
    direction: -1,
    reasonRequired: true,
    reasons: [
      { value: 'damaged', label: '商品损坏' },
      { value: 'expired', label: '过期失效' },
      { value: 'lost', label: '丢失' },
      { value: 'other', label: '其他' },
    ],
  },
  {
    value: 'adjust',
    label: '库存调整',
    direction: 0,
    reasonRequired: true,
    reasons: [
      { value: 'entry_error', label: '录入错误' },
      { value: 'count_fix', label: '盘点修正' },
      { value: 'system_fix', label: '系统纠错' },
      { value: 'other', label: '其他' },
    ],
  },
]

export const STOCKTAKE_STATUS_LABELS: Record<string, { label: string; type: 'primary' | 'warning' | 'success' | 'info' }> = {
  counting: { label: '盘点中', type: 'primary' },
  reviewing: { label: '待确认', type: 'warning' },
  completed: { label: '已完成', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
}

export const STOCKTAKE_DIFF_REASON_OPTIONS = [
  { value: 'missed_sale', label: '销售漏记' },
  { value: 'damaged', label: '商品损坏' },
  { value: 'lost', label: '丢失' },
  { value: 'inbound_error', label: '入库错误' },
  { value: 'outbound_error', label: '出库错误' },
  { value: 'other', label: '其他' },
]

export const STOCKTAKE_RESOLUTION_OPTIONS = [
  { value: 'adjust', label: '调整库存' },
  { value: 'damage', label: '报损' },
  { value: 'recount', label: '重新盘点' },
  { value: 'ignore', label: '暂不处理' },
]
