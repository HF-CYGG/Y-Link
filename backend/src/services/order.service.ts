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
import { Brackets } from 'typeorm'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import {
  isRetryableSqliteLockError,
  isUniqueConstraintError,
} from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { generateOrderUuid } from '../utils/id-generator.js'
import type { PaginationResult } from '../types/api.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { orderSerialService, type OrderType } from './order-serial.service.js'

export interface SubmitOrderItemInput {
  productId: string | number
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
  qty: string
  unitPrice: string
  subTotal: string
  lineAmount: string
  remark: string | null
}

export interface OrderSummaryView {
  id: string
  showNo: string
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
}

export interface SubmittedOrderItemView {
  id: string
  productId: string
  qty: string
  unitPrice: string
  remark: string | null
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

export class OrderService {
  private readonly orderRepo = AppDataSource.getRepository(BizOutboundOrder)
  private readonly itemRepo = AppDataSource.getRepository(BizOutboundOrderItem)

  async list(query: OrderListQuery): Promise<PaginationResult<OrderSummaryView>> {
    const qb = this.orderRepo.createQueryBuilder('order')

    const normalizedKeyword = String(query.keyword ?? query.showNo ?? '').trim()
    if (normalizedKeyword) {
      qb.andWhere(
        new Brackets((keywordQb) => {
          keywordQb
            .where('order.showNo LIKE :keyword', { keyword: `%${normalizedKeyword}%` })
            .orWhere('order.customerName LIKE :keyword', { keyword: `%${normalizedKeyword}%` })
            .orWhere('order.customerDepartmentName LIKE :keyword', { keyword: `%${normalizedKeyword}%` })
            .orWhere('order.issuerName LIKE :keyword', { keyword: `%${normalizedKeyword}%` })
            .orWhere('order.creatorDisplayName LIKE :keyword', { keyword: `%${normalizedKeyword}%` })
            .orWhere('order.creatorUsername LIKE :keyword', { keyword: `%${normalizedKeyword}%` })
        }),
      )
    }

    if (query.showNo && !query.keyword) {
      qb.andWhere('order.showNo LIKE :showNo', { showNo: `%${query.showNo.trim()}%` })
    }
    if (query.orderType && ORDER_TYPE_SET.has(query.orderType as OrderType)) {
      qb.andWhere('order.orderType = :orderType', { orderType: query.orderType })
    }
    if (query.startDate) {
      qb.andWhere('order.createdAt >= :startDate', { startDate: query.startDate })
    }
    if (query.endDate) {
      qb.andWhere('order.createdAt <= :endDate', { endDate: query.endDate + ' 23:59:59' })
    }
    if (query.onlyDeleted) {
      qb.andWhere('order.isDeleted = :onlyDeleted', { onlyDeleted: true })
    } else if (!query.includeDeleted) {
      qb.andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
    }

    const [list, total] = await qb
      .orderBy('order.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: list.map((order) => this.buildOrderSummaryView(order)),
    }
  }

  async detailById(id: string): Promise<{ order: OrderSummaryView; items: OrderDetailItemView[] }> {
    const order = await this.orderRepo.findOne({ where: { id } })
    if (!order) {
      throw new BizError('出库单不存在', 404)
    }
    const items = await this.loadDetailItems(id)
    return { order: this.buildOrderSummaryView(order), items }
  }

  async detailByShowNo(showNo: string): Promise<{ order: OrderSummaryView; items: OrderDetailItemView[] }> {
    const order = await this.orderRepo.findOne({ where: { showNo } })
    if (!order) {
      throw new BizError('出库单不存在', 404)
    }
    const items = await this.loadDetailItems(order.id)
    return { order: this.buildOrderSummaryView(order), items }
  }

  async updateComplianceFlags(input: UpdateOrderComplianceFlagsInput): Promise<{ order: OrderSummaryView; items: OrderDetailItemView[] }> {
    if (typeof input.hasCustomerOrder !== 'boolean' && typeof input.isSystemApplied !== 'boolean') {
      throw new BizError('请至少传入一个可更新字段', 400)
    }

    const order = await this.orderRepo.findOne({ where: { id: input.orderId } })
    if (!order) {
      throw new BizError('出库单不存在', 404)
    }
    if (order.orderType !== 'department') {
      throw new BizError('散客单不适用该状态编辑', 409)
    }
    if (typeof input.hasCustomerOrder === 'boolean') {
      order.hasCustomerOrder = input.hasCustomerOrder
    }
    if (typeof input.isSystemApplied === 'boolean') {
      order.isSystemApplied = input.isSystemApplied
    }
    await this.orderRepo.save(order)
    return this.detailById(String(order.id))
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

    return AppDataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(BizOutboundOrder)
      const order = await orderRepo.findOne({ where: { id } })
      if (!order) {
        throw new BizError('出库单不存在', 404)
      }

      if (order.showNo !== normalizedConfirmShowNo) {
        throw new BizError('二次确认失败：业务单号不匹配', 400)
      }

      if (order.isDeleted) {
        throw new BizError('该出库单已删除', 409)
      }

      order.isDeleted = true
      order.deletedAt = new Date()
      order.deletedByUserId = actor.userId
      order.deletedByUsername = actor.username
      order.deletedByDisplayName = actor.displayName
      const savedOrder = await orderRepo.save(order)

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
                // 记录部门与客户双快照，供工作台近期动态按“部门优先、客户兜底”展示。
                customerDepartmentName: savedOrder.customerDepartmentName,
            customerName: savedOrder.customerName,
            totalQty: savedOrder.totalQty,
            totalAmount: savedOrder.totalAmount,
          },
        },
        manager,
      )

      return this.buildOrderSummaryView(savedOrder)
    })
  }

  /**
   * 恢复单据：
   * - 清空删除标记与删除人快照；
   * - 保留主单与明细原始数据，恢复后可继续查询与查看详情。
   */
  async restoreById(id: string, actor: AuthUserContext, requestMeta?: RequestMeta): Promise<OrderSummaryView> {
    return AppDataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(BizOutboundOrder)
      const order = await orderRepo.findOne({ where: { id } })
      if (!order) {
        throw new BizError('出库单不存在', 404)
      }

      if (!order.isDeleted) {
        throw new BizError('该出库单未被删除，无需恢复', 409)
      }

      order.isDeleted = false
      order.deletedAt = null
      order.deletedByUserId = null
      order.deletedByUsername = null
      order.deletedByDisplayName = null
      const savedOrder = await orderRepo.save(order)

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
                // 记录部门与客户双快照，供工作台近期动态按“部门优先、客户兜底”展示。
                customerDepartmentName: savedOrder.customerDepartmentName,
            customerName: savedOrder.customerName,
            totalQty: savedOrder.totalQty,
            totalAmount: savedOrder.totalAmount,
          },
        },
        manager,
      )

      return this.buildOrderSummaryView(savedOrder)
    })
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
    if (!input.items.length) {
      throw new BizError('至少需要一条明细')
    }
    const submitContext = this.buildSubmitOrderContext(input, actor)

    let lastError: unknown
    for (let attempt = 1; attempt <= ORDER_SUBMIT_MAX_RETRY; attempt += 1) {
      try {
        return await AppDataSource.transaction(async (manager) => {
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

          const normalizedProductIds = [...new Set(input.items.map((item) => String(item.productId).trim()))]
          const products = await productRepo
            .createQueryBuilder('product')
            .where('product.id IN (:...productIds)', { productIds: normalizedProductIds })
            .andWhere('product.isActive = :isActive', { isActive: true })
            .getMany()

          const productMap = new Map(products.map((product) => [String(product.id), product]))
          if (productMap.size !== normalizedProductIds.length) {
            throw new BizError('存在无效或停用产品，无法提交')
          }
          const orderUuid = generateOrderUuid()
          const showNo = await orderSerialService.generateOrderNo(submitContext.normalizedOrderType, manager)
          const preparedItems = this.prepareSubmitItems(input.items, productMap, itemRepo)

          const order = orderRepo.create({
            orderUuid,
            showNo,
            orderType: submitContext.normalizedOrderType,
            hasCustomerOrder: Boolean(input.hasCustomerOrder),
            isSystemApplied: Boolean(input.isSystemApplied),
            issuerName: submitContext.normalizedIssuerName,
            customerDepartmentName: submitContext.normalizedCustomerDepartmentName,
            idempotencyKey: submitContext.normalizedIdempotencyKey,
            customerName: input.customerName?.trim() || null,
            remark: input.remark?.trim() || null,
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
                // 创建时同步写入部门快照，避免首页近期动态只能看到客户名而丢失部门语义。
                customerDepartmentName: savedOrder.customerDepartmentName,
                customerName: savedOrder.customerName,
                totalQty: savedOrder.totalQty,
                totalAmount: savedOrder.totalAmount,
                itemCount: savedItems.length,
              },
            },
            manager,
          )

          return {
            order: this.buildSubmittedOrderView(savedOrder),
            items: savedItems.map((item) => this.buildSubmittedOrderItemView(item)),
          }
        })
      } catch (error) {
        lastError = error

        // 并发下若另一请求已成功落库同一幂等键，则直接回查既有单据返回。
        if (isUniqueConstraintError(error, IDEMPOTENCY_CONSTRAINT_MATCHER)) {
          return this.loadOrderByIdempotencyKey(submitContext.normalizedIdempotencyKey)
        }

        if (this.shouldRetrySubmitError(error, attempt)) {
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

  private buildSubmitOrderContext(input: SubmitOrderInput, actor: AuthUserContext): SubmitOrderContext {
    const normalizedIdempotencyKey = input.idempotencyKey.trim()
    if (!normalizedIdempotencyKey) {
      throw new BizError('幂等键不能为空')
    }
    const normalizedOrderType = this.normalizeOrderType(input.orderType)
    if (!normalizedOrderType) {
      throw new BizError('订单类型非法，仅支持 department 或 walkin', 400)
    }
    const normalizedIssuerName = input.issuerName?.trim() || actor.displayName?.trim() || actor.username?.trim()
    if (!normalizedIssuerName) {
      throw new BizError('出单人不能为空', 400)
    }
    const normalizedCustomerDepartmentName = input.customerDepartmentName?.trim() || null
    if (normalizedOrderType === 'department' && !normalizedCustomerDepartmentName) {
      throw new BizError('部门订单必须填写客户部门名称', 400)
    }
    return {
      normalizedIdempotencyKey,
      normalizedOrderType,
      normalizedIssuerName,
      normalizedCustomerDepartmentName,
    }
  }

  private prepareSubmitItems(
    inputItems: SubmitOrderItemInput[],
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
      if (item.qty <= 0) {
        throw new BizError(`第 ${index + 1} 行数量非法`)
      }
      if (item.unitPrice <= 0) {
        throw new BizError(`第 ${index + 1} 行单价必须大于 0`)
      }

      const lineAmount = Number((item.qty * item.unitPrice).toFixed(2))
      totalQty += item.qty
      totalAmount += lineAmount
      latestProductPriceMap.set(normalizedProductId, item.unitPrice.toFixed(2))

      itemEntities.push(
        itemRepo.create({
          lineNo: index + 1,
          productId: product.id,
          productNameSnapshot: product.productName,
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

  private shouldRetrySubmitError(error: unknown, attempt: number) {
    return (
      attempt < ORDER_SUBMIT_MAX_RETRY
      && (isUniqueConstraintError(error, SHOW_NO_CONSTRAINT_MATCHER) || isRetryableSqliteLockError(error))
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
  private async loadDetailItems(orderId: string): Promise<OrderDetailItemView[]> {
    const items = await this.itemRepo.find({
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
      qty: normalizeDecimalText(item.qty),
      unitPrice: normalizeDecimalText(item.unitPrice),
      subTotal: normalizeDecimalText(item.lineAmount),
      lineAmount: normalizeDecimalText(item.lineAmount),
      remark: item.remark,
    }))
  }

  private buildOrderSummaryView(order: BizOutboundOrder): OrderSummaryView {
    return {
      id: normalizeEntityId(order.id),
      showNo: order.showNo,
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
    }
  }

  private buildSubmittedOrderItemView(item: BizOutboundOrderItem): SubmittedOrderItemView {
    return {
      id: normalizeEntityId(item.id),
      productId: normalizeEntityId(item.productId),
      qty: normalizeDecimalText(item.qty),
      unitPrice: normalizeDecimalText(item.unitPrice),
      remark: item.remark,
    }
  }
}

export const orderService = new OrderService()
