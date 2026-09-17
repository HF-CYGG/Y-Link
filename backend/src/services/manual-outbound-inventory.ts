/**
 * 模块说明：手工出库单库存记账共享模块。
 * 文件职责：统一承接手工出库单创建、内容编辑、删除回补与恢复重扣四类库存变动。
 * 实现逻辑：
 * - 校验、记账与落库委托 `inventory-ledger.service.ts#applyInventoryDeltas`，调用方仍需先在事务内稳定顺序锁行；
 * - `deltaQty` 为出库方向数量：正数表示扣减物理库存，负数表示回补物理库存；
 * - 商品汇总库存只由“当前版本且启用”的 SKU 构成（与商品编辑重算、库存报表同一口径）：
 *   参与汇总的 SKU 同步改动商品汇总并校验商品级可用量；已停用或退役的 SKU 只改动自身库存，
 *   避免订单引用的规格在开单后被停用时，回补/重扣把商品汇总改得偏离启用 SKU 合计；
 * - 扣减方向对 SKU 可用量（`currentStock - preOrderedStock`）逐一校验，任何一级不足整笔拒绝；
 * - 每个 SKU 变动写一条可还原流水，`preOrderedStock` 永不改动（O2O 预占不属于手工出库语义）。
 * 维护重点：本模块只服务手工出库；其他库存变动场景直接调用 `applyInventoryDeltas`，不要在服务里手写增减与流水。
 */

import { In, type EntityManager } from 'typeorm'
import type { BaseProduct } from '../entities/base-product.entity.js'
import type { BaseProductSku } from '../entities/base-product-sku.entity.js'
import type { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { applyInventoryDeltas, skuContributesToProductAggregate, type InventoryStockDelta } from './inventory-ledger.service.js'

export const MANUAL_OUTBOUND_REF_TYPE = 'biz_outbound_order'

export const MANUAL_OUTBOUND_CHANGE_TYPES = {
  create: 'manual_outbound_create',
  edit: 'manual_outbound_edit',
  deleteRelease: 'manual_outbound_delete_release',
  restoreApply: 'manual_outbound_restore_apply',
} as const

export type ManualOutboundChangeType = typeof MANUAL_OUTBOUND_CHANGE_TYPES[keyof typeof MANUAL_OUTBOUND_CHANGE_TYPES]

export interface ManualOutboundInventoryDelta {
  product: BaseProduct
  sku: BaseProductSku
  /** 出库方向数量：正数扣减，负数回补，0 会被忽略。 */
  deltaQty: number
}

export interface ManualOutboundInventoryLineView {
  productId: string
  skuId: string
  skuCode: string
  deltaQty: number
  /** 该 SKU 是否参与商品汇总；为 false 时商品汇总库存前后不变。 */
  affectsProductAggregate: boolean
  beforeCurrentStock: number
  afterCurrentStock: number
  beforeSkuCurrentStock: number
  afterSkuCurrentStock: number
}

export interface ApplyManualOutboundInventoryInput {
  order: Pick<BizOutboundOrder, 'id' | 'businessNo'>
  deltas: ManualOutboundInventoryDelta[]
  actor: AuthUserContext
  changeType: ManualOutboundChangeType
  /** 生成流水备注，便于在库存流水中直接看出来源动作。 */
  buildRemark: (delta: ManualOutboundInventoryDelta) => string
}

const normalizeId = (value: unknown): string => String(value ?? '').trim()

export { skuContributesToProductAggregate }

/**
 * 在当前事务内应用手工出库库存变动：委托 `applyInventoryDeltas` 统一校验与记账，
 * 流水 `changeQty` 保持出库方向（扣减为正）的历史口径，已有对账与回补判定依赖该口径。
 */
export async function applyManualOutboundInventoryDeltas(
  manager: EntityManager,
  input: ApplyManualOutboundInventoryInput,
): Promise<ManualOutboundInventoryLineView[]> {
  const deltaByLedger = new Map<InventoryStockDelta, ManualOutboundInventoryDelta>()
  const ledgerDeltas = input.deltas.map((delta) => {
    const ledgerDelta: InventoryStockDelta = { product: delta.product, sku: delta.sku, stockDelta: -delta.deltaQty }
    deltaByLedger.set(ledgerDelta, delta)
    return ledgerDelta
  })
  const lines = await applyInventoryDeltas(manager, {
    deltas: ledgerDeltas,
    changeType: input.changeType,
    refType: MANUAL_OUTBOUND_REF_TYPE,
    refId: normalizeId(input.order.id),
    operator: { type: 'admin', id: input.actor.userId, name: input.actor.displayName },
    buildRemark: (ledgerDelta) => input.buildRemark(deltaByLedger.get(ledgerDelta)!),
    logQtyDirection: 'outbound',
  })
  return lines.map(({ stockDelta, ...line }) => ({ ...line, deltaQty: -stockDelta }))
}

/**
 * 批量判定订单库存是否处于“删除时已回补”状态：
 * - 以该订单最近一条删除回补 / 恢复重扣流水为准，最近是删除回补即视为已回补；
 * - 不新增订单列，直接命中 `idx_inventory_log_ref_lookup` 索引，保证历史订单无需迁移。
 */
export async function resolveManualOutboundReleasedOrderIds(
  manager: EntityManager,
  orderIds: string[],
): Promise<Set<string>> {
  const normalizedIds = [...new Set(orderIds.map(normalizeId).filter(Boolean))]
  if (normalizedIds.length === 0) return new Set()
  const rows = await manager.getRepository(InventoryLog).find({
    select: ['id', 'refId', 'changeType'],
    where: {
      refType: MANUAL_OUTBOUND_REF_TYPE,
      refId: In(normalizedIds),
      changeType: In([MANUAL_OUTBOUND_CHANGE_TYPES.deleteRelease, MANUAL_OUTBOUND_CHANGE_TYPES.restoreApply]),
    },
    order: { id: 'DESC' },
  })
  const decided = new Set<string>()
  const released = new Set<string>()
  // SQLite / MySQL 的自增主键在字符串形态下排序不可靠，这里再按数值兜底排序一次。
  rows.sort((left, right) => Number(right.id) - Number(left.id))
  for (const row of rows) {
    const refId = normalizeId(row.refId)
    if (decided.has(refId)) continue
    decided.add(refId)
    if (row.changeType === MANUAL_OUTBOUND_CHANGE_TYPES.deleteRelease) released.add(refId)
  }
  return released
}
