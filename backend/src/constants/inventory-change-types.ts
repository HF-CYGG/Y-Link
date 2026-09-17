/**
 * 模块说明：库存流水变更类型与库存单据类型字典。
 * 文件职责：集中维护 inventory_log.change_type 的中文名，以及库存单据类型到库存方向、流水类型、原因编码的映射。
 * 维护重点：新增流水类型时同步前端 src/constants/inventory.ts 的同名字典。
 */

export const INVENTORY_CHANGE_TYPE_LABELS: Readonly<Record<string, string>> = {
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

export const STOCK_DOC_TYPES = ['purchase_in', 'return_in', 'other_out', 'damage_out', 'adjust'] as const
export type StockDocType = (typeof STOCK_DOC_TYPES)[number]

interface StockDocTypeDefinition {
  label: string
  /** 1：入库（数量为正）；-1：出库（数量为正、记账取负）；0：调整（数量有符号）。 */
  direction: 1 | -1 | 0
  changeType: string
  reasons: Readonly<Record<string, string>>
  reasonRequired: boolean
}

export const STOCK_DOC_TYPE_DEFINITIONS: Readonly<Record<StockDocType, StockDocTypeDefinition>> = {
  purchase_in: { label: '采购入库', direction: 1, changeType: 'stock_purchase_in', reasons: {}, reasonRequired: false },
  return_in: {
    label: '退货入库',
    direction: 1,
    changeType: 'stock_return_in',
    reasons: { customer_return: '顾客退货', exchange: '换货退回', other: '其他' },
    reasonRequired: false,
  },
  other_out: {
    label: '其他出库',
    direction: -1,
    changeType: 'stock_other_out',
    reasons: { internal_use: '内部领用', gift: '赠送', sample: '样品', transfer: '调出', other: '其他' },
    reasonRequired: true,
  },
  damage_out: {
    label: '报损出库',
    direction: -1,
    changeType: 'stock_damage_out',
    reasons: { damaged: '商品损坏', expired: '过期失效', lost: '丢失', other: '其他' },
    reasonRequired: true,
  },
  adjust: {
    label: '库存调整',
    direction: 0,
    changeType: 'stock_adjust',
    reasons: { entry_error: '录入错误', count_fix: '盘点修正', system_fix: '系统纠错', other: '其他' },
    reasonRequired: true,
  },
}

export const STOCKTAKE_DIFF_REASONS: Readonly<Record<string, string>> = {
  missed_sale: '销售漏记',
  damaged: '商品损坏',
  lost: '丢失',
  inbound_error: '入库错误',
  outbound_error: '出库错误',
  other: '其他',
}

export const STOCKTAKE_RESOLUTIONS: Readonly<Record<string, string>> = {
  adjust: '调整库存',
  damage: '报损',
  recount: '重新盘点',
  ignore: '暂不处理',
}
