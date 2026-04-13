import { randomUUID } from 'node:crypto'
import { AppDataSource } from '../config/data-source.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BizInboundOrder } from '../entities/biz-inbound-order.entity.js'
import { BizInboundOrderItem } from '../entities/biz-inbound-order-item.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import { BizError } from '../utils/errors.js'

export interface SubmitInboundItemInput {
  productId: string
  qty: number
}

export interface SubmitInboundInput {
  remark?: string
  items: SubmitInboundItemInput[]
}

class InboundService {
  private readonly inboundRepo = AppDataSource.getRepository(BizInboundOrder)
  private readonly inboundItemRepo = AppDataSource.getRepository(BizInboundOrderItem)
  private readonly productRepo = AppDataSource.getRepository(BaseProduct)

  private async generateShowNo(manager = AppDataSource.manager): Promise<string> {
    const dateText = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const prefix = `IN${dateText}`
    const raw = (await manager
      .getRepository(BizInboundOrder)
      .createQueryBuilder('order')
      .select('order.showNo', 'showNo')
      .where('order.showNo LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('order.showNo', 'DESC')
      .getRawOne()) as { showNo?: string } | null
    const current = raw?.showNo ? Number.parseInt(raw.showNo.slice(prefix.length), 10) || 0 : 0
    return `${prefix}${String(current + 1).padStart(4, '0')}`
  }

  // 供货方创建送货单
  async submitSupplierDelivery(actor: AuthUserContext, input: SubmitInboundInput) {
    if (actor.role !== 'supplier') {
      throw new BizError('仅供货方账号可提交送货单', 403)
    }
    if (!Array.isArray(input.items) || !input.items.length) {
      throw new BizError('至少选择一个商品', 400)
    }

    const normalizedItems = input.items.map((item) => ({
      productId: String(item.productId).trim(),
      qty: Math.floor(Number(item.qty)),
    }))
    normalizedItems.forEach((item) => {
      if (!item.productId || !Number.isInteger(item.qty) || item.qty <= 0) {
        throw new BizError('商品数量必须为正整数', 400)
      }
    })

    return AppDataSource.transaction(async (manager) => {
      const productIds = [...new Set(normalizedItems.map((item) => item.productId))]
      const products = await manager.getRepository(BaseProduct)
        .createQueryBuilder('product')
        .where('product.id IN (:...productIds)', { productIds })
        .andWhere('product.isActive = :isActive', { isActive: true })
        .getMany()

      if (products.length !== productIds.length) {
        throw new BizError('存在无效或停用商品', 400)
      }
      const productMap = new Map(products.map((item) => [String(item.id), item]))
      
      let totalQty = 0
      normalizedItems.forEach((item) => {
        totalQty += item.qty
      })

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

      const itemEntities = normalizedItems.map((item) =>
        manager.getRepository(BizInboundOrderItem).create({
          orderId: savedOrder.id,
          productId: item.productId,
          productNameSnapshot: productMap.get(item.productId)!.productName,
          qty: String(item.qty),
        }),
      )
      await manager.getRepository(BizInboundOrderItem).save(itemEntities)

      return this.detailById(savedOrder.id)
    })
  }

  async listSupplierDeliveries(actor: AuthUserContext) {
    const rows = await this.inboundRepo.find({
      where: { supplierId: actor.userId },
      order: { id: 'DESC' },
      take: 50,
    })
    return rows
  }

  async detailById(id: string) {
    const order = await this.inboundRepo.findOne({ where: { id } })
    if (!order) {
      throw new BizError('送货单不存在', 404)
    }
    const items = await this.inboundItemRepo.find({ where: { orderId: id } })
    return { order, items }
  }

  async detailByVerifyCode(verifyCode: string) {
    const normalizedCode = verifyCode.trim().toLowerCase()
    const order = await this.inboundRepo.findOne({ where: { verifyCode: normalizedCode } })
    if (!order) {
      throw new BizError('核销码无效或送货单不存在', 404)
    }
    const items = await this.inboundItemRepo.find({ where: { orderId: order.id } })
    return { order, items }
  }

  // 库管员核销入库
  async verifyInbound(verifyCode: string, actor: AuthUserContext) {
    const normalizedCode = verifyCode.trim().toLowerCase()
    return AppDataSource.transaction(async (manager) => {
      const order = await manager.getRepository(BizInboundOrder).findOne({
        where: { verifyCode: normalizedCode },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('核销码无效', 404)
      }
      if (order.status === 'verified') {
        throw new BizError(`该送货单（${order.showNo}）已入库，请勿重复操作`, 409)
      }
      if (order.status === 'cancelled') {
        throw new BizError('该送货单已取消', 409)
      }

      const items = await manager.getRepository(BizInboundOrderItem).find({ where: { orderId: order.id } })

      for (const row of items) {
        const product = await manager.getRepository(BaseProduct).findOne({
          where: { id: row.productId },
          lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
        })
        if (!product) continue

        const qty = Number(row.qty)
        const beforeCurrentStock = Number(product.currentStock ?? 0)
        
        product.currentStock = beforeCurrentStock + qty
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
      return { order: savedOrder, items }
    })
  }

  // 管理端查看所有入库单
  async listAllInboundOrders(query: { limit?: number, status?: string }) {
    const limit = Math.min(200, Math.max(1, query.limit || 50))
    const qb = this.inboundRepo.createQueryBuilder('order').orderBy('order.id', 'DESC').take(limit)
    if (query.status) {
      qb.andWhere('order.status = :status', { status: query.status })
    }
    return qb.getMany()
  }
}

export const inboundService = new InboundService()
