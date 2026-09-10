/**
 * 模块说明：backend/src/services/inbound.service.ts
 * 文件职责：封装供货方送货单提交、库管核销入库、入库单查询与库存回写流程。
 * 维护说明：修改入库流程时需同步关注单号生成、权限边界、库存日志与幂等性约束。
 */

import { randomUUID } from 'node:crypto'
import { Brackets, In, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BizInboundOrder } from '../entities/biz-inbound-order.entity.js'
import { BizInboundOrderItem } from '../entities/biz-inbound-order-item.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { auditService } from './audit.service.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import { MAX_DATABASE_INT, MAX_INBOUND_ORDER_ITEM_COUNT } from '../constants/web-resource-limits.js'
import { assertPermanentDeletePassword } from '../utils/permanent-delete-password.js'

export interface SubmitInboundItemInput {
  productId: string
  skuId?: string | null
  qty: number
}

export interface SubmitInboundInput {
  remark?: string
  items: SubmitInboundItemInput[]
}

export interface UpdateSupplierInboundInput {
  remark?: string
  items: SubmitInboundItemInput[]
}

export interface DeleteVerifiedSupplierInboundInput {
  confirmShowNo?: string
  permanentDeletePassword?: string
}

export interface SupplierDeliveryListQuery {
  keyword?: string
  status?: string
  page?: number
  pageSize?: number
  includeDeleted?: boolean
  onlyDeleted?: boolean
}

export interface SupplierDeliverySummaryResult {
  total: number
  pending: number
  verified: number
  cancelled: number
  deleted: number
}

export interface SupplierDeliveryListResult {
  page: number
  pageSize: number
  total: number
  records: BizInboundOrder[]
  summary: SupplierDeliverySummaryResult
}

class InboundService {
  private readonly inboundRepo = AppDataSource.getRepository(BizInboundOrder)
  private readonly inboundItemRepo = AppDataSource.getRepository(BizInboundOrderItem)

  // 核销入库属于后台库管职责：
  // - 即便路由层误配权限，服务层也只允许 admin / operator 执行最终入库动作；
  // - 这样可以避免 supplier 账号拿到权限点后直接越权完成库存落账。
  private assertCanVerifyInbound(actor: AuthUserContext) {
    if (actor.role !== 'admin' && actor.role !== 'operator') {
      throw new BizError('仅后台库管人员可执行核销入库', 403)
    }
  }
  private readonly supplierInboundStatuses = new Set<BizInboundOrder['status']>(['pending', 'verified', 'cancelled'])

  private isDeleted(order: Pick<BizInboundOrder, 'isDeleted'> | null | undefined): boolean {
    return Boolean(order?.isDeleted)
  }

  private assertSupplierActor(actor: AuthUserContext) {
    if (actor.role !== 'supplier') {
      throw new BizError('仅供货方账号可操作送货单', 403)
    }
  }

  // 后台现场改单与核销入库属于同一工作台职责，统一限制为 admin / operator。
  private assertAdminInboundActor(actor: AuthUserContext) {
    if (actor.role !== 'admin' && actor.role !== 'operator') {
      throw new BizError('仅后台库管人员可操作该送货单', 403)
    }
  }

  private normalizeSupplierInboundItems(items: SubmitInboundItemInput[]) {
    if (!Array.isArray(items) || !items.length) {
      throw new BizError('至少选择一个商品', 400)
    }
    if (items.length > MAX_INBOUND_ORDER_ITEM_COUNT) {
      throw new BizError(`单次最多提交 ${MAX_INBOUND_ORDER_ITEM_COUNT} 条商品明细`, 400)
    }

    const mergedItems = new Map<string, { productId: string; skuId: string | null; qty: number }>()
    items.forEach((item) => {
      const productId = String(item.productId).trim()
      const skuId = item.skuId === null || item.skuId === undefined ? null : String(item.skuId).trim() || null
      const qty = Number(item.qty)
      const itemKey = `${productId}::${skuId ?? ''}`
      const current = mergedItems.get(itemKey)
      mergedItems.set(itemKey, { productId, skuId, qty: (current?.qty ?? 0) + qty })
    })
    const normalizedItems = [...mergedItems.values()]

    normalizedItems.forEach((item) => {
      if (!item.productId || !Number.isSafeInteger(item.qty) || item.qty <= 0 || item.qty > MAX_DATABASE_INT) {
        throw new BizError('商品数量必须为正整数', 400)
      }
    })
    this.assertInboundQuantityBounds(normalizedItems)

    return normalizedItems
  }

  /** 合并同商品/规格后仍须确保单条与订单合计均可安全写入数据库 INT。 */
  private assertInboundQuantityBounds(items: Array<{ qty: number }>) {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_INBOUND_ORDER_ITEM_COUNT) {
      throw new BizError(`单次最多提交 ${MAX_INBOUND_ORDER_ITEM_COUNT} 条商品明细`, 400)
    }
    let totalQty = 0
    for (const item of items) {
      const qty = Number(item.qty)
      if (!Number.isSafeInteger(qty) || qty <= 0 || qty > MAX_DATABASE_INT) {
        throw new BizError('商品数量必须为正整数且不超过系统上限', 400)
      }
      totalQty += qty
      if (!Number.isSafeInteger(totalQty) || totalQty > MAX_DATABASE_INT) {
        throw new BizError('送货单总数量超过系统可处理上限', 400)
      }
    }
    return totalQty
  }

  private isCurrentActiveSku(sku: Pick<BaseProductSku, 'isActive' | 'isCurrent'>): boolean {
    const isEnabled = (value: unknown) => value !== false && value !== 0 && value !== '0' && value !== 'false'
    return isEnabled(sku.isActive) && isEnabled(sku.isCurrent)
  }

  private assertValidStockSnapshot(currentStock: number, preorderedStock: number, targetLabel: string) {
    if (
      !Number.isSafeInteger(currentStock)
      || !Number.isSafeInteger(preorderedStock)
      || currentStock < 0
      || preorderedStock < 0
      || currentStock > MAX_DATABASE_INT
      || preorderedStock > currentStock
    ) {
      throw new BizError(`${targetLabel}的库存数据异常，无法安全冲销`, 409)
    }
  }

  /** 与 O2O 库存写入保持一致：先按数据库主键升序一次锁定全部商品。 */
  private async loadAndLockInboundProducts(manager: EntityManager, productIds: string[], missingMessage: string) {
    const normalizedIds = [...new Set(productIds)]
    if (!normalizedIds.length) return { rows: [] as BaseProduct[], map: new Map<string, BaseProduct>() }
    const query = manager.getRepository(BaseProduct)
      .createQueryBuilder('product')
      .where('product.id IN (:...productIds)', { productIds: normalizedIds })
      .orderBy('product.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') {
      query.setLock('pessimistic_write')
    }
    const rows = await query.getMany()
    if (rows.length !== normalizedIds.length) {
      throw new BizError(missingMessage, 409)
    }
    return { rows, map: new Map(rows.map((product) => [String(product.id), product])) }
  }

  /** 商品锁全部取得后，再按商品主键、SKU 主键升序一次锁定全部 SKU。 */
  private async loadAndLockInboundSkus(manager: EntityManager, skuIds: string[], missingMessage: string) {
    const normalizedIds = [...new Set(skuIds)]
    if (!normalizedIds.length) return { rows: [] as BaseProductSku[], map: new Map<string, BaseProductSku>() }
    const query = manager.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .where('sku.id IN (:...skuIds)', { skuIds: normalizedIds })
      .orderBy('sku.productId', 'ASC')
      .addOrderBy('sku.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') {
      query.setLock('pessimistic_write')
    }
    const rows = await query.getMany()
    if (rows.length !== normalizedIds.length) {
      throw new BizError(missingMessage, 409)
    }
    return { rows, map: new Map(rows.map((sku) => [String(sku.id), sku])) }
  }

  /**
   * 为每一条入库明细锁定真实 SKU：
   * - 新版调用方必须显式提交 skuId；
   * - 兼容旧客户端时，仅在商品只有一个当前启用 SKU，或存在唯一“默认规格”时自动补齐；
   * - 多规格商品不允许静默选中任意 SKU，避免把库存记到错误规格。
   */
  private async resolveInboundItemsWithSku(
    items: ReturnType<InboundService['normalizeSupplierInboundItems']>,
    productMap: Map<string, BaseProduct>,
    manager: EntityManager,
  ) {
    const productIds = [...new Set(items.map((item) => item.productId))]
    const skus = productIds.length
      ? await manager.getRepository(BaseProductSku).find({ where: { productId: In(productIds) } })
      : []
    const skuById = new Map(skus.map((sku) => [String(sku.id), sku]))
    const activeSkusByProduct = new Map<string, BaseProductSku[]>()
    skus.filter((sku) => this.isCurrentActiveSku(sku)).forEach((sku) => {
      const current = activeSkusByProduct.get(String(sku.productId)) ?? []
      current.push(sku)
      activeSkusByProduct.set(String(sku.productId), current)
    })
    activeSkusByProduct.forEach((rows) => rows.sort((left, right) => {
      return Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0) || Number(left.id) - Number(right.id)
    }))

    return items.map((item) => {
      const product = productMap.get(item.productId)
      if (!product) {
        throw new BizError('存在无效或停用商品', 400)
      }
      if (item.skuId) {
        const sku = skuById.get(item.skuId)
        if (!sku || String(sku.productId) !== item.productId || !this.isCurrentActiveSku(sku)) {
          throw new BizError(`商品“${product.productName}”的入库规格无效或已退役，请重新选择`, 409)
        }
        return { ...item, skuId: String(sku.id) }
      }

      const candidates = activeSkusByProduct.get(item.productId) ?? []
      const defaultCandidates = candidates.filter((sku) => {
        return sku.specText === '默认规格' || sku.specValuesJson === '{}'
      })
      const resolvedSku = candidates.length === 1
        ? candidates[0]
        : defaultCandidates.length === 1
          ? defaultCandidates[0]
          : null
      if (!resolvedSku) {
        throw new BizError(`商品“${product.productName}”存在多个规格，请明确选择入库 SKU`, 400)
      }
      return { ...item, skuId: String(resolvedSku.id) }
    })
  }

  private async loadActiveProductsByIds(productIds: string[], manager = AppDataSource.manager) {
    const products = await manager.getRepository(BaseProduct)
      .createQueryBuilder('product')
      .where('product.id IN (:...productIds)', { productIds })
      .andWhere('product.isActive = :isActive', { isActive: true })
      .getMany()

    if (products.length !== productIds.length) {
      throw new BizError('存在无效或停用商品', 400)
    }

    return new Map(products.map((item) => [String(item.id), item]))
  }

  private async findSupplierMutableOrder(orderId: string, actor: AuthUserContext, actionLabel: '改单' | '撤销', manager = AppDataSource.manager) {
    this.assertSupplierActor(actor)

    const normalizedOrderId = String(orderId).trim()
    if (!normalizedOrderId) {
      throw new BizError('送货单不存在', 404)
    }

    const order = await manager.getRepository(BizInboundOrder).findOne({
      where: { id: normalizedOrderId },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
    })

    if (!order || String(order.supplierId) !== String(actor.userId)) {
      throw new BizError('送货单不存在', 404)
    }

    if (this.isDeleted(order)) {
      throw new BizError(`送货单“${order.showNo}”已删除，无法继续${actionLabel}`, 409)
    }

    if (order.status === 'verified') {
      throw new BizError(`送货单“${order.showNo}”已入库，无法继续${actionLabel}`, 409)
    }

    if (order.status === 'cancelled') {
      throw new BizError(`送货单“${order.showNo}”已撤销，无法继续${actionLabel}`, 409)
    }

    return order
  }

  private async findSupplierOwnedOrder(orderId: string, actor: AuthUserContext, manager = AppDataSource.manager) {
    this.assertSupplierActor(actor)

    const normalizedOrderId = String(orderId).trim()
    if (!normalizedOrderId) {
      throw new BizError('送货单不存在', 404)
    }

    const order = await manager.getRepository(BizInboundOrder).findOne({
      where: { id: normalizedOrderId },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
    })

    if (!order || String(order.supplierId) !== String(actor.userId)) {
      throw new BizError('送货单不存在', 404)
    }

    return order
  }

  private async generateShowNo(manager = AppDataSource.manager): Promise<string> {
    const dateText = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const prefix = `IN${dateText}`
    const raw = await manager
      .getRepository(BizInboundOrder)
      .createQueryBuilder('order')
      .select('order.showNo', 'showNo')
      .where('order.showNo LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('order.showNo', 'DESC')
      .getRawOne<{ showNo?: string }>()
    const current = raw?.showNo ? Number.parseInt(raw.showNo.slice(prefix.length), 10) || 0 : 0
    return `${prefix}${String(current + 1).padStart(4, '0')}`
  }

  // 供货方创建送货单
  async submitSupplierDelivery(actor: AuthUserContext, input: SubmitInboundInput, requestMeta?: RequestMeta) {
    this.assertSupplierActor(actor)
    const normalizedItems = this.normalizeSupplierInboundItems(input.items)

    return runInTransaction(async (manager) => {
      const productIds = [...new Set(normalizedItems.map((item) => item.productId))]
      const productMap = await this.loadActiveProductsByIds(productIds, manager)
      const resolvedItems = await this.resolveInboundItemsWithSku(normalizedItems, productMap, manager)
      
      const totalQty = this.assertInboundQuantityBounds(resolvedItems)

      const showNo = await this.generateShowNo(manager)
      const savedOrder = await manager.getRepository(BizInboundOrder).save(
        manager.getRepository(BizInboundOrder).create({
          showNo,
          verifyCode: randomUUID(),
          supplierId: actor.userId,
          supplierName: actor.displayName || actor.username,
          status: 'pending',
          totalQty: String(totalQty),
          remark: input.remark?.trim() || null,
        }),
      )

      const itemEntities = resolvedItems.map((item) => {
        const product = productMap.get(item.productId)
        if (!product) {
          throw new BizError('存在无效或停用商品', 400)
        }

        return manager.getRepository(BizInboundOrderItem).create({
          orderId: savedOrder.id,
          productId: item.productId,
          skuId: item.skuId,
          productNameSnapshot: product.productName,
          qty: String(item.qty),
        })
      })
      await manager.getRepository(BizInboundOrderItem).save(itemEntities)

      await auditService.record({
        actionType: 'inbound.supplier.create',
        actionLabel: '供货方创建送货单',
        targetType: 'biz_inbound_order',
        targetId: savedOrder.id,
        targetCode: savedOrder.showNo,
        actor,
        requestMeta,
        detail: {
          status: savedOrder.status,
          supplierId: savedOrder.supplierId,
          supplierName: savedOrder.supplierName,
          itemCount: itemEntities.length,
          totalQty: savedOrder.totalQty,
        },
      }, manager)

      return this.detailById(savedOrder.id, manager)
    })
  }

  // 供货方改单：仅允许修改本人待入库送货单的商品、数量和备注。
  async updateSupplierDelivery(actor: AuthUserContext, orderId: string, input: UpdateSupplierInboundInput, requestMeta?: RequestMeta) {
    const normalizedItems = this.normalizeSupplierInboundItems(input.items)

    return runInTransaction(async (manager) => {
      const order = await this.findSupplierMutableOrder(orderId, actor, '改单', manager)
      const productIds = [...new Set(normalizedItems.map((item) => item.productId))]
      const productMap = await this.loadActiveProductsByIds(productIds, manager)
      const resolvedItems = await this.resolveInboundItemsWithSku(normalizedItems, productMap, manager)

      const nextTotalQty = this.assertInboundQuantityBounds(resolvedItems)

      await manager.getRepository(BizInboundOrderItem).delete({ orderId: order.id })

      const nextItems = resolvedItems.map((item) => {
        const product = productMap.get(item.productId)
        if (!product) {
          throw new BizError('存在无效或停用商品', 400)
        }

        return manager.getRepository(BizInboundOrderItem).create({
          orderId: order.id,
          productId: item.productId,
          skuId: item.skuId,
          productNameSnapshot: product.productName,
          qty: String(item.qty),
        })
      })
      await manager.getRepository(BizInboundOrderItem).save(nextItems)

      order.remark = input.remark?.trim() || null
      order.totalQty = String(nextTotalQty)

      const savedOrder = await manager.getRepository(BizInboundOrder).save(order)
      await auditService.record({
        actionType: 'inbound.supplier.update',
        actionLabel: '供货方修改送货单',
        targetType: 'biz_inbound_order',
        targetId: savedOrder.id,
        targetCode: savedOrder.showNo,
        actor,
        requestMeta,
        detail: {
          status: savedOrder.status,
          supplierId: savedOrder.supplierId,
          supplierName: savedOrder.supplierName,
          itemCount: nextItems.length,
          totalQty: savedOrder.totalQty,
        },
      }, manager)
      return {
        order: savedOrder,
        items: nextItems,
      }
    })
  }

  // 供货方撤销：仅允许本人待入库送货单撤销，撤销后保留历史明细与撤销原因用于追溯。
  async cancelSupplierDelivery(actor: AuthUserContext, orderId: string, reason: string, requestMeta?: RequestMeta) {
    const normalizedReason = reason.trim()
    if (!normalizedReason) {
      throw new BizError('请填写撤销原因', 400)
    }

    return runInTransaction(async (manager) => {
      const order = await this.findSupplierMutableOrder(orderId, actor, '撤销', manager)
      const items = await manager.getRepository(BizInboundOrderItem).find({ where: { orderId: order.id } })

      order.status = 'cancelled'
      order.cancelReason = normalizedReason
      order.cancelledAt = new Date()
      order.cancelledByUserId = actor.userId
      order.cancelledByUsername = actor.username
      order.cancelledByDisplayName = actor.displayName || actor.username

      const savedOrder = await manager.getRepository(BizInboundOrder).save(order)
      await auditService.record({
        actionType: 'inbound.supplier.cancel',
        actionLabel: '供货方撤销送货单',
        targetType: 'biz_inbound_order',
        targetId: savedOrder.id,
        targetCode: savedOrder.showNo,
        actor,
        requestMeta,
        detail: {
          status: savedOrder.status,
          supplierId: savedOrder.supplierId,
          supplierName: savedOrder.supplierName,
          itemCount: items.length,
          cancelReason: savedOrder.cancelReason,
        },
      }, manager)
      return {
        order: savedOrder,
        items,
      }
    })
  }

  async softDeleteSupplierDelivery(actor: AuthUserContext, orderId: string, requestMeta?: RequestMeta) {
    return runInTransaction(async (manager) => {
      const order = await this.findSupplierOwnedOrder(orderId, actor, manager)
      if (this.isDeleted(order)) {
        throw new BizError(`送货单“${order.showNo}”已删除，请勿重复删除`, 409)
      }
      if (order.status === 'verified') {
        throw new BizError(`送货单“${order.showNo}”已入库，不能删除入库凭证`, 409)
      }

      order.isDeleted = true
      order.deletedAt = new Date()
      order.deletedByUserId = actor.userId
      order.deletedByUsername = actor.username
      order.deletedByDisplayName = actor.displayName || actor.username

      const savedOrder = await manager.getRepository(BizInboundOrder).save(order)
      await auditService.record({
        actionType: 'inbound.supplier.delete',
        actionLabel: '供货方删除送货单',
        targetType: 'biz_inbound_order',
        targetId: savedOrder.id,
        targetCode: savedOrder.showNo,
        actor,
        requestMeta,
        detail: {
          status: savedOrder.status,
          supplierId: savedOrder.supplierId,
          supplierName: savedOrder.supplierName,
        },
      }, manager)

      const items = await manager.getRepository(BizInboundOrderItem).find({ where: { orderId: savedOrder.id } })
      return { order: savedOrder, items }
    })
  }

  async restoreSupplierDelivery(actor: AuthUserContext, orderId: string, requestMeta?: RequestMeta) {
    return runInTransaction(async (manager) => {
      const order = await this.findSupplierOwnedOrder(orderId, actor, manager)
      if (!this.isDeleted(order)) {
        throw new BizError(`送货单“${order.showNo}”未删除，无需恢复`, 409)
      }
      if (order.status === 'verified') {
        throw new BizError(`送货单“${order.showNo}”已入库，不能恢复删除状态`, 409)
      }

      order.isDeleted = false
      order.deletedAt = null
      order.deletedByUserId = null
      order.deletedByUsername = null
      order.deletedByDisplayName = null

      const savedOrder = await manager.getRepository(BizInboundOrder).save(order)
      await auditService.record({
        actionType: 'inbound.supplier.restore',
        actionLabel: '供货方恢复送货单',
        targetType: 'biz_inbound_order',
        targetId: savedOrder.id,
        targetCode: savedOrder.showNo,
        actor,
        requestMeta,
        detail: {
          status: savedOrder.status,
          supplierId: savedOrder.supplierId,
          supplierName: savedOrder.supplierName,
        },
      }, manager)

      const items = await manager.getRepository(BizInboundOrderItem).find({ where: { orderId: savedOrder.id } })
      return { order: savedOrder, items }
    })
  }

  async purgeSupplierDelivery(actor: AuthUserContext, orderId: string, confirmShowNo?: string, requestMeta?: RequestMeta) {
    return runInTransaction(async (manager) => {
      const order = await this.findSupplierOwnedOrder(orderId, actor, manager)
      if (!this.isDeleted(order)) {
        throw new BizError(`送货单“${order.showNo}”未删除，请先删除后再永久删除`, 409)
      }
      if (order.status === 'verified') {
        throw new BizError(`送货单“${order.showNo}”已入库，不能永久删除入库凭证`, 409)
      }
      if (!confirmShowNo || confirmShowNo.trim().toUpperCase() !== order.showNo.toUpperCase()) {
        throw new BizError('确认单号不一致，已取消永久删除', 400)
      }

      const items = await manager.getRepository(BizInboundOrderItem).find({ where: { orderId: order.id } })
      await manager.getRepository(BizInboundOrderItem).delete({ orderId: order.id })
      await manager.getRepository(BizInboundOrder).delete({ id: order.id })
      await auditService.record({
        actionType: 'inbound.supplier.purge',
        actionLabel: '供货方永久删除送货单',
        targetType: 'biz_inbound_order',
        targetId: order.id,
        targetCode: order.showNo,
        actor,
        requestMeta,
        detail: {
          status: order.status,
          supplierId: order.supplierId,
          supplierName: order.supplierName,
          itemCount: items.length,
        },
      }, manager)

      return { order, items }
    })
  }

  /**
   * 删除已入库送货单：冲销该单据确实产生的库存后保留 verified 凭证并标记为已删除。
   * 已删除的 verified 单据不可恢复或永久删除，避免同一入库事实被再次使用或丢失追溯依据。
   */
  async deleteVerifiedSupplierDelivery(
    actor: AuthUserContext,
    orderId: string,
    input: DeleteVerifiedSupplierInboundInput,
    requestMeta?: RequestMeta,
  ) {
    const normalizedOrderId = String(orderId).trim()
    let auditTargetId: string | null = normalizedOrderId && normalizedOrderId.length <= 64 ? normalizedOrderId : null
    let auditTargetCode: string | null = null
    let failureReason = 'request_rejected'
    let failureStatus: BizInboundOrder['status'] | null = null

    try {
      failureReason = 'role_mismatch'
      this.assertSupplierActor(actor)

      failureReason = 'password_rejected'
      assertPermanentDeletePassword(input.permanentDeletePassword)

      failureReason = 'invalid_order_id'
      if (!normalizedOrderId || normalizedOrderId.length > 64) {
        throw new BizError('送货单不存在', 404)
      }

      const result = await runInTransaction(async (manager) => {
        failureReason = 'order_not_found_or_not_owned'
        const order = await this.findSupplierOwnedOrder(normalizedOrderId, actor, manager)
        auditTargetId = order.id
        auditTargetCode = order.showNo
        failureStatus = order.status

        failureReason = 'show_no_mismatch'
        if (!input.confirmShowNo || input.confirmShowNo.trim().toUpperCase() !== order.showNo.toUpperCase()) {
          throw new BizError('确认单号不一致，已取消删除', 400)
        }

        failureReason = 'order_already_deleted'
        if (this.isDeleted(order)) {
          throw new BizError(`送货单“${order.showNo}”已删除，请勿重复删除`, 409)
        }

        failureReason = 'order_not_verified'
        if (order.status !== 'verified') {
          throw new BizError(`送货单“${order.showNo}”尚未入库，请使用普通删除`, 409)
        }

        const items = await manager.getRepository(BizInboundOrderItem).find({
          where: { orderId: order.id },
          order: { productId: 'ASC', skuId: 'ASC', id: 'ASC' },
        })
        failureReason = 'inbound_detail_invalid'
        if (!items.length) {
          throw new BizError(`送货单“${order.showNo}”缺少入库明细，无法安全冲销`, 409)
        }

        const quantitiesByProduct = new Map<string, number>()
        const quantitiesBySku = new Map<string, { productId: string; skuId: string; qty: number }>()
        const productIdBySku = new Map<string, string>()
        const expectedInboundLogEntries = new Map<string, number>()
        let totalQty = 0
        for (const item of items) {
          const productId = String(item.productId)
          const skuId = item.skuId ? String(item.skuId) : ''
          const qty = Number(item.qty)
          if (!productId || !skuId || !Number.isSafeInteger(qty) || qty <= 0 || qty > MAX_DATABASE_INT) {
            throw new BizError(`送货单“${order.showNo}”存在缺少 SKU 或数量异常的明细，无法安全冲销`, 409)
          }
          const knownProductId = productIdBySku.get(skuId)
          if (knownProductId && knownProductId !== productId) {
            throw new BizError(`送货单“${order.showNo}”存在跨商品复用 SKU 的异常明细，无法安全冲销`, 409)
          }
          productIdBySku.set(skuId, productId)
          totalQty += qty
          if (!Number.isSafeInteger(totalQty) || totalQty > MAX_DATABASE_INT) {
            throw new BizError(`送货单“${order.showNo}”的明细总数量异常，无法安全冲销`, 409)
          }
          quantitiesByProduct.set(productId, (quantitiesByProduct.get(productId) ?? 0) + qty)
          const logEntryKey = `${productId}::${qty}`
          expectedInboundLogEntries.set(logEntryKey, (expectedInboundLogEntries.get(logEntryKey) ?? 0) + 1)
          const skuKey = `${productId}::${skuId}`
          const current = quantitiesBySku.get(skuKey)
          quantitiesBySku.set(skuKey, { productId, skuId, qty: (current?.qty ?? 0) + qty })
        }
        if (Number(order.totalQty) !== totalQty) {
          throw new BizError(`送货单“${order.showNo}”的主单总数量与入库明细不一致，无法安全冲销`, 409)
        }

        failureReason = 'inbound_log_mismatch'
        const inboundLogs = await manager.getRepository(InventoryLog).find({
          where: { refType: 'biz_inbound_order', refId: order.id, changeType: 'inbound_sys' },
          order: { id: 'ASC' },
        })
        const loggedQuantitiesByProduct = new Map<string, number>()
        const actualInboundLogEntries = new Map<string, number>()
        for (const log of inboundLogs) {
          const changeQty = Number(log.changeQty)
          const beforeCurrentStock = Number(log.beforeCurrentStock)
          const afterCurrentStock = Number(log.afterCurrentStock)
          const beforePreorderedStock = Number(log.beforePreorderedStock)
          const afterPreorderedStock = Number(log.afterPreorderedStock)
          this.assertValidStockSnapshot(beforeCurrentStock, beforePreorderedStock, `送货单“${order.showNo}”的原始入库流水变更前`)
          this.assertValidStockSnapshot(afterCurrentStock, afterPreorderedStock, `送货单“${order.showNo}”的原始入库流水变更后`)
          const currentDelta = afterCurrentStock - beforeCurrentStock
          const preorderedDelta = afterPreorderedStock - beforePreorderedStock
          if (!Number.isSafeInteger(changeQty) || changeQty <= 0 || currentDelta !== changeQty || preorderedDelta !== 0) {
            throw new BizError(`送货单“${order.showNo}”的原始入库流水不一致，无法安全冲销`, 409)
          }
          const productId = String(log.productId)
          loggedQuantitiesByProduct.set(productId, (loggedQuantitiesByProduct.get(productId) ?? 0) + changeQty)
          const logEntryKey = `${productId}::${changeQty}`
          actualInboundLogEntries.set(logEntryKey, (actualInboundLogEntries.get(logEntryKey) ?? 0) + 1)
        }
        const productIds = [...quantitiesByProduct.keys()]
        if (
          loggedQuantitiesByProduct.size !== quantitiesByProduct.size
          || productIds.some((productId) => loggedQuantitiesByProduct.get(productId) !== quantitiesByProduct.get(productId))
          || actualInboundLogEntries.size !== expectedInboundLogEntries.size
          || [...expectedInboundLogEntries].some(([entryKey, count]) => actualInboundLogEntries.get(entryKey) !== count)
        ) {
          throw new BizError(`送货单“${order.showNo}”的原始入库流水与明细不一致，无法安全冲销`, 409)
        }

        const reversalItems: Array<{ productId: string; skuId: string; qty: number }> = []
        const productRepository = manager.getRepository(BaseProduct)
        const skuRepository = manager.getRepository(BaseProductSku)
        const inventoryLogRepository = manager.getRepository(InventoryLog)
        failureReason = 'product_missing'
        const { rows: lockedProducts, map: productMap } = await this.loadAndLockInboundProducts(
          manager,
          productIds,
          `送货单“${order.showNo}”关联的商品不存在，无法安全冲销`,
        )

        const skuQuantities = [...quantitiesBySku.values()]
        const skuIds = skuQuantities.map((item) => item.skuId)
        failureReason = 'sku_missing_or_retired'
        const { rows: lockedSkus } = await this.loadAndLockInboundSkus(
          manager,
          skuIds,
          `送货单“${order.showNo}”关联的入库 SKU 不存在，无法安全冲销`,
        )

        for (const product of lockedProducts) {
          const productId = String(product.id)
          const productQty = quantitiesByProduct.get(productId) ?? 0
          const productCurrentStock = Number(product.currentStock)
          const productPreorderedStock = Number(product.preOrderedStock)
          failureReason = 'product_stock_invalid'
          this.assertValidStockSnapshot(productCurrentStock, productPreorderedStock, `商品“${product.productName}”`)
          failureReason = 'product_stock_insufficient'
          if (productCurrentStock < productQty) {
            throw new BizError(`商品“${product.productName}”的入库库存已售出，当前库存不足以冲销`, 409)
          }
          failureReason = 'product_stock_reserved'
          if (productCurrentStock - productQty < productPreorderedStock) {
            throw new BizError(`商品“${product.productName}”的入库库存已被预订占用，无法冲销`, 409)
          }
        }

        for (const sku of lockedSkus) {
          const item = quantitiesBySku.get(`${sku.productId}::${sku.id}`)
          const product = productMap.get(String(sku.productId))
          failureReason = 'sku_missing_or_retired'
          if (!item || !product || String(sku.productId) !== item.productId) {
            throw new BizError(`送货单“${order.showNo}”的入库 SKU 归属异常，无法安全冲销`, 409)
          }
          if (!this.isCurrentActiveSku(sku)) {
            throw new BizError(`商品“${product.productName}”的入库 SKU 已退役或停用，无法安全冲销`, 409)
          }

          const skuCurrentStock = Number(sku.currentStock)
          const skuPreorderedStock = Number(sku.preOrderedStock)
          failureReason = 'sku_stock_invalid'
          this.assertValidStockSnapshot(skuCurrentStock, skuPreorderedStock, `商品“${product.productName}”的该规格`)
          failureReason = 'sku_stock_insufficient'
          if (skuCurrentStock < item.qty) {
            throw new BizError(`商品“${product.productName}”的该规格入库库存已售出，当前库存不足以冲销`, 409)
          }
          failureReason = 'sku_stock_reserved'
          if (skuCurrentStock - item.qty < skuPreorderedStock) {
            throw new BizError(`商品“${product.productName}”的该规格入库库存已被预订占用，无法冲销`, 409)
          }
        }

        for (const sku of lockedSkus) {
          const item = quantitiesBySku.get(`${sku.productId}::${sku.id}`)
          const product = productMap.get(String(sku.productId))
          if (!item || !product || String(sku.productId) !== item.productId) {
            throw new BizError(`送货单“${order.showNo}”的入库 SKU 归属异常，无法安全冲销`, 409)
          }
          const beforeCurrentStock = Number(product.currentStock)
          const afterCurrentStock = beforeCurrentStock - item.qty
          sku.currentStock = Number(sku.currentStock) - item.qty
          product.currentStock = afterCurrentStock
          await skuRepository.save(sku)
          await productRepository.save(product)
          await inventoryLogRepository.save(inventoryLogRepository.create({
            productId: String(product.id),
            changeType: 'inbound_reverse',
            changeQty: -item.qty,
            beforeCurrentStock,
            afterCurrentStock,
            beforePreorderedStock: Number(product.preOrderedStock),
            afterPreorderedStock: Number(product.preOrderedStock),
            operatorType: 'supplier',
            operatorId: actor.userId,
            operatorName: actor.displayName || actor.username,
            refType: 'biz_inbound_order',
            refId: order.id,
            remark: `冲销已入库送货单 ${order.showNo}；SKU ${item.skuId}；数量 ${item.qty}`,
          }))
          reversalItems.push(item)
        }

        failureReason = 'order_update_failed'
        order.isDeleted = true
        order.deletedAt = new Date()
        order.deletedByUserId = actor.userId
        order.deletedByUsername = actor.username
        order.deletedByDisplayName = actor.displayName || actor.username
        const savedOrder = await manager.getRepository(BizInboundOrder).save(order)

        failureReason = 'success_audit_failed'
        await auditService.record({
          actionType: 'inbound.supplier.delete_verified',
          actionLabel: '供货方删除已入库送货单并冲销库存',
          targetType: 'biz_inbound_order',
          targetId: savedOrder.id,
          targetCode: savedOrder.showNo,
          actor,
          requestMeta,
          detail: {
            status: savedOrder.status,
            isDeleted: savedOrder.isDeleted,
            supplierId: savedOrder.supplierId,
            supplierName: savedOrder.supplierName,
            itemCount: items.length,
            totalQty,
            reversalItems,
          },
        }, manager)
        return { order: savedOrder, items }
      })

      invalidateMallCatalogReadCache()
      return result
    } catch (error) {
      await auditService.safeRecord({
        actionType: 'inbound.supplier.delete_verified',
        actionLabel: '供货方删除已入库送货单并冲销库存（失败）',
        targetType: 'biz_inbound_order',
        targetId: auditTargetId,
        targetCode: auditTargetCode,
        actor,
        requestMeta,
        resultStatus: 'failed',
        detail: {
          reason: failureReason,
          status: failureStatus,
        },
      })
      throw error
    }
  }

  // 后台现场改单：仓管在扫码核对现场可直接修正待入库单据，再继续完成核销。
  async updateInboundOrderForAdmin(actor: AuthUserContext, orderId: string, input: UpdateSupplierInboundInput, requestMeta?: RequestMeta) {
    this.assertAdminInboundActor(actor)
    const normalizedItems = this.normalizeSupplierInboundItems(input.items)

    return runInTransaction(async (manager) => {
      const normalizedOrderId = String(orderId).trim()
      if (!normalizedOrderId) {
        throw new BizError('送货单不存在', 404)
      }

      const order = await manager.getRepository(BizInboundOrder).findOne({
        where: { id: normalizedOrderId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })

      if (!order) {
        throw new BizError('送货单不存在', 404)
      }

      if (this.isDeleted(order)) {
        throw new BizError(`送货单“${order.showNo}”已删除，无法现场改单`, 409)
      }

      if (order.status === 'verified') {
        throw new BizError(`送货单“${order.showNo}”已入库，无法现场改单`, 409)
      }

      if (order.status === 'cancelled') {
        throw new BizError(`送货单“${order.showNo}”已撤销，无法现场改单`, 409)
      }

      const productIds = [...new Set(normalizedItems.map((item) => item.productId))]
      const productMap = await this.loadActiveProductsByIds(productIds, manager)
      const resolvedItems = await this.resolveInboundItemsWithSku(normalizedItems, productMap, manager)
      const nextTotalQty = this.assertInboundQuantityBounds(resolvedItems)

      await manager.getRepository(BizInboundOrderItem).delete({ orderId: order.id })

      const nextItems = resolvedItems.map((item) => {
        const product = productMap.get(item.productId)
        if (!product) {
          throw new BizError('存在无效或停用商品', 400)
        }

        return manager.getRepository(BizInboundOrderItem).create({
          orderId: order.id,
          productId: item.productId,
          skuId: item.skuId,
          productNameSnapshot: product.productName,
          qty: String(item.qty),
        })
      })
      await manager.getRepository(BizInboundOrderItem).save(nextItems)

      order.remark = input.remark?.trim() || null
      order.totalQty = String(nextTotalQty)

      const savedOrder = await manager.getRepository(BizInboundOrder).save(order)
      await auditService.record({
        actionType: 'inbound.admin.update',
        actionLabel: '库管现场修改送货单',
        targetType: 'biz_inbound_order',
        targetId: savedOrder.id,
        targetCode: savedOrder.showNo,
        actor,
        requestMeta,
        detail: {
          status: savedOrder.status,
          supplierId: savedOrder.supplierId,
          supplierName: savedOrder.supplierName,
          itemCount: nextItems.length,
          totalQty: savedOrder.totalQty,
        },
      }, manager)
      return {
        order: savedOrder,
        items: nextItems,
      }
    })
  }

  private async buildSupplierDeliverySummary(supplierId: string): Promise<SupplierDeliverySummaryResult> {
    const [rows, deleted] = await Promise.all([
      this.inboundRepo
        .createQueryBuilder('order')
        .select('order.status', 'status')
        .addSelect('COUNT(1)', 'count')
        .where('order.supplierId = :supplierId', { supplierId })
        .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
        .groupBy('order.status')
        .getRawMany<{ status: BizInboundOrder['status']; count: string }>(),
      this.inboundRepo
        .createQueryBuilder('order')
        .where('order.supplierId = :supplierId', { supplierId })
        .andWhere('order.isDeleted = :isDeleted', { isDeleted: true })
        .getCount(),
    ])

    const summary: SupplierDeliverySummaryResult = {
      total: 0,
      pending: 0,
      verified: 0,
      cancelled: 0,
      deleted,
    }
    rows.forEach((row) => {
      const count = Number(row.count || 0)
      summary.total += count
      if (row.status in summary) {
        summary[row.status] = count
      }
    })
    return summary
  }

  async listSupplierDeliveries(actor: AuthUserContext, query: SupplierDeliveryListQuery = {}): Promise<SupplierDeliveryListResult> {
    if (actor.role !== 'supplier') {
      throw new BizError('仅供货方账号可查看送货单历史', 403)
    }

    const page = Math.max(1, Math.floor(Number(query.page || 1)))
    const pageSize = Math.min(50, Math.max(10, Math.floor(Number(query.pageSize || 10))))
    const normalizedKeyword = String(query.keyword || '').trim()
    const normalizedStatus = String(query.status || '').trim() as BizInboundOrder['status'] | ''
    const includeDeleted = Boolean(query.includeDeleted)
    const onlyDeleted = Boolean(query.onlyDeleted)

    const baseQueryBuilder = this.inboundRepo
      .createQueryBuilder('order')
      .where('order.supplierId = :supplierId', { supplierId: actor.userId })
      .orderBy('order.createdAt', 'DESC')

    if (onlyDeleted) {
      baseQueryBuilder.andWhere('order.isDeleted = :isDeleted', { isDeleted: true })
    } else if (!includeDeleted) {
      baseQueryBuilder.andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
    }

    if (normalizedStatus && this.supplierInboundStatuses.has(normalizedStatus)) {
      baseQueryBuilder.andWhere('order.status = :status', { status: normalizedStatus })
    }

    if (normalizedKeyword) {
      baseQueryBuilder.andWhere(
        new Brackets((keywordBuilder) => {
          keywordBuilder
            .where('order.showNo LIKE :keyword', { keyword: `%${normalizedKeyword}%` })
            .orWhere('order.supplierName LIKE :keyword', { keyword: `%${normalizedKeyword}%` })
        }),
      )
    }

    const [records, total, summary] = await Promise.all([
      baseQueryBuilder.clone().skip((page - 1) * pageSize).take(pageSize).getMany(),
      baseQueryBuilder.clone().getCount(),
      this.buildSupplierDeliverySummary(actor.userId),
    ])

    return {
      page,
      pageSize,
      total,
      records,
      summary,
    }
  }

  async detailById(id: string, manager: EntityManager = AppDataSource.manager) {
    const order = await manager.getRepository(BizInboundOrder).findOne({ where: { id } })
    if (!order) {
      throw new BizError('送货单不存在', 404)
    }
    const items = await manager.getRepository(BizInboundOrderItem).find({ where: { orderId: id }, relations: { sku: true } })
    return { order, items }
  }

  async detailByVerifyCode(verifyCode: string, actor: AuthUserContext, options: { includeDeleted?: boolean } = {}) {
    const normalizedCode = verifyCode.trim().toLowerCase()
    const qb = this.inboundRepo.createQueryBuilder('order').where('order.verifyCode = :verifyCode', {
      verifyCode: normalizedCode,
    })
    if (!options.includeDeleted) {
      qb.andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
    }
    // 核心安全兜底：supplier 只能查询自己创建的单据，避免通过核销码横向读取他人数据。
    if (actor.role === 'supplier') {
      qb.andWhere('order.supplierId = :supplierId', { supplierId: actor.userId })
    }
    const order = await qb.getOne()
    if (!order) {
      throw new BizError('核销码无效或送货单不存在', 404)
    }
    const items = await this.inboundItemRepo.find({ where: { orderId: order.id }, relations: { sku: true } })
    return { order, items }
  }

  // 供货方/管理端：通过 showNo 查看详情（兼容人工输入单号查询）
  async detailByShowNo(showNo: string, actor: AuthUserContext, options: { includeDeleted?: boolean } = {}) {
    const normalizedShowNo = showNo.trim().toUpperCase()
    const qb = this.inboundRepo.createQueryBuilder('order').where('order.showNo = :showNo', {
      showNo: normalizedShowNo,
    })
    if (!options.includeDeleted) {
      qb.andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
    }
    // 与 detailByVerifyCode 保持同一权限口径：supplier 仅读取本人送货单。
    if (actor.role === 'supplier') {
      qb.andWhere('order.supplierId = :supplierId', { supplierId: actor.userId })
    }
    const order = await qb.getOne()
    if (!order) {
      throw new BizError('送货单号无效或送货单不存在', 404)
    }
    const items = await this.inboundItemRepo.find({ where: { orderId: order.id }, relations: { sku: true } })
    return { order, items }
  }

  // 库管员核销入库
  async verifyInbound(verifyCode: string, actor: AuthUserContext, requestMeta?: RequestMeta) {
    this.assertCanVerifyInbound(actor)
    const normalizedCode = verifyCode.trim().toLowerCase()
    if (!normalizedCode) {
      throw new BizError('核销码不能为空', 400)
    }
    const result = await runInTransaction(async (manager) => {
      const order = await manager.getRepository(BizInboundOrder).findOne({
        where: { verifyCode: normalizedCode },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('核销码无效', 404)
      }
      if (this.isDeleted(order)) {
        throw new BizError(`送货单“${order.showNo}”已删除，不能继续扫码入库`, 409)
      }
      if (order.status === 'verified') {
        throw new BizError(`该送货单（${order.showNo}）已入库，请勿重复操作`, 409)
      }
      if (order.status === 'cancelled') {
        throw new BizError('该送货单已取消', 409)
      }

      const items = await manager.getRepository(BizInboundOrderItem).find({
        where: { orderId: order.id },
        order: { productId: 'ASC', skuId: 'ASC', id: 'ASC' },
      })
      if (!items.length) {
        throw new BizError(`送货单“${order.showNo}”缺少入库明细，无法核销`, 409)
      }

      const productAdditions = new Map<string, number>()
      const skuAdditions = new Map<string, { productId: string; qty: number }>()
      for (const row of items) {
        if (!row.skuId) {
          throw new BizError('入库明细缺少 SKU，请先现场改单后再核销', 409)
        }
        const qty = Number(row.qty)
        if (!Number.isSafeInteger(qty) || qty <= 0 || qty > MAX_DATABASE_INT) {
          throw new BizError('入库明细数量异常，请先现场改单后再核销', 409)
        }
        const productId = String(row.productId)
        const skuId = String(row.skuId)
        const currentSkuAddition = skuAdditions.get(skuId)
        if (currentSkuAddition && currentSkuAddition.productId !== productId) {
          throw new BizError('送货单存在跨商品复用 SKU 的异常明细，无法核销', 409)
        }
        const nextProductQty = (productAdditions.get(productId) ?? 0) + qty
        const nextSkuQty = (currentSkuAddition?.qty ?? 0) + qty
        if (!Number.isSafeInteger(nextProductQty) || nextProductQty > MAX_DATABASE_INT || !Number.isSafeInteger(nextSkuQty) || nextSkuQty > MAX_DATABASE_INT) {
          throw new BizError('送货单入库数量超过系统可处理上限', 409)
        }
        productAdditions.set(productId, nextProductQty)
        skuAdditions.set(skuId, { productId, qty: nextSkuQty })
      }

      const { map: productMap } = await this.loadAndLockInboundProducts(
        manager,
        [...productAdditions.keys()],
        '送货单关联商品缺失，无法核销',
      )
      const { map: skuMap } = await this.loadAndLockInboundSkus(
        manager,
        [...skuAdditions.keys()],
        '送货单关联 SKU 缺失，无法核销',
      )

      for (const [productId, additionQty] of productAdditions) {
        const product = productMap.get(productId)
        if (!product) throw new BizError('送货单关联商品缺失，无法核销', 409)
        const currentStock = Number(product.currentStock)
        const preorderedStock = Number(product.preOrderedStock)
        this.assertValidStockSnapshot(currentStock, preorderedStock, `商品“${product.productName}”`)
        if (!Number.isSafeInteger(currentStock + additionQty) || currentStock + additionQty > MAX_DATABASE_INT) {
          throw new BizError(`商品“${product.productName}”的入库库存超过系统可处理上限`, 409)
        }
      }
      for (const [skuId, addition] of skuAdditions) {
        const sku = skuMap.get(skuId)
        const product = productMap.get(addition.productId)
        if (!sku || !product || String(sku.productId) !== addition.productId || !this.isCurrentActiveSku(sku)) {
          throw new BizError(`商品“${product?.productName ?? '未知商品'}”的入库 SKU 已失效，请先现场改单后再核销`, 409)
        }
        const currentStock = Number(sku.currentStock)
        const preorderedStock = Number(sku.preOrderedStock)
        this.assertValidStockSnapshot(currentStock, preorderedStock, `商品“${product.productName}”的该规格`)
        if (!Number.isSafeInteger(currentStock + addition.qty) || currentStock + addition.qty > MAX_DATABASE_INT) {
          throw new BizError(`商品“${product.productName}”的该规格入库库存超过系统可处理上限`, 409)
        }
      }

      for (const row of items) {
        const product = productMap.get(String(row.productId))
        const sku = row.skuId ? skuMap.get(String(row.skuId)) : null
        if (!product || !sku || String(sku.productId) !== String(row.productId)) {
          throw new BizError('送货单关联商品或 SKU 缺失，无法核销', 409)
        }
        row.sku = sku

        const qty = Number(row.qty)
        const beforeCurrentStock = Number(product.currentStock)
        const beforeSkuCurrentStock = Number(sku.currentStock)
        
        product.currentStock = beforeCurrentStock + qty
        sku.currentStock = beforeSkuCurrentStock + qty
        await manager.getRepository(BaseProductSku).save(sku)
        await manager.getRepository(BaseProduct).save(product)

        await manager.getRepository(InventoryLog).save(
          manager.getRepository(InventoryLog).create({
            productId: product.id,
            changeType: 'inbound_sys',
            changeQty: qty,
            beforeCurrentStock,
            afterCurrentStock: product.currentStock,
            beforePreorderedStock: product.preOrderedStock ?? 0,
            afterPreorderedStock: product.preOrderedStock ?? 0,
            operatorType: 'system',
            operatorId: actor.userId,
            operatorName: actor.displayName || actor.username,
            refType: 'biz_inbound_order',
            refId: order.id,
          })
        )
      }

      order.status = 'verified'
      order.verifiedAt = new Date()
      order.verifiedByUserId = actor.userId
      order.verifiedByUsername = actor.username
      order.verifiedByDisplayName = actor.displayName
      
      const savedOrder = await manager.getRepository(BizInboundOrder).save(order)
      await auditService.record({
        actionType: 'inbound.admin.verify',
        actionLabel: '库管核销入库',
        targetType: 'biz_inbound_order',
        targetId: savedOrder.id,
        targetCode: savedOrder.showNo,
        actor,
        requestMeta,
        detail: {
          status: savedOrder.status,
          supplierId: savedOrder.supplierId,
          supplierName: savedOrder.supplierName,
          itemCount: items.length,
          totalQty: savedOrder.totalQty,
        },
      }, manager)
      return { order: savedOrder, items }
    })
    invalidateMallCatalogReadCache()
    return result
  }

  // 管理端查看所有入库单
  async listAllInboundOrders(actor: AuthUserContext, query: { limit?: number, status?: string }) {
    const limit = Math.min(200, Math.max(1, query.limit || 50))
    const qb = this.inboundRepo.createQueryBuilder('order').orderBy('order.id', 'DESC').take(limit)
    qb.andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
    // 服务层角色兜底：即便路由层误放开，supplier 也只能看到本人数据。
    if (actor.role === 'supplier') {
      qb.andWhere('order.supplierId = :supplierId', { supplierId: actor.userId })
    }
    if (query.status) {
      qb.andWhere('order.status = :status', { status: query.status })
    }
    return qb.getMany()
  }
}

export const inboundService = new InboundService()
