/**
 * 模块说明：`backend/src/services/order.service.ts`
 * 文件职责：负责出库单列表、详情、提交、删除恢复与相关审计留痕。
 * 实现逻辑：
 * 1. 服务层统一处理分页筛选、详情字段归一化与金额文本格式化；
 * 2. 提交流程在事务内完成主单、明细、编号与审计日志写入，保证整单原子性；
 * 3. 删除、恢复和创建时同步写入订单相关快照，供工作台近期动态与审计追溯复用；
 * 4. 兼容幂等重试、编号冲突与 SQLite 锁冲突，减少并发下的重复单与失败单。
 */

import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { Brackets, In, type EntityManager } from 'typeorm'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { O2oReturnRequest } from '../entities/o2o-return-request.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import {
  isRetryableMysqlTransactionError,
  isRetryableSqliteLockError,
  isUniqueConstraintError,
} from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { generateOrderUuid } from '../utils/id-generator.js'
import type { PaginationResult } from '../types/api.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import {
  orderAmendmentService,
  type OrderAmendmentBatchInput,
  type OrderAmendmentPreviewResult,
} from './order-amendment.service.js'
import { orderBusinessNoService } from './order-business-no.service.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import {
  orderContentEditService,
  type UpdateOrderContentInput,
} from './order-content-edit.service.js'
import { orderSerialService, type OrderType } from './order-serial.service.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { systemConfigService, type ClientDepartmentTreeNode } from './system-config.service.js'
import {
  orderMergeService,
  type CommitOrderMergeInput,
  type OrderMergeInput,
  type OrderMergeMetadata,
} from './order-merge.service.js'

/**
 * 开单页客户部门选项：
 * - nodeId 为系统部门配置中的稳定节点标识；
 * - path 与 `resolveClientDepartmentNode` 的拼接口径一致，也是订单保存的部门快照。
 */
export interface OrderDepartmentOptionView {
  nodeId: string
  label: string
  path: string
}

export interface SubmitOrderItemInput {
  productId: string | number
  skuId?: string | number | null
  qty: number
  unitPrice: number
  remark?: string
}

export interface SubmitOrderInput {
  idempotencyKey: string
  orderType?: string
  hasCustomerOrder?: boolean
  isSystemApplied?: boolean
  issuerName?: string
  customerDepartmentName?: string
  /** 选自系统部门配置时的节点 ID；存在时以服务端解析出的完整路径为准。 */
  customerDepartmentNodeId?: string
  customerName?: string
  remark?: string
  items: SubmitOrderItemInput[]
}

export interface OrderListQuery {
  page: number
  pageSize: number
  keyword?: string
  showNo?: string
  orderType?: string
  startDate?: string
  endDate?: string
  includeDeleted?: boolean
  onlyDeleted?: boolean
}

export interface UpdateOrderComplianceFlagsInput {
  orderId: string
  editVersion: number
  hasCustomerOrder?: boolean
  isSystemApplied?: boolean
}

/**
 * 订单详情明细视图：
 * - productCode / productName / subTotal 对齐前端详情抽屉既有契约；
 * - 同时保留 productNameSnapshot / lineAmount，兼容当前或历史调用方可能使用的旧字段；
 * - 后端统一在服务层完成字段归一化，避免路由层和前端重复兜底。
 */
export interface OrderDetailItemView {
  id: string
  lineNo: number
  productId: string
  productCode: string
  productName: string
  productNameSnapshot: string
  skuId: string | null
  skuCode: string | null
  skuCodeSnapshot: string | null
  specText: string | null
  specTextSnapshot: string | null
  qty: string
  unitPrice: string
  subTotal: string
  lineAmount: string
  remark: string | null
  sourceOrderId: string | null
  sourceOrderUuid: string | null
  sourceOrderItemId: string | null
}

export interface OrderSummaryView {
  id: string
  showNo: string
  businessNo: string
  editVersion: number
  status: BizOutboundOrder['status']
  merge: OrderMergeMetadata
  inventoryMode: BizOutboundOrder['inventoryMode']
  contentEditable: boolean
  contentEditBlockers: string[]
  orderType: string
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  issuerName: string | null
  customerDepartmentName: string | null
  customerName: string | null
  totalAmount: string
  totalQty: string
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

export interface SubmittedOrderView {
  id: string
  showNo: string
  businessNo: string
  editVersion: number
  inventoryMode: BizOutboundOrder['inventoryMode']
}

export interface SubmittedOrderItemView {
  id: string
  productId: string
  skuId: string | null
  skuCodeSnapshot: string | null
  specTextSnapshot: string | null
  qty: string
  unitPrice: string
  remark: string | null
}

export interface PurgedOrderView {
  id: string
  showNo: string
  orderType: string
  serialRolledBack: boolean
}

interface SubmitOrderContext {
  normalizedIdempotencyKey: string
  normalizedOrderType: OrderType
  normalizedIssuerName: string
  normalizedCustomerDepartmentName: string | null
}

interface PreparedSubmitItemsResult {
  totalQty: number
  totalAmount: number
  itemEntities: BizOutboundOrderItem[]
  latestProductPriceMap: Map<string, string>
}

interface NormalizedSubmitOrderItem {
  productId: string
  skuId: string | null
  qty: number
  unitPrice: number
  remark?: string
}

interface ResolvedSubmitOrderItem extends Omit<NormalizedSubmitOrderItem, 'skuId'> {
  skuId: string
  sku: BaseProductSku
  shouldUpdateProductDefaultPrice: boolean
}

const normalizeEntityId = (value: string | number): string => String(value).trim()

const normalizeNullableEntityId = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const normalizedValue = normalizeEntityId(value)
  return normalizedValue || null
}

const normalizeDecimalText = (value: string | number | null | undefined, fallback = '0.00'): string => {
  if (value === null || value === undefined || value === '') {
    return fallback
  }

  const normalizedNumber = Number(value)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : fallback
}

const normalizeDateTime = (value: Date | string): string => {
  return value instanceof Date ? value.toISOString() : String(value)
}

const IDEMPOTENCY_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_biz_outbound_idempotency_key',
  sqliteColumns: ['biz_outbound_order.idempotency_key'],
} as const

const SHOW_NO_CONSTRAINT_MATCHER = {
  mysqlConstraints: ['uk_biz_outbound_show_no', 'uk_biz_outbound_show_no_is_deleted', 'uk_orders_order_no'],
  sqliteColumns: ['biz_outbound_order.show_no', 'orders.order_no'],
} as const

const ORDER_SUBMIT_MAX_RETRY = 3
const ORDER_TYPE_SET = new Set<OrderType>(['department', 'walkin'])
const O2O_VERIFIED_PREORDER_IDEMPOTENCY_KEY_PREFIX = 'o2o-preorder-verify:'
const ORDER_FIELD_LIMITS = {
  idempotencyKey: 128,
  issuerName: 64,
  customerDepartmentName: 271,
  customerName: 128,
  orderRemark: 500,
  itemRemark: 200,
  maxItemCount: 200,
  maxQty: 999999999.99,
  maxUnitPrice: 9999999999.99,
} as const

export class OrderService {
  private readonly orderRepo = AppDataSource.getRepository(BizOutboundOrder)
  private readonly itemRepo = AppDataSource.getRepository(BizOutboundOrderItem)

  private resolveLinkedO2oPreorderId(order: Pick<BizOutboundOrder, 'idempotencyKey'>): string | null {
    const idempotencyKey = order.idempotencyKey?.trim() ?? ''
    if (!idempotencyKey.startsWith(O2O_VERIFIED_PREORDER_IDEMPOTENCY_KEY_PREFIX)) {
      return null
    }
    return idempotencyKey.slice(O2O_VERIFIED_PREORDER_IDEMPOTENCY_KEY_PREFIX.length).trim() || null
  }

  private async syncLinkedO2oPreorderVisibilityInManager(
    manager: EntityManager,
    order: Pick<BizOutboundOrder, 'id' | 'idempotencyKey'>,
    actor: AuthUserContext,
    deleted: boolean,
  ) {
    const relatedOrderIds = [normalizeEntityId(order.id)]
    const mergeMetadata = (await orderMergeService.getMetadataMap(relatedOrderIds, manager)).get(relatedOrderIds[0]!)
    if (mergeMetadata?.role === 'parent') {
      relatedOrderIds.push(...mergeMetadata.children.map((child) => child.id))
    }
    const relatedOrders = await manager.getRepository(BizOutboundOrder).find({
      select: ['id', 'idempotencyKey'],
      where: { id: In(relatedOrderIds) },
    })
    const preorderIds = [...new Set(relatedOrders
      .map((relatedOrder) => this.resolveLinkedO2oPreorderId(relatedOrder))
      .filter((preorderId): preorderId is string => Boolean(preorderId)))]
      .sort((left, right) => left.localeCompare(right))
    if (!preorderIds.length) {
      return null
    }
    const preorderRepo = manager.getRepository(O2oPreorder)
    const preorderQuery = preorderRepo.createQueryBuilder('preorder')
      .where('preorder.id IN (:...preorderIds)', { preorderIds })
      .orderBy('preorder.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') preorderQuery.setLock('pessimistic_write')
    const preorders = await preorderQuery.getMany()
    const changedPreorderIds: string[] = []
    for (const preorder of preorders) {
      if (Boolean(preorder.isDeleted) === deleted) continue
      preorder.isDeleted = deleted
      if (deleted) {
        preorder.deletedAt = new Date()
        preorder.deletedByUserId = actor.userId
        preorder.deletedByUsername = actor.username
        preorder.deletedByDisplayName = actor.displayName
      } else {
        preorder.deletedAt = null
        preorder.deletedByUserId = null
        preorder.deletedByUsername = null
        preorder.deletedByDisplayName = null
      }
      await preorderRepo.save(preorder)
      changedPreorderIds.push(normalizeEntityId(preorder.id))
    }
    return { preorderIds, changedPreorderIds, deleted }
  }

  private async assertLinkedO2oMergeGroupHasNoPendingReturns(
    manager: EntityManager,
    order: Pick<BizOutboundOrder, 'id' | 'idempotencyKey'>,
  ): Promise<void> {
    const relatedOrderIds = [normalizeEntityId(order.id)]
    const mergeMetadata = (await orderMergeService.getMetadataMap(relatedOrderIds, manager)).get(relatedOrderIds[0]!)
    if (mergeMetadata?.role === 'parent') {
      relatedOrderIds.push(...mergeMetadata.children.map((child) => child.id))
    }
    const relatedOrders = await manager.getRepository(BizOutboundOrder).find({
      select: ['id', 'idempotencyKey'],
      where: { id: In(relatedOrderIds) },
    })
    const preorderIds = [...new Set(relatedOrders
      .map((relatedOrder) => this.resolveLinkedO2oPreorderId(relatedOrder))
      .filter((preorderId): preorderId is string => Boolean(preorderId)))]
      .sort((left, right) => left.localeCompare(right))
    if (!preorderIds.length) return

    const preorderQuery = manager.getRepository(O2oPreorder)
      .createQueryBuilder('preorder')
      .where('preorder.id IN (:...preorderIds)', { preorderIds })
      .orderBy('preorder.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') preorderQuery.setLock('pessimistic_write')
    await preorderQuery.getMany()

    const returnQuery = manager.getRepository(O2oReturnRequest)
      .createQueryBuilder('returnRequest')
      .where('returnRequest.orderId IN (:...preorderIds)', { preorderIds })
      .orderBy('returnRequest.orderId', 'ASC')
      .addOrderBy('returnRequest.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') returnQuery.setLock('pessimistic_write')
    const returnRequests = await returnQuery.getMany()
    if (returnRequests.some((returnRequest) => returnRequest.status === 'pending')) {
      throw new BizError('合并成员存在未完成退货申请，完成处理前禁止删除父单', 409)
    }
  }

  async list(query: OrderListQuery): Promise<PaginationResult<OrderSummaryView>> {
    const qb = this.orderRepo.createQueryBuilder('order')

    const normalizedKeyword = String(query.keyword ?? query.showNo ?? '').trim()
    if (normalizedKeyword) {
      const isLikelyShowNo = /^[A-Za-z0-9-]+$/.test(normalizedKeyword)
      qb.andWhere(
        new Brackets((keywordQb) => {
          keywordQb.where(new Brackets((rootQb) => {
            rootQb
              .where('order.businessNo LIKE :keyword', { keyword: '%' + normalizedKeyword + '%' })
              .orWhere('order.showNo LIKE :keyword', { keyword: '%' + normalizedKeyword + '%' })
              .orWhere(isLikelyShowNo ? 'order.showNo = :exactShowNo' : '1 = 0', { exactShowNo: normalizedKeyword })
              .orWhere('order.customerName LIKE :keyword', { keyword: '%' + normalizedKeyword + '%' })
              .orWhere('order.customerDepartmentName LIKE :keyword', { keyword: '%' + normalizedKeyword + '%' })
              .orWhere('order.issuerName LIKE :keyword', { keyword: '%' + normalizedKeyword + '%' })
              .orWhere('order.creatorDisplayName LIKE :keyword', { keyword: '%' + normalizedKeyword + '%' })
              .orWhere('order.creatorUsername LIKE :keyword', { keyword: '%' + normalizedKeyword + '%' })
          })).orWhere(
            'EXISTS (SELECT 1 FROM order_merge_relation relation INNER JOIN biz_outbound_order child ON child.id = relation.source_order_id WHERE relation.parent_order_id = order.id AND (child.business_no LIKE :keyword OR child.show_no LIKE :keyword OR child.customer_name LIKE :keyword OR child.customer_department_name LIKE :keyword OR child.issuer_name LIKE :keyword OR child.creator_display_name LIKE :keyword OR child.creator_username LIKE :keyword))',
            { keyword: '%' + normalizedKeyword + '%' },
          )
        }),
      )
    }

    if (query.orderType && ORDER_TYPE_SET.has(query.orderType as OrderType)) {
      qb.andWhere('order.orderType = :orderType', { orderType: query.orderType })
    }
    if (query.startDate || query.endDate) {
      const endDate = query.endDate ? query.endDate + ' 23:59:59' : null
      const rootDateConditions = [
        query.startDate ? 'order.createdAt >= :startDate' : null,
        endDate ? 'order.createdAt <= :endDate' : null,
      ].filter((condition): condition is string => Boolean(condition))
      const childDateConditions = [
        query.startDate ? 'child.created_at >= :startDate' : null,
        endDate ? 'child.created_at <= :endDate' : null,
      ].filter((condition): condition is string => Boolean(condition))
      qb.andWhere(new Brackets((dateQb) => {
        dateQb.where(`(${rootDateConditions.join(' AND ')})`, {
          startDate: query.startDate,
          endDate,
        }).orWhere(
          `EXISTS (SELECT 1 FROM order_merge_relation relation INNER JOIN biz_outbound_order child ON child.id = relation.source_order_id WHERE relation.parent_order_id = order.id AND ${childDateConditions.join(' AND ')})`,
          { startDate: query.startDate, endDate },
        )
      }))
    }
    if (query.onlyDeleted) {
      qb.andWhere('order.isDeleted = :onlyDeleted', { onlyDeleted: true })
    } else if (!query.includeDeleted) {
      qb.andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
    }
    qb.andWhere('order.status = :activeMergeStatus', { activeMergeStatus: 'active' })
    qb.andWhere(
      'NOT EXISTS (SELECT 1 FROM order_merge_relation rootRelation WHERE rootRelation.source_order_id = order.id)',
    )

    const [list, total] = await qb
      .orderBy('order.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    const metadataMap = await orderMergeService.getMetadataMap(list.map((order) => normalizeEntityId(order.id)))
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: list.map((order) => this.buildOrderSummaryView(order, metadataMap.get(normalizeEntityId(order.id)))),
    }
  }

  async detailById(
    id: string,
    manager: EntityManager = AppDataSource.manager,
  ): Promise<{ order: OrderSummaryView; items: OrderDetailItemView[] }> {
    const order = await manager.getRepository(BizOutboundOrder).findOne({ where: { id } })
    if (!order) {
      throw new BizError('出库单不存在', 404)
    }
    const items = await this.loadDetailItems(id, manager)
    const metadata = (await orderMergeService.getMetadataMap(
      [normalizeEntityId(order.id)],
      manager,
    )).get(normalizeEntityId(order.id))
    return { order: this.buildOrderSummaryView(order, metadata), items }
  }

  async detailByShowNo(showNo: string): Promise<{ order: OrderSummaryView; items: OrderDetailItemView[] }> {
    const order = await this.orderRepo.findOne({ where: { showNo } })
    if (!order) {
      throw new BizError('出库单不存在', 404)
    }
    const items = await this.loadDetailItems(order.id)
    const metadata = (await orderMergeService.getMetadataMap([normalizeEntityId(order.id)])).get(normalizeEntityId(order.id))
    return { order: this.buildOrderSummaryView(order, metadata), items }
  }

  async updateComplianceFlags(
    input: UpdateOrderComplianceFlagsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ order: OrderSummaryView; items: OrderDetailItemView[] }> {
    if (typeof input.hasCustomerOrder !== 'boolean' && typeof input.isSystemApplied !== 'boolean') {
      throw new BizError('请至少传入一个可更新字段', 400)
    }
    await orderAmendmentService.commit({ amendments: [{
      orderId: input.orderId,
      editVersion: input.editVersion,
      hasCustomerOrder: input.hasCustomerOrder,
      isSystemApplied: input.isSystemApplied,
      reason: '合规状态编辑',
    }] }, actor, requestMeta)
    return this.detailById(input.orderId)
  }

  async previewAmendments(input: OrderAmendmentBatchInput, actor: AuthUserContext): Promise<OrderAmendmentPreviewResult> {
    return orderAmendmentService.preview(input, actor)
  }

  async commitAmendments(
    input: OrderAmendmentBatchInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<OrderAmendmentPreviewResult> {
    return orderAmendmentService.commit(input, actor, requestMeta)
  }

  async updateContent(
    orderId: string,
    input: UpdateOrderContentInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    return orderContentEditService.updateContent(orderId, input, actor, requestMeta)
  }

  async listRevisions(orderId: string) {
    return orderContentEditService.listRevisions(orderId)
  }

  describeContentEditability(order: BizOutboundOrder) {
    return orderContentEditService.describeEditability(order)
  }

  async previewMerge(input: OrderMergeInput, actor: AuthUserContext) {
    return orderMergeService.preview(input, actor)
  }

  async commitMerge(input: CommitOrderMergeInput, actor: AuthUserContext, requestMeta?: RequestMeta) {
    return orderMergeService.commit(
      input,
      actor,
      (manager, targetOrderId) => this.detailById(targetOrderId, manager),
      requestMeta,
    )
  }

  /**
   * 软删除单据：
   * - 仅标记主单删除态，不物理删除明细，保证可恢复；
   * - 记录删除操作者快照，满足后续审计追溯。
   */
  async softDeleteById(
    id: string,
    actor: AuthUserContext,
    confirmShowNo: string,
    requestMeta?: RequestMeta,
  ): Promise<OrderSummaryView> {
    const normalizedConfirmShowNo = confirmShowNo.trim()
    if (!normalizedConfirmShowNo) {
      throw new BizError('请填写业务单号完成二次确认')
    }

    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const orderRepo = manager.getRepository(BizOutboundOrder)
      const orderQuery = orderRepo.createQueryBuilder('order').where('order.id = :id', { id })
      if (manager.connection.options.type !== 'sqlite') orderQuery.setLock('pessimistic_write')
      const order = await orderQuery.getOne()
      if (!order) {
        throw new BizError('出库单不存在', 404)
      }

      if (order.showNo !== normalizedConfirmShowNo && order.businessNo !== normalizedConfirmShowNo) {
        throw new BizError('二次确认失败：业务单号不匹配', 400)
      }

      if (order.isDeleted) {
        throw new BizError('该出库单已删除', 409)
      }
      if (order.status === 'merged') {
        throw new BizError('合并来源单只允许查看，禁止删除', 409)
      }

      await this.assertLinkedO2oMergeGroupHasNoPendingReturns(manager, order)

      order.isDeleted = true
      order.deletedAt = new Date()
      order.deletedByUserId = actor.userId
      order.deletedByUsername = actor.username
      order.deletedByDisplayName = actor.displayName
      const savedOrder = await orderRepo.save(order)
      const linkedO2oPreorderSync = await this.syncLinkedO2oPreorderVisibilityInManager(manager, savedOrder, actor, true)

      await auditService.record(
        {
          actionType: 'order.delete',
          actionLabel: '删除出库单',
          targetType: 'order',
          targetId: savedOrder.id,
          targetCode: savedOrder.showNo,
          actor,
          requestMeta,
          detail: {
            ...this.buildOrderAuditDetail(savedOrder),
            linkedO2oPreorderSync,
          },
        },
        manager,
      )

      const orderId = normalizeEntityId(savedOrder.id)
      const mergeMetadata = (await orderMergeService.getMetadataMap([orderId], manager)).get(orderId)
      return this.buildOrderSummaryView(savedOrder, mergeMetadata)
    })
  }

  /**
   * 恢复单据：
   * - 清空删除标记与删除人快照；
   * - 保留主单与明细原始数据，恢复后可继续查询与查看详情。
   */
  async restoreById(id: string, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<OrderSummaryView> {
    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const orderRepo = manager.getRepository(BizOutboundOrder)
      const orderQuery = orderRepo.createQueryBuilder('order').where('order.id = :id', { id })
      if (manager.connection.options.type !== 'sqlite') orderQuery.setLock('pessimistic_write')
      const order = await orderQuery.getOne()
      if (!order) {
        throw new BizError('出库单不存在', 404)
      }

      if (!order.isDeleted) {
        throw new BizError('该出库单未被删除，无需恢复', 409)
      }
      if (order.status === 'merged') {
        throw new BizError('合并来源单只允许查看，禁止恢复', 409)
      }

      order.isDeleted = false
      order.deletedAt = null
      order.deletedByUserId = null
      order.deletedByUsername = null
      order.deletedByDisplayName = null
      const savedOrder = await orderRepo.save(order)
      const linkedO2oPreorderSync = await this.syncLinkedO2oPreorderVisibilityInManager(manager, savedOrder, actor, false)

      await auditService.record(
        {
          actionType: 'order.restore',
          actionLabel: '恢复出库单',
          targetType: 'order',
          targetId: savedOrder.id,
          targetCode: savedOrder.showNo,
          actor,
          requestMeta,
          detail: {
            ...this.buildOrderAuditDetail(savedOrder),
            linkedO2oPreorderSync,
          },
        },
        manager,
      )

      const orderId = normalizeEntityId(savedOrder.id)
      const mergeMetadata = (await orderMergeService.getMetadataMap([orderId], manager)).get(orderId)
      return this.buildOrderSummaryView(savedOrder, mergeMetadata)
    })
  }

  /**
   * 永久删除单据：
   * - 仅允许对已软删除单据执行，避免把正常业务单据直接物理移除；
   * - 物理删除主单后依赖外键级联删除明细；
   * - 仅当该单据是同类型“最后一张单”且流水 current 与其编号匹配时，才安全回拨 1 位。
   */
  async purgeById(
    id: string,
    actor: AuthUserContext,
    confirmShowNo: string,
    requestMeta?: RequestMeta,
  ): Promise<PurgedOrderView> {
    const normalizedConfirmShowNo = confirmShowNo.trim()
    if (!normalizedConfirmShowNo) {
      throw new BizError('请填写业务单号完成二次确认')
    }

    return runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const orderRepo = manager.getRepository(BizOutboundOrder)
      const orderQuery = orderRepo.createQueryBuilder('order').where('order.id = :id', { id })
      if (manager.connection.options.type !== 'sqlite') orderQuery.setLock('pessimistic_write')
      const order = await orderQuery.getOne()
      if (!order) {
        throw new BizError('出库单不存在', 404)
      }

      if (order.showNo !== normalizedConfirmShowNo && order.businessNo !== normalizedConfirmShowNo) {
        throw new BizError('二次确认失败：业务单号不匹配', 400)
      }

      if (!order.isDeleted) {
        throw new BizError('仅已删除单据支持永久删除，请先执行删除操作', 409)
      }

      if (order.inventoryMode === 'manual_applied') {
        throw new BizError('该手工出库单仍承载库存影响，禁止永久删除', 409)
      }
      await orderMergeService.assertNotMergeMember(manager, normalizeEntityId(order.id))

      const linkedO2oPreorderSync = await this.syncLinkedO2oPreorderVisibilityInManager(manager, order, actor, true)
      const deleteResult = await orderRepo.delete({ id: order.id })
      if ((deleteResult.affected ?? 0) <= 0) {
        throw new BizError('永久删除出库单失败，请稍后重试', 500)
      }

      const serialCalibration = await orderSerialService.recalibrateCurrentFromOccupancy(order.orderType, manager)
      const serialRolledBack = serialCalibration.rolledBack
      const auditDetail = {
        ...this.buildOrderAuditDetail(order),
        serialRolledBack,
        serialCalibration,
        linkedO2oPreorderSync,
      }

      await auditService.record(
        {
          actionType: 'order.purge',
          actionLabel: '永久删除出库单',
          targetType: 'order',
          targetId: String(order.id),
          targetCode: order.showNo,
          actor,
          requestMeta,
          detail: auditDetail,
        },
        manager,
      )

      return {
        id: normalizeEntityId(order.id),
        showNo: order.showNo,
        orderType: order.orderType,
        serialRolledBack,
      }
    })
  }

  /**
   * 开单页客户部门选项：
   * - 只读展开系统部门配置树，不做任何写入或自动补建；
   * - 路径拼接口径与 `systemConfigService.resolveClientDepartmentNode` 保持一致。
   */
  async listDepartmentOptions(): Promise<{ options: OrderDepartmentOptionView[] }> {
    const config = await systemConfigService.getClientDepartmentConfigs()
    const options: OrderDepartmentOptionView[] = []
    const walk = (nodes: ClientDepartmentTreeNode[], parentPath = '') => {
      for (const node of nodes) {
        const path = parentPath ? `${parentPath}-${node.label}` : node.label
        options.push({ nodeId: node.id, label: node.label, path })
        walk(node.children, path)
      }
    }
    walk(config.tree)
    return { options }
  }

  /**
   * 解析提交的客户部门来源：
   * - 仅部门单携带节点 ID 时才按系统配置只读解析，并用规范完整路径覆盖提交文本；
   * - 未携带节点 ID 视为手动录入，原样交给后续长度与必填校验，绝不回写系统配置；
   * - 节点已被删除时明确拒绝，提示用户重新选择或改为手动填写；
   * - 必须在提交事务内、幂等命中检查之后调用，并复用同一事务管理器读取配置。
   */
  private async resolveSubmitCustomerDepartment(
    input: SubmitOrderInput,
    context: SubmitOrderContext,
    manager: EntityManager,
  ): Promise<{ customerDepartmentName: string | null; source: 'config' | 'manual' }> {
    const nodeId = input.customerDepartmentNodeId?.trim() ?? ''
    if (!nodeId || context.normalizedOrderType !== 'department') {
      return { customerDepartmentName: context.normalizedCustomerDepartmentName, source: 'manual' }
    }
    let departmentName: string
    try {
      departmentName = (await systemConfigService.resolveClientDepartmentNode(nodeId, manager)).departmentName
    } catch (error) {
      if (error instanceof BizError) {
        throw new BizError('所选部门已从系统配置中移除，请重新选择或直接手动填写', 400)
      }
      throw error
    }
    return {
      customerDepartmentName: this.readLimitedText(
        departmentName,
        '客户部门名称',
        ORDER_FIELD_LIMITS.customerDepartmentName,
        { required: true },
      ),
      source: 'config',
    }
  }

  /**
   * 整单提交逻辑：
   * 1) 幂等键查重（命中直接返回）
   * 2) 生成 order_uuid + show_no
   * 3) 先写主表再批量写入子表
   * 4) 任意步骤异常则回滚，保证主子表原子性
   */
  async submit(
    input: SubmitOrderInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<{ order: SubmittedOrderView; items: SubmittedOrderItemView[] }> {
    const normalizedItems = this.normalizeSubmitItemsInput(input.items)
    const normalizedCustomerName = this.readLimitedText(
      input.customerName,
      '客户名称',
      ORDER_FIELD_LIMITS.customerName,
    )
    const normalizedRemark = this.readLimitedText(
      input.remark,
      '订单备注',
      ORDER_FIELD_LIMITS.orderRemark,
    )
    const submitContext = this.buildSubmitOrderContext(input, actor)

    let lastError: unknown
    for (let attempt = 1; attempt <= ORDER_SUBMIT_MAX_RETRY; attempt += 1) {
      try {
        const result = await runInTransaction(async (manager) => {
          await lockActiveSysAccountForBusiness(manager, actor.userId)
          const orderRepo = manager.getRepository(BizOutboundOrder)
          const itemRepo = manager.getRepository(BizOutboundOrderItem)
          const productRepo = manager.getRepository(BaseProduct)

          // 使用幂等键实现重复提交防重，客户端重试会返回同一单据。
          const existed = await orderRepo.findOne({
            where: { idempotencyKey: submitContext.normalizedIdempotencyKey },
          })
          if (existed) {
            const existedItems = await itemRepo.find({
              where: { orderId: existed.id },
              order: { lineNo: 'ASC' },
            })
            return {
              order: this.buildSubmittedOrderView(existed),
              items: existedItems.map((item) => this.buildSubmittedOrderItemView(item)),
            }
          }

          // 部门节点须在确认不是幂等重试后再解析：重试命中既有订单时，不应因部门配置此后变更而失败。
          const resolvedDepartment = await this.resolveSubmitCustomerDepartment(input, submitContext, manager)

          const normalizedProductIds = [...new Set(normalizedItems.map((item) => item.productId))]
            .sort((left, right) => left.localeCompare(right))
          const productQuery = productRepo
            .createQueryBuilder('product')
            .where('product.id IN (:...productIds)', { productIds: normalizedProductIds })
            .andWhere('product.isActive = :isActive', { isActive: true })
            .orderBy('product.id', 'ASC')
          if (manager.connection.options.type !== 'sqlite') productQuery.setLock('pessimistic_write')
          const products = await productQuery.getMany()

          const productMap = new Map(products.map((product) => [String(product.id), product]))
          if (productMap.size !== normalizedProductIds.length) {
            throw new BizError('存在无效或停用产品，无法提交')
          }
          const resolvedItems = await this.resolveSubmitItemsWithSku(normalizedItems, productMap, manager)
          const orderUuid = generateOrderUuid()
          const showNo = await orderSerialService.generateOrderNo(submitContext.normalizedOrderType, manager)
          const businessNo = await orderBusinessNoService.allocate(submitContext.normalizedOrderType, orderUuid, manager)
          const preparedItems = this.prepareSubmitItems(resolvedItems, productMap, itemRepo)

          const order = orderRepo.create({
            orderUuid,
            showNo,
            businessNo,
            editVersion: 1,
            inventoryMode: 'manual_applied',
            orderType: submitContext.normalizedOrderType,
            hasCustomerOrder: Boolean(input.hasCustomerOrder),
            isSystemApplied: Boolean(input.isSystemApplied),
            issuerName: submitContext.normalizedIssuerName,
            customerDepartmentName: resolvedDepartment.customerDepartmentName,
            idempotencyKey: submitContext.normalizedIdempotencyKey,
            customerName: normalizedCustomerName,
            remark: normalizedRemark,
            totalQty: preparedItems.totalQty.toFixed(2),
            totalAmount: preparedItems.totalAmount.toFixed(2),
            creatorUserId: actor.userId,
            creatorUsername: actor.username,
            creatorDisplayName: actor.displayName,
          })

          const savedOrder = await orderRepo.save(order)
          preparedItems.itemEntities.forEach((item) => {
            item.orderId = savedOrder.id
          })
          const savedItems = await itemRepo.save(preparedItems.itemEntities)

          await this.applyManualInventoryForCreate(manager, savedOrder, resolvedItems, productMap, actor)

          products.forEach((product) => {
            const latestPrice = preparedItems.latestProductPriceMap.get(String(product.id))
            if (latestPrice) {
              product.defaultPrice = latestPrice
            }
          })
          await productRepo.save(products)

          await auditService.record(
            {
              actionType: 'order.create',
              actionLabel: '创建出库单',
              targetType: 'order',
              targetId: savedOrder.id,
              targetCode: savedOrder.showNo,
              actor,
              requestMeta,
              detail: {
                ...this.buildOrderAuditDetail(savedOrder),
                // 区分部门快照来自系统配置还是手动录入，便于后续整理历史部门名称。
                customerDepartmentSource: savedOrder.customerDepartmentName ? resolvedDepartment.source : null,
                itemCount: savedItems.length,
                inventoryMode: savedOrder.inventoryMode,
              },
            },
            manager,
          )

          return {
            order: this.buildSubmittedOrderView(savedOrder),
            items: savedItems.map((item) => this.buildSubmittedOrderItemView(item)),
          }
        })
        invalidateMallCatalogReadCache()
        return result
      } catch (error) {
        lastError = error

        // 并发下若另一请求已成功落库同一幂等键，则直接回查既有单据返回。
        if (isUniqueConstraintError(error, IDEMPOTENCY_CONSTRAINT_MATCHER)) {
          return this.loadOrderByIdempotencyKey(submitContext.normalizedIdempotencyKey)
        }

        if (this.shouldRetrySubmitError(error, attempt)) {
          const backoffMs = 25 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 25)
          await new Promise<void>((resolve) => {
            setTimeout(resolve, backoffMs)
          })
          continue
        }

        if (isUniqueConstraintError(error, SHOW_NO_CONSTRAINT_MATCHER)) {
          throw new BizError('出库单编号生成繁忙，请稍后重试', 409)
        }

        throw error
      }
    }

    throw lastError ?? new BizError('订单提交失败，请稍后重试', 500)
  }

  /**
   * 统一读取订单文本字段：
   * - 订单主表、明细备注共用同一套边界约束；
   * - 服务层直接阻断空白文本与超长内容，避免数据库截断后才暴露问题。
   */
  private readLimitedText(
    value: string | undefined,
    label: string,
    maxLength: number,
    options: { required?: boolean } = {},
  ): string | null {
    const normalizedValue = value?.trim() ?? ''
    if (!normalizedValue) {
      if (options.required) {
        throw new BizError(`${label}不能为空`, 400)
      }
      return null
    }
    if (normalizedValue.length > maxLength) {
      throw new BizError(`${label}长度不能超过 ${maxLength} 个字符`, 400)
    }
    return normalizedValue
  }

  private readPositiveDecimal(value: number, label: string, maxValue: number, rowIndex?: number): number {
    const rowPrefix = rowIndex ? `第 ${rowIndex} 行` : ''
    if (!Number.isFinite(value) || value <= 0) {
      throw new BizError(`${rowPrefix}${label}必须大于 0`, 400)
    }
    if (value > maxValue) {
      throw new BizError(`${rowPrefix}${label}不能超过 ${maxValue}`, 400)
    }
    const normalizedValue = Number(value.toFixed(2))
    if (normalizedValue < 0.01) {
      throw new BizError(`${rowPrefix}${label}按两位小数舍入后必须至少为 0.01`, 400)
    }
    return normalizedValue
  }

  private normalizeSubmitItemsInput(inputItems: SubmitOrderItemInput[]): NormalizedSubmitOrderItem[] {
    if (!inputItems.length) {
      throw new BizError('至少需要一条明细', 400)
    }
    if (inputItems.length > ORDER_FIELD_LIMITS.maxItemCount) {
      throw new BizError(`单次最多提交 ${ORDER_FIELD_LIMITS.maxItemCount} 条明细`, 400)
    }

    return inputItems.map((item, index) => {
      const rowIndex = index + 1
      const normalizedProductId = String(item.productId ?? '').trim()
      if (!normalizedProductId) {
        throw new BizError(`第 ${rowIndex} 行产品ID不能为空`, 400)
      }
      return {
        productId: normalizedProductId,
        skuId: normalizeNullableEntityId(item.skuId),
        qty: this.readPositiveInteger(item.qty, '数量', ORDER_FIELD_LIMITS.maxQty, rowIndex),
        unitPrice: this.readPositiveDecimal(item.unitPrice, '单价', ORDER_FIELD_LIMITS.maxUnitPrice, rowIndex),
        remark: this.readLimitedText(item.remark, '明细备注', ORDER_FIELD_LIMITS.itemRemark) ?? undefined,
      }
    })
  }

  private readPositiveInteger(value: number, label: string, maxValue: number, rowIndex?: number): number {
    const rowPrefix = rowIndex ? `第 ${rowIndex} 行` : ''
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BizError(`${rowIndex ? `第 ${rowIndex} 行` : ''}${label}必须为正整数`, 400)
    }
    if (value > maxValue) throw new BizError(`${rowPrefix}${label}不能超过 ${maxValue}`, 400)
    return value
  }

  /**
   * 将手工出库行解析为当前有效 SKU：
   * - 显式 skuId 必须存在、归属当前商品且仍为当前启用版本；
   * - 旧调用方省略 skuId 时仅允许单规格商品自动选择，多规格必须显式选择；
   * - 去重键使用 productId + skuId，因此同商品不同规格可以分行，同规格重复仍被阻断。
   */
  private async resolveSubmitItemsWithSku(
    inputItems: NormalizedSubmitOrderItem[],
    productMap: Map<string, BaseProduct>,
    manager: EntityManager,
  ): Promise<ResolvedSubmitOrderItem[]> {
    const productIds = [...new Set(inputItems.map((item) => item.productId))]
    const explicitSkuIds = [...new Set(inputItems.map((item) => item.skuId).filter((skuId): skuId is string => Boolean(skuId)))]
    const skuQuery = manager.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .where('sku.productId IN (:...productIds)', { productIds })
    if (explicitSkuIds.length > 0) {
      // 同时读取显式选择的 SKU，才能区分“不存在”和“属于其他商品”两类非法引用。
      skuQuery.orWhere('sku.id IN (:...explicitSkuIds)', { explicitSkuIds })
    }
    skuQuery
      .orderBy('sku.productId', 'ASC')
      .addOrderBy('sku.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') skuQuery.setLock('pessimistic_write')
    const skus = await skuQuery.getMany()
    const skuMap = new Map(skus.map((sku) => [String(sku.id), sku]))
    const activeSkusByProduct = new Map<string, BaseProductSku[]>()
    const currentSkuCountByProduct = new Map<string, number>()
    skus.filter((sku) => this.isDatabaseFlagEnabled(sku.isCurrent)).forEach((sku) => {
      const productId = String(sku.productId)
      currentSkuCountByProduct.set(productId, (currentSkuCountByProduct.get(productId) ?? 0) + 1)
    })
    skus.filter((sku) => this.isCurrentActiveSku(sku)).forEach((sku) => {
      const productId = String(sku.productId)
      const current = activeSkusByProduct.get(productId) ?? []
      current.push(sku)
      activeSkusByProduct.set(productId, current)
    })

    const resolvedKeySet = new Set<string>()
    return inputItems.map((item, index) => {
      const product = productMap.get(item.productId)
      if (!product) {
        throw new BizError(`第 ${index + 1} 行产品不存在`, 400)
      }

      const candidates = activeSkusByProduct.get(item.productId) ?? []
      let sku: BaseProductSku | undefined
      if (item.skuId) {
        sku = skuMap.get(item.skuId)
        if (!sku) {
          throw new BizError(`第 ${index + 1} 行规格不存在或无效，请重新选择`, 400)
        }
        if (String(sku.productId) !== item.productId) {
          throw new BizError(`第 ${index + 1} 行所选规格不属于商品“${product.productName}”`, 400)
        }
        if (!this.isCurrentActiveSku(sku)) {
          throw new BizError(`第 ${index + 1} 行商品“${product.productName}”的规格已停用或不属于当前版本`, 409)
        }
      } else {
        if (candidates.length === 0) {
          throw new BizError(`第 ${index + 1} 行商品“${product.productName}”暂无当前启用规格`, 409)
        }
        if (candidates.length > 1) {
          throw new BizError(`第 ${index + 1} 行商品“${product.productName}”为多规格商品，请选择规格`, 400)
        }
        sku = candidates[0]
      }

      const resolvedSkuId = String(sku.id)
      const resolvedKey = `${item.productId}::${resolvedSkuId}`
      if (resolvedKeySet.has(resolvedKey)) {
        throw new BizError(`第 ${index + 1} 行与前面明细为同一规格，请合并数量后再提交`, 400)
      }
      resolvedKeySet.add(resolvedKey)
      return {
        ...item,
        skuId: resolvedSkuId,
        sku,
        // 商品主价只保留单 current SKU 的历史回写；多 SKU 人工价不能因明细顺序污染主价。
        shouldUpdateProductDefaultPrice: currentSkuCountByProduct.get(item.productId) === 1,
      }
    })
  }

  private isCurrentActiveSku(sku: Pick<BaseProductSku, 'isActive' | 'isCurrent'>): boolean {
    return this.isDatabaseFlagEnabled(sku.isActive) && this.isDatabaseFlagEnabled(sku.isCurrent)
  }

  private isDatabaseFlagEnabled(value: unknown): boolean {
    return value !== false && value !== 0 && value !== '0' && value !== 'false'
  }

  private buildSubmitOrderContext(input: SubmitOrderInput, actor: AuthUserContext): SubmitOrderContext {
    const normalizedIdempotencyKey = this.readLimitedText(
      input.idempotencyKey,
      '幂等键',
      ORDER_FIELD_LIMITS.idempotencyKey,
      { required: true },
    )
    const normalizedOrderType = this.normalizeOrderType(input.orderType)
    if (!normalizedOrderType) {
      throw new BizError('订单类型非法，仅支持 department 或 walkin', 400)
    }
    const normalizedIssuerName = this.readLimitedText(
      input.issuerName ?? actor.displayName ?? actor.username,
      '出单人',
      ORDER_FIELD_LIMITS.issuerName,
      { required: true },
    )
    const normalizedCustomerDepartmentName = this.readLimitedText(
      input.customerDepartmentName,
      '客户部门名称',
      ORDER_FIELD_LIMITS.customerDepartmentName,
    )
    // 携带部门节点时名称以事务内解析出的规范路径为准，此处只校验手动录入的部门单。
    if (normalizedOrderType === 'department' && !normalizedCustomerDepartmentName && !input.customerDepartmentNodeId?.trim()) {
      throw new BizError('部门订单必须填写客户部门名称', 400)
    }
    return {
      normalizedIdempotencyKey: normalizedIdempotencyKey as string,
      normalizedOrderType,
      normalizedIssuerName: normalizedIssuerName as string,
      normalizedCustomerDepartmentName,
    }
  }

  private prepareSubmitItems(
    inputItems: ResolvedSubmitOrderItem[],
    productMap: Map<string, BaseProduct>,
    itemRepo: ReturnType<typeof AppDataSource.getRepository<BizOutboundOrderItem>>,
  ): PreparedSubmitItemsResult {
    let totalQty = 0
    let totalAmount = 0
    const itemEntities: BizOutboundOrderItem[] = []
    const latestProductPriceMap = new Map<string, string>()

    inputItems.forEach((item, index) => {
      const normalizedProductId = String(item.productId).trim()
      const product = productMap.get(normalizedProductId)
      if (!product) {
        throw new BizError(`产品不存在: ${item.productId}`)
      }

      const lineAmount = Number((item.qty * item.unitPrice).toFixed(2))
      totalQty += item.qty
      totalAmount += lineAmount
      if (item.shouldUpdateProductDefaultPrice) {
        latestProductPriceMap.set(normalizedProductId, item.unitPrice.toFixed(2))
      }

      itemEntities.push(
        itemRepo.create({
          lineNo: index + 1,
          productId: product.id,
          productNameSnapshot: product.productName,
          skuId: item.skuId,
          skuCodeSnapshot: item.sku.skuCode,
          specTextSnapshot: item.sku.specText,
          qty: item.qty.toFixed(2),
          unitPrice: item.unitPrice.toFixed(2),
          lineAmount: lineAmount.toFixed(2),
          remark: item.remark?.trim() || null,
        }),
      )
    })

    return {
      totalQty,
      totalAmount,
      itemEntities,
      latestProductPriceMap,
    }
  }

  private async applyManualInventoryForCreate(
    manager: EntityManager,
    order: BizOutboundOrder,
    items: ResolvedSubmitOrderItem[],
    productMap: Map<string, BaseProduct>,
    actor: AuthUserContext,
  ): Promise<void> {
    const productQtyMap = new Map<string, number>()
    for (const item of items) {
      productQtyMap.set(item.productId, (productQtyMap.get(item.productId) ?? 0) + item.qty)
      if (Number(item.sku.currentStock) - Number(item.sku.preOrderedStock) < item.qty) {
        throw new BizError(`SKU ${item.sku.skuCode} 可用库存不足`, 409)
      }
    }
    for (const [productId, qty] of productQtyMap) {
      const product = productMap.get(productId)
      if (!product || Number(product.currentStock) - Number(product.preOrderedStock) < qty) {
        throw new BizError(`商品 ${product?.productName ?? productId} 可用库存不足`, 409)
      }
    }

    const inventoryLogs: InventoryLog[] = []
    for (const item of items) {
      const product = productMap.get(item.productId)
      if (!product) throw new BizError(`商品 ${item.productId} 不存在`, 409)
      const beforeCurrentStock = Number(product.currentStock)
      const beforePreorderedStock = Number(product.preOrderedStock)
      const beforeSkuCurrentStock = Number(item.sku.currentStock)
      const beforeSkuPreorderedStock = Number(item.sku.preOrderedStock)
      product.currentStock = beforeCurrentStock - item.qty
      item.sku.currentStock = beforeSkuCurrentStock - item.qty
      inventoryLogs.push(manager.getRepository(InventoryLog).create({
        productId: item.productId,
        skuId: item.skuId,
        changeType: 'manual_outbound_create',
        changeQty: item.qty,
        beforeCurrentStock,
        afterCurrentStock: product.currentStock,
        beforePreorderedStock,
        afterPreorderedStock: beforePreorderedStock,
        beforeSkuCurrentStock,
        afterSkuCurrentStock: item.sku.currentStock,
        beforeSkuPreorderedStock,
        afterSkuPreorderedStock: beforeSkuPreorderedStock,
        operatorType: 'admin',
        operatorId: actor.userId,
        operatorName: actor.displayName,
        refType: 'biz_outbound_order',
        refId: String(order.id),
        remark: `创建手工出库单 ${order.businessNo}，扣减库存 ${item.qty}`,
      }))
    }
    await manager.getRepository(BaseProduct).save([...productMap.values()])
    await manager.getRepository(BaseProductSku).save(items.map((item) => item.sku))
    await manager.getRepository(InventoryLog).save(inventoryLogs)
  }

  private shouldRetrySubmitError(error: unknown, attempt: number) {
    return (
      attempt < ORDER_SUBMIT_MAX_RETRY
      && (
        isUniqueConstraintError(error, SHOW_NO_CONSTRAINT_MATCHER)
        || isRetryableSqliteLockError(error)
        || isRetryableMysqlTransactionError(error)
      )
    )
  }

  private normalizeOrderType(orderType: string | undefined): OrderType | null {
    const normalizedOrderType = (orderType ?? 'walkin').trim().toLowerCase()
    if (!ORDER_TYPE_SET.has(normalizedOrderType as OrderType)) {
      return null
    }
    return normalizedOrderType as OrderType
  }

  private async loadOrderByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<{ order: SubmittedOrderView; items: SubmittedOrderItemView[] }> {
    const order = await this.orderRepo.findOne({ where: { idempotencyKey } })
    if (!order) {
      throw new BizError('订单处理中，请稍后重试', 409)
    }

    const items = await this.itemRepo.find({
      where: { orderId: order.id },
      order: { lineNo: 'ASC' },
    })

    return {
      order: this.buildSubmittedOrderView(order),
      items: items.map((item) => this.buildSubmittedOrderItemView(item)),
    }
  }

  /**
   * 加载详情明细并输出兼容字段：
   * - 关联产品表补齐 productCode，修复详情抽屉“产品编码错位/缺失”问题；
   * - productName 优先使用历史快照，保证产品改名后旧单据仍展示下单时名称；
   * - subTotal 映射 lineAmount，兼容前端既有字段命名，避免金额出现 NaN。
   */
  private async loadDetailItems(
    orderId: string,
    manager: EntityManager = AppDataSource.manager,
  ): Promise<OrderDetailItemView[]> {
    const items = await manager.getRepository(BizOutboundOrderItem).find({
      where: { orderId },
      relations: { product: true },
      order: { lineNo: 'ASC' },
    })

    return items.map((item) => ({
      id: normalizeEntityId(item.id),
      lineNo: item.lineNo,
      productId: normalizeEntityId(item.productId),
      productCode: item.product?.productCode ?? '',
      productName: item.productNameSnapshot || item.product?.productName || '',
      productNameSnapshot: item.productNameSnapshot,
      skuId: normalizeNullableEntityId(item.skuId),
      skuCode: item.skuCodeSnapshot,
      skuCodeSnapshot: item.skuCodeSnapshot,
      specText: item.specTextSnapshot,
      specTextSnapshot: item.specTextSnapshot,
      qty: normalizeDecimalText(item.qty),
      unitPrice: normalizeDecimalText(item.unitPrice),
      subTotal: normalizeDecimalText(item.lineAmount),
      lineAmount: normalizeDecimalText(item.lineAmount),
      remark: item.remark,
      sourceOrderId: normalizeNullableEntityId(item.sourceOrderId),
      sourceOrderUuid: item.sourceOrderUuid ?? null,
      sourceOrderItemId: normalizeNullableEntityId(item.sourceOrderItemId),
    }))
  }

  /**
   * 统一构造订单审计详情：
   * - 创建、删除、恢复、永久删除都复用同一组业务快照；
   * - 让工作台近期动态与审计详情保持同一份客户/金额口径。
   */
  private buildOrderAuditDetail(order: BizOutboundOrder) {
    return {
      businessNo: order.businessNo,
      showNo: order.showNo,
      customerDepartmentName: order.customerDepartmentName,
      customerName: order.customerName,
      totalQty: order.totalQty,
      totalAmount: order.totalAmount,
    }
  }

  private buildOrderSummaryView(order: BizOutboundOrder, metadata?: OrderMergeMetadata): OrderSummaryView {
    const merge = metadata ?? { role: 'standalone' as const, parent: null, children: [] }
    const editability = orderContentEditService.describeEditability(order)
    if (merge.role === 'parent' && !editability.contentEditBlockers.includes('合并目标父单禁止编辑内容')) {
      editability.contentEditBlockers.push('合并目标父单禁止编辑内容')
      editability.contentEditable = false
    }
    return {
      id: normalizeEntityId(order.id),
      showNo: order.showNo,
      businessNo: order.businessNo,
      editVersion: Number(order.editVersion),
      status: order.status,
      merge,
      inventoryMode: order.inventoryMode,
      ...editability,
      orderType: order.orderType,
      hasCustomerOrder: Boolean(order.hasCustomerOrder),
      isSystemApplied: Boolean(order.isSystemApplied),
      issuerName: order.issuerName,
      customerDepartmentName: order.customerDepartmentName,
      customerName: order.customerName,
      totalAmount: normalizeDecimalText(order.totalAmount),
      totalQty: normalizeDecimalText(order.totalQty),
      remark: order.remark,
      creatorUserId: normalizeNullableEntityId(order.creatorUserId),
      creatorUsername: order.creatorUsername,
      creatorDisplayName: order.creatorDisplayName,
      isDeleted: Boolean(order.isDeleted),
      deletedAt: order.deletedAt ? normalizeDateTime(order.deletedAt) : null,
      deletedByUserId: normalizeNullableEntityId(order.deletedByUserId),
      deletedByUsername: order.deletedByUsername,
      deletedByDisplayName: order.deletedByDisplayName,
      createdAt: normalizeDateTime(order.createdAt),
    }
  }

  private buildSubmittedOrderView(order: BizOutboundOrder): SubmittedOrderView {
    return {
      id: normalizeEntityId(order.id),
      showNo: order.showNo,
      businessNo: order.businessNo,
      editVersion: Number(order.editVersion),
      inventoryMode: order.inventoryMode,
    }
  }

  private buildSubmittedOrderItemView(item: BizOutboundOrderItem): SubmittedOrderItemView {
    return {
      id: normalizeEntityId(item.id),
      productId: normalizeEntityId(item.productId),
      skuId: normalizeNullableEntityId(item.skuId),
      skuCodeSnapshot: item.skuCodeSnapshot,
      specTextSnapshot: item.specTextSnapshot,
      qty: normalizeDecimalText(item.qty),
      unitPrice: normalizeDecimalText(item.unitPrice),
      remark: item.remark,
    }
  }
}

export const orderService = new OrderService()
