/**
 * 模块说明：手工出库单库存记账共享模块。
 * 文件职责：统一承接手工出库单创建、内容编辑、删除回补与恢复重扣四类库存变动。
 * 实现逻辑：
 * - 调用方必须已在同一事务内按商品 ID、SKU ID 稳定顺序锁定商品与 SKU，本模块只做校验、记账与落库；
 * - `deltaQty` 为出库方向数量：正数表示扣减物理库存，负数表示回补物理库存；
 * - 扣减方向同时校验 SKU 与商品汇总两级可用量（`currentStock - preOrderedStock`），任何一级不足整笔拒绝；
 * - 每个 SKU 变动写一条可还原流水，`preOrderedStock` 永不改动（O2O 预占不属于手工出库语义）。
 * 维护重点：新增库存变动场景时复用本模块，不要在服务里再手写扣减与流水，避免口径漂移。
 */

import { In, type EntityManager } from 'typeorm'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import type { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'

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

/**
 * 在当前事务内应用手工出库库存变动：
 * 1. 按 SKU、商品两级汇总净变动，对净扣减方向校验可用量；
 * 2. 按商品 ID、SKU ID 稳定顺序逐行更新内存实体并生成流水快照；
 * 3. 写后兜底校验被扣减实体未出现负库存或低于预订量，异常直接抛错让事务回滚；
 * 4. 批量保存商品、SKU 与流水。
 */
export async function applyManualOutboundInventoryDeltas(
  manager: EntityManager,
  input: ApplyManualOutboundInventoryInput,
): Promise<ManualOutboundInventoryLineView[]> {
  const changed = input.deltas
    .filter((delta) => delta.deltaQty !== 0)
    .sort((left, right) => normalizeId(left.product.id).localeCompare(normalizeId(right.product.id))
      || normalizeId(left.sku.id).localeCompare(normalizeId(right.sku.id)))
  if (changed.length === 0) return []

  const skuNetMap = new Map<string, { sku: BaseProductSku; qty: number }>()
  const productNetMap = new Map<string, { product: BaseProduct; qty: number }>()
  for (const delta of changed) {
    if (!Number.isSafeInteger(delta.deltaQty)) {
      throw new BizError('库存变动数量必须为整数', 409)
    }
    if (normalizeId(delta.sku.productId) !== normalizeId(delta.product.id)) {
      throw new BizError(`SKU ${delta.sku.skuCode} 不属于商品 ${delta.product.productName}`, 409)
    }
    const skuId = normalizeId(delta.sku.id)
    const productId = normalizeId(delta.product.id)
    skuNetMap.set(skuId, { sku: delta.sku, qty: (skuNetMap.get(skuId)?.qty ?? 0) + delta.deltaQty })
    productNetMap.set(productId, { product: delta.product, qty: (productNetMap.get(productId)?.qty ?? 0) + delta.deltaQty })
  }

  for (const { sku, qty } of skuNetMap.values()) {
    if (qty > 0 && Number(sku.currentStock) - qty < Number(sku.preOrderedStock)) {
      throw new BizError(
        `SKU ${sku.skuCode} 可用库存不足（可用 ${Number(sku.currentStock) - Number(sku.preOrderedStock)}，需要 ${qty}）`,
        409,
      )
    }
  }
  for (const { product, qty } of productNetMap.values()) {
    if (qty > 0 && Number(product.currentStock) - qty < Number(product.preOrderedStock)) {
      throw new BizError(
        `商品 ${product.productName} 可用库存不足（可用 ${Number(product.currentStock) - Number(product.preOrderedStock)}，需要 ${qty}）`,
        409,
      )
    }
  }

  const inventoryLogRepo = manager.getRepository(InventoryLog)
  const logs: InventoryLog[] = []
  const lines: ManualOutboundInventoryLineView[] = []
  for (const delta of changed) {
    const { product, sku } = delta
    const beforeCurrentStock = Number(product.currentStock)
    const beforePreorderedStock = Number(product.preOrderedStock)
    const beforeSkuCurrentStock = Number(sku.currentStock)
    const beforeSkuPreorderedStock = Number(sku.preOrderedStock)
    product.currentStock = beforeCurrentStock - delta.deltaQty
    sku.currentStock = beforeSkuCurrentStock - delta.deltaQty
    lines.push({
      productId: normalizeId(product.id),
      skuId: normalizeId(sku.id),
      skuCode: sku.skuCode,
      deltaQty: delta.deltaQty,
      beforeCurrentStock,
      afterCurrentStock: product.currentStock,
      beforeSkuCurrentStock,
      afterSkuCurrentStock: sku.currentStock,
    })
    logs.push(inventoryLogRepo.create({
      productId: normalizeId(product.id),
      skuId: normalizeId(sku.id),
      changeType: input.changeType,
      changeQty: delta.deltaQty,
      beforeCurrentStock,
      afterCurrentStock: product.currentStock,
      beforePreorderedStock,
      afterPreorderedStock: beforePreorderedStock,
      beforeSkuCurrentStock,
      afterSkuCurrentStock: sku.currentStock,
      beforeSkuPreorderedStock,
      afterSkuPreorderedStock: beforeSkuPreorderedStock,
      operatorType: 'admin',
      operatorId: input.actor.userId,
      operatorName: input.actor.displayName,
      refType: MANUAL_OUTBOUND_REF_TYPE,
      refId: normalizeId(input.order.id),
      remark: input.buildRemark(delta).slice(0, 255),
    }))
  }

  // 写后兜底：只校验净扣减的实体，避免历史异常数据阻断“减少出库数量”这类回补操作。
  for (const { sku, qty } of skuNetMap.values()) {
    if (qty > 0 && (Number(sku.currentStock) < 0 || Number(sku.currentStock) < Number(sku.preOrderedStock))) {
      throw new BizError(`SKU ${sku.skuCode} 扣减后库存异常，已回滚`, 409)
    }
  }
  for (const { product, qty } of productNetMap.values()) {
    if (qty > 0 && (Number(product.currentStock) < 0 || Number(product.currentStock) < Number(product.preOrderedStock))) {
      throw new BizError(`商品 ${product.productName} 扣减后库存异常，已回滚`, 409)
    }
  }

  await manager.getRepository(BaseProduct).save([...productNetMap.values()].map((item) => item.product))
  await manager.getRepository(BaseProductSku).save([...skuNetMap.values()].map((item) => item.sku))
  await inventoryLogRepo.save(logs)
  return lines
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
