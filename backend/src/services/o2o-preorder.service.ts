/**
 * 模块说明：backend/src/services/o2o-preorder.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { randomUUID } from 'node:crypto'
import { Brackets, In, LessThanOrEqual } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import {
  O2O_PREORDER_BUSINESS_STATUSES,
  O2oPreorder,
  type O2oPreorderBusinessStatus,
  type O2oPreorderCancelReason,
} from '../entities/o2o-preorder.entity.js'
import { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import type { ClientAuthContext } from '../types/client-auth.js'
import { BizError } from '../utils/errors.js'
import { generateOrderUuid } from '../utils/id-generator.js'
import { orderSerialService } from './order-serial.service.js'
import { systemConfigService } from './system-config.service.js'

export interface SubmitPreorderItemInput {
  productId: string | number
  qty: number
}

export interface SubmitPreorderInput {
  items: SubmitPreorderItemInput[]
  remark?: string
}

export interface UpdateOrderBusinessStatusInput {
  orderId: string
  businessStatus: O2oPreorderBusinessStatus | null
}

class O2oPreorderService {
  private readonly productRepo = AppDataSource.getRepository(BaseProduct)
  private readonly preorderRepo = AppDataSource.getRepository(O2oPreorder)
  private readonly preorderItemRepo = AppDataSource.getRepository(O2oPreorderItem)
  private readonly inventoryLogRepo = AppDataSource.getRepository(InventoryLog)

  // 货币金额统一按“分”做整数运算，避免 0.1 + 0.2、19.9 * 3 之类的浮点误差。
  // 当前商品单价字段是 scale=2 的 decimal，因此这里按两位小数解析即可满足业务口径。
  private parseMoneyToCents(value: string | number | null | undefined) {
    if (value === null || value === undefined || value === '') {
      return 0
    }
    const raw = String(value).trim()
    const matched = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw)
    if (!matched) {
      return 0
    }
    const sign = matched[1] === '-' ? -1 : 1
    const integerPart = Number(matched[2] ?? '0')
    const decimalPart = (matched[3] ?? '').padEnd(2, '0')
    return sign * (integerPart * 100 + Number(decimalPart))
  }

  private formatCentsToMoney(cents: number) {
    const sign = cents < 0 ? '-' : ''
    const absoluteCents = Math.abs(cents)
    const integerPart = Math.floor(absoluteCents / 100)
    const decimalPart = String(absoluteCents % 100).padStart(2, '0')
    return `${sign}${integerPart}.${decimalPart}`
  }

  private normalizeVerifyCode(value: string) {
    const raw = value.trim()
    if (!raw) {
      return ''
    }
    // 标准 UUID 形态直接统一转成小写，保证带连字符输入也能稳定命中数据库中的核销码。
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      return raw.toLowerCase()
    }
    // 兼容“扫码器或外部系统只传 32 位十六进制”的紧凑形态，补齐为标准 UUID。
    const compact = raw.replaceAll(/[^a-zA-Z0-9]/g, '')
    if (/^[a-fA-F0-9]{32}$/.test(compact)) {
      const hex = compact.toLowerCase()
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
    return raw
  }

  private normalizeBusinessStatus(value: string | null | undefined) {
    const normalizedValue = value?.trim()
    if (!normalizedValue) {
      return null
    }
    if (O2O_PREORDER_BUSINESS_STATUSES.includes(normalizedValue as O2oPreorderBusinessStatus)) {
      return normalizedValue as O2oPreorderBusinessStatus
    }
    throw new BizError('商家状态不受支持', 400)
  }

  private resolveCancelledOrderReason(
    order: Pick<O2oPreorder, 'status' | 'timeoutAt' | 'cancelReason'>,
    nowMs = Date.now(),
  ): O2oPreorderCancelReason | null {
    if (order.status !== 'cancelled') {
      return null
    }
    if (order.cancelReason === 'manual' || order.cancelReason === 'timeout') {
      return order.cancelReason
    }
    return this.isOrderTimeoutReached(order, nowMs) ? 'timeout' : 'manual'
  }

  private resolveOrderStatusReport(
    order: Pick<O2oPreorder, 'status' | 'timeoutAt' | 'cancelReason'>,
    nowMs = Date.now(),
  ) {
    const timeoutAtMs = order.timeoutAt ? order.timeoutAt.getTime() : null
    const timeoutReached = Boolean(timeoutAtMs && timeoutAtMs <= nowMs)
    const timeoutSoon = Boolean(timeoutAtMs && timeoutAtMs > nowMs && timeoutAtMs - nowMs <= 2 * 60 * 60 * 1000)
    const cancelReason = this.resolveCancelledOrderReason(order, nowMs)
    if (order.status === 'verified') {
      return {
        scenario: 'verified' as const,
        cancelReason: null,
        timeoutReached,
        timeoutSoon: false,
      }
    }
    if (order.status === 'cancelled' && cancelReason === 'timeout') {
      return {
        scenario: 'timeout_cancelled' as const,
        cancelReason: 'timeout' as const,
        timeoutReached,
        timeoutSoon: false,
      }
    }
    if (order.status === 'cancelled') {
      return {
        scenario: 'cancelled' as const,
        cancelReason: cancelReason ?? 'manual',
        timeoutReached,
        timeoutSoon: false,
      }
    }
    if (timeoutSoon) {
      return {
        scenario: 'timeout_soon' as const,
        cancelReason: null,
        timeoutReached,
        timeoutSoon: true,
      }
    }
    return {
      scenario: 'pending' as const,
      cancelReason: null,
      timeoutReached,
      timeoutSoon: false,
    }
  }

  // 线上预订核销成功后，同步沉淀为一张“散客出库单”：
  // - showNo 使用散客流水单号，满足出库单列表“业务单号”展示要求；
  // - orderType 固定为 walkin，确保归类到“散客单”；
  // - 通过 idempotencyKey 绑定预订单ID，防止重复核销或重试时重复落单。
  private async createWalkInOutboundOrderFromVerifiedPreorder(
    manager: typeof AppDataSource.manager,
    input: {
      preorder: O2oPreorder
      items: O2oPreorderItem[]
      productMap: Map<string, BaseProduct>
      actor: AuthUserContext
    },
  ) {
    const orderRepo = manager.getRepository(BizOutboundOrder)
    const itemRepo = manager.getRepository(BizOutboundOrderItem)
    const clientUserRepo = manager.getRepository(ClientUser)
    const idempotencyKey = `o2o-preorder-verify:${input.preorder.id}`

    const existed = await orderRepo.findOne({ where: { idempotencyKey } })
    if (existed) {
      return existed
    }

    const clientUser = await clientUserRepo.findOne({ where: { id: input.preorder.clientUserId } })
    const showNo = await orderSerialService.generateOrderNo('walkin', manager)

    let totalQty = 0
    let totalAmountCents = 0
    const itemEntities: BizOutboundOrderItem[] = []

    input.items.forEach((row, index) => {
      const product = input.productMap.get(String(row.productId))
      if (!product) {
        throw new BizError('商品不存在，无法生成对应出库单', 409)
      }
      const qty = Number(row.qty ?? 0)
      const unitPriceCents = this.parseMoneyToCents(product.defaultPrice)
      const lineAmountCents = qty * unitPriceCents
      totalQty += qty
      totalAmountCents += lineAmountCents
      itemEntities.push(
        itemRepo.create({
          lineNo: index + 1,
          productId: product.id,
          productNameSnapshot: product.productName,
          qty: qty.toFixed(2),
          unitPrice: this.formatCentsToMoney(unitPriceCents),
          lineAmount: this.formatCentsToMoney(lineAmountCents),
          remark: `线上预订核销，预订单号：${input.preorder.showNo}`,
        }),
      )
    })

    const outboundOrder = orderRepo.create({
      orderUuid: generateOrderUuid(),
      showNo,
      orderType: 'walkin',
      hasCustomerOrder: false,
      isSystemApplied: true,
      issuerName: input.actor.displayName || input.actor.username,
      customerDepartmentName: clientUser?.departmentName?.trim() || null,
      idempotencyKey,
      customerName: clientUser?.realName?.trim() || null,
      remark: `线上预订核销出库，预订单号：${input.preorder.showNo}`,
      totalQty: totalQty.toFixed(2),
      totalAmount: this.formatCentsToMoney(totalAmountCents),
      creatorUserId: input.actor.userId,
      creatorUsername: input.actor.username,
      creatorDisplayName: input.actor.displayName,
    })

    const savedOrder = await orderRepo.save(outboundOrder)
    itemEntities.forEach((item) => {
      item.orderId = savedOrder.id
    })
    await itemRepo.save(itemEntities)
    return savedOrder
  }

  private normalizeDecimalText(value: string | number | null | undefined, fallback = '0.00') {
    if (value === null || value === undefined || value === '') {
      return fallback
    }
    const normalizedNumber = Number(value)
    return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : fallback
  }

  private resolveExpireInSeconds(order: Pick<O2oPreorder, 'status' | 'timeoutAt'>, nowMs = Date.now()) {
    if (order.status !== 'pending' || !order.timeoutAt) {
      return 0
    }
    const remainMs = order.timeoutAt.getTime() - nowMs
    return remainMs > 0 ? Math.floor(remainMs / 1000) : 0
  }

  private parseTimeFilter(value: string | undefined, fieldName: '开始时间' | '结束时间') {
    const normalizedValue = value?.trim()
    if (!normalizedValue) {
      return null
    }
    const parsed = new Date(normalizedValue)
    if (Number.isNaN(parsed.getTime())) {
      throw new BizError(`${fieldName}格式不正确`, 400)
    }
    return parsed
  }

  // 订单是否已达到超时点：
  // 这里只判断“时间是否过期”，不直接关心当前状态，
  // 便于在查询、核销事务、定时回收等多个入口复用同一口径。
  private isOrderTimeoutReached(order: Pick<O2oPreorder, 'timeoutAt'>, nowMs = Date.now()) {
    return Boolean(order.timeoutAt && order.timeoutAt.getTime() <= nowMs)
  }

  // 统一执行“预订单取消 + 释放预订库存”：
  // - 超时自动取消与客户端主动撤回都复用这一套逻辑；
  // - 只回滚 preOrderedStock，不触碰 currentStock，因为 pending 阶段尚未实际出库；
  // - 返回 false 表示订单已经不是 pending，调用方可按各自语义决定提示文案。
  private async cancelOrderInManager(
    manager: typeof AppDataSource.manager,
    input: {
      order: O2oPreorder
      cancelReason: O2oPreorderCancelReason
      operatorType: 'system' | 'client' | 'admin'
      operatorId?: string | null
      operatorName?: string | null
      logRemark?: string | null
    },
  ) {
    if (input.order.status !== 'pending') {
      return false
    }
    const items = await manager.getRepository(O2oPreorderItem).find({ where: { orderId: input.order.id } })
    for (const row of items) {
      const product = await manager.getRepository(BaseProduct).findOne({
        where: { id: row.productId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
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
          operatorType: input.operatorType,
          operatorId: input.operatorId ?? null,
          operatorName: input.operatorName ?? null,
          refType: 'o2o_preorder',
          refId: input.order.id,
          remark: input.logRemark ?? null,
        }),
      )
    }
    input.order.status = 'cancelled'
    input.order.cancelReason = input.cancelReason
    await manager.getRepository(O2oPreorder).save(input.order)
    return true
  }

  // 在事务内执行“单笔超时取消 + 释放预订库存”。
  // 这个方法用于两类场景：
  // 1. 定时/查询前的批量回收；
  // 2. 核销事务里兜底发现订单刚好超时，立即回收并阻断核销。
  private async cancelTimedOutOrderInManager(manager: typeof AppDataSource.manager, order: O2oPreorder) {
    if (order.status !== 'pending' || !this.isOrderTimeoutReached(order)) {
      return false
    }
    const cancelled = await this.cancelOrderInManager(manager, {
      order,
      cancelReason: 'timeout',
      operatorType: 'system',
      operatorName: 'auto_cancel',
      logRemark: '订单超时自动取消，释放预订库存',
    })
    if (!cancelled) {
      return false
    }
    return true
  }

  private async buildOrderDetail(order: O2oPreorder) {
    const id = String(order.id)
    const items = await this.preorderItemRepo.find({ where: { orderId: id }, relations: { product: true } })
    let totalAmountNumber = 0
    const normalizedItems = items.map((item) => {
      const unitPrice = Number(item.product?.defaultPrice ?? 0)
      const lineAmount = unitPrice * Number(item.qty ?? 0)
      totalAmountNumber += lineAmount
      return {
        id: String(item.id),
        productId: String(item.productId),
        productCode: item.product?.productCode ?? '',
        productName: item.product?.productName ?? '',
        defaultPrice: this.normalizeDecimalText(unitPrice),
        qty: item.qty,
        subTotal: this.normalizeDecimalText(lineAmount),
      }
    })
    const nowMs = Date.now()
    const totalAmount = this.normalizeDecimalText(totalAmountNumber)
    return {
      order: {
        statusReport: this.resolveOrderStatusReport(order, nowMs),
        totalAmount,
        expireInSeconds: this.resolveExpireInSeconds(order, nowMs),
        id,
        showNo: order.showNo,
        verifyCode: order.verifyCode,
        status: order.status,
        businessStatus: order.businessStatus ?? null,
        totalQty: order.totalQty,
        timeoutAt: order.timeoutAt,
        verifiedAt: order.verifiedAt,
        createdAt: order.createdAt,
      },
      items: normalizedItems,
      amountSummary: {
        totalAmount,
        totalQty: order.totalQty,
        totalItemCount: normalizedItems.length,
      },
      qrPayload: `y-link://o2o/verify/${order.verifyCode}`,
    }
  }

  private async resolveOrderTotalAmountMap(orderIds: string[]) {
    if (!orderIds.length) {
      return new Map<string, string>()
    }
    const rows = await this.preorderItemRepo
      .createQueryBuilder('item')
      .leftJoin('item.product', 'product')
      .select('item.orderId', 'orderId')
      .addSelect('SUM(item.qty * COALESCE(product.defaultPrice, 0))', 'totalAmount')
      .where('item.orderId IN (:...orderIds)', { orderIds })
      .groupBy('item.orderId')
      .getRawMany<{ orderId: string; totalAmount: string | number | null }>()
    return new Map(rows.map((item) => [String(item.orderId), this.normalizeDecimalText(item.totalAmount)]))
  }

  async listMallProducts() {
    // 商城端只暴露“可售且已上架”的商品，并把库存口径统一换算成前端直接可用的 availableStock。
    const products = await this.productRepo.find({
      where: { isActive: true, o2oStatus: 'listed' },
      order: { id: 'DESC' },
    })

    if (!products.length) return []

    const productIds = products.map((p) => String(p.id))
    const relations = await AppDataSource.manager.getRepository(RelProductTag).find({
      where: { productId: In(productIds) },
      relations: { tag: true },
    })

    const productTagMap = new Map<string, string[]>()
    relations.forEach((relation) => {
      const productId = String(relation.productId)
      const currentTags = productTagMap.get(productId) ?? []
      if (relation.tag?.tagName) {
        currentTags.push(relation.tag.tagName)
      }
      productTagMap.set(productId, currentTags)
    })

    return products.map((item) => ({
      id: String(item.id),
      productCode: item.productCode,
      productName: item.productName,
      defaultPrice: item.defaultPrice,
      tags: productTagMap.get(String(item.id)) ?? [],
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
      const products = await manager.getRepository(BaseProduct).find({
        where: { id: In(productIds) },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
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
    const nowMs = Date.now()
    const totalAmountMap = await this.resolveOrderTotalAmountMap(rows.map((item) => String(item.id)))
    return rows.map((item) => ({
      statusReport: this.resolveOrderStatusReport(item, nowMs),
      totalAmount: totalAmountMap.get(String(item.id)) ?? '0.00',
      expireInSeconds: this.resolveExpireInSeconds(item, nowMs),
      id: String(item.id),
      showNo: item.showNo,
      verifyCode: item.verifyCode,
      status: item.status,
      businessStatus: item.businessStatus ?? null,
      totalQty: item.totalQty,
      timeoutAt: item.timeoutAt,
      createdAt: item.createdAt,
    }))
  }

  async getMyOrderDetail(auth: ClientAuthContext, id: string) {
    await this.cancelTimeoutOrders()
    const order = await this.preorderRepo.findOne({ where: { id, clientUserId: auth.userId } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    return this.buildOrderDetail(order)
  }

  async listConsoleOrders(input: {
    status?: 'pending' | 'verified' | 'cancelled'
    keyword?: string
    startTime?: string
    endTime?: string
    limit?: number
  }) {
    const normalizedKeyword = input.keyword?.trim() ?? ''
    const normalizedLimit = Math.max(1, Math.min(200, Number(input.limit) || 50))
    const startTime = this.parseTimeFilter(input.startTime, '开始时间')
    const endTime = this.parseTimeFilter(input.endTime, '结束时间')
    if (startTime && endTime && startTime.getTime() > endTime.getTime()) {
      throw new BizError('开始时间不能晚于结束时间', 400)
    }
    await this.cancelTimeoutOrders()
    const queryBuilder = this.preorderRepo.createQueryBuilder('order').orderBy('order.id', 'DESC').take(normalizedLimit)

    if (input.status) {
      queryBuilder.andWhere('order.status = :status', { status: input.status })
    }

    if (startTime) {
      queryBuilder.andWhere('order.createdAt >= :startTime', { startTime })
    }
    if (endTime) {
      queryBuilder.andWhere('order.createdAt <= :endTime', { endTime })
    }

    if (normalizedKeyword) {
      const keyword = `%${normalizedKeyword}%`
      const clientKeywordSubQuery = this.preorderRepo
        .createQueryBuilder('order_keyword_client')
        .subQuery()
        .select('1')
        .from(ClientUser, 'clientUser')
        .where('clientUser.id = order.clientUserId')
        .andWhere(
          '(clientUser.realName LIKE :keyword OR clientUser.mobile LIKE :keyword OR clientUser.departmentName LIKE :keyword)',
        )
        .getQuery()
      const itemKeywordSubQuery = this.preorderRepo
        .createQueryBuilder('order_keyword_item')
        .subQuery()
        .select('1')
        .from(O2oPreorderItem, 'item')
        .leftJoin(BaseProduct, 'product', 'product.id = item.productId')
        .where('item.orderId = order.id')
        .andWhere('(product.productName LIKE :keyword OR product.productCode LIKE :keyword)')
        .getQuery()
      queryBuilder.andWhere(
        new Brackets((keywordQb) => {
          keywordQb
            .where('order.showNo LIKE :keyword', { keyword })
            .orWhere('order.verifyCode LIKE :keyword', { keyword })
            .orWhere('order.remark LIKE :keyword', { keyword })
            .orWhere('order.verifiedBy LIKE :keyword', { keyword })
            .orWhere(`EXISTS ${clientKeywordSubQuery}`, { keyword })
            .orWhere(`EXISTS ${itemKeywordSubQuery}`, { keyword })
        }),
      )
    }

    const rows = await queryBuilder.getMany()
    const nowMs = Date.now()
    const totalAmountMap = await this.resolveOrderTotalAmountMap(rows.map((item) => String(item.id)))
    return rows.map((item) => ({
      statusReport: this.resolveOrderStatusReport(item, nowMs),
      totalAmount: totalAmountMap.get(String(item.id)) ?? '0.00',
      expireInSeconds: this.resolveExpireInSeconds(item, nowMs),
      id: String(item.id),
      showNo: item.showNo,
      verifyCode: item.verifyCode,
      status: item.status,
      businessStatus: item.businessStatus ?? null,
      totalQty: item.totalQty,
      timeoutAt: item.timeoutAt,
      createdAt: item.createdAt,
    }))
  }

  async detailById(id: string) {
    await this.cancelTimeoutOrders()
    const order = await this.preorderRepo.findOne({ where: { id } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    return this.buildOrderDetail(order)
  }

  async updateBusinessStatus(input: UpdateOrderBusinessStatusInput) {
    const order = await this.preorderRepo.findOne({ where: { id: input.orderId } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    order.businessStatus = this.normalizeBusinessStatus(input.businessStatus)
    await this.preorderRepo.save(order)
    return this.detailById(order.id)
  }

  async cancelMyOrder(auth: ClientAuthContext, id: string) {
    await this.cancelTimeoutOrders()
    await AppDataSource.transaction(async (manager) => {
      const order = await manager.getRepository(O2oPreorder).findOne({
        where: { id },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('预订单不存在', 404)
      }
      if (String(order.clientUserId) !== String(auth.userId)) {
        throw new BizError('无权撤回他人订单', 403)
      }
      if (await this.cancelTimedOutOrderInManager(manager, order)) {
        throw new BizError('订单已超时取消，无法撤回', 409)
      }
      if (order.status === 'verified') {
        throw new BizError('订单已核销，无法撤回', 409)
      }
      if (order.status === 'cancelled') {
        const cancelReason = this.resolveCancelledOrderReason(order)
        throw new BizError(cancelReason === 'timeout' ? '订单已超时取消，无法重复撤回' : '订单已撤回，请勿重复操作', 409)
      }
      const cancelled = await this.cancelOrderInManager(manager, {
        order,
        cancelReason: 'manual',
        operatorType: 'client',
        operatorId: String(auth.userId),
        operatorName: auth.realName || auth.mobile,
        logRemark: '客户端主动撤回订单，释放预订库存',
      })
      if (!cancelled) {
        throw new BizError('当前预订单不可撤回', 409)
      }
    })
    return this.getMyOrderDetail(auth, id)
  }

  async verifyByCode(verifyCode: string, actor: AuthUserContext) {
    const normalizedVerifyCode = this.normalizeVerifyCode(verifyCode)
    await this.cancelTimeoutOrders()
    return AppDataSource.transaction(async (manager) => {
      const order = await manager.getRepository(O2oPreorder).findOne({ where: { verifyCode: normalizedVerifyCode } })
      if (!order) {
        throw new BizError('预订单不存在', 404)
      }
      // 这里在事务内部再次兜底校验一次超时：
      // 防止订单在“外层 cancelTimeoutOrders 执行完成后、事务真正扣库存前”刚好跨过超时点。
      if (await this.cancelTimedOutOrderInManager(manager, order)) {
        throw new BizError('预订单已超时取消，库存已释放，不可继续核销', 409)
      }
      if (order.status !== 'pending') {
        throw new BizError('当前预订单不可核销', 409)
      }
      const items = await manager.getRepository(O2oPreorderItem).find({ where: { orderId: order.id } })
      const productIds = [...new Set(items.map((item) => String(item.productId)))]
      const products = await manager.getRepository(BaseProduct).find({
        where: { id: In(productIds) },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
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
      // 同事务生成一张散客出库单：
      // 这样“线上预订并成功核销”的订单会自然进入出库单列表，
      // 且业务单号展示为散客流水单号，而不是预订单号。
      await this.createWalkInOutboundOrderFromVerifiedPreorder(manager, {
        preorder: savedOrder,
        items,
        productMap,
        actor,
      })
      return this.detailById(savedOrder.id)
    })
  }

  async inboundStock(productId: string, qty: number, actor: AuthUserContext, remark?: string) {
    const normalizedQty = Math.floor(Number(qty))
    if (!Number.isInteger(normalizedQty) || normalizedQty <= 0) {
      throw new BizError('入库数量必须为正整数', 400)
    }
    return AppDataSource.transaction(async (manager) => {
      const product = await manager.getRepository(BaseProduct).findOne({
        where: { id: productId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
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
    let cancelledCount = 0
    // 分批循环回收，避免单次只处理 100 条导致仍有超时订单残留。
    // 这样即使门店长时间未触发查询，也能在下一次入口访问时尽量回收完整。
    while (true) {
      const timeoutOrders = await this.preorderRepo.find({
        where: {
          status: 'pending',
          timeoutAt: LessThanOrEqual(new Date()),
        },
        take: 100,
      })
      if (!timeoutOrders.length) {
        break
      }
      await AppDataSource.transaction(async (manager) => {
        for (const order of timeoutOrders) {
          const cancelled = await this.cancelTimedOutOrderInManager(manager, order)
          if (cancelled) {
            cancelledCount += 1
          }
        }
      })
      if (timeoutOrders.length < 100) {
        break
      }
    }
    return { cancelledCount }
  }

  async getVerifyDetail(verifyCode: string) {
    const normalizedVerifyCode = this.normalizeVerifyCode(verifyCode)
    await this.cancelTimeoutOrders()
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
    await this.cancelTimeoutOrders()
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
