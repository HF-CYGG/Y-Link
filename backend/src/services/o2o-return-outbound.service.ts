/** 核销已取货退货时，在同一事务内冲减原正式单及其合并父单的对应明细。 */
import { In, type EntityManager } from 'typeorm'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import type { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import { OrderMergeRelation } from '../entities/order-merge-relation.entity.js'
import { OrderRevision } from '../entities/order-revision.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { formatMoneyFromCents, parseMoneyToCents } from '../utils/discount-price.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'

interface ReturnOutboundOrders {
  original: BizOutboundOrder
  parent: BizOutboundOrder | undefined
  items: BizOutboundOrderItem[]
}

/**
 * 调用方在 MySQL READ COMMITTED 事务内先锁操作人，再锁正式单和明细。
 * 合并也先锁正式单，锁定后复查关系，避免拿着原预订单锁等待合并父单。
 */
export async function lockReturnOutboundOrders(manager: EntityManager, preorderId: string): Promise<ReturnOutboundOrders | null> {
  const orderRepo = manager.getRepository(BizOutboundOrder)
  const linked = await orderRepo.find({ where: { sourceDocType: 'o2o_preorder', sourceDocId: preorderId }, take: 2 })
  if (!linked.length) {
    // 历史上未生成正式单的预订单仍允许回库；发现有未经结构化验证的单据时需先核实归属。
    if (await orderRepo.existsBy({ idempotencyKey: `o2o-preorder-verify:${preorderId}` })) {
      throw new BizError('原正式出库单缺少可信来源，无法核销退货', 409)
    }
    return null
  }
  if (linked.length !== 1) throw new BizError('原预订单关联了多张正式出库单，无法核销退货', 409)

  const originalId = String(linked[0]!.id)
  const relationRepo = manager.getRepository(OrderMergeRelation)
  const oldRelation = await relationRepo.findOneBy({ sourceOrderId: originalId })
  const parentId = oldRelation ? String(oldRelation.parentOrderId) : undefined
  const orderIds = parentId ? [originalId, parentId] : [originalId]
  const lock = manager.connection.options.type === 'mysql' ? { mode: 'pessimistic_write' as const } : undefined
  const orders = await orderRepo.find({ where: { id: In(orderIds) }, order: { id: 'ASC' }, lock })
  const relation = await relationRepo.findOneBy({ sourceOrderId: originalId })
  if (String(relation?.id ?? '') !== String(oldRelation?.id ?? '')) {
    throw new BizError('正式出库单的合并关系已变化，请重新核销', 409)
  }
  const original = orders.find((order) => String(order.id) === originalId)
  const parent = orders.find((order) => String(order.id) === parentId)
  if (!original || original.isDeleted || original.inventoryMode !== 'o2o_preapplied'
    || original.sourceDocType !== 'o2o_preorder' || String(original.sourceDocId) !== preorderId
    || original.status !== (parentId ? 'merged' : 'active')
    || (parentId && (!parent || parent.id === original.id || parent.isDeleted || parent.status !== 'active'
      || parent.inventoryMode !== 'o2o_preapplied' || parent.orderUuid !== relation?.parentOrderUuid
      || original.orderUuid !== relation?.sourceOrderUuid))) {
    throw new BizError('原正式出库单或合并父单状态已变化，无法核销退货', 409)
  }

  const items = await manager.getRepository(BizOutboundOrderItem).find({
    where: { orderId: In(orderIds) }, order: { orderId: 'ASC', id: 'ASC' }, lock,
  })
  return { original, parent, items }
}

function snapshotOutboundContent(order: BizOutboundOrder, items: BizOutboundOrderItem[]) {
  return {
    businessNo: order.businessNo,
    systemNo: order.systemNo,
    showNo: order.systemNo,
    editVersion: Number(order.editVersion),
    inventoryMode: order.inventoryMode,
    status: order.status,
    totalQty: formatMoneyFromCents(parseMoneyToCents(order.totalQty)),
    totalAmount: formatMoneyFromCents(parseMoneyToCents(order.totalAmount)),
    items: [...items].sort((left, right) => left.lineNo - right.lineNo).map((item) => ({
      id: String(item.id),
      lineNo: item.lineNo,
      productId: String(item.productId),
      productNameSnapshot: item.productNameSnapshot,
      skuId: item.skuId == null ? null : String(item.skuId),
      skuCodeSnapshot: item.skuCodeSnapshot,
      specTextSnapshot: item.specTextSnapshot,
      qty: formatMoneyFromCents(parseMoneyToCents(item.qty)),
      unitPrice: formatMoneyFromCents(parseMoneyToCents(item.unitPrice)),
      lineAmount: formatMoneyFromCents(parseMoneyToCents(item.lineAmount)),
      sourceOrderId: item.sourceOrderId == null ? null : String(item.sourceOrderId),
      sourceOrderItemId: item.sourceOrderItemId == null ? null : String(item.sourceOrderItemId),
      sourceOrderUuid: item.sourceOrderUuid,
      remark: item.remark,
    })),
  }
}

export async function applyReturnToOutboundOrders(
  manager: EntityManager,
  { original, parent, items }: ReturnOutboundOrders,
  changes: ReadonlyMap<O2oPreorderItem, number>,
  returnNo: string,
  actor: AuthUserContext,
  requestMeta?: RequestMeta,
) {
  const originalItems = items.filter((item) => String(item.orderId) === String(original.id))
  const adjustmentByItemId = new Map<string, number>()
  for (const [remaining, previousQty] of changes) {
    const matched = originalItems.filter((item) => item.sourceOrderId == null
      && String(item.productId) === String(remaining.productId)
      && String(item.skuId) === String(remaining.skuId))
    const line = matched[0]
    const recordedQty = Number(line?.qty)
    if (matched.length !== 1 || !line || !Number.isSafeInteger(recordedQty) || recordedQty < previousQty) {
      throw new BizError('原正式出库明细与退货规格或数量不一致，无法核销退货', 409)
    }
    // 已有的退货可能只减过原预订单数量；本次核销按该规格实际剩余量同步。
    adjustmentByItemId.set(String(line.id), remaining.qty)
    if (!parent) continue
    const copies = items.filter((item) => String(item.orderId) === String(parent.id)
      && String(item.sourceOrderId) === String(original.id)
      && String(item.sourceOrderItemId) === String(line.id))
    const copy = copies[0]
    if (copies.length !== 1 || !copy || copy.sourceOrderUuid !== original.orderUuid
      || String(copy.productId) !== String(line.productId) || String(copy.skuId) !== String(line.skuId)
      || Number(copy.qty) !== Number(line.qty) || parseMoneyToCents(copy.unitPrice) !== parseMoneyToCents(line.unitPrice)) {
      throw new BizError('合并父单的来源明细与原正式单不一致，无法核销退货', 409)
    }
    adjustmentByItemId.set(String(copy.id), remaining.qty)
  }

  for (const order of parent ? [original, parent] : [original]) {
    const orderItems = items.filter((item) => String(item.orderId) === String(order.id))
    const before = snapshotOutboundContent(order, orderItems)
    const removedIds: string[] = []
    const updatedItems: BizOutboundOrderItem[] = []
    const remainingItems: BizOutboundOrderItem[] = []
    for (const item of orderItems) {
      const itemId = String(item.id)
      const remainingQty = adjustmentByItemId.get(itemId)
      if (remainingQty === 0) {
        removedIds.push(itemId)
        continue
      }
      if (remainingQty !== undefined) {
        item.qty = remainingQty.toFixed(2)
        item.lineAmount = formatMoneyFromCents(remainingQty * parseMoneyToCents(item.unitPrice))
        updatedItems.push(item)
      }
      remainingItems.push(item)
    }
    const itemRepo = manager.getRepository(BizOutboundOrderItem)
    if (removedIds.length) await itemRepo.delete({ id: In(removedIds) })
    if (updatedItems.length) await itemRepo.save(updatedItems)
    order.totalQty = formatMoneyFromCents(remainingItems.reduce((sum, item) => sum + parseMoneyToCents(item.qty), 0))
    order.totalAmount = formatMoneyFromCents(remainingItems.reduce((sum, item) => sum + parseMoneyToCents(item.lineAmount), 0))
    order.editVersion = Number(order.editVersion) + 1
    await manager.getRepository(BizOutboundOrder).save(order)
    await manager.getRepository(OrderRevision).insert({
      orderIdSnapshot: String(order.id),
      orderUuid: order.orderUuid,
      revisionNo: order.editVersion,
      beforeSnapshotJson: JSON.stringify(before),
      afterSnapshotJson: JSON.stringify(snapshotOutboundContent(order, remainingItems)),
      reason: `O2O 退货核销冲减 · ${returnNo}`,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorDisplayName: actor.displayName,
      ipAddress: requestMeta?.ipAddress?.slice(0, 64) ?? null,
      userAgent: Array.from(requestMeta?.userAgent ?? '').slice(0, 255).join('') || null,
    })
  }
}
