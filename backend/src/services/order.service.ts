import { AppDataSource } from '../config/data-source.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import {
  isRetryableSqliteLockError,
  isUniqueConstraintError,
} from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { generateOrderUuid, generateShowNo } from '../utils/id-generator.js'
import type { PaginationResult } from '../types/api.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'

export interface SubmitOrderItemInput {
  productId: string | number
  qty: number
  unitPrice: number
  remark?: string
}

export interface SubmitOrderInput {
  idempotencyKey: string
  customerName?: string
  remark?: string
  items: SubmitOrderItemInput[]
}

export interface OrderListQuery {
  page: number
  pageSize: number
  showNo?: string
  startDate?: string
  endDate?: string
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
  customerName: string | null
  totalAmount: string
  totalQty: string
  remark: string | null
  creatorUserId: string | null
  creatorUsername: string | null
  creatorDisplayName: string | null
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
  mysqlConstraint: 'uk_biz_outbound_show_no',
  sqliteColumns: ['biz_outbound_order.show_no'],
} as const

const ORDER_SUBMIT_MAX_RETRY = 3

export class OrderService {
  private readonly orderRepo = AppDataSource.getRepository(BizOutboundOrder)
  private readonly itemRepo = AppDataSource.getRepository(BizOutboundOrderItem)

  async list(query: OrderListQuery): Promise<PaginationResult<OrderSummaryView>> {
    const qb = this.orderRepo.createQueryBuilder('order')
    
    if (query.showNo) {
      qb.andWhere('order.showNo LIKE :showNo', { showNo: `%${query.showNo.trim()}%` })
    }
    if (query.startDate) {
      qb.andWhere('order.createdAt >= :startDate', { startDate: query.startDate })
    }
    if (query.endDate) {
      qb.andWhere('order.createdAt <= :endDate', { endDate: query.endDate + ' 23:59:59' })
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

    const normalizedIdempotencyKey = input.idempotencyKey.trim()
    if (!normalizedIdempotencyKey) {
      throw new BizError('幂等键不能为空')
    }

    let lastError: unknown
    for (let attempt = 1; attempt <= ORDER_SUBMIT_MAX_RETRY; attempt += 1) {
      try {
        return await AppDataSource.transaction(async (manager) => {
          const orderRepo = manager.getRepository(BizOutboundOrder)
          const itemRepo = manager.getRepository(BizOutboundOrderItem)
          const productRepo = manager.getRepository(BaseProduct)

          // 使用幂等键实现重复提交防重，客户端重试会返回同一单据。
          const existed = await orderRepo.findOne({
            where: { idempotencyKey: normalizedIdempotencyKey },
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
          const showNo = await generateShowNo(manager)

          let totalQty = 0
          let totalAmount = 0
          const itemEntities: BizOutboundOrderItem[] = []
          const latestProductPriceMap = new Map<string, string>()

          input.items.forEach((item, index) => {
            const normalizedProductId = String(item.productId).trim()
            const product = productMap.get(normalizedProductId)
            if (!product) {
              throw new BizError(`产品不存在: ${item.productId}`)
            }
            if (item.qty <= 0 || item.unitPrice < 0) {
              throw new BizError(`第 ${index + 1} 行数量或单价非法`)
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

          const order = orderRepo.create({
            orderUuid,
            showNo,
            idempotencyKey: normalizedIdempotencyKey,
            customerName: input.customerName?.trim() || null,
            remark: input.remark?.trim() || null,
            totalQty: totalQty.toFixed(2),
            totalAmount: totalAmount.toFixed(2),
            creatorUserId: actor.userId,
            creatorUsername: actor.username,
            creatorDisplayName: actor.displayName,
          })

          const savedOrder = await orderRepo.save(order)
          itemEntities.forEach((item) => {
            item.orderId = savedOrder.id
          })
          const savedItems = await itemRepo.save(itemEntities)

          products.forEach((product) => {
            const latestPrice = latestProductPriceMap.get(String(product.id))
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
          return this.loadOrderByIdempotencyKey(normalizedIdempotencyKey)
        }

        // show_no 抢号冲突或 SQLite 锁冲突时，重试整个事务重新申请编号。
        if (
          attempt < ORDER_SUBMIT_MAX_RETRY &&
          (isUniqueConstraintError(error, SHOW_NO_CONSTRAINT_MATCHER) || isRetryableSqliteLockError(error))
        ) {
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
      customerName: order.customerName,
      totalAmount: normalizeDecimalText(order.totalAmount),
      totalQty: normalizeDecimalText(order.totalQty),
      remark: order.remark,
      creatorUserId: normalizeNullableEntityId(order.creatorUserId),
      creatorUsername: order.creatorUsername,
      creatorDisplayName: order.creatorDisplayName,
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
