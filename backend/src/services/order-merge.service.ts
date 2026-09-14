/**
 * 模块说明：出库单合并治理服务。
 * 文件职责：提供无副作用预览、幂等原子提交、父子关系查询以及合并成员写操作门禁。
 * 实现逻辑：正式提交固定按“操作账号 -> 全部订单 -> 全部明细”稳定顺序加锁，复制来源明细但不触碰库存。
 */

import { createHash, randomUUID } from 'node:crypto'
import { Brackets, In, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { O2oReturnRequest } from '../entities/o2o-return-request.entity.js'
import { OrderMergeOperation } from '../entities/order-merge-operation.entity.js'
import { OrderMergeRelation } from '../entities/order-merge-relation.entity.js'
import { OrderRevision } from '../entities/order-revision.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { isRetryableMysqlTransactionError, isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'

const O2O_ORDER_PREFIX = 'o2o-preorder-verify:'
const MAX_TRANSACTION_ATTEMPTS = 3
const MAX_SOURCE_ORDERS = 100

export interface OrderMergeParticipantInput {
  orderId: string
  editVersion: number
}

export interface OrderMergeInput {
  target: OrderMergeParticipantInput
  sources: OrderMergeParticipantInput[]
  reason: string
}

export interface CommitOrderMergeInput extends OrderMergeInput {
  idempotencyKey: string
}

export interface OrderMergeBlocker {
  orderId: string
  code: string
  message: string
}


export interface OrderMergeOrderReference {
  id: string
  showNo: string
  businessNo: string
  editVersion: number
  status: BizOutboundOrder['status']
  orderType: string
  inventoryMode: BizOutboundOrder['inventoryMode']
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  issuerName: string | null
  customerDepartmentName: string | null
  customerName: string | null
  totalQty: string
  totalAmount: string
  remark: string | null
  creatorUserId: string | null
  creatorUsername: string | null
  creatorDisplayName: string | null
  isDeleted: boolean
  deletedAt: string | null
  deletedByUserId: string | null
  deletedByUsername: string | null
  deletedByDisplayName: string | null
  createdAt: string
}

export interface OrderMergePreviewItem {
  sourceOrderId: string
  sourceOrderUuid: string
  sourceOrderItemId: string
  prospectiveLineNo: number
  productId: string
  productNameSnapshot: string
  skuId: string | null
  skuCodeSnapshot: string | null
  specTextSnapshot: string | null
  qty: string
  unitPrice: string
  lineAmount: string
  remark: string | null
}

export interface OrderMergePreviewResult {
  ready: boolean
  blockers: OrderMergeBlocker[]
  target: OrderMergeOrderReference | null
  sources: Array<OrderMergeOrderReference | { id: string; missing: true }>
  beforeTotals: { totalQty: string; totalAmount: string; itemCount: number }
  afterTotals: { totalQty: string; totalAmount: string; itemCount: number }
  mergedItems: OrderMergePreviewItem[]
  inventoryImpact: {
    quantityDelta: 0
    amountDelta: 0
    movementDelta: 0
    message: string
  }
  requestHash: string
}

export interface OrderMergeCommitResult {
  operationId: string
  idempotentReplay: boolean
  targetOrderId: string
  targetEditVersion: number
  mergedSourceOrderIds: string[]
  detail: unknown
}

export interface OrderMergeMetadata {
  role: 'standalone' | 'parent' | 'source'
  parent: OrderMergeOrderReference | null
  children: OrderMergeOrderReference[]
}

interface NormalizedMergeInput {
  target: OrderMergeParticipantInput
  sources: OrderMergeParticipantInput[]
  reason: string
}

interface EvaluatedMerge {
  normalized: NormalizedMergeInput
  requestHash: string
  target: BizOutboundOrder | null
  sources: Array<BizOutboundOrder | null>
  orderMap: Map<string, BizOutboundOrder>
  itemsByOrderId: Map<string, BizOutboundOrderItem[]>
  existingSourceOrderIds: string[]
  preview: OrderMergePreviewResult
}

const normalizeId = (value: unknown): string => String(value ?? '').trim()

/**
 * 合并统计日必须与报表、Dashboard 的服务器本地日期边界一致。
 * 不能使用 toISOString 截取 UTC 日期，否则本地 00:00-08:00 会被归到前一天。
 */
const resolveLocalStatisticsDate = (value: unknown): string | null => {
  let date: Date | null = null
  if (value instanceof Date) {
    date = value
  } else if (typeof value === 'string' && value.trim()) {
    date = new Date(value)
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value)
  }
  if (!date || Number.isNaN(date.getTime())) return null
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

interface Fixed2Decimal {
  units: bigint
  text: string
}

type Fixed2ParseResult =
  | { ok: true; value: Fixed2Decimal }
  | { ok: false; reason: 'invalid' | 'scale' | 'precision' }

const parseFixed2Decimal = (
  value: string | number | null | undefined,
  precision: number,
): Fixed2ParseResult => {
  const raw = String(value ?? '').trim()
  const matched = /^(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!matched) return { ok: false, reason: 'invalid' }
  const fraction = matched[2] ?? ''
  if (fraction.length > 2) return { ok: false, reason: 'scale' }
  const integerPart = matched[1]!.replace(/^0+(?=\d)/, '')
  const units = BigInt(integerPart) * 100n + BigInt((fraction + '00').slice(0, 2))
  if (units > (10n ** BigInt(precision)) - 1n) return { ok: false, reason: 'precision' }
  return {
    ok: true,
    value: {
      units,
      text: `${integerPart}.${(fraction + '00').slice(0, 2)}`,
    },
  }
}

const formatFixed2Units = (units: bigint): string => {
  const integerPart = units / 100n
  const fractionPart = String(units % 100n).padStart(2, '0')
  return `${integerPart}.${fractionPart}`
}

const normalizeDecimal = (value: string | number | null | undefined): string => {
  const parsed = parseFixed2Decimal(value, 30)
  return parsed.ok ? parsed.value.text : '0.00'
}

const truncate = (value: string | null | undefined, maxLength: number): string | null => {
  if (value == null) return null
  return Array.from(value).slice(0, maxLength).join('')
}

export class OrderMergeService {
  async preview(input: OrderMergeInput, _actor: AuthUserContext): Promise<OrderMergePreviewResult> {
    const normalized = this.normalizeInput(input)
    return (await this.evaluate(normalized, AppDataSource.manager, false)).preview
  }

  async commit<TDetail>(
    input: CommitOrderMergeInput,
    actor: AuthUserContext,
    buildDetailSnapshot: (manager: EntityManager, targetOrderId: string) => Promise<TDetail>,
    requestMeta?: RequestMeta,
  ): Promise<OrderMergeCommitResult & { detail: TDetail }> {
    const normalized = this.normalizeInput(input)
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotencyKey)
    const requestHash = this.hashInput(normalized)
    let lastError: unknown

    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await runInTransaction(async (manager) => {
          await lockActiveSysAccountForBusiness(manager, actor.userId)
          const evaluated = await this.evaluate(normalized, manager, true)
          const operationRepo = manager.getRepository(OrderMergeOperation)
          const operationQuery = operationRepo.createQueryBuilder('operation')
            .where('operation.idempotencyKey = :idempotencyKey', { idempotencyKey })
          if (manager.connection.options.type !== 'sqlite') operationQuery.setLock('pessimistic_write')
          const existingOperation = await operationQuery.getOne()
          if (existingOperation) {
            return this.replayOperation(existingOperation, requestHash)
          }
          if (!evaluated.preview.ready || !evaluated.target) {
            this.throwCommitBlockers(evaluated.preview.blockers)
          }
          return this.persistMerge(
            manager,
            evaluated,
            idempotencyKey,
            actor,
            buildDetailSnapshot,
            requestMeta,
          )
        })
      } catch (error) {
        lastError = error
        if (isUniqueConstraintError(error)) {
          const existingOperation = await AppDataSource.getRepository(OrderMergeOperation).findOne({
            where: { idempotencyKey },
          })
          if (existingOperation) {
            try {
              return this.replayOperation(existingOperation, requestHash)
            } catch (replayError) {
              lastError = replayError
              break
            }
          }
        }
        if (attempt < MAX_TRANSACTION_ATTEMPTS && isRetryableMysqlTransactionError(error)) continue
        break
      }
    }

    await this.recordFailureAudit(actor, normalized, lastError, requestMeta)
    throw lastError
  }

  async assertNotMergeMember(
    manager: EntityManager,
    orderId: string,
    message = '合并成员禁止永久删除',
  ): Promise<void> {
    const normalizedOrderId = normalizeId(orderId)
    const count = await manager.getRepository(OrderMergeRelation)
      .createQueryBuilder('relation')
      .where('relation.parentOrderId = :orderId OR relation.sourceOrderId = :orderId', { orderId: normalizedOrderId })
      .getCount()
    if (count > 0) throw new BizError(message, 409)
  }

  async getMetadataMap(
    orderIds: string[],
    manager: EntityManager = AppDataSource.manager,
  ): Promise<Map<string, OrderMergeMetadata>> {
    const normalizedIds = [...new Set(orderIds.map(normalizeId).filter(Boolean))]
    const result = new Map<string, OrderMergeMetadata>()
    normalizedIds.forEach((id) => result.set(id, { role: 'standalone', parent: null, children: [] }))
    if (!normalizedIds.length) return result

    const relations = await manager.getRepository(OrderMergeRelation)
      .createQueryBuilder('relation')
      .where(new Brackets((qb) => {
        qb.where('relation.parentOrderId IN (:...orderIds)', { orderIds: normalizedIds })
          .orWhere('relation.sourceOrderId IN (:...orderIds)', { orderIds: normalizedIds })
      }))
      .orderBy('relation.id', 'ASC')
      .getMany()
    if (!relations.length) return result

    const relatedIds = [...new Set(relations.flatMap((relation) => [
      normalizeId(relation.parentOrderId),
      normalizeId(relation.sourceOrderId),
    ]))]
    const orders = await manager.getRepository(BizOutboundOrder).find({ where: { id: In(relatedIds) } })
    const orderMap = new Map(orders.map((order) => [normalizeId(order.id), order]))
    for (const relation of relations) {
      const parentId = normalizeId(relation.parentOrderId)
      const sourceId = normalizeId(relation.sourceOrderId)
      const parent = orderMap.get(parentId)
      const source = orderMap.get(sourceId)
      if (!parent || !source) continue
      if (normalizedIds.includes(parentId)) {
        const metadata = result.get(parentId) ?? { role: 'parent' as const, parent: null, children: [] }
        metadata.role = 'parent'
        metadata.children.push(this.toReference(source))
        result.set(parentId, metadata)
      }
      if (normalizedIds.includes(sourceId)) {
        result.set(sourceId, {
          role: 'source',
          parent: this.toReference(parent),
          children: [],
        })
      }
    }
    return result
  }

  private normalizeInput(input: OrderMergeInput): NormalizedMergeInput {
    const targetOrderId = normalizeId(input?.target?.orderId)
    const targetEditVersion = Number(input?.target?.editVersion)
    if (!targetOrderId) throw new BizError('目标订单 ID 不能为空', 400)
    if (!Number.isSafeInteger(targetEditVersion) || targetEditVersion <= 0) {
      throw new BizError('目标订单 editVersion 必须为正整数', 400)
    }
    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      throw new BizError('至少选择一张来源订单', 400)
    }
    if (input.sources.length > MAX_SOURCE_ORDERS) {
      throw new BizError('单次最多合并 ' + MAX_SOURCE_ORDERS + ' 张来源订单', 400)
    }
    const sources = input.sources.map((source, index) => {
      const orderId = normalizeId(source?.orderId)
      const editVersion = Number(source?.editVersion)
      if (!orderId) throw new BizError('第 ' + (index + 1) + ' 张来源订单 ID 不能为空', 400)
      if (!Number.isSafeInteger(editVersion) || editVersion <= 0) {
        throw new BizError('第 ' + (index + 1) + ' 张来源订单 editVersion 必须为正整数', 400)
      }
      return { orderId, editVersion }
    }).sort((left, right) => left.orderId.localeCompare(right.orderId))
    const sourceIds = sources.map((source) => source.orderId)
    if (new Set(sourceIds).size !== sourceIds.length) throw new BizError('来源订单不能重复', 400)
    if (sourceIds.includes(targetOrderId)) throw new BizError('目标订单不能同时作为来源订单', 400)
    const reason = String(input.reason ?? '').trim()
    if (!reason) throw new BizError('请填写合并原因', 400)
    if (Array.from(reason).length > 500) throw new BizError('合并原因长度不能超过 500', 400)
    return {
      target: { orderId: targetOrderId, editVersion: targetEditVersion },
      sources,
      reason,
    }
  }

  private normalizeIdempotencyKey(value: unknown): string {
    const normalized = normalizeId(value)
    if (normalized.length < 8 || normalized.length > 128) {
      throw new BizError('idempotencyKey 长度应为 8-128', 400)
    }
    return normalized
  }

  private hashInput(input: NormalizedMergeInput): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex')
  }

  private async evaluate(
    normalized: NormalizedMergeInput,
    manager: EntityManager,
    lockRows: boolean,
  ): Promise<EvaluatedMerge> {
    const participantIds = [
      normalized.target.orderId,
      ...normalized.sources.map((source) => source.orderId),
    ].sort((left, right) => left.localeCompare(right))
    const orderQuery = manager.getRepository(BizOutboundOrder)
      .createQueryBuilder('order')
      .where('order.id IN (:...participantIds)', { participantIds })
      .orderBy('order.id', 'ASC')
    if (lockRows && manager.connection.options.type !== 'sqlite') orderQuery.setLock('pessimistic_write')
    const orders = await orderQuery.getMany()
    const orderMap = new Map(orders.map((order) => [normalizeId(order.id), order]))

    const itemQuery = manager.getRepository(BizOutboundOrderItem)
      .createQueryBuilder('item')
      .where('item.orderId IN (:...participantIds)', { participantIds })
      .orderBy('item.orderId', 'ASC')
      .addOrderBy('item.id', 'ASC')
    if (lockRows && manager.connection.options.type !== 'sqlite') itemQuery.setLock('pessimistic_write')
    const items = await itemQuery.getMany()
    const itemsByOrderId = new Map<string, BizOutboundOrderItem[]>()
    participantIds.forEach((id) => itemsByOrderId.set(id, []))
    items.forEach((item) => {
      const orderId = normalizeId(item.orderId)
      itemsByOrderId.get(orderId)?.push(item)
    })

    const relationQuery = manager.getRepository(OrderMergeRelation)
      .createQueryBuilder('relation')
      .where(new Brackets((qb) => {
        qb.where('relation.parentOrderId IN (:...participantIds)', { participantIds })
          .orWhere('relation.sourceOrderId IN (:...participantIds)', { participantIds })
      }))
      .orderBy('relation.parentOrderId', 'ASC')
      .addOrderBy('relation.sourceOrderId', 'ASC')
    if (lockRows && manager.connection.options.type !== 'sqlite') relationQuery.setLock('pessimistic_read')
    const relations = await relationQuery.getMany()

    const target = orderMap.get(normalized.target.orderId) ?? null
    const sources = normalized.sources.map((source) => orderMap.get(source.orderId) ?? null)
    const blockers: OrderMergeBlocker[] = []
    const addBlocker = (orderId: string, code: string, message: string) => {
      if (!blockers.some((item) => item.orderId === orderId && item.code === code)) {
        blockers.push({ orderId, code, message })
      }
    }

    if (!target) addBlocker(normalized.target.orderId, 'ORDER_NOT_FOUND', '目标订单不存在')
    normalized.sources.forEach((source, index) => {
      if (!sources[index]) addBlocker(source.orderId, 'ORDER_NOT_FOUND', '来源订单不存在')
    })

    const checkCommon = (order: BizOutboundOrder, expectedVersion: number, roleLabel: string) => {
      const orderId = normalizeId(order.id)
      if (order.isDeleted) addBlocker(orderId, 'ORDER_DELETED', roleLabel + '已删除')
      if (order.status !== 'active') addBlocker(orderId, 'ORDER_NOT_ACTIVE', roleLabel + '已是合并来源，只允许查看并跳转父单')
      if (Number(order.editVersion) !== expectedVersion) {
        addBlocker(orderId, 'ORDER_VERSION_CONFLICT', roleLabel + '版本已变化，当前版本为 ' + order.editVersion)
      }
      if (order.hasCustomerOrder) addBlocker(orderId, 'CUSTOMER_ORDER_PRINTED', roleLabel + '已打印或已关联客户订单')
      if (order.isSystemApplied) addBlocker(orderId, 'SYSTEM_APPLIED', roleLabel + '已完成系统申请')
    }
    if (target) checkCommon(target, normalized.target.editVersion, '目标订单')
    sources.forEach((source, index) => {
      if (source) checkCommon(source, normalized.sources[index]!.editVersion, '来源订单')
    })

    const targetStatisticsDate = target ? resolveLocalStatisticsDate(target.createdAt) : null
    if (target && !targetStatisticsDate) {
      addBlocker(normalizeId(target.id), 'STATISTICS_DATE_INVALID', '目标订单统计日期无效，不能参与合并')
    }
    if (targetStatisticsDate) {
      sources.forEach((source) => {
        if (!source) return
        const sourceId = normalizeId(source.id)
        const sourceStatisticsDate = resolveLocalStatisticsDate(source.createdAt)
        if (!sourceStatisticsDate) {
          addBlocker(sourceId, 'STATISTICS_DATE_INVALID', '来源订单统计日期无效，不能参与合并')
        } else if (sourceStatisticsDate !== targetStatisticsDate) {
          addBlocker(
            sourceId,
            'STATISTICS_DATE_MISMATCH',
            `来源订单统计日期 ${sourceStatisticsDate} 与目标订单 ${targetStatisticsDate} 不一致`,
          )
        }
      })
    }

    const targetAsSource = relations.find((relation) => normalizeId(relation.sourceOrderId) === normalized.target.orderId)
    if (targetAsSource) addBlocker(normalized.target.orderId, 'TARGET_IS_SOURCE', '合并来源不能作为新的目标父单')
    normalized.sources.forEach((source) => {
      const relation = relations.find((item) =>
        normalizeId(item.sourceOrderId) === source.orderId || normalizeId(item.parentOrderId) === source.orderId,
      )
      if (relation) addBlocker(source.orderId, 'SOURCE_ALREADY_MERGED', '来源订单已参与其他合并')
    })

    if (target) {
      sources.forEach((source) => {
        if (!source) return
        const sourceId = normalizeId(source.id)
        if (source.orderType !== target.orderType) {
          addBlocker(sourceId, 'ORDER_TYPE_MISMATCH', '来源订单与目标订单类型不一致')
        }
        if (source.inventoryMode !== target.inventoryMode) {
          addBlocker(sourceId, 'INVENTORY_MODE_MISMATCH', '来源订单与目标订单库存模式不一致')
        }
        if (target.orderType === 'department') {
          if (normalizeId(source.customerDepartmentName) !== normalizeId(target.customerDepartmentName)) {
            addBlocker(sourceId, 'DEPARTMENT_MISMATCH', '来源订单与目标订单部门完整路径不一致')
          }
        } else if (normalizeId(source.customerName) !== normalizeId(target.customerName)) {
          addBlocker(sourceId, 'CUSTOMER_MISMATCH', '来源订单与目标订单散客名称不一致')
        }
      })
    }

    const existingChildIds = [...new Set(relations
      .filter((relation) => normalizeId(relation.parentOrderId) === normalized.target.orderId)
      .map((relation) => normalizeId(relation.sourceOrderId)))]
      .sort((left, right) => left.localeCompare(right))
    const existingChildren = existingChildIds.length
      ? await manager.getRepository(BizOutboundOrder).find({ where: { id: In(existingChildIds) } })
      : []
    for (const child of existingChildren) {
      if (child.hasCustomerOrder) {
        addBlocker(normalized.target.orderId, 'CUSTOMER_ORDER_PRINTED', '已有合并来源已打印，目标父单已锁定')
      }
      if (child.isSystemApplied) {
        addBlocker(normalized.target.orderId, 'SYSTEM_APPLIED', '已有合并来源已完成系统申请，目标父单已锁定')
      }
    }

    await this.evaluateO2oRules(manager, target, sources, existingChildren, addBlocker, lockRows)

    const targetItems = target ? (itemsByOrderId.get(normalizeId(target.id)) ?? []) : []
    const normalizedItemDecimals = new Map<string, {
      qty: Fixed2Decimal
      unitPrice: Fixed2Decimal
      lineAmount: Fixed2Decimal
    }>()
    for (const [orderId, orderItems] of itemsByOrderId) {
      for (const item of orderItems) {
        const fields = [
          ['qty', item.qty, 12, '数量'],
          ['unitPrice', item.unitPrice, 12, '单价'],
          ['lineAmount', item.lineAmount, 14, '行金额'],
        ] as const
        const parsedFields: Partial<{
          qty: Fixed2Decimal
          unitPrice: Fixed2Decimal
          lineAmount: Fixed2Decimal
        }> = {}
        for (const [fieldName, rawValue, precision, label] of fields) {
          const parsed = parseFixed2Decimal(rawValue, precision)
          if (!parsed.ok) {
            const code = parsed.reason === 'scale'
              ? 'DECIMAL_SCALE_INVALID'
              : parsed.reason === 'precision'
                ? 'DECIMAL_PRECISION_OVERFLOW'
                : 'DECIMAL_VALUE_INVALID'
            addBlocker(orderId, code, `${label}不符合 decimal(${precision},2) 数据约束`)
            continue
          }
          parsedFields[fieldName] = parsed.value
        }
        if (parsedFields.qty && parsedFields.unitPrice && parsedFields.lineAmount) {
          normalizedItemDecimals.set(normalizeId(item.id), parsedFields as {
            qty: Fixed2Decimal
            unitPrice: Fixed2Decimal
            lineAmount: Fixed2Decimal
          })
        }
      }
    }

    let nextLineNo = targetItems.reduce((maximum, item) => Math.max(maximum, Number(item.lineNo)), 0) + 1
    const mergedItems: OrderMergePreviewItem[] = []
    sources.forEach((source) => {
      if (!source) return
      for (const item of itemsByOrderId.get(normalizeId(source.id)) ?? []) {
        const decimals = normalizedItemDecimals.get(normalizeId(item.id))
        mergedItems.push({
          sourceOrderId: normalizeId(source.id),
          sourceOrderUuid: source.orderUuid,
          sourceOrderItemId: normalizeId(item.id),
          prospectiveLineNo: nextLineNo,
          productId: normalizeId(item.productId),
          productNameSnapshot: item.productNameSnapshot,
          skuId: item.skuId == null ? null : normalizeId(item.skuId),
          skuCodeSnapshot: item.skuCodeSnapshot ?? null,
          specTextSnapshot: item.specTextSnapshot ?? null,
          qty: decimals?.qty.text ?? normalizeDecimal(item.qty),
          unitPrice: decimals?.unitPrice.text ?? normalizeDecimal(item.unitPrice),
          lineAmount: decimals?.lineAmount.text ?? normalizeDecimal(item.lineAmount),
          remark: item.remark ?? null,
        })
        nextLineNo += 1
      }
    })

    const beforeQty = parseFixed2Decimal(target?.totalQty ?? '0', 12)
    const beforeAmount = parseFixed2Decimal(target?.totalAmount ?? '0', 14)
    if (target && !beforeQty.ok) {
      addBlocker(
        normalizeId(target.id),
        beforeQty.reason === 'scale' ? 'DECIMAL_SCALE_INVALID' : 'DECIMAL_PRECISION_OVERFLOW',
        '目标订单总数量不符合 decimal(12,2) 数据约束',
      )
    }
    if (target && !beforeAmount.ok) {
      addBlocker(
        normalizeId(target.id),
        beforeAmount.reason === 'scale' ? 'DECIMAL_SCALE_INVALID' : 'DECIMAL_PRECISION_OVERFLOW',
        '目标订单总金额不符合 decimal(14,2) 数据约束',
      )
    }
    const allItems = [...targetItems, ...sources.flatMap((source) => (
      source ? (itemsByOrderId.get(normalizeId(source.id)) ?? []) : []
    ))]
    const recomputedQtyUnits = allItems.reduce(
      (sum, item) => sum + (normalizedItemDecimals.get(normalizeId(item.id))?.qty.units ?? 0n),
      0n,
    )
    const recomputedAmountUnits = allItems.reduce(
      (sum, item) => sum + (normalizedItemDecimals.get(normalizeId(item.id))?.lineAmount.units ?? 0n),
      0n,
    )
    const maxQtyUnits = (10n ** 12n) - 1n
    const maxAmountUnits = (10n ** 14n) - 1n
    if (target && recomputedQtyUnits > maxQtyUnits) {
      addBlocker(normalizeId(target.id), 'TOTAL_QTY_OVERFLOW', '合并后总数量超过 decimal(12,2) 上限')
    }
    if (target && recomputedAmountUnits > maxAmountUnits) {
      addBlocker(normalizeId(target.id), 'TOTAL_AMOUNT_OVERFLOW', '合并后总金额超过 decimal(14,2) 上限')
    }
    const requestHash = this.hashInput(normalized)
    const preview: OrderMergePreviewResult = {
      ready: blockers.length === 0,
      blockers,
      target: target ? this.toReference(target) : null,
      sources: normalized.sources.map((source, index) => {
        const order = sources[index]
        return order ? this.toReference(order) : { id: source.orderId, missing: true as const }
      }),
      beforeTotals: {
        totalQty: beforeQty.ok ? beforeQty.value.text : normalizeDecimal(target?.totalQty),
        totalAmount: beforeAmount.ok ? beforeAmount.value.text : normalizeDecimal(target?.totalAmount),
        itemCount: targetItems.length,
      },
      afterTotals: {
        totalQty: formatFixed2Units(recomputedQtyUnits),
        totalAmount: formatFixed2Units(recomputedAmountUnits),
        itemCount: targetItems.length + mergedItems.length,
      },
      mergedItems,
      inventoryImpact: {
        quantityDelta: 0,
        amountDelta: 0,
        movementDelta: 0,
        message: '合并只复制来源明细并重新汇总父单，不扣减或回补库存，也不生成库存流水。',
      },
      requestHash,
    }
    return {
      normalized,
      requestHash,
      target,
      sources,
      orderMap,
      itemsByOrderId,
      existingSourceOrderIds: existingChildIds,
      preview,
    }
  }

  private async evaluateO2oRules(
    manager: EntityManager,
    target: BizOutboundOrder | null,
    sources: Array<BizOutboundOrder | null>,
    existingChildren: BizOutboundOrder[],
    addBlocker: (orderId: string, code: string, message: string) => void,
    lockRows: boolean,
  ): Promise<void> {
    const candidates = [target, ...sources].filter((order): order is BizOutboundOrder => Boolean(order))
    const memberOrders = [...candidates, ...existingChildren]
    const preorderIdByOrderId = new Map<string, string>()
    memberOrders.forEach((order) => {
      const key = order.idempotencyKey?.trim() ?? ''
      if (key.startsWith(O2O_ORDER_PREFIX)) {
        const preorderId = key.slice(O2O_ORDER_PREFIX.length).trim()
        if (preorderId) preorderIdByOrderId.set(normalizeId(order.id), preorderId)
      } else if (order.inventoryMode === 'o2o_preapplied') {
        addBlocker(normalizeId(order.id), 'O2O_LINK_MISSING', 'O2O 正式出库单缺少原预订单追溯关系')
      }
    })
    const preorderIds = [...new Set(preorderIdByOrderId.values())]
      .sort((left, right) => left.localeCompare(right))
    if (!preorderIds.length) return
    const preorderQuery = manager.getRepository(O2oPreorder)
      .createQueryBuilder('preorder')
      .where('preorder.id IN (:...preorderIds)', { preorderIds })
      .orderBy('preorder.id', 'ASC')
    if (lockRows && manager.connection.options.type !== 'sqlite') preorderQuery.setLock('pessimistic_write')
    const preorders = await preorderQuery.getMany()
    const preorderMap = new Map(preorders.map((preorder) => [normalizeId(preorder.id), preorder]))
    const pendingReturns = await manager.getRepository(O2oReturnRequest).find({
      select: ['orderId'],
      where: { orderId: In(preorderIds), status: 'pending' },
    })
    const pendingPreorderIds = new Set(pendingReturns.map((request) => normalizeId(request.orderId)))

    for (const [orderId, preorderId] of preorderIdByOrderId) {
      if (!preorderMap.has(preorderId)) {
        addBlocker(orderId, 'O2O_LINK_MISSING', 'O2O 正式出库单关联的原预订单不存在')
      }
      if (pendingPreorderIds.has(preorderId)) {
        const blockerOrderId = existingChildren.some((order) => normalizeId(order.id) === orderId) && target
          ? normalizeId(target.id)
          : orderId
        addBlocker(blockerOrderId, 'PENDING_RETURN_EXISTS', '合并成员存在未完成退货申请')
      }
    }

    if (target?.orderType !== 'walkin' || target.inventoryMode !== 'o2o_preapplied') return
    const targetPreorderId = preorderIdByOrderId.get(normalizeId(target.id))
    const targetClientUserId = targetPreorderId ? normalizeId(preorderMap.get(targetPreorderId)?.clientUserId) : ''
    for (const source of sources) {
      if (!source) continue
      const sourcePreorderId = preorderIdByOrderId.get(normalizeId(source.id))
      const sourceClientUserId = sourcePreorderId ? normalizeId(preorderMap.get(sourcePreorderId)?.clientUserId) : ''
      if (!targetClientUserId || !sourceClientUserId || sourceClientUserId !== targetClientUserId) {
        addBlocker(normalizeId(source.id), 'O2O_CLIENT_MISMATCH', 'O2O 散客正式出库单必须属于同一客户端账号')
      }
    }
  }

  private async persistMerge<TDetail>(
    manager: EntityManager,
    evaluated: EvaluatedMerge,
    idempotencyKey: string,
    actor: AuthUserContext,
    buildDetailSnapshot: (manager: EntityManager, targetOrderId: string) => Promise<TDetail>,
    requestMeta?: RequestMeta,
  ): Promise<OrderMergeCommitResult & { detail: TDetail }> {
    const target = evaluated.target as BizOutboundOrder
    const sources = evaluated.sources.filter((source): source is BizOutboundOrder => Boolean(source))
    const operationRepo = manager.getRepository(OrderMergeOperation)
    const relationRepo = manager.getRepository(OrderMergeRelation)
    const itemRepo = manager.getRepository(BizOutboundOrderItem)
    const orderRepo = manager.getRepository(BizOutboundOrder)
    const revisionRepo = manager.getRepository(OrderRevision)
    const sourceIds = sources.map((source) => normalizeId(source.id))
    const allSourceOrderIds = [...new Set([...evaluated.existingSourceOrderIds, ...sourceIds])]
      .sort((left, right) => left.localeCompare(right))

    const targetBefore = this.buildRevisionSnapshot(
      target,
      evaluated.itemsByOrderId.get(normalizeId(target.id)) ?? [],
      { role: 'target_before', sourceOrderIds: evaluated.existingSourceOrderIds },
    )
    const sourceBefore = new Map(sources.map((source) => [
      normalizeId(source.id),
      this.buildRevisionSnapshot(
        source,
        evaluated.itemsByOrderId.get(normalizeId(source.id)) ?? [],
        { role: 'source_before', sourceOrderIds: [] },
      ),
    ]))

    const operation = await operationRepo.save(operationRepo.create({
      operationUuid: randomUUID(),
      idempotencyKey,
      requestHash: evaluated.requestHash,
      targetOrderId: normalizeId(target.id),
      targetOrderUuid: target.orderUuid,
      targetEditVersion: Number(target.editVersion) + 1,
      mergedSourceOrderIdsJson: JSON.stringify(sourceIds),
      resultJson: '{}',
      reason: evaluated.normalized.reason,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorDisplayName: actor.displayName,
    }))

    const copiedItems = evaluated.preview.mergedItems.map((item) => itemRepo.create({
      orderId: target.id,
      lineNo: item.prospectiveLineNo,
      productId: item.productId,
      productNameSnapshot: item.productNameSnapshot,
      skuId: item.skuId,
      skuCodeSnapshot: item.skuCodeSnapshot,
      specTextSnapshot: item.specTextSnapshot,
      qty: item.qty,
      unitPrice: item.unitPrice,
      lineAmount: item.lineAmount,
      remark: item.remark,
      sourceOrderId: item.sourceOrderId,
      sourceOrderUuid: item.sourceOrderUuid,
      sourceOrderItemId: item.sourceOrderItemId,
    }))
    if (copiedItems.length) await itemRepo.save(copiedItems)

    target.totalQty = evaluated.preview.afterTotals.totalQty
    target.totalAmount = evaluated.preview.afterTotals.totalAmount
    target.editVersion = Number(target.editVersion) + 1
    target.status = 'active'
    await orderRepo.save(target)
    for (const source of sources) {
      source.status = 'merged'
      source.editVersion = Number(source.editVersion) + 1
      await orderRepo.save(source)
    }

    await relationRepo.save(sources.map((source) => relationRepo.create({
      operationId: operation.id,
      parentOrderId: target.id,
      parentOrderUuid: target.orderUuid,
      parentBusinessNoSnapshot: target.businessNo,
      sourceOrderId: source.id,
      sourceOrderUuid: source.orderUuid,
      sourceBusinessNoSnapshot: source.businessNo,
    })))

    const allTargetItems = [
      ...(evaluated.itemsByOrderId.get(normalizeId(target.id)) ?? []),
      ...copiedItems,
    ]
    const targetAfter = this.buildRevisionSnapshot(target, allTargetItems, {
      role: 'parent',
      sourceOrderIds: allSourceOrderIds,
    })
    await revisionRepo.insert(revisionRepo.create({
      orderIdSnapshot: normalizeId(target.id),
      orderUuid: target.orderUuid,
      revisionNo: target.editVersion,
      beforeSnapshotJson: JSON.stringify(targetBefore),
      afterSnapshotJson: JSON.stringify(targetAfter),
      reason: evaluated.normalized.reason,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorDisplayName: actor.displayName,
      ipAddress: truncate(requestMeta?.ipAddress, 64),
      userAgent: truncate(requestMeta?.userAgent, 255),
    }))
    for (const source of sources) {
      const sourceId = normalizeId(source.id)
      await revisionRepo.insert(revisionRepo.create({
        orderIdSnapshot: sourceId,
        orderUuid: source.orderUuid,
        revisionNo: source.editVersion,
        beforeSnapshotJson: JSON.stringify(sourceBefore.get(sourceId)),
        afterSnapshotJson: JSON.stringify(this.buildRevisionSnapshot(
          source,
          evaluated.itemsByOrderId.get(sourceId) ?? [],
          { role: 'source', parentOrderId: normalizeId(target.id), sourceOrderIds: [] },
        )),
        reason: evaluated.normalized.reason,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        actorDisplayName: actor.displayName,
        ipAddress: truncate(requestMeta?.ipAddress, 64),
        userAgent: truncate(requestMeta?.userAgent, 255),
      }))
    }

    await auditService.record({
      actionType: 'order.merge',
      actionLabel: '合并出库单',
      targetType: 'order',
      targetId: normalizeId(target.id),
      targetCode: target.showNo,
      actor,
      requestMeta,
      detail: {
        operationId: normalizeId(operation.id),
        targetOrderId: normalizeId(target.id),
        targetOrderUuid: target.orderUuid,
        targetBusinessNo: target.businessNo,
        mergedSourceOrderIds: sourceIds,
        copiedItemCount: copiedItems.length,
        beforeTotals: evaluated.preview.beforeTotals,
        afterTotals: evaluated.preview.afterTotals,
        inventoryMovementDelta: 0,
        reason: evaluated.normalized.reason,
      },
    }, manager)

    const result = {
      operationId: normalizeId(operation.id),
      idempotentReplay: false,
      targetOrderId: normalizeId(target.id),
      targetEditVersion: target.editVersion,
      mergedSourceOrderIds: sourceIds,
      detail: await buildDetailSnapshot(manager, normalizeId(target.id)),
    }
    operation.resultJson = JSON.stringify(result)
    await operationRepo.save(operation)
    return result
  }

  private buildRevisionSnapshot(
    order: BizOutboundOrder,
    items: BizOutboundOrderItem[],
    merge: { role: string; parentOrderId?: string; sourceOrderIds: string[] },
  ) {
    return {
      businessNo: order.businessNo,
      showNo: order.showNo,
      orderType: order.orderType,
      customerDepartmentName: order.customerDepartmentName,
      customerName: order.customerName,
      issuerName: order.issuerName,
      hasCustomerOrder: Boolean(order.hasCustomerOrder),
      isSystemApplied: Boolean(order.isSystemApplied),
      remark: order.remark,
      status: order.status,
      totalQty: normalizeDecimal(order.totalQty),
      totalAmount: normalizeDecimal(order.totalAmount),
      editVersion: Number(order.editVersion),
      itemCount: items.length,
      merge,
    }
  }

  private throwCommitBlockers(blockers: OrderMergeBlocker[]): never {
    const missing = blockers.find((blocker) => blocker.code === 'ORDER_NOT_FOUND')
    if (missing) throw new BizError(missing.message, 404, { blockers })
    const summary = blockers.map((blocker) => blocker.orderId + ': ' + blocker.message).join(' | ')
    throw new BizError('订单合并存在冲突：' + summary, 409, { blockers })
  }

  private replayOperation<TDetail>(
    operation: OrderMergeOperation,
    requestHash: string,
  ): OrderMergeCommitResult & { detail: TDetail } {
    if (operation.requestHash !== requestHash) {
      throw new BizError('同一 idempotencyKey 对应的合并请求不一致', 409, {
        reason: 'ORDER_MERGE_IDEMPOTENCY_CONFLICT',
      })
    }
    try {
      const parsed = JSON.parse(operation.resultJson) as Partial<OrderMergeCommitResult>
      if (
        !parsed
        || typeof parsed !== 'object'
        || !normalizeId(parsed.operationId)
        || !normalizeId(parsed.targetOrderId)
        || !Number.isSafeInteger(Number(parsed.targetEditVersion))
        || !Array.isArray(parsed.mergedSourceOrderIds)
        || !Object.hasOwn(parsed, 'detail')
      ) {
        throw new Error('invalid snapshot')
      }
      return {
        operationId: normalizeId(parsed.operationId),
        idempotentReplay: true,
        targetOrderId: normalizeId(parsed.targetOrderId),
        targetEditVersion: Number(parsed.targetEditVersion),
        mergedSourceOrderIds: parsed.mergedSourceOrderIds.map(normalizeId).filter(Boolean),
        detail: parsed.detail as TDetail,
      }
    } catch {
      throw new BizError('历史合并操作结果损坏，无法安全重放', 409)
    }
  }

  private async recordFailureAudit(
    actor: AuthUserContext,
    input: NormalizedMergeInput,
    error: unknown,
    requestMeta?: RequestMeta,
  ): Promise<void> {
    await auditService.safeRecord({
      actionType: 'order.merge_failed',
      actionLabel: '合并出库单失败',
      targetType: 'order',
      targetId: input.target.orderId,
      actor,
      requestMeta,
      detail: {
        targetOrderId: input.target.orderId,
        sourceOrderIds: input.sources.map((source) => source.orderId),
        errorType: error instanceof BizError ? 'business' : 'internal',
        statusCode: error instanceof BizError ? error.statusCode : 500,
        message: error instanceof BizError
          ? truncate(error.message, 200)
          : '订单合并失败',
      },
    })
  }

  private toReference(order: BizOutboundOrder): OrderMergeOrderReference {
    return {
      id: normalizeId(order.id),
      showNo: order.showNo,
      businessNo: order.businessNo,
      editVersion: Number(order.editVersion),
      status: order.status,
      orderType: order.orderType,
      inventoryMode: order.inventoryMode,
      hasCustomerOrder: Boolean(order.hasCustomerOrder),
      isSystemApplied: Boolean(order.isSystemApplied),
      issuerName: order.issuerName ?? null,
      customerDepartmentName: order.customerDepartmentName ?? null,
      customerName: order.customerName ?? null,
      totalQty: normalizeDecimal(order.totalQty),
      totalAmount: normalizeDecimal(order.totalAmount),
      remark: order.remark ?? null,
      creatorUserId: order.creatorUserId == null ? null : normalizeId(order.creatorUserId),
      creatorUsername: order.creatorUsername ?? null,
      creatorDisplayName: order.creatorDisplayName ?? null,
      isDeleted: Boolean(order.isDeleted),
      deletedAt: order.deletedAt?.toISOString() ?? null,
      deletedByUserId: order.deletedByUserId == null ? null : normalizeId(order.deletedByUserId),
      deletedByUsername: order.deletedByUsername ?? null,
      deletedByDisplayName: order.deletedByDisplayName ?? null,
      createdAt: order.createdAt.toISOString(),
    }
  }
}

export const orderMergeService = new OrderMergeService()
