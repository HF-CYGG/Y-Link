/**
 * 模块说明：订单永久删除前的可识别数据清理。
 * 文件职责：删除 revision、通知和历史审计等单据快照，匿名化库存事实，并生成不可逆目标摘要。
 * 维护边界：只按稳定主键/UUID/明确来源类型清理，禁止按可复用 businessNo 关联删除其它业务记录。
 */

import { randomUUID } from 'node:crypto'
import { In, type EntityManager } from 'typeorm'
import { ClientFeedbackConversation } from '../entities/client-feedback-conversation.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { NotificationDispatch } from '../entities/notification-dispatch.entity.js'
import { NotificationEvent } from '../entities/notification-event.entity.js'
import { NotificationInbox } from '../entities/notification-inbox.entity.js'
import { OrderRevision } from '../entities/order-revision.entity.js'
import { SysAuditLog } from '../entities/sys-audit-log.entity.js'

interface PermanentDeleteCleanupInput {
  orderIds?: string[]
  orderUuids?: string[]
  preorderIds?: string[]
  returnRequestIds?: string[]
  stableFeedbackRefs?: string[]
}

const uniqueValues = (values: Array<string | null | undefined>): string[] => (
  [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))]
)

export const buildRedactedDeleteTarget = (scope: 'order' | 'o2o'): string => `${scope}:deleted:${randomUUID()}`

export async function cleanupOrderIdentifiableData(
  manager: EntityManager,
  input: PermanentDeleteCleanupInput,
): Promise<void> {
  const orderIds = uniqueValues(input.orderIds ?? [])
  const orderUuids = uniqueValues(input.orderUuids ?? [])
  const preorderIds = uniqueValues(input.preorderIds ?? [])
  const returnRequestIds = uniqueValues(input.returnRequestIds ?? [])
  const stableFeedbackRefs = uniqueValues(input.stableFeedbackRefs ?? [])

  if (orderUuids.length > 0) {
    await manager.getRepository(OrderRevision).delete({ orderUuid: In(orderUuids) })
  }

  const inventoryPredicates: Array<{ refType: string; refIds: string[] }> = [
    { refType: 'outbound_order', refIds: orderIds },
    { refType: 'biz_outbound_order', refIds: orderIds },
    { refType: 'order', refIds: orderIds },
    { refType: 'o2o_preorder', refIds: preorderIds },
    { refType: 'o2o_return_request', refIds: returnRequestIds },
  ]
  for (const predicate of inventoryPredicates) {
    if (predicate.refIds.length === 0) continue
    await manager.getRepository(InventoryLog)
      .createQueryBuilder()
      .update()
      .set({
        operatorType: 'anonymized',
        operatorId: null,
        operatorName: null,
        refType: null,
        refId: null,
        remark: null,
      })
      .where('ref_type = :refType', { refType: predicate.refType })
      .andWhere('ref_id IN (:...refIds)', { refIds: predicate.refIds })
      .execute()
  }

  const notificationSources: Array<{ sourceType: string; sourceIds: string[] }> = [
    { sourceType: 'order', sourceIds: [...orderIds, ...orderUuids] },
    { sourceType: 'outbound_order', sourceIds: [...orderIds, ...orderUuids] },
    { sourceType: 'biz_outbound_order', sourceIds: [...orderIds, ...orderUuids] },
    { sourceType: 'o2o_preorder', sourceIds: preorderIds },
    { sourceType: 'o2o_return_request', sourceIds: returnRequestIds },
  ]
  for (const source of notificationSources) {
    if (source.sourceIds.length === 0) continue
    const events = await manager.getRepository(NotificationEvent).find({
      select: ['id'],
      where: { sourceType: source.sourceType, sourceId: In(source.sourceIds) },
    })
    const eventIds = events.map((event) => String(event.id))
    if (eventIds.length === 0) continue
    await manager.getRepository(NotificationDispatch).delete({ eventId: In(eventIds) })
    await manager.getRepository(NotificationInbox).delete({ eventId: In(eventIds) })
    await manager.getRepository(NotificationEvent).delete({ id: In(eventIds) })
  }

  if (stableFeedbackRefs.length > 0) {
    await manager.getRepository(ClientFeedbackConversation)
      .createQueryBuilder()
      .update()
      .set({ orderRef: null })
      .where('order_ref IN (:...stableFeedbackRefs)', { stableFeedbackRefs })
      .execute()
  }

  const auditTargetGroups: Array<{ targetType: string; targetIds: string[] }> = [
    { targetType: 'order', targetIds: uniqueValues([...orderIds, ...orderUuids]) },
    { targetType: 'o2o_order', targetIds: preorderIds },
    { targetType: 'o2o_return_request', targetIds: returnRequestIds },
  ]
  for (const group of auditTargetGroups) {
    if (group.targetIds.length === 0) continue
    await manager.getRepository(SysAuditLog)
      .createQueryBuilder()
      .delete()
      .where('target_type = :targetType', { targetType: group.targetType })
      .andWhere('target_id IN (:...targetIds)', { targetIds: group.targetIds })
      .execute()
  }
}
