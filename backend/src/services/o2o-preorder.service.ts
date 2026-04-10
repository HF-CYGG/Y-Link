/**
 * 模块说明：backend/src/services/o2o-preorder.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { randomUUID } from 'node:crypto'
import { In, LessThanOrEqual } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import { O2oPreorder } from '../entities/o2o-preorder.entity.js'
import { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import type { ClientAuthContext } from '../types/client-auth.js'
import { BizError } from '../utils/errors.js'
import { systemConfigService } from './system-config.service.js'

export interface SubmitPreorderItemInput {
  productId: string | number
  qty: number
}

export interface SubmitPreorderInput {
  items: SubmitPreorderItemInput[]
  remark?: string
}

class O2oPreorderService {
  private readonly productRepo = AppDataSource.getRepository(BaseProduct)
  private readonly preorderRepo = AppDataSource.getRepository(O2oPreorder)
  private readonly preorderItemRepo = AppDataSource.getRepository(O2oPreorderItem)
  private readonly inventoryLogRepo = AppDataSource.getRepository(InventoryLog)

  private normalizeVerifyCode(value: string) {
    const raw = value.trim()
    if (!raw) {
      return ''
    }
    const compact = raw.replace(/[^a-zA-Z0-9]/g, '')
    if (/^[a-fA-F0-9]{32}$/.test(compact)) {
      const hex = compact.toLowerCase()
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
    return raw
  }

  async listMallProducts() {
    // 商城端只暴露“可售且已上架”的商品，并把库存口径统一换算成前端直接可用的 availableStock。
    const products = await this.productRepo.find({
      where: { isActive: true, o2oStatus: 'listed' },
      order: { id: 'DESC' },
    })
    return products.map((item) => ({
      id: String(item.id),
      productCode: item.productCode,
      productName: item.productName,
      defaultPrice: item.defaultPrice,
      category: item.category || '默认分类',
      thumbnail: item.thumbnail,
      detailContent: item.detailContent,
      limitPerUser: Number(item.limitPerUser ?? 5),
      currentStock: Number(item.currentStock ?? 0),
      preOrderedStock: Number(item.preOrderedStock ?? 0),
      availableStock: Math.max(0, Number(item.currentStock ?? 0) - Number(item.preOrderedStock ?? 0)),
    }))
  }

  private async generatePreorderShowNo(manager = AppDataSource.manager): Promise<string> {
    // 展示单号采用“日期 + 当日流水号”形式：
    // - 便于人工肉眼识别和线下核对；
    // - 与内部数据库主键解耦，避免直接暴露自增 ID。
    const dateText = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const prefix = `PO${dateText}`
    const raw = (await manager
      .getRepository(O2oPreorder)
      .createQueryBuilder('order')
      .select('order.showNo', 'showNo')
      .where('order.showNo LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('order.showNo', 'DESC')
      .getRawOne()) as { showNo?: string } | null
    const current = raw?.showNo ? Number.parseInt(raw.showNo.slice(prefix.length), 10) || 0 : 0
    return `${prefix}${String(current + 1).padStart(4, '0')}`
  }

  async submit(auth: ClientAuthContext, input: SubmitPreorderInput) {
    if (!Array.isArray(input.items) || !input.items.length) {
      throw new BizError('至少选择一个商品', 400)
    }
    // 先把商品 ID 和数量做一次标准化，避免事务中混入空值、浮点数或前端字符串残留。
    const normalizedItems = input.items.map((item) => ({
      productId: String(item.productId).trim(),
      qty: Math.floor(Number(item.qty)),
    }))
    normalizedItems.forEach((item) => {
      if (!item.productId || !Number.isInteger(item.qty) || item.qty <= 0) {
        throw new BizError('商品数量必须为正整数', 400)
      }
    })

    const o2oRules = await systemConfigService.getO2oRuleConfigs()
    return AppDataSource.transaction(async (manager) => {
      // 事务内完成“查商品 -> 校验库存/限购 -> 写订单 -> 占用预订库存 -> 记录库存日志”，
      // 确保任一步失败都能整体回滚，避免只生成订单或只扣预订库存的脏状态。
      const productIds = [...new Set(normalizedItems.map((item) => item.productId))]
      const products = await manager.getRepository(BaseProduct).find({ where: { id: In(productIds) } })
      if (products.length !== productIds.length) {
        throw new BizError('存在无效商品', 400)
      }
      const productMap = new Map(products.map((item) => [String(item.id), item]))
      let totalQty = 0
      for (const row of normalizedItems) {
        const product = productMap.get(row.productId)!
        if (!product.isActive || product.o2oStatus !== 'listed') {
          throw new BizError(`商品「${product.productName}」已下架，不可预订`, 409)
        }
        // 预订库存不直接扣 currentStock，而是先增加 preOrderedStock 占位，
        // 这样线下真正核销时再把现货库存扣减，符合“线上预留、线下履约”的业务模型。
        const availableStock = Number(product.currentStock ?? 0) - Number(product.preOrderedStock ?? 0)
        if (availableStock < row.qty) {
          throw new BizError(`商品「${product.productName}」库存不足`, 409)
        }
        const limitQty = o2oRules.limitEnabled ? Math.min(Number(product.limitPerUser || 5), o2oRules.limitQty) : Number(product.limitPerUser || 5)
        if (o2oRules.limitEnabled && row.qty > limitQty) {
          throw new BizError(`商品「${product.productName}」超过限购数量`, 409)
        }
        totalQty += row.qty
      }

      // verifyCode 既用于用户端展示二维码，也作为管理端核销入口的核心识别码。
      const showNo = await this.generatePreorderShowNo(manager)
      const timeoutAt = o2oRules.autoCancelEnabled ? new Date(Date.now() + o2oRules.autoCancelHours * 60 * 60 * 1000) : null
      const savedOrder = await manager.getRepository(O2oPreorder).save(
        manager.getRepository(O2oPreorder).create({
          showNo,
          clientUserId: auth.userId,
          verifyCode: randomUUID(),
          status: 'pending',
          totalQty,
          remark: input.remark?.trim() || null,
          timeoutAt,
        }),
      )
      const itemEntities = normalizedItems.map((item) =>
        manager.getRepository(O2oPreorderItem).create({
          orderId: savedOrder.id,
          productId: item.productId,
          qty: item.qty,
        }),
      )
      await manager.getRepository(O2oPreorderItem).save(itemEntities)

      for (const row of normalizedItems) {
        const product = productMap.get(row.productId)!
        const beforeCurrentStock = Number(product.currentStock ?? 0)
        const beforePreOrderedStock = Number(product.preOrderedStock ?? 0)
        // 下单成功后只增加预订占用库存，不减少现货库存；
        // 真正出库动作发生在 verifyByCode。
        product.preOrderedStock = beforePreOrderedStock + row.qty
        await manager.getRepository(BaseProduct).save(product)
        await manager.getRepository(InventoryLog).save(
          manager.getRepository(InventoryLog).create({
            productId: product.id,
            changeType: 'preorder_hold',
            changeQty: row.qty,
            beforeCurrentStock,
            afterCurrentStock: beforeCurrentStock,
            beforePreorderedStock: beforePreOrderedStock,
            afterPreorderedStock: product.preOrderedStock,
            operatorType: 'client',
            operatorId: auth.userId,
            operatorName: auth.realName,
            refType: 'o2o_preorder',
            refId: savedOrder.id,
          }),
        )
      }
      return this.detailById(savedOrder.id)
    })
  }

  async listMyOrders(auth: ClientAuthContext) {
    // 先做一次超时回收，保证用户看到的订单状态尽量接近当前真实状态。
    await this.cancelTimeoutOrders()
    const rows = await this.preorderRepo.find({
      where: { clientUserId: auth.userId },
      order: { id: 'DESC' },
      take: 50,
    })
    return rows.map((item) => ({
      id: String(item.id),
      showNo: item.showNo,
      verifyCode: item.verifyCode,
      status: item.status,
      totalQty: item.totalQty,
      timeoutAt: item.timeoutAt,
      createdAt: item.createdAt,
    }))
  }

  async detailById(id: string) {
    const order = await this.preorderRepo.findOne({ where: { id } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    const items = await this.preorderItemRepo.find({ where: { orderId: id }, relations: { product: true } })
    return {
      order: {
        id: String(order.id),
        showNo: order.showNo,
        verifyCode: order.verifyCode,
        status: order.status,
        totalQty: order.totalQty,
        timeoutAt: order.timeoutAt,
        verifiedAt: order.verifiedAt,
        createdAt: order.createdAt,
      },
      items: items.map((item) => ({
        id: String(item.id),
        productId: String(item.productId),
        productCode: item.product?.productCode ?? '',
        productName: item.product?.productName ?? '',
        qty: item.qty,
      })),
      qrPayload: `y-link://o2o/verify/${order.verifyCode}`,
    }
  }

  async verifyByCode(verifyCode: string, actor: AuthUserContext) {
    const normalizedVerifyCode = this.normalizeVerifyCode(verifyCode)
    await this.cancelTimeoutOrders()
    return AppDataSource.transaction(async (manager) => {
      const order = await manager.getRepository(O2oPreorder).findOne({ where: { verifyCode: normalizedVerifyCode } })
      if (!order) {
        throw new BizError('预订单不存在', 404)
      }
      if (order.status !== 'pending') {
        throw new BizError('当前预订单不可核销', 409)
      }
      const items = await manager.getRepository(O2oPreorderItem).find({ where: { orderId: order.id } })
      const productIds = [...new Set(items.map((item) => String(item.productId)))]
      const products = await manager.getRepository(BaseProduct).find({ where: { id: In(productIds) } })
      const productMap = new Map(products.map((item) => [String(item.id), item]))
      for (const row of items) {
        const product = productMap.get(String(row.productId))
        if (!product) {
          throw new BizError('商品不存在，无法核销', 409)
        }
        const beforeCurrentStock = Number(product.currentStock ?? 0)
        const beforePreOrderedStock = Number(product.preOrderedStock ?? 0)
        if (beforeCurrentStock < row.qty || beforePreOrderedStock < row.qty) {
          throw new BizError(`商品「${product.productName}」库存异常，请先补货后再核销`, 409)
        }
        // 核销时同步减少“现货库存”和“预订占用库存”，表示货品真正离库。
        product.currentStock = beforeCurrentStock - row.qty
        product.preOrderedStock = beforePreOrderedStock - row.qty
        await manager.getRepository(BaseProduct).save(product)
        await manager.getRepository(InventoryLog).save(
          manager.getRepository(InventoryLog).create({
            productId: product.id,
            changeType: 'preorder_verify',
            changeQty: row.qty,
            beforeCurrentStock,
            afterCurrentStock: product.currentStock,
            beforePreorderedStock: beforePreOrderedStock,
            afterPreorderedStock: product.preOrderedStock,
            operatorType: 'admin',
            operatorId: actor.userId,
            operatorName: actor.displayName,
            refType: 'o2o_preorder',
            refId: order.id,
          }),
        )
      }
      // 只有所有商品都成功扣减后，订单状态才更新为 verified，避免部分核销成功的中间态。
      order.status = 'verified'
      order.verifiedAt = new Date()
      order.verifiedBy = actor.displayName
      const savedOrder = await manager.getRepository(O2oPreorder).save(order)
      return this.detailById(savedOrder.id)
    })
  }

  async inboundStock(productId: string, qty: number, actor: AuthUserContext, remark?: string) {
    const normalizedQty = Math.floor(Number(qty))
    if (!Number.isInteger(normalizedQty) || normalizedQty <= 0) {
      throw new BizError('入库数量必须为正整数', 400)
    }
    return AppDataSource.transaction(async (manager) => {
      const product = await manager.getRepository(BaseProduct).findOne({ where: { id: productId } })
      if (!product) {
        throw new BizError('商品不存在', 404)
      }
      const beforeCurrentStock = Number(product.currentStock ?? 0)
      const beforePreOrderedStock = Number(product.preOrderedStock ?? 0)
      // 入库只增加现货库存，不改动预订占用库存，因为预订占用代表已承诺但未核销的数量。
      product.currentStock = beforeCurrentStock + normalizedQty
      await manager.getRepository(BaseProduct).save(product)
      await manager.getRepository(InventoryLog).save(
        manager.getRepository(InventoryLog).create({
          productId: product.id,
          changeType: 'inbound',
          changeQty: normalizedQty,
          beforeCurrentStock,
          afterCurrentStock: product.currentStock,
          beforePreorderedStock: beforePreOrderedStock,
          afterPreorderedStock: beforePreOrderedStock,
          operatorType: 'admin',
          operatorId: actor.userId,
          operatorName: actor.displayName,
          refType: 'manual_inbound',
          refId: String(product.id),
          remark: remark?.trim() || null,
        }),
      )
      return {
        id: String(product.id),
        productName: product.productName,
        currentStock: product.currentStock,
        preOrderedStock: product.preOrderedStock,
      }
    })
  }

  async cancelTimeoutOrders() {
    const config = await systemConfigService.getO2oRuleConfigs()
    if (!config.autoCancelEnabled) {
      return { cancelledCount: 0 }
    }
    const now = new Date()
    const timeoutOrders = await this.preorderRepo.find({
      where: {
        status: 'pending',
        timeoutAt: LessThanOrEqual(now),
      },
      take: 100,
    })
    if (!timeoutOrders.length) {
      return { cancelledCount: 0 }
    }
    await AppDataSource.transaction(async (manager) => {
      // 超时取消的核心是“释放预订占用库存”而非回滚现货库存，
      // 因为 pending 订单尚未发生真实出库，currentStock 理论上没有减少过。
      for (const order of timeoutOrders) {
        const items = await manager.getRepository(O2oPreorderItem).find({ where: { orderId: order.id } })
        for (const row of items) {
          const product = await manager.getRepository(BaseProduct).findOne({ where: { id: row.productId } })
          if (!product) {
            continue
          }
          const beforeCurrentStock = Number(product.currentStock ?? 0)
          const beforePreOrderedStock = Number(product.preOrderedStock ?? 0)
          product.preOrderedStock = Math.max(0, beforePreOrderedStock - row.qty)
          await manager.getRepository(BaseProduct).save(product)
          await manager.getRepository(InventoryLog).save(
            manager.getRepository(InventoryLog).create({
              productId: product.id,
              changeType: 'preorder_release',
              changeQty: row.qty,
              beforeCurrentStock,
              afterCurrentStock: beforeCurrentStock,
              beforePreorderedStock: beforePreOrderedStock,
              afterPreorderedStock: product.preOrderedStock,
              operatorType: 'system',
              operatorName: 'auto_cancel',
              refType: 'o2o_preorder',
              refId: order.id,
            }),
          )
        }
        order.status = 'cancelled'
        await manager.getRepository(O2oPreorder).save(order)
      }
    })
    return { cancelledCount: timeoutOrders.length }
  }

  async getVerifyDetail(verifyCode: string) {
    const normalizedVerifyCode = this.normalizeVerifyCode(verifyCode)
    const order = await this.preorderRepo.findOne({ where: { verifyCode: normalizedVerifyCode } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    return this.detailById(order.id)
  }

  async getVerifyDetailByShowNo(showNo: string) {
    const normalizedShowNo = showNo.trim()
    if (!normalizedShowNo) {
      throw new BizError('预订单号不能为空', 400)
    }
    const order = await this.preorderRepo.findOne({ where: { showNo: normalizedShowNo } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    return this.detailById(order.id)
  }

  async listInventoryLogs(limit = 100) {
    const rows = await this.inventoryLogRepo.find({
      order: { id: 'DESC' },
      take: Math.max(1, Math.min(500, limit)),
      relations: { product: true },
    })
    return rows.map((item) => ({
      id: String(item.id),
      productId: String(item.productId),
      productName: item.product?.productName ?? '',
      changeType: item.changeType,
      changeQty: item.changeQty,
      beforeCurrentStock: item.beforeCurrentStock,
      afterCurrentStock: item.afterCurrentStock,
      beforePreorderedStock: item.beforePreorderedStock,
      afterPreorderedStock: item.afterPreorderedStock,
      operatorType: item.operatorType,
      operatorName: item.operatorName,
      refType: item.refType,
      refId: item.refId,
      createdAt: item.createdAt,
    }))
  }
}

export const o2oPreorderService = new O2oPreorderService()
