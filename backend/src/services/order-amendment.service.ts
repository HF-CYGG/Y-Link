/**
 * 模块说明：历史出库订单分类与业务号修订服务。
 * 文件职责：提供无副作用预览和全事务提交，并以 editVersion、永久号码占用与 revision 保证可追溯一致性。
 * 实现逻辑：提交阶段重新锁定并校验全部订单，任一阻断即整体回滚；只允许修改主单治理字段，不触碰商品明细或库存。
 */

import type { EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { OrderRevision } from '../entities/order-revision.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { BizError } from '../utils/errors.js'
import { auditService } from './audit.service.js'
import { orderBusinessNoService } from './order-business-no.service.js'
import type { BusinessNoCursorPlan, ParsedBusinessNo } from './order-business-no.service.js'
import type { OrderType } from './order-serial.service.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { orderMergeService } from './order-merge.service.js'

export interface OrderAmendmentInput {
  orderId: string
  editVersion: number
  businessNo?: string
  orderType?: OrderType
  customerDepartmentName?: string | null
  customerName?: string | null
  issuerName?: string | null
  hasCustomerOrder?: boolean
  isSystemApplied?: boolean
  remark?: string | null
  reason?: string
}

export interface OrderAmendmentBatchInput {
  amendments: OrderAmendmentInput[]
}

export interface OrderAmendmentSnapshot {
  businessNo: string
  showNo: string
  orderType: OrderType
  customerDepartmentName: string | null
  customerName: string | null
  issuerName: string | null
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  remark: string | null
  editVersion: number
}

export interface OrderAmendmentPreviewItem {
  orderId: string
  blockingReasons: string[]
  before: OrderAmendmentSnapshot
  after: OrderAmendmentSnapshot
}

export interface OrderAmendmentPreviewResult {
  ready: boolean
  cursorPlans: BusinessNoCursorPlan[]
  items: OrderAmendmentPreviewItem[]
}

interface EvaluatedAmendment extends OrderAmendmentPreviewItem {
  order: BizOutboundOrder
  input: OrderAmendmentInput
  businessNoChanged: boolean
  parsedBusinessNo: ParsedBusinessNo | null
}

const FIELD_LIMITS = {
  batchSize: 100,
  businessNo: 32,
  customerDepartmentName: 271,
  customerName: 128,
  issuerName: 64,
  remark: 500,
  reason: 500,
} as const

const hasOwn = (input: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(input, key)

const truncateByCodePoint = (value: string | null | undefined, maxLength: number): string | null => {
  if (value == null) return null
  const characters = Array.from(value)
  return characters.length <= maxLength ? value : characters.slice(0, maxLength).join('')
}

export class OrderAmendmentService {
  async preview(input: OrderAmendmentBatchInput, _actor: AuthUserContext): Promise<OrderAmendmentPreviewResult> {
    const evaluated = await this.evaluate(input, AppDataSource.manager, false)
    const cursorPlans = await orderBusinessNoService.previewCursorPlans(
      evaluated
        .filter((item) => item.businessNoChanged && item.parsedBusinessNo && item.blockingReasons.length === 0)
        .map((item) => item.parsedBusinessNo as ParsedBusinessNo),
      AppDataSource.manager,
    )
    return this.toPreviewResult(evaluated, cursorPlans)
  }

  async commit(
    input: OrderAmendmentBatchInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<OrderAmendmentPreviewResult> {
    const normalizedInput: OrderAmendmentBatchInput = {
      amendments: input.amendments.map((amendment) => ({
        ...amendment,
        reason: this.normalizeRequiredReason(amendment.reason),
      })),
    }
    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      // 预览不是授权凭证：正式提交必须在同一事务中重新锁行、重查占用并计算全部阻断原因。
      const evaluated = await this.evaluate(normalizedInput, manager, true)
      const preliminaryPlans = await orderBusinessNoService.previewCursorPlans(
        evaluated
          .filter((item) => item.businessNoChanged && item.parsedBusinessNo && item.blockingReasons.length === 0)
          .map((item) => item.parsedBusinessNo as ParsedBusinessNo),
        manager,
      )
      const preview = this.toPreviewResult(evaluated, preliminaryPlans)
      if (!preview.ready) {
        const summary = preview.items
          .filter((item) => item.blockingReasons.length > 0)
          .map((item) => `${item.orderId}: ${item.blockingReasons.join('；')}`)
          .join(' | ')
        throw new BizError(`订单修订存在冲突：${summary}`, 409)
      }

      const cursorPlans = await orderBusinessNoService.reserveConfirmedBatch(
        evaluated
          .filter((item) => item.businessNoChanged && item.parsedBusinessNo)
          .map((item) => ({
            parsed: item.parsedBusinessNo as ParsedBusinessNo,
            orderUuid: item.order.orderUuid,
            reason: this.normalizeNullableText(item.input.reason, FIELD_LIMITS.reason, '修订原因'),
          })),
        manager,
      )
      const orderRepo = manager.getRepository(BizOutboundOrder)
      const revisionRepo = manager.getRepository(OrderRevision)
      for (const item of evaluated) {
        item.order.businessNo = item.after.businessNo
        item.order.orderType = item.after.orderType
        item.order.customerDepartmentName = item.after.customerDepartmentName
        item.order.customerName = item.after.customerName
        item.order.issuerName = item.after.issuerName
        item.order.hasCustomerOrder = item.after.hasCustomerOrder
        item.order.isSystemApplied = item.after.isSystemApplied
        item.order.remark = item.after.remark
        item.order.editVersion = item.before.editVersion + 1
        await orderRepo.save(item.order)

        item.after.editVersion = item.order.editVersion
        const reason = this.normalizeNullableText(item.input.reason, FIELD_LIMITS.reason, '修订原因')
        await revisionRepo.insert(revisionRepo.create({
          orderIdSnapshot: String(item.order.id),
          orderUuid: item.order.orderUuid,
          revisionNo: item.order.editVersion,
          beforeSnapshotJson: JSON.stringify(item.before),
          afterSnapshotJson: JSON.stringify(item.after),
          reason,
          actorUserId: actor.userId,
          actorUsername: actor.username,
          actorDisplayName: actor.displayName,
          ipAddress: truncateByCodePoint(requestMeta?.ipAddress, 64),
          userAgent: truncateByCodePoint(requestMeta?.userAgent, 255),
        }))
        await auditService.record({
          actionType: 'order.amendment',
          actionLabel: '修订出库单',
          targetType: 'order',
          targetId: String(item.order.id),
          // 仪表盘动态跳转仍以不可变 showNo 为系统定位键；可编辑 businessNo 只放入审计详情。
          targetCode: item.order.showNo,
          actor,
          requestMeta,
          detail: {
            reason,
            before: item.before,
            after: item.after,
            cursorPlan: item.businessNoChanged
              ? cursorPlans.find((plan) => plan.namespace === item.parsedBusinessNo?.namespace) ?? null
              : null,
          },
        }, manager)
      }

      return this.toPreviewResult(evaluated, cursorPlans)
    })
  }

  private async evaluate(
    input: OrderAmendmentBatchInput,
    manager: EntityManager,
    lockOrders: boolean,
  ): Promise<EvaluatedAmendment[]> {
    if (!Array.isArray(input.amendments) || input.amendments.length === 0) {
      throw new BizError('至少提交一张待修订订单', 400)
    }
    if (input.amendments.length > FIELD_LIMITS.batchSize) {
      throw new BizError(`单次最多修订 ${FIELD_LIMITS.batchSize} 张订单`, 400)
    }

    const duplicateOrderIds = new Set<string>()
    const seenOrderIds = new Set<string>()
    for (const amendment of input.amendments) {
      const orderId = String(amendment.orderId ?? '').trim()
      if (seenOrderIds.has(orderId)) duplicateOrderIds.add(orderId)
      seenOrderIds.add(orderId)
    }

    // 所有提交按稳定主键顺序锁订单行；与业务号服务的命名空间顺序锁配合，降低批量并发死锁概率。
    const orderedAmendments = [...input.amendments].sort((left, right) =>
      String(left.orderId ?? '').trim().localeCompare(String(right.orderId ?? '').trim()),
    )
    const evaluated: EvaluatedAmendment[] = []
    for (const amendment of orderedAmendments) {
      const orderId = String(amendment.orderId ?? '').trim()
      if (!orderId) throw new BizError('订单 ID 不能为空', 400)
      const query = manager.getRepository(BizOutboundOrder)
        .createQueryBuilder('order')
        .where('order.id = :orderId', { orderId })
      if (lockOrders && manager.connection.options.type !== 'sqlite') {
        query.setLock('pessimistic_write')
      }
      const order = await query.getOne()
      if (!order) {
        const emptySnapshot = this.emptySnapshot()
        evaluated.push({
          orderId,
          blockingReasons: ['订单不存在'],
          before: emptySnapshot,
          after: { ...emptySnapshot },
          order: new BizOutboundOrder(),
          input: amendment,
          businessNoChanged: false,
          parsedBusinessNo: null,
        })
        continue
      }

      const before = this.snapshot(order)
      const after = this.buildAfterSnapshot(before, amendment)
      const blockingReasons: string[] = []
      const mergeMetadata = (await orderMergeService.getMetadataMap([orderId], manager)).get(orderId)
      if (order.isDeleted) {
        blockingReasons.push('已删除订单不可修订')
      }
      if (order.status === 'merged' || mergeMetadata?.role === 'source') {
        blockingReasons.push('合并来源单只允许查看，禁止任何修订')
      }
      if (!Number.isSafeInteger(amendment.editVersion) || amendment.editVersion <= 0) {
        blockingReasons.push('editVersion 必须为正整数')
      } else if (amendment.editVersion !== before.editVersion) {
        blockingReasons.push(`editVersion 已过期，当前版本为 ${before.editVersion}`)
      }
      if (duplicateOrderIds.has(orderId)) {
        blockingReasons.push('同一批次不得重复提交同一订单')
      }

      const orderTypeChanged = after.orderType !== before.orderType
      const businessNoChanged = after.businessNo !== before.businessNo
      if (
        mergeMetadata?.role === 'parent'
        && (
          orderTypeChanged
          || businessNoChanged
          || after.customerDepartmentName !== before.customerDepartmentName
          || after.customerName !== before.customerName
          || after.hasCustomerOrder !== before.hasCustomerOrder
          || after.isSystemApplied !== before.isSystemApplied
        )
      ) {
        blockingReasons.push('合并目标父单禁止结构或合规字段修订')
      }
      let parsedBusinessNo: ParsedBusinessNo | null = null
      if (orderTypeChanged && !businessNoChanged) {
        blockingReasons.push('切换订单类型时必须确认目标命名空间的新业务号')
      }
      if (after.orderType === 'department' && !after.customerDepartmentName) {
        blockingReasons.push('部门订单必须填写客户部门名称')
      }
      if (after.orderType === 'walkin' && !after.customerName) {
        blockingReasons.push('散客订单必须填写客户名称')
      }
      if (businessNoChanged) {
        const inspection = await orderBusinessNoService.inspectConfirmed(after.businessNo, after.orderType, manager)
        parsedBusinessNo = inspection.parsed
        if (inspection.blockingReason) blockingReasons.push(inspection.blockingReason)
      }

      const comparableBefore = JSON.stringify(before)
      const comparableAfter = JSON.stringify(after)
      if (comparableBefore === comparableAfter) {
        blockingReasons.push('没有可提交的修订内容')
      }
      evaluated.push({
        orderId,
        blockingReasons,
        before,
        after,
        order,
        input: amendment,
        businessNoChanged,
        parsedBusinessNo,
      })
    }

    const seenBusinessNos = new Map<string, string>()
    for (const item of evaluated) {
      if (!item.businessNoChanged) continue
      const previousOrderId = seenBusinessNos.get(item.after.businessNo)
      if (previousOrderId) {
        item.blockingReasons.push(`批次内业务号与订单 ${previousOrderId} 重复`)
      } else {
        seenBusinessNos.set(item.after.businessNo, item.orderId)
      }
    }
    return evaluated
  }

  private buildAfterSnapshot(before: OrderAmendmentSnapshot, input: OrderAmendmentInput): OrderAmendmentSnapshot {
    const after: OrderAmendmentSnapshot = { ...before }
    if (hasOwn(input, 'businessNo')) {
      after.businessNo = this.normalizeRequiredText(input.businessNo, FIELD_LIMITS.businessNo, '业务号')
    }
    if (hasOwn(input, 'orderType')) {
      if (input.orderType !== 'department' && input.orderType !== 'walkin') {
        throw new BizError('订单类型非法，仅支持 department 或 walkin', 409)
      }
      after.orderType = input.orderType
    }
    if (hasOwn(input, 'customerDepartmentName')) {
      after.customerDepartmentName = this.normalizeNullableText(
        input.customerDepartmentName,
        FIELD_LIMITS.customerDepartmentName,
        '客户部门名称',
      )
    }
    if (hasOwn(input, 'customerName')) {
      after.customerName = this.normalizeNullableText(input.customerName, FIELD_LIMITS.customerName, '客户名称')
    }
    if (hasOwn(input, 'issuerName')) {
      after.issuerName = this.normalizeNullableText(input.issuerName, FIELD_LIMITS.issuerName, '出单人')
    }
    if (typeof input.hasCustomerOrder === 'boolean') after.hasCustomerOrder = input.hasCustomerOrder
    if (typeof input.isSystemApplied === 'boolean') after.isSystemApplied = input.isSystemApplied
    if (hasOwn(input, 'remark')) {
      after.remark = this.normalizeNullableText(input.remark, FIELD_LIMITS.remark, '订单备注')
    }

    // 不只在类型切换时清理；任意改单都必须把不属于目标类型的领用字段收敛掉。
    if (after.orderType === 'walkin') {
      after.customerDepartmentName = null
      after.hasCustomerOrder = false
      after.isSystemApplied = false
    } else {
      after.customerName = null
    }
    return after
  }

  private snapshot(order: BizOutboundOrder): OrderAmendmentSnapshot {
    return {
      businessNo: order.businessNo,
      showNo: order.showNo,
      orderType: order.orderType as OrderType,
      customerDepartmentName: order.customerDepartmentName,
      customerName: order.customerName,
      issuerName: order.issuerName,
      hasCustomerOrder: Boolean(order.hasCustomerOrder),
      isSystemApplied: Boolean(order.isSystemApplied),
      remark: order.remark,
      editVersion: Number(order.editVersion),
    }
  }

  private emptySnapshot(): OrderAmendmentSnapshot {
    return {
      businessNo: '',
      showNo: '',
      orderType: 'walkin',
      customerDepartmentName: null,
      customerName: null,
      issuerName: null,
      hasCustomerOrder: false,
      isSystemApplied: false,
      remark: null,
      editVersion: 0,
    }
  }

  private normalizeRequiredText(value: string | null | undefined, maxLength: number, label: string): string {
    const normalized = value?.trim() ?? ''
    if (!normalized) throw new BizError(`${label}不能为空`, 409)
    if (Array.from(normalized).length > maxLength) throw new BizError(`${label}长度不能超过 ${maxLength} 个字符`, 409)
    return normalized.toLowerCase()
  }

  private normalizeRequiredReason(value: string | null | undefined): string {
    const normalized = value?.trim() ?? ''
    if (!normalized) throw new BizError('修订原因不能为空', 400)
    if (Array.from(normalized).length > FIELD_LIMITS.reason) throw new BizError(`修订原因长度不能超过 ${FIELD_LIMITS.reason} 个字符`, 400)
    return normalized
  }

  private normalizeNullableText(value: string | null | undefined, maxLength: number, label: string): string | null {
    const normalized = value?.trim() ?? ''
    if (!normalized) return null
    if (Array.from(normalized).length > maxLength) throw new BizError(`${label}长度不能超过 ${maxLength} 个字符`, 409)
    return normalized
  }

  private toPreviewResult(
    items: EvaluatedAmendment[],
    cursorPlans: BusinessNoCursorPlan[],
  ): OrderAmendmentPreviewResult {
    return {
      ready: items.every((item) => item.blockingReasons.length === 0),
      cursorPlans,
      items: items.map(({ orderId, blockingReasons, before, after }) => ({
        orderId,
        blockingReasons,
        before,
        after,
      })),
    }
  }
}

export const orderAmendmentService = new OrderAmendmentService()
