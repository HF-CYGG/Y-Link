/**
 * 模块说明：订单内容编辑与库存治理服务。
 * 文件职责：在单一事务中编排订单锁、商品/SKU 库存差额、业务号占用、修订与审计。
 * 实现逻辑：
 * - 先锁订单和旧明细，再按商品 ID、商品 ID + SKU ID 的稳定顺序加锁；
 * - `manual_applied` 按新旧数量差额扣减或回补库存，`legacy_none` 只改单据而不触碰库存；
 * - 服务端重建快照、金额和库存差额，最后在同一事务写主单、明细、库存流水、revision 与审计。
 */

import type { EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { BizOutboundOrder, type OrderInventoryMode } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { OrderRevision } from '../entities/order-revision.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { isRetryableMysqlTransactionError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import { invalidateMallCatalogReadCache } from './mall-catalog-revision.service.js'
import { applyManualOutboundInventoryDeltas, MANUAL_OUTBOUND_CHANGE_TYPES } from './manual-outbound-inventory.js'
import { orderBusinessNoService } from './order-business-no.service.js'
import type { OrderType } from './order-serial.service.js'
import { lockActiveSysAccountForBusiness } from './account-business-guard.service.js'
import { orderMergeService } from './order-merge.service.js'

export interface OrderContentItemInput {
  productId: string
  skuId?: string | null
  qty: number
  unitPrice: number
  remark?: string | null
}

export interface UpdateOrderContentInput {
  expectedVersion: number
  reason: string
  businessNo?: string
  items: OrderContentItemInput[]
}

interface NormalizedContentItem {
  productId: string
  skuId: string | null
  qty: number
  unitPrice: number
  remark: string | null
}

interface ResolvedContentItem extends Omit<NormalizedContentItem, 'skuId'> {
  skuId: string | null
  product: BaseProduct
  sku: BaseProductSku | null
  previousItem: BizOutboundOrderItem | null
}

interface QuantityDelta {
  key: string
  productId: string
  skuId: string | null
  oldQty: number
  newQty: number
  deltaQty: number
  product: BaseProduct
  sku: BaseProductSku | null
}

export interface OrderRevisionView {
  id: string
  orderId: string
  orderUuid: string
  revisionNo: number
  reason: string | null
  actorUsername: string
  actorDisplayName: string
  createdAt: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

const FIELD_LIMITS = {
  maxItems: 200,
  maxQty: 999_999_999,
  maxUnitPrice: 9_999_999_999.99,
  itemRemark: 200,
  reason: 500,
} as const

const O2O_ORDER_PREFIX = 'o2o-preorder-verify:'
const MAX_TRANSACTION_ATTEMPTS = 3

const normalizeId = (value: unknown): string => String(value ?? '').trim()
const itemKey = (productId: string, skuId: string | null) => `${productId}::${skuId ?? 'legacy-none'}`
const isEnabled = (value: unknown) => value !== false && value !== 0 && value !== '0' && value !== 'false'
const truncateByCodePoint = (value: string | null | undefined, maxLength: number): string | null => {
  if (value == null) return null
  const characters = Array.from(value)
  return characters.length <= maxLength ? value : characters.slice(0, maxLength).join('')
}

export class OrderContentEditService {
  describeEditability(order: BizOutboundOrder): { contentEditable: boolean; contentEditBlockers: string[] } {
    const blockers: string[] = []
    if (order.isDeleted) blockers.push('已删除订单不可编辑')
    if (order.hasCustomerOrder) blockers.push('已关联客户订单')
    if (order.isSystemApplied) blockers.push('系统申请订单')
    if (order.inventoryMode === 'o2o_preapplied' || order.idempotencyKey.startsWith(O2O_ORDER_PREFIX)) {
      blockers.push('O2O 正式出库单已锁定')
    }
    if (order.status === 'merged') blockers.push('合并来源单只允许查看')
    if (!['manual_applied', 'legacy_none', 'o2o_preapplied'].includes(order.inventoryMode)) {
      blockers.push('订单库存模式异常')
    }
    return { contentEditable: blockers.length === 0, contentEditBlockers: blockers }
  }

  async updateContent(
    orderId: string,
    input: UpdateOrderContentInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    const normalizedOrderId = normalizeId(orderId)
    if (!normalizedOrderId) throw new BizError('订单 ID 不能为空', 400)
    const normalizedReason = this.normalizeRequiredText(input.reason, FIELD_LIMITS.reason, '修改原因')
    const normalizedItems = this.normalizeItems(input.items)

    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        const result = await runInTransaction((manager) => this.updateInManager(
          manager,
          normalizedOrderId,
          { ...input, reason: normalizedReason, items: normalizedItems },
          actor,
          requestMeta,
        ))
        if (result.inventoryDeltas.length > 0) invalidateMallCatalogReadCache()
        return result
      } catch (error) {
        lastError = error
        if (attempt >= MAX_TRANSACTION_ATTEMPTS || !isRetryableMysqlTransactionError(error)) throw error
      }
    }
    throw lastError
  }

  async listRevisions(orderId: string): Promise<OrderRevisionView[]> {
    const normalizedOrderId = normalizeId(orderId)
    if (!normalizedOrderId) throw new BizError('订单 ID 不能为空', 400)
    const revisions = await AppDataSource.getRepository(OrderRevision).find({
      where: { orderIdSnapshot: normalizedOrderId },
      order: { revisionNo: 'DESC', id: 'DESC' },
    })
    return revisions.map((revision) => this.buildRevisionView(revision))
  }

  private async updateInManager(
    manager: EntityManager,
    orderId: string,
    input: Omit<UpdateOrderContentInput, 'items'> & { items: NormalizedContentItem[] },
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    await lockActiveSysAccountForBusiness(manager, actor.userId)
    const orderQuery = manager.getRepository(BizOutboundOrder)
      .createQueryBuilder('order')
      .where('order.id = :orderId', { orderId })
    if (manager.connection.options.type !== 'sqlite') orderQuery.setLock('pessimistic_write')
    const order = await orderQuery.getOne()
    if (!order) throw new BizError('出库单不存在', 404)
    this.assertOrderEditable(order, input.expectedVersion)
    const mergeMetadata = (await orderMergeService.getMetadataMap([orderId], manager)).get(orderId)
    if (mergeMetadata?.role === 'parent') {
      throw new BizError('合并目标父单禁止编辑商品明细', 409)
    }

    const itemQuery = manager.getRepository(BizOutboundOrderItem)
      .createQueryBuilder('item')
      .where('item.orderId = :orderId', { orderId })
      .orderBy('item.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') itemQuery.setLock('pessimistic_write')
    const previousItems = await itemQuery.getMany()
    const productIds = [...new Set([
      ...previousItems.map((item) => normalizeId(item.productId)),
      ...input.items.map((item) => item.productId),
    ])].sort((left, right) => left.localeCompare(right))

    const productQuery = manager.getRepository(BaseProduct)
      .createQueryBuilder('product')
      .where('product.id IN (:...productIds)', { productIds })
      .orderBy('product.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') productQuery.setLock('pessimistic_write')
    const products = await productQuery.getMany()
    if (products.length !== productIds.length) throw new BizError('订单明细中存在已删除商品', 409)
    const productMap = new Map(products.map((product) => [normalizeId(product.id), product]))

    const skuQuery = manager.getRepository(BaseProductSku)
      .createQueryBuilder('sku')
      .where('sku.productId IN (:...productIds)', { productIds })
      .orderBy('sku.productId', 'ASC')
      .addOrderBy('sku.id', 'ASC')
    if (manager.connection.options.type !== 'sqlite') skuQuery.setLock('pessimistic_write')
    const skus = await skuQuery.getMany()
    const skuMap = new Map(skus.map((sku) => [normalizeId(sku.id), sku]))

    const resolvedItems = this.resolveItems(order.inventoryMode, input.items, previousItems, productMap, skus, skuMap)
    const deltas = this.buildDeltas(previousItems, resolvedItems, productMap, skuMap)
    const inventoryDeltas = order.inventoryMode === 'manual_applied'
      ? await this.applyInventoryDeltas(manager, order, deltas, actor)
      : []

    let nextBusinessNo = order.businessNo
    if (input.businessNo !== undefined && input.businessNo.trim().toLowerCase() !== order.businessNo) {
      const parsed = await orderBusinessNoService.reserveConfirmed(
        input.businessNo,
        order.orderType as OrderType,
        order.orderUuid,
        input.reason,
        manager,
      )
      nextBusinessNo = parsed.businessNo
    }

    const beforeSnapshot = this.buildSnapshot(order, previousItems)
    const itemRepo = manager.getRepository(BizOutboundOrderItem)
    const totalQty = resolvedItems.reduce((sum, item) => sum + item.qty, 0)
    const totalAmount = resolvedItems.reduce((sum, item) => sum + Number((item.qty * item.unitPrice).toFixed(2)), 0)
    order.businessNo = nextBusinessNo
    order.totalQty = totalQty.toFixed(2)
    order.totalAmount = totalAmount.toFixed(2)
    order.editVersion = Number(order.editVersion) + 1
    await manager.getRepository(BizOutboundOrder).save(order)

    await itemRepo.delete({ orderId: order.id })
    const nextItems = resolvedItems.map((item, index) => itemRepo.create({
      orderId: order.id,
      lineNo: index + 1,
      productId: item.productId,
      productNameSnapshot: item.previousItem?.productNameSnapshot || item.product.productName,
      skuId: item.skuId,
      skuCodeSnapshot: item.previousItem?.skuCodeSnapshot ?? item.sku?.skuCode ?? null,
      specTextSnapshot: item.previousItem?.specTextSnapshot ?? item.sku?.specText ?? null,
      qty: item.qty.toFixed(2),
      unitPrice: item.unitPrice.toFixed(2),
      lineAmount: (item.qty * item.unitPrice).toFixed(2),
      remark: item.remark,
    }))
    const savedItems = await itemRepo.save(nextItems)
    const afterSnapshot = this.buildSnapshot(order, savedItems)

    const revisionRepo = manager.getRepository(OrderRevision)
    const revision = await revisionRepo.save(revisionRepo.create({
      orderIdSnapshot: normalizeId(order.id),
      orderUuid: order.orderUuid,
      revisionNo: order.editVersion,
      beforeSnapshotJson: JSON.stringify(beforeSnapshot),
      afterSnapshotJson: JSON.stringify(afterSnapshot),
      reason: input.reason,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorDisplayName: actor.displayName,
      ipAddress: truncateByCodePoint(requestMeta?.ipAddress, 64),
      userAgent: truncateByCodePoint(requestMeta?.userAgent, 255),
    }))
    await auditService.record({
      actionType: 'order.content_edit',
      actionLabel: '编辑出库单内容',
      targetType: 'order',
      targetId: normalizeId(order.id),
      targetCode: order.showNo,
      actor,
      requestMeta,
      detail: {
        reason: input.reason,
        inventoryMode: order.inventoryMode,
        beforeVersion: input.expectedVersion,
        afterVersion: order.editVersion,
        beforeTotalQty: beforeSnapshot.totalQty,
        afterTotalQty: afterSnapshot.totalQty,
        beforeTotalAmount: beforeSnapshot.totalAmount,
        afterTotalAmount: afterSnapshot.totalAmount,
        businessNoChanged: beforeSnapshot.businessNo !== afterSnapshot.businessNo,
        inventoryDeltas,
      },
    }, manager)

    return {
      order: this.buildOrderView(order),
      items: savedItems.map((item, index) => this.buildItemView(item, resolvedItems[index]?.product.productCode ?? '')),
      revision: this.buildRevisionView(revision),
      inventoryDeltas,
      notice: order.inventoryMode === 'legacy_none'
        ? '历史订单为 legacy_none，本次编辑不追溯扣减或回补库存。'
        : null,
    }
  }

  private assertOrderEditable(order: BizOutboundOrder, expectedVersion: number) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) throw new BizError('expectedVersion 必须为正整数', 400)
    if (Number(order.editVersion) !== expectedVersion) {
      throw new BizError(`订单已被其他人更新，当前版本为 ${order.editVersion}`, 409, {
        reason: 'ORDER_EDIT_CONFLICT',
        currentVersion: Number(order.editVersion),
      })
    }
    const editability = this.describeEditability(order)
    if (!editability.contentEditable) throw new BizError(editability.contentEditBlockers.join('；'), 409)
  }

  private normalizeItems(items: OrderContentItemInput[]): NormalizedContentItem[] {
    if (!Array.isArray(items) || items.length === 0) throw new BizError('至少需要一条明细', 400)
    if (items.length > FIELD_LIMITS.maxItems) throw new BizError(`单次最多编辑 ${FIELD_LIMITS.maxItems} 条明细`, 400)
    return items.map((item, index) => {
      const productId = normalizeId(item.productId)
      if (!productId) throw new BizError(`第 ${index + 1} 行商品 ID 不能为空`, 400)
      const qty = Number(item.qty)
      const unitPrice = Number(item.unitPrice)
      if (!Number.isFinite(qty) || qty <= 0 || qty > FIELD_LIMITS.maxQty) throw new BizError(`第 ${index + 1} 行数量必须大于 0`, 400)
      if (!Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > FIELD_LIMITS.maxUnitPrice) throw new BizError(`第 ${index + 1} 行单价必须大于 0`, 400)
      const normalizedUnitPrice = Number(unitPrice.toFixed(2))
      if (normalizedUnitPrice < 0.01) throw new BizError(`第 ${index + 1} 行单价按两位小数舍入后必须至少为 0.01`, 400)
      return {
        productId,
        skuId: normalizeId(item.skuId) || null,
        qty,
        unitPrice: normalizedUnitPrice,
        remark: this.normalizeNullableText(item.remark, FIELD_LIMITS.itemRemark, `第 ${index + 1} 行备注`),
      }
    })
  }

  private resolveItems(
    inventoryMode: OrderInventoryMode,
    inputs: NormalizedContentItem[],
    previousItems: BizOutboundOrderItem[],
    productMap: Map<string, BaseProduct>,
    skus: BaseProductSku[],
    skuMap: Map<string, BaseProductSku>,
  ): ResolvedContentItem[] {
    const oldQtyMap = new Map<string, number>()
    const previousItemMap = new Map<string, BizOutboundOrderItem>()
    for (const item of previousItems) {
      const key = itemKey(normalizeId(item.productId), normalizeId(item.skuId) || null)
      oldQtyMap.set(key, (oldQtyMap.get(key) ?? 0) + Number(item.qty))
      if (!previousItemMap.has(key)) previousItemMap.set(key, item)
    }
    const activeSkusByProduct = new Map<string, BaseProductSku[]>()
    for (const sku of skus) {
      if (!isEnabled(sku.isActive) || !isEnabled(sku.isCurrent)) continue
      const productId = normalizeId(sku.productId)
      activeSkusByProduct.set(productId, [...(activeSkusByProduct.get(productId) ?? []), sku])
    }

    const seen = new Set<string>()
    return inputs.map((input, index) => {
      const product = productMap.get(input.productId)
      if (!product) throw new BizError(`第 ${index + 1} 行商品不存在`, 404)
      let skuId = input.skuId
      let sku = skuId ? skuMap.get(skuId) ?? null : null
      if (skuId && !sku) throw new BizError(`第 ${index + 1} 行规格不存在`, 404)
      if (sku && normalizeId(sku.productId) !== input.productId) throw new BizError(`第 ${index + 1} 行规格不属于当前商品`, 400)

      if (!sku) {
        const legacyKey = itemKey(input.productId, null)
        if (!(inventoryMode === 'legacy_none' && oldQtyMap.has(legacyKey))) {
          const candidates = activeSkusByProduct.get(input.productId) ?? []
          if (candidates.length === 0) throw new BizError(`第 ${index + 1} 行商品暂无当前启用规格`, 409)
          if (candidates.length > 1) throw new BizError(`第 ${index + 1} 行为多规格商品，请选择规格`, 400)
          sku = candidates[0] ?? null
          skuId = sku ? normalizeId(sku.id) : null
        }
      }
      const key = itemKey(input.productId, skuId)
      if (seen.has(key)) throw new BizError(`第 ${index + 1} 行与前面明细为同一规格，请合并后提交`, 400)
      seen.add(key)
      const oldQty = oldQtyMap.get(key) ?? 0
      const increasesQty = input.qty > oldQty
      if (inventoryMode === 'manual_applied' && !Number.isSafeInteger(input.qty)) {
        throw new BizError(`第 ${index + 1} 行库存型订单数量必须为正整数`, 400)
      }
      if (increasesQty && !isEnabled(product.isActive)) throw new BizError(`第 ${index + 1} 行商品已停用，只允许减少或删除`, 409)
      if (sku && increasesQty && (!isEnabled(sku.isActive) || !isEnabled(sku.isCurrent))) {
        throw new BizError(`第 ${index + 1} 行 SKU 已退役，只允许减少或删除`, 409)
      }
      if (inventoryMode === 'manual_applied' && !sku) throw new BizError('库存型订单明细缺少 SKU，已阻止编辑', 409)
      return {
        ...input,
        qty: Number(input.qty.toFixed(2)),
        skuId,
        product,
        sku,
        previousItem: previousItemMap.get(key) ?? null,
      }
    })
  }

  private buildDeltas(
    previousItems: BizOutboundOrderItem[],
    nextItems: ResolvedContentItem[],
    productMap: Map<string, BaseProduct>,
    skuMap: Map<string, BaseProductSku>,
  ): QuantityDelta[] {
    const quantities = new Map<string, Omit<QuantityDelta, 'deltaQty'>>()
    for (const item of previousItems) {
      const productId = normalizeId(item.productId)
      const skuId = normalizeId(item.skuId) || null
      const key = itemKey(productId, skuId)
      const product = productMap.get(productId)
      if (!product) throw new BizError('历史明细关联商品缺失', 409)
      quantities.set(key, {
        key, productId, skuId,
        oldQty: (quantities.get(key)?.oldQty ?? 0) + Number(item.qty),
        newQty: quantities.get(key)?.newQty ?? 0,
        product,
        sku: skuId ? skuMap.get(skuId) ?? null : null,
      })
    }
    for (const item of nextItems) {
      const key = itemKey(item.productId, item.skuId)
      const current = quantities.get(key)
      quantities.set(key, {
        key,
        productId: item.productId,
        skuId: item.skuId,
        oldQty: current?.oldQty ?? 0,
        newQty: (current?.newQty ?? 0) + item.qty,
        product: item.product,
        sku: item.sku,
      })
    }
    return [...quantities.values()]
      .map((item) => ({ ...item, deltaQty: item.newQty - item.oldQty }))
      .sort((left, right) => left.productId.localeCompare(right.productId) || (left.skuId ?? '').localeCompare(right.skuId ?? ''))
  }

  private async applyInventoryDeltas(
    manager: EntityManager,
    order: BizOutboundOrder,
    deltas: QuantityDelta[],
    actor: AuthUserContext,
  ) {
    const changed = deltas.filter((delta) => delta.deltaQty !== 0)
    for (const delta of changed) {
      if (!Number.isSafeInteger(delta.deltaQty) || !delta.sku) throw new BizError('库存型订单差额或 SKU 异常', 409)
    }
    // 校验、记账与落库统一交给共享模块，保证与创建、删除回补、恢复重扣同一口径。
    return applyManualOutboundInventoryDeltas(manager, {
      order,
      actor,
      changeType: MANUAL_OUTBOUND_CHANGE_TYPES.edit,
      deltas: changed.map((delta) => ({ product: delta.product, sku: delta.sku as BaseProductSku, deltaQty: delta.deltaQty })),
      buildRemark: (delta) => `编辑出库单 ${order.businessNo}，库存差额 ${delta.deltaQty}`,
    })
  }

  private buildSnapshot(order: BizOutboundOrder, items: BizOutboundOrderItem[]) {
    return {
      showNo: order.showNo,
      businessNo: order.businessNo,
      editVersion: Number(order.editVersion),
      inventoryMode: order.inventoryMode,
      totalQty: Number(order.totalQty).toFixed(2),
      totalAmount: Number(order.totalAmount).toFixed(2),
      items: items.map((item) => ({
        productId: normalizeId(item.productId),
        productNameSnapshot: item.productNameSnapshot,
        skuId: normalizeId(item.skuId) || null,
        skuCodeSnapshot: item.skuCodeSnapshot,
        specTextSnapshot: item.specTextSnapshot,
        qty: Number(item.qty).toFixed(2),
        unitPrice: Number(item.unitPrice).toFixed(2),
        lineAmount: Number(item.lineAmount).toFixed(2),
        remark: item.remark,
      })),
    }
  }

  private buildOrderView(order: BizOutboundOrder) {
    return {
      id: normalizeId(order.id),
      showNo: order.showNo,
      businessNo: order.businessNo,
      editVersion: Number(order.editVersion),
      inventoryMode: order.inventoryMode,
      ...this.describeEditability(order),
      orderType: order.orderType,
      totalQty: Number(order.totalQty).toFixed(2),
      totalAmount: Number(order.totalAmount).toFixed(2),
      hasCustomerOrder: Boolean(order.hasCustomerOrder),
      isSystemApplied: Boolean(order.isSystemApplied),
      issuerName: order.issuerName,
      customerDepartmentName: order.customerDepartmentName,
      customerName: order.customerName,
      remark: order.remark,
      creatorUserId: normalizeId(order.creatorUserId) || null,
      creatorUsername: order.creatorUsername,
      creatorDisplayName: order.creatorDisplayName,
      isDeleted: Boolean(order.isDeleted),
      deletedAt: order.deletedAt ? this.normalizeDateTime(order.deletedAt) : null,
      deletedByUserId: normalizeId(order.deletedByUserId) || null,
      deletedByUsername: order.deletedByUsername,
      deletedByDisplayName: order.deletedByDisplayName,
      createdAt: this.normalizeDateTime(order.createdAt),
    }
  }

  private buildItemView(item: BizOutboundOrderItem, productCode: string) {
    return {
      id: normalizeId(item.id),
      lineNo: item.lineNo,
      productId: normalizeId(item.productId),
      productCode,
      productName: item.productNameSnapshot,
      productNameSnapshot: item.productNameSnapshot,
      skuId: normalizeId(item.skuId) || null,
      skuCode: item.skuCodeSnapshot,
      skuCodeSnapshot: item.skuCodeSnapshot,
      specText: item.specTextSnapshot,
      specTextSnapshot: item.specTextSnapshot,
      qty: Number(item.qty).toFixed(2),
      unitPrice: Number(item.unitPrice).toFixed(2),
      subTotal: Number(item.lineAmount).toFixed(2),
      lineAmount: Number(item.lineAmount).toFixed(2),
      remark: item.remark,
    }
  }

  private normalizeDateTime(value: Date | string): string {
    if (value instanceof Date) return value.toISOString()
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString()
  }

  private buildRevisionView(revision: OrderRevision): OrderRevisionView {
    return {
      id: normalizeId(revision.id),
      orderId: revision.orderIdSnapshot,
      orderUuid: revision.orderUuid,
      revisionNo: Number(revision.revisionNo),
      reason: revision.reason,
      actorUsername: revision.actorUsername,
      actorDisplayName: revision.actorDisplayName,
      createdAt: revision.createdAt instanceof Date ? revision.createdAt.toISOString() : String(revision.createdAt),
      before: this.parseSnapshot(revision.beforeSnapshotJson),
      after: this.parseSnapshot(revision.afterSnapshotJson),
    }
  }

  private parseSnapshot(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }

  private normalizeRequiredText(value: string | null | undefined, maxLength: number, label: string): string {
    const normalized = value?.trim() ?? ''
    if (!normalized) throw new BizError(`${label}不能为空`, 400)
    if (Array.from(normalized).length > maxLength) throw new BizError(`${label}长度不能超过 ${maxLength} 个字符`, 400)
    return normalized
  }

  private normalizeNullableText(value: string | null | undefined, maxLength: number, label: string): string | null {
    const normalized = value?.trim() ?? ''
    if (!normalized) return null
    if (Array.from(normalized).length > maxLength) throw new BizError(`${label}长度不能超过 ${maxLength} 个字符`, 400)
    return normalized
  }
}

export const orderContentEditService = new OrderContentEditService()
