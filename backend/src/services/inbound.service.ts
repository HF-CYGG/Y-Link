/**
 * 模块说明：backend/src/services/inbound.service.ts
 * 文件职责：封装供货方送货单提交、库管核销入库、入库单查询与库存回写流程。
 * 维护说明：修改入库流程时需同步关注单号生成、权限边界、库存日志与幂等性约束。
 */

import { randomUUID } from 'node:crypto'
import { Brackets } from 'typeorm'
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

export interface SupplierDeliveryListQuery {
  keyword?: string
  status?: string
  page?: number
  pageSize?: number
}

export interface SupplierDeliverySummaryResult {
  total: number
  pending: number
  verified: number
  cancelled: number
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
  private readonly productRepo = AppDataSource.getRepository(BaseProduct)

  // 核销入库属于后台库管职责：
  // - 即便路由层误配权限，服务层也只允许 admin / operator 执行最终入库动作；
  // - 这样可以避免 supplier 账号拿到权限点后直接越权完成库存落账。
  private assertCanVerifyInbound(actor: AuthUserContext) {
    if (actor.role !== 'admin' && actor.role !== 'operator') {
      throw new BizError('仅后台库管人员可执行核销入库', 403)
    }
  }
  private readonly supplierInboundStatuses = new Set<BizInboundOrder['status']>(['pending', 'verified', 'cancelled'])

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

      const itemEntities = normalizedItems.map((item) => {
        const product = productMap.get(item.productId)
        if (!product) {
          throw new BizError('存在无效或停用商品', 400)
        }

        return manager.getRepository(BizInboundOrderItem).create({
          orderId: savedOrder.id,
          productId: item.productId,
          productNameSnapshot: product.productName,
          qty: String(item.qty),
        })
      })
      await manager.getRepository(BizInboundOrderItem).save(itemEntities)

      return this.detailById(savedOrder.id)
    })
  }

  private async buildSupplierDeliverySummary(supplierId: string): Promise<SupplierDeliverySummaryResult> {
    const rows = await this.inboundRepo
      .createQueryBuilder('order')
      .select('order.status', 'status')
      .addSelect('COUNT(1)', 'count')
      .where('order.supplierId = :supplierId', { supplierId })
      .groupBy('order.status')
      .getRawMany<{ status: BizInboundOrder['status']; count: string }>()

    const summary: SupplierDeliverySummaryResult = {
      total: 0,
      pending: 0,
      verified: 0,
      cancelled: 0,
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

    const baseQueryBuilder = this.inboundRepo
      .createQueryBuilder('order')
      .where('order.supplierId = :supplierId', { supplierId: actor.userId })
      .orderBy('order.createdAt', 'DESC')

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

  async detailById(id: string) {
    const order = await this.inboundRepo.findOne({ where: { id } })
    if (!order) {
      throw new BizError('送货单不存在', 404)
    }
    const items = await this.inboundItemRepo.find({ where: { orderId: id } })
    return { order, items }
  }

  async detailByVerifyCode(verifyCode: string, actor: AuthUserContext) {
    const normalizedCode = verifyCode.trim().toLowerCase()
    const qb = this.inboundRepo.createQueryBuilder('order').where('order.verifyCode = :verifyCode', {
      verifyCode: normalizedCode,
    })
    // 核心安全兜底：supplier 只能查询自己创建的单据，避免通过核销码横向读取他人数据。
    if (actor.role === 'supplier') {
      qb.andWhere('order.supplierId = :supplierId', { supplierId: actor.userId })
    }
    const order = await qb.getOne()
    if (!order) {
      throw new BizError('核销码无效或送货单不存在', 404)
    }
    const items = await this.inboundItemRepo.find({ where: { orderId: order.id } })
    return { order, items }
  }

  // 供货方/管理端：通过 showNo 查看详情（兼容人工输入单号查询）
  async detailByShowNo(showNo: string, actor: AuthUserContext) {
    const normalizedShowNo = showNo.trim().toUpperCase()
    const qb = this.inboundRepo.createQueryBuilder('order').where('order.showNo = :showNo', {
      showNo: normalizedShowNo,
    })
    // 与 detailByVerifyCode 保持同一权限口径：supplier 仅读取本人送货单。
    if (actor.role === 'supplier') {
      qb.andWhere('order.supplierId = :supplierId', { supplierId: actor.userId })
    }
    const order = await qb.getOne()
    if (!order) {
      throw new BizError('送货单号无效或送货单不存在', 404)
    }
    const items = await this.inboundItemRepo.find({ where: { orderId: order.id } })
    return { order, items }
  }

  // 库管员核销入库
  async verifyInbound(verifyCode: string, actor: AuthUserContext) {
    this.assertCanVerifyInbound(actor)
    const normalizedCode = verifyCode.trim().toLowerCase()
    if (!normalizedCode) {
      throw new BizError('核销码不能为空', 400)
    }
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
  async listAllInboundOrders(actor: AuthUserContext, query: { limit?: number, status?: string }) {
    const limit = Math.min(200, Math.max(1, query.limit || 50))
    const qb = this.inboundRepo.createQueryBuilder('order').orderBy('order.id', 'DESC').take(limit)
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
