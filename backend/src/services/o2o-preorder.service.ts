/**
 * 模块说明：backend/src/services/o2o-preorder.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { randomUUID } from 'node:crypto'
import { Brackets, type EntityManager, In, LessThanOrEqual, Not } from 'typeorm'
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
  type O2oPreorderStatus,
} from '../entities/o2o-preorder.entity.js'
import { O2oPreorderItem } from '../entities/o2o-preorder-item.entity.js'
import {
  O2oReturnRequest,
  type O2oReturnRequestStatus,
} from '../entities/o2o-return-request.entity.js'
import { O2oReturnRequestItem } from '../entities/o2o-return-request-item.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import type { ClientAuthContext } from '../types/client-auth.js'
import { BizError } from '../utils/errors.js'
import { generateOrderUuid } from '../utils/id-generator.js'
import { orderSerialService } from './order-serial.service.js'
import { systemConfigService } from './system-config.service.js'
import type { PaginationResult } from '../types/api.js'

export interface SubmitPreorderItemInput {
  productId: string | number
  qty: number
}

export interface SubmitPreorderInput {
  items: SubmitPreorderItemInput[]
  remark?: string
}

export interface UpdateMyPreorderInput {
  items: SubmitPreorderItemInput[]
  remark?: string
}

export interface UpdateOrderBusinessStatusInput {
  orderId: string
  businessStatus: O2oPreorderBusinessStatus | null
}

export interface UpdateOrderMerchantMessageInput {
  orderId: string
  merchantMessage: string | null
}

export interface SubmitReturnRequestItemInput {
  productId: string | number
  qty: number
}

export interface SubmitReturnRequestInput {
  reason: string
  items: SubmitReturnRequestItemInput[]
}

export interface MyOrderListQuery {
  status?: 'pending' | 'verified' | 'cancelled'
  keyword?: string
  page: number
  pageSize: number
}

export interface O2oPreorderSummaryView {
  statusReport: {
    scenario: 'pending' | 'verified' | 'cancelled' | 'timeout_soon' | 'timeout_cancelled'
    cancelReason: 'timeout' | 'manual' | null
    timeoutReached: boolean
    timeoutSoon: boolean
  }
  totalAmount: string
  expireInSeconds: number
  id: string
  showNo: string
  verifyCode: string
  status: O2oPreorder['status']
  businessStatus: O2oPreorder['businessStatus']
  merchantMessage: string | null
  totalQty: number
  timeoutAt: Date | null
  createdAt: Date
}

export interface O2oPreorderDetailItemView {
  id: string
  productId: string
  productCode: string
  productName: string
  defaultPrice: string
  qty: number
  returnedQty: number
  availableReturnQty: number
  subTotal: string
}

export interface O2oPreorderDetailView {
  order: {
    statusReport: O2oPreorderSummaryView['statusReport']
    totalAmount: string
    expireInSeconds: number
    id: string
    showNo: string
    verifyCode: string
    status: O2oPreorder['status']
    businessStatus: O2oPreorder['businessStatus']
    merchantMessage: string | null
    remark: string | null
    updateCount: number
    remainingUpdateCount: number
    maxUpdateCount: number
    totalQty: number
    timeoutAt: Date | null
    verifiedAt: Date | null
    createdAt: Date
  }
  customerProfile: {
    id: string
    username: string
    mobile: string | null
    email: string | null
    departmentName: string | null
  } | null
  items: O2oPreorderDetailItemView[]
  returnRequests: O2oReturnRequestView[]
  amountSummary: {
    totalAmount: string
    totalQty: number
    totalItemCount: number
  }
  qrPayload: string
}

export interface O2oReturnRequestItemView {
  id: string
  productId: string
  productCode: string
  productName: string
  qty: number
}

export interface O2oReturnRequestView {
  id: string
  returnNo: string
  verifyCode: string
  status: O2oReturnRequestStatus
  sourceOrderStatus: O2oPreorderStatus
  reason: string
  totalQty: number
  createdAt: Date
  verifiedAt: Date | null
  verifiedBy: string | null
  qrPayload: string
  items: O2oReturnRequestItemView[]
}

export interface O2oVerifyDetailView {
  verifyTargetType: 'preorder' | 'return_request'
  detail: O2oPreorderDetailView | O2oReturnRequestView
}

export interface O2oVerifyResultView extends O2oVerifyDetailView {
  operationType: 'preorder_verify' | 'return_verify'
}

export const O2O_PREORDER_REMARK_MAX_LENGTH = 255
export const O2O_MERCHANT_MESSAGE_MAX_LENGTH = 500
export const O2O_RETURN_REASON_MAX_LENGTH = 500

const LIKE_ESCAPE_CHAR = String.raw`\\`
const LIKE_SPECIAL_CHAR_PATTERN = /[%_\\]/g

class O2oPreorderService {
  private readonly productRepo = AppDataSource.getRepository(BaseProduct)
  private readonly preorderRepo = AppDataSource.getRepository(O2oPreorder)
  private readonly preorderItemRepo = AppDataSource.getRepository(O2oPreorderItem)
  private readonly returnRequestRepo = AppDataSource.getRepository(O2oReturnRequest)
  private readonly returnRequestItemRepo = AppDataSource.getRepository(O2oReturnRequestItem)
  private readonly clientUserRepo = AppDataSource.getRepository(ClientUser)
  private readonly inventoryLogRepo = AppDataSource.getRepository(InventoryLog)

  /**
   * 客户端改单次数上限：
   * - 统一从系统配置读取，避免业务规则硬编码在服务常量中；
   * - 便于后续通过系统配置调整，不需要再次发版。
   */
  private async getClientPreorderUpdateLimit() {
    const config = await systemConfigService.getO2oRuleConfigs()
    return config.clientPreorderUpdateLimit
  }

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

  /**
   * 使用类型守卫判断输入值是否属于允许的商家业务状态，
   * 避免在业务入口处通过 as 进行强制类型断言导致的“假安全”。
   */
  private isBusinessStatus(value: string): value is O2oPreorderBusinessStatus {
    return (O2O_PREORDER_BUSINESS_STATUSES as readonly string[]).includes(value)
  }

  private normalizeBusinessStatus(value: string | null | undefined): O2oPreorderBusinessStatus | null {
    const normalizedValue = value?.trim()
    if (!normalizedValue) {
      return null
    }
    if (this.isBusinessStatus(normalizedValue)) {
      return normalizedValue
    }
    throw new BizError('商家状态不受支持', 400)
  }

  /**
   * 统一商家留言口径：
   * - 入参去首尾空格；
   * - 空字符串按“清空留言”处理并统一回写 null；
   * - 超长直接拦截，避免数据库层报错影响可读性。
   */
  private normalizeMerchantMessage(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null
    }
    const normalizedValue = value.trim()
    if (!normalizedValue) {
      return null
    }
    if (normalizedValue.length > O2O_MERCHANT_MESSAGE_MAX_LENGTH) {
      throw new BizError(`商家留言长度不能超过${O2O_MERCHANT_MESSAGE_MAX_LENGTH}个字符`, 400)
    }
    return normalizedValue
  }

  private normalizeReturnReason(value: string | null | undefined): string {
    const normalizedValue = value?.trim() ?? ''
    if (!normalizedValue) {
      throw new BizError('请填写退货原因', 400)
    }
    if (normalizedValue.length > O2O_RETURN_REASON_MAX_LENGTH) {
      throw new BizError(`退货原因长度不能超过${O2O_RETURN_REASON_MAX_LENGTH}个字符`, 400)
    }
    return normalizedValue
  }

  private normalizePreorderRemark(value: string | null | undefined): string | null {
    const normalizedValue = value?.trim() ?? ''
    if (!normalizedValue) {
      return null
    }
    if (normalizedValue.length > O2O_PREORDER_REMARK_MAX_LENGTH) {
      throw new BizError(`订单备注长度不能超过${O2O_PREORDER_REMARK_MAX_LENGTH}个字符`, 400)
    }
    return normalizedValue
  }

  /**
   * 统一整理客户端传入的预订单商品明细：
   * - 商品 ID 转成字符串并去空格；
   * - 数量统一收敛为正整数；
   * - 同一商品若被前端重复传入，则自动合并数量，避免后续库存校验口径分叉。
   */
  private normalizePreorderItems(items: SubmitPreorderItemInput[]) {
    if (!Array.isArray(items) || !items.length) {
      throw new BizError('至少选择一个商品', 400)
    }
    const mergedQtyMap = new Map<string, number>()
    items.forEach((item) => {
      const productId = String(item.productId).trim()
      const qty = Math.floor(Number(item.qty))
      if (!productId || !Number.isInteger(qty) || qty <= 0) {
        throw new BizError('商品数量必须为正整数', 400)
      }
      const currentQty = mergedQtyMap.get(productId) ?? 0
      mergedQtyMap.set(productId, currentQty + qty)
    })
    return [...mergedQtyMap.entries()].map(([productId, qty]) => ({ productId, qty }))
  }

  private resolveProductLimitQty(product: BaseProduct, o2oRules: Awaited<ReturnType<typeof systemConfigService.getO2oRuleConfigs>>) {
    return o2oRules.limitEnabled
      ? Math.min(Number(product.limitPerUser || 5), o2oRules.limitQty)
      : Number(product.limitPerUser || 5)
  }

  private async generateReturnRequestNo(manager = AppDataSource.manager): Promise<string> {
    // 退货申请单号采用独立前缀，便于核销台与线下门店快速区分“取货码 / 退货码”。
    const dateText = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const prefix = `RO${dateText}`
    const raw = await manager
      .getRepository(O2oReturnRequest)
      .createQueryBuilder('returnRequest')
      .select('returnRequest.returnNo', 'returnNo')
      .where('returnRequest.returnNo LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('returnRequest.returnNo', 'DESC')
      .getRawOne<{ returnNo?: string }>()
    const current = raw?.returnNo ? Number.parseInt(raw.returnNo.slice(prefix.length), 10) || 0 : 0
    return `${prefix}${String(current + 1).padStart(4, '0')}`
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

  /**
   * 对 LIKE 条件中的关键字做转义，避免把用户输入的 % / _ 误解为通配符。
   * 这里使用 ESCAPE '\'，可同时兼容 MySQL 与 SQLite。
   */
  private escapeLikeKeyword(value: string) {
    return value.replaceAll(LIKE_SPECIAL_CHAR_PATTERN, `${LIKE_ESCAPE_CHAR}$&`)
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

  private async listReturnRequestsByOrder(orderId: string) {
    return this.returnRequestRepo.find({
      where: { orderId },
      order: { id: 'DESC' },
    })
  }

  private async listReturnRequestItemsByRequestIds(requestIds: string[]) {
    if (!requestIds.length) {
      return []
    }
    return this.returnRequestItemRepo.find({
      where: { returnRequestId: In(requestIds) },
      relations: { product: true },
      order: { id: 'ASC' },
    })
  }

  private async resolveReturnedQtyMapByOrder(orderId: string) {
    const returnRequests = await this.listReturnRequestsByOrder(orderId)
    const requestIds = returnRequests.map((item) => String(item.id))
    const requestItemRows = await this.listReturnRequestItemsByRequestIds(requestIds)
    const pendingRequestIdSet = new Set(
      returnRequests.filter((item) => item.status === 'pending').map((item) => String(item.id)),
    )
    const returnedQtyMap = new Map<string, number>()
    requestItemRows.forEach((item) => {
      if (!pendingRequestIdSet.has(String(item.returnRequestId))) {
        return
      }
      const productId = String(item.productId)
      const currentQty = returnedQtyMap.get(productId) ?? 0
      returnedQtyMap.set(productId, currentQty + Math.max(0, Number(item.qty ?? 0)))
    })
    return { returnRequests, returnedQtyMap, requestItemRows }
  }

  private buildReturnRequestView(
    returnRequest: O2oReturnRequest,
    requestItems: O2oReturnRequestItem[],
  ): O2oReturnRequestView {
    return {
      id: String(returnRequest.id),
      returnNo: returnRequest.returnNo,
      verifyCode: returnRequest.verifyCode,
      status: returnRequest.status,
      sourceOrderStatus: returnRequest.sourceOrderStatus,
      reason: returnRequest.reason,
      totalQty: Number(returnRequest.totalQty ?? 0),
      createdAt: returnRequest.createdAt,
      verifiedAt: returnRequest.verifiedAt,
      verifiedBy: returnRequest.verifiedBy ?? null,
      qrPayload: `y-link://o2o/return/${returnRequest.verifyCode}`,
      items: requestItems.map((item) => ({
        id: String(item.id),
        productId: String(item.productId),
        productCode: item.product?.productCode ?? '',
        productName: item.product?.productName ?? '',
        qty: Number(item.qty ?? 0),
      })),
    }
  }

  private async buildReturnRequestDetail(returnRequest: O2oReturnRequest): Promise<O2oReturnRequestView> {
    const requestItems = await this.listReturnRequestItemsByRequestIds([String(returnRequest.id)])
    return this.buildReturnRequestView(returnRequest, requestItems)
  }

  private async buildOrderDetail(order: O2oPreorder): Promise<O2oPreorderDetailView> {
    const id = String(order.id)
    const clientPreorderUpdateLimit = await this.getClientPreorderUpdateLimit()
    const clientUser = await this.clientUserRepo.findOne({
      where: { id: String(order.clientUserId) },
      select: ['id', 'realName', 'mobile', 'email', 'departmentName'],
    })
    // 历史库与不同驱动下 order_id 参数类型可能出现 number/string 混用，
    // 这里做双口径兼容查询，避免订单详情“总件数存在但明细为空”。
    let items = await this.preorderItemRepo.find({
      where: { orderId: order.id as unknown as string },
      relations: { product: true },
    })
    if (!items.length) {
      items = await this.preorderItemRepo.find({
        where: { orderId: id },
        relations: { product: true },
      })
    }
    if (!items.length && Number(order.totalQty ?? 0) > 0) {
      items = await this.buildFallbackOrderItemsFromInventoryLog(id)
    }
    const { returnRequests, returnedQtyMap, requestItemRows } = await this.resolveReturnedQtyMapByOrder(id)
    const requestItemsByRequestId = new Map<string, O2oReturnRequestItem[]>()
    requestItemRows.forEach((item) => {
      const requestId = String(item.returnRequestId)
      const currentItems = requestItemsByRequestId.get(requestId) ?? []
      currentItems.push(item)
      requestItemsByRequestId.set(requestId, currentItems)
    })
    let totalAmountNumber = 0
    const normalizedItems = items.map((item) => {
      const unitPrice = Number(item.product?.defaultPrice ?? 0)
      const lineAmount = unitPrice * Number(item.qty ?? 0)
      const totalQty = Math.max(0, Number(item.qty ?? 0))
      const returnedQty = Math.min(totalQty, Math.max(0, Number(returnedQtyMap.get(String(item.productId)) ?? 0)))
      totalAmountNumber += lineAmount
      return {
        id: String(item.id),
        productId: String(item.productId),
        productCode: item.product?.productCode ?? '',
        productName: item.product?.productName ?? '',
        defaultPrice: this.normalizeDecimalText(unitPrice),
        qty: totalQty,
        returnedQty,
        availableReturnQty: Math.max(0, totalQty - returnedQty),
        subTotal: this.normalizeDecimalText(lineAmount),
      }
    })
    const nowMs = Date.now()
    const totalAmount = this.normalizeDecimalText(totalAmountNumber)
    const updateCount = Math.max(0, Number(order.updateCount ?? 0))
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
        merchantMessage: order.merchantMessage ?? null,
        remark: order.remark ?? null,
        updateCount,
        remainingUpdateCount: Math.max(0, clientPreorderUpdateLimit - updateCount),
        maxUpdateCount: clientPreorderUpdateLimit,
        totalQty: order.totalQty,
        timeoutAt: order.timeoutAt,
        verifiedAt: order.verifiedAt,
        createdAt: order.createdAt,
      },
      customerProfile: clientUser
        ? {
            id: String(clientUser.id),
            username: clientUser.realName?.trim() || '未命名用户',
            mobile: clientUser.mobile?.trim() || null,
            email: clientUser.email?.trim() || null,
            departmentName: clientUser.departmentName?.trim() || null,
          }
        : null,
      items: normalizedItems,
      returnRequests: returnRequests.map((item) =>
        this.buildReturnRequestView(item, requestItemsByRequestId.get(String(item.id)) ?? []),
      ),
      amountSummary: {
        totalAmount,
        totalQty: order.totalQty,
        totalItemCount: normalizedItems.length,
      },
      qrPayload: `y-link://o2o/verify/${order.verifyCode}`,
    }
  }

  private async buildFallbackOrderItemsFromInventoryLog(orderId: string): Promise<O2oPreorderItem[]> {
    // 历史异常数据中可能出现“主订单存在、totalQty>0，但明细表丢失”的情况。
    // 这里使用 preorder_hold 库存流水回填最小可展示明细，确保客户端详情可读。
    const logs = await this.inventoryLogRepo.find({
      where: {
        refType: 'o2o_preorder',
        refId: orderId,
        changeType: 'preorder_hold',
      },
      order: {
        id: 'ASC',
      },
    })
    if (!logs.length) {
      return []
    }
    const groupedQtyByProductId = new Map<string, number>()
    logs.forEach((log) => {
      const productId = String(log.productId)
      const currentQty = groupedQtyByProductId.get(productId) ?? 0
      groupedQtyByProductId.set(productId, currentQty + Math.max(0, Number(log.changeQty ?? 0)))
    })
    const productIds = [...groupedQtyByProductId.keys()]
    const products = await this.productRepo.find({
      where: { id: In(productIds) },
    })
    const productMap = new Map(products.map((product) => [String(product.id), product]))
    return productIds.map((productId, index) => {
      const product = productMap.get(productId)
      const fallbackItem = new O2oPreorderItem()
      fallbackItem.id = `fallback-${orderId}-${index + 1}`
      fallbackItem.orderId = orderId
      fallbackItem.productId = productId
      fallbackItem.qty = groupedQtyByProductId.get(productId) ?? 0
      fallbackItem.product = product
      return fallbackItem
    })
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
    const raw = await manager
      .getRepository(O2oPreorder)
      .createQueryBuilder('order')
      .select('order.showNo', 'showNo')
      .where('order.showNo LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('order.showNo', 'DESC')
      .getRawOne<{ showNo?: string }>()
    const current = raw?.showNo ? Number.parseInt(raw.showNo.slice(prefix.length), 10) || 0 : 0
    return `${prefix}${String(current + 1).padStart(4, '0')}`
  }

  // 详细注释：创建退货申请前，需要先统一校验订单是否仍处于允许售后的窗口。
  // 待取货订单若已超时，需要先走自动取消逻辑，避免继续基于脏状态申请退货。
  private async assertCanCreateReturnRequestForOrder(
    manager: typeof AppDataSource.manager,
    order: O2oPreorder,
  ) {
    if (await this.cancelTimedOutOrderInManager(manager, order)) {
      throw new BizError('订单已超时取消，无法申请退货', 409)
    }
    if (order.status === 'cancelled') {
      throw new BizError('已取消订单不可申请退货', 409)
    }
    if (order.status === 'pending') {
      throw new BizError('订单未核销前请使用修改订单，不支持直接申请退货', 409)
    }
    if (order.status !== 'verified') {
      throw new BizError('当前订单状态不可申请退货', 409)
    }
  }

  // 详细注释：优先读取订单商品明细；若历史脏数据导致明细缺失，再退回库存日志兜底构造，
  // 从而保证老订单仍能正确计算“可退数量”。
  private async loadOrderItemsForReturn(
    manager: typeof AppDataSource.manager,
    orderId: string,
    totalQty: number,
  ) {
    const orderItems = await manager.getRepository(O2oPreorderItem).find({
      where: { orderId },
      relations: { product: true },
    })
    if (orderItems.length || totalQty <= 0) {
      return orderItems
    }
    return this.buildFallbackOrderItemsFromInventoryLog(orderId)
  }

  // 详细注释：同一订单允许多次退货，但门店尚未核销完成的申请需要先占住可退数量，
  // 避免用户连续提交多笔申请把同一件商品重复退超。
  private async buildPendingReturnQtyMap(
    manager: typeof AppDataSource.manager,
    orderId: string,
  ) {
    const pendingReturnRequests = await manager.getRepository(O2oReturnRequest).find({
      where: { orderId, status: 'pending' },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_read' },
    })
    const pendingRequestIds = pendingReturnRequests.map((item) => String(item.id))
    const pendingReturnItems = pendingRequestIds.length
      ? await manager.getRepository(O2oReturnRequestItem).find({
          where: { returnRequestId: In(pendingRequestIds) },
        })
      : []
    const pendingQtyMap = new Map<string, number>()
    pendingReturnItems.forEach((item) => {
      const productId = String(item.productId)
      const currentQty = pendingQtyMap.get(productId) ?? 0
      pendingQtyMap.set(productId, currentQty + Math.max(0, Number(item.qty ?? 0)))
    })
    return pendingQtyMap
  }

  // 详细注释：把同一商品的多行请求先合并，再与订单原始数量、待核销量逐项比对，
  // 统一产出本次退货申请需要写入数据库的商品映射和总件数。
  private validateReturnRequestItems(
    orderItems: O2oPreorderItem[],
    pendingQtyMap: Map<string, number>,
    normalizedItems: Array<{ productId: string; qty: number }>,
  ) {
    const orderItemMap = new Map(orderItems.map((item) => [String(item.productId), item]))
    const mergedRequestQtyMap = new Map<string, number>()
    normalizedItems.forEach((item) => {
      const currentQty = mergedRequestQtyMap.get(item.productId) ?? 0
      mergedRequestQtyMap.set(item.productId, currentQty + item.qty)
    })

    let totalQty = 0
    for (const [productId, requestQty] of mergedRequestQtyMap) {
      const orderItem = orderItemMap.get(productId)
      if (!orderItem) {
        throw new BizError('存在不属于当前订单的商品，无法申请退货', 409)
      }
      const orderQty = Math.max(0, Number(orderItem.qty ?? 0))
      const pendingQty = Math.max(0, Number(pendingQtyMap.get(productId) ?? 0))
      const availableReturnQty = Math.max(0, orderQty - pendingQty)
      if (availableReturnQty <= 0) {
        throw new BizError(`商品「${orderItem.product?.productName ?? productId}」暂无可退数量`, 409)
      }
      if (requestQty > availableReturnQty) {
        throw new BizError(`商品「${orderItem.product?.productName ?? productId}」最多可退 ${availableReturnQty} 件`, 409)
      }
      totalQty += requestQty
    }

    return { mergedRequestQtyMap, totalQty }
  }

  async submit(auth: ClientAuthContext, input: SubmitPreorderInput) {
    const normalizedItems = this.normalizePreorderItems(input.items)
    const normalizedRemark = this.normalizePreorderRemark(input.remark)

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
        const limitQty = this.resolveProductLimitQty(product, o2oRules)
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
          remark: normalizedRemark,
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

  private async assertCanUpdateOrderInManager(manager: EntityManager, order: O2oPreorder) {
    if (await this.cancelTimedOutOrderInManager(manager, order)) {
      throw new BizError('订单已超时取消，无法修改', 409)
    }
    if (order.status === 'verified') {
      throw new BizError('订单已核销，无法修改', 409)
    }
    if (order.status === 'cancelled') {
      throw new BizError('订单已取消，无法修改', 409)
    }
    if (order.status !== 'pending') {
      throw new BizError('当前订单状态不可修改', 409)
    }
    const clientPreorderUpdateLimit = await this.getClientPreorderUpdateLimit()
    if (Math.max(0, Number(order.updateCount ?? 0)) >= clientPreorderUpdateLimit) {
      throw new BizError(`订单最多仅可修改 ${clientPreorderUpdateLimit} 次`, 409)
    }

    const returnRequestCount = await manager.getRepository(O2oReturnRequest).count({
      where: { orderId: String(order.id) },
    })
    if (returnRequestCount > 0) {
      throw new BizError('当前订单已存在退货申请记录，暂不支持修改订单', 409)
    }
  }

  private async loadEditableOrderProductsInManager(
    manager: EntityManager,
    productIds: string[],
  ): Promise<Map<string, BaseProduct>> {
    const productRepo = manager.getRepository(BaseProduct)
    const products = await productRepo.find({
      where: { id: In(productIds) },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
    })
    if (products.length !== productIds.length) {
      throw new BizError('存在无效商品，无法修改订单', 400)
    }
    return new Map<string, BaseProduct>(products.map((item: BaseProduct) => [String(item.id), item]))
  }

  private validateUpdatedPreorderItems(
    normalizedItems: Array<{ productId: string; qty: number }>,
    existingQtyMap: Map<string, number>,
    productMap: Map<string, BaseProduct>,
    o2oRules: Awaited<ReturnType<typeof systemConfigService.getO2oRuleConfigs>>,
  ) {
    let totalQty = 0
    normalizedItems.forEach((row) => {
      const product = productMap.get(row.productId)
      if (!product) {
        throw new BizError('存在无效商品，无法修改订单', 400)
      }
      const originalQty = existingQtyMap.get(row.productId) ?? 0
      if (!product.isActive || product.o2oStatus !== 'listed') {
        if (originalQty <= 0) {
          throw new BizError(`商品「${product.productName}」已下架，不可加入订单`, 409)
        }
        if (row.qty > originalQty) {
          throw new BizError(`商品「${product.productName}」已下架，当前只能维持或减少原有数量`, 409)
        }
      }

      const effectiveAvailableStock = Math.max(
        0,
        Number(product.currentStock ?? 0) - Number(product.preOrderedStock ?? 0) + originalQty,
      )
      if (effectiveAvailableStock < row.qty) {
        throw new BizError(`商品「${product.productName}」库存不足，当前最多可保留 ${effectiveAvailableStock} 件`, 409)
      }

      const limitQty = this.resolveProductLimitQty(product, o2oRules)
      if (o2oRules.limitEnabled && row.qty > limitQty) {
        throw new BizError(`商品「${product.productName}」超过限购数量`, 409)
      }
      totalQty += row.qty
    })

    if (totalQty <= 0) {
      throw new BizError('订单至少保留一件商品', 400)
    }
    return totalQty
  }

  private async applyPreorderItemStockDeltaInManager(
    manager: EntityManager,
    auth: ClientAuthContext,
    order: O2oPreorder,
    existingQtyMap: Map<string, number>,
    nextQtyMap: Map<string, number>,
    productMap: Map<string, BaseProduct>,
  ) {
    const productRepo = manager.getRepository(BaseProduct)
    const inventoryLogRepo = manager.getRepository(InventoryLog)
    const changedProductIds = [...new Set([...existingQtyMap.keys(), ...nextQtyMap.keys()])]

    for (const productId of changedProductIds) {
      const previousQty = existingQtyMap.get(productId) ?? 0
      const nextQty = nextQtyMap.get(productId) ?? 0
      const deltaQty = nextQty - previousQty
      if (deltaQty === 0) {
        continue
      }

      const product = productMap.get(productId)
        ?? await productRepo.findOne({
          where: { id: productId },
          lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
        })
      if (!product) {
        throw new BizError('存在已失效商品，无法修改订单', 409)
      }

      const beforeCurrentStock = Number(product.currentStock ?? 0)
      const beforePreOrderedStock = Number(product.preOrderedStock ?? 0)
      const changeQty = Math.abs(deltaQty)
      product.preOrderedStock = deltaQty > 0
        ? beforePreOrderedStock + deltaQty
        : Math.max(0, beforePreOrderedStock - changeQty)

      await productRepo.save(product)
      await inventoryLogRepo.save(
        inventoryLogRepo.create({
          productId: product.id,
          changeType: deltaQty > 0 ? 'preorder_hold' : 'preorder_release',
          changeQty,
          beforeCurrentStock,
          afterCurrentStock: beforeCurrentStock,
          beforePreorderedStock: beforePreOrderedStock,
          afterPreorderedStock: product.preOrderedStock,
          operatorType: 'client',
          operatorId: auth.userId,
          operatorName: auth.realName || auth.mobile,
          refType: 'o2o_preorder',
          refId: String(order.id),
          remark: `客户端修改订单，订单号：${order.showNo}`,
        }),
      )
    }
  }

  private async saveUpdatedPreorderItemsInManager(
    manager: EntityManager,
    order: O2oPreorder,
    existingItems: O2oPreorderItem[],
    normalizedItems: Array<{ productId: string; qty: number }>,
    nextQtyMap: Map<string, number>,
  ) {
    const orderItemRepo = manager.getRepository(O2oPreorderItem)
    const existingItemMap = new Map(existingItems.map((item) => [String(item.productId), item]))
    const nextItemEntities = normalizedItems.map((item) => {
      const existedItem = existingItemMap.get(item.productId)
      if (existedItem) {
        existedItem.qty = item.qty
        return existedItem
      }
      return orderItemRepo.create({
        orderId: String(order.id),
        productId: item.productId,
        qty: item.qty,
      })
    })
    await orderItemRepo.save(nextItemEntities)

    const removedItems = existingItems.filter((item) => !nextQtyMap.has(String(item.productId)))
    if (removedItems.length) {
      await orderItemRepo.remove(removedItems)
    }
  }

  async updateMyOrder(auth: ClientAuthContext, orderId: string, input: UpdateMyPreorderInput) {
    await this.cancelTimeoutOrders()
    const normalizedItems = this.normalizePreorderItems(input.items)
    const normalizedRemark = this.normalizePreorderRemark(input.remark)
    const o2oRules = await systemConfigService.getO2oRuleConfigs()

    return AppDataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(O2oPreorder)
      const orderItemRepo = manager.getRepository(O2oPreorderItem)

      const order = await orderRepo.findOne({
        where: { id: orderId, clientUserId: auth.userId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('预订单不存在', 404)
      }
      await this.assertCanUpdateOrderInManager(manager, order)

      const existingItems = await orderItemRepo.find({
        where: { orderId: String(order.id) },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      const existingQtyMap = new Map(existingItems.map((item) => [String(item.productId), Math.max(0, Number(item.qty ?? 0))]))

      const productIds = [...new Set(normalizedItems.map((item) => item.productId))]
      const productMap = await this.loadEditableOrderProductsInManager(manager, productIds)
      const totalQty = this.validateUpdatedPreorderItems(normalizedItems, existingQtyMap, productMap, o2oRules)

      const nextQtyMap = new Map(normalizedItems.map((item) => [item.productId, item.qty]))
      await this.applyPreorderItemStockDeltaInManager(manager, auth, order, existingQtyMap, nextQtyMap, productMap)
      await this.saveUpdatedPreorderItemsInManager(manager, order, existingItems, normalizedItems, nextQtyMap)

      order.totalQty = totalQty
      order.remark = normalizedRemark
      order.updateCount = Math.max(0, Number(order.updateCount ?? 0)) + 1
      await orderRepo.save(order)
      return this.buildOrderDetail(order)
    })
  }

  async listMyOrders(auth: ClientAuthContext, query?: Partial<MyOrderListQuery>): Promise<PaginationResult<O2oPreorderSummaryView>> {
    // 先做一次超时回收，保证用户看到的订单状态尽量接近当前真实状态。
    await this.cancelTimeoutOrders()

    const normalizedPage = Math.max(1, Number(query?.page) || 1)
    const normalizedPageSize = Math.max(1, Math.min(50, Number(query?.pageSize) || 20))
    const normalizedKeyword = query?.keyword?.trim() ?? ''
    const normalizedStatus = query?.status

    // 索引命中策略说明：
    // 1. status 有值时：优先命中 idx_o2o_preorder_client_status_id(client_user_id, status, id)；
    // 2. status 为空时：优先命中 idx_o2o_preorder_client_id(client_user_id, id)。
    const queryBuilder = this.preorderRepo
      .createQueryBuilder('order')
      .where('order.clientUserId = :clientUserId', { clientUserId: auth.userId })
      .orderBy('order.id', 'DESC')
      .skip((normalizedPage - 1) * normalizedPageSize)
      .take(normalizedPageSize)

    if (normalizedStatus) {
      queryBuilder.andWhere('order.status = :status', { status: normalizedStatus })
    }

    if (normalizedKeyword) {
      const escapedKeyword = this.escapeLikeKeyword(normalizedKeyword)
      const keywordPrefix = `${escapedKeyword}%`
      const normalizedVerifyCodeKeyword = this.normalizeVerifyCode(normalizedKeyword)
      const escapedVerifyKeyword = this.escapeLikeKeyword(normalizedVerifyCodeKeyword)

      queryBuilder.andWhere(
        new Brackets((keywordQb) => {
          keywordQb
            // 等值匹配优先命中 show_no / verify_code 唯一索引。
            .where('order.showNo = :showNoExact', { showNoExact: normalizedKeyword })
            .orWhere('order.verifyCode = :verifyCodeExact', { verifyCodeExact: normalizedVerifyCodeKeyword })
            // 前缀匹配在输入单号前几位时仍可利用 B-Tree 索引。
            .orWhere(String.raw`order.showNo LIKE :showNoPrefix ESCAPE '\'`, { showNoPrefix: keywordPrefix })
            .orWhere(String.raw`order.verifyCode LIKE :verifyCodePrefix ESCAPE '\'`, {
              verifyCodePrefix: `${escapedVerifyKeyword}%`,
            })
        }),
      )
    }

    const [rows, total] = await queryBuilder.getManyAndCount()
    const nowMs = Date.now()
    const totalAmountMap = await this.resolveOrderTotalAmountMap(rows.map((item) => String(item.id)))
    return {
      page: normalizedPage,
      pageSize: normalizedPageSize,
      total,
      list: rows.map((item) => ({
        statusReport: this.resolveOrderStatusReport(item, nowMs),
        totalAmount: totalAmountMap.get(String(item.id)) ?? '0.00',
        expireInSeconds: this.resolveExpireInSeconds(item, nowMs),
        id: String(item.id),
        showNo: item.showNo,
        verifyCode: item.verifyCode,
        status: item.status,
        businessStatus: item.businessStatus ?? null,
        merchantMessage: item.merchantMessage ?? null,
        totalQty: item.totalQty,
        timeoutAt: item.timeoutAt,
        createdAt: item.createdAt,
      })),
    }
  }

  async getMyOrderDetail(auth: ClientAuthContext, id: string) {
    await this.cancelTimeoutOrders()
    const order = await this.preorderRepo.findOne({ where: { id, clientUserId: auth.userId } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    return this.buildOrderDetail(order)
  }

  async createReturnRequest(auth: ClientAuthContext, orderId: string, input: SubmitReturnRequestInput) {
    await this.cancelTimeoutOrders()
    const normalizedReason = this.normalizeReturnReason(input.reason)
    if (!Array.isArray(input.items) || !input.items.length) {
      throw new BizError('至少选择一个商品申请退货', 400)
    }
    const normalizedItems = input.items.map((item) => ({
      productId: String(item.productId).trim(),
      qty: Math.floor(Number(item.qty)),
    }))
    normalizedItems.forEach((item) => {
      if (!item.productId || !Number.isInteger(item.qty) || item.qty <= 0) {
        throw new BizError('退货数量必须为正整数', 400)
      }
    })
    return AppDataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(O2oPreorder)
      const order = await orderRepo.findOne({
        where: { id: orderId, clientUserId: auth.userId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('预订单不存在', 404)
      }
      await this.assertCanCreateReturnRequestForOrder(manager, order)

      const orderItems = await this.loadOrderItemsForReturn(
        manager,
        String(order.id),
        Number(order.totalQty ?? 0),
      )
      if (!orderItems.length) {
        throw new BizError('订单无可退商品', 409)
      }

      const pendingQtyMap = await this.buildPendingReturnQtyMap(manager, String(order.id))
      const { mergedRequestQtyMap, totalQty } = this.validateReturnRequestItems(
        orderItems,
        pendingQtyMap,
        normalizedItems,
      )

      const returnRequestRepo = manager.getRepository(O2oReturnRequest)
      const returnRequestItemRepo = manager.getRepository(O2oReturnRequestItem)
      const savedRequest = await returnRequestRepo.save(
        returnRequestRepo.create({
          returnNo: await this.generateReturnRequestNo(manager),
          orderId: String(order.id),
          clientUserId: String(auth.userId),
          verifyCode: randomUUID(),
          status: 'pending',
          sourceOrderStatus: order.status,
          reason: normalizedReason,
          totalQty,
        }),
      )
      const requestItemEntities = [...mergedRequestQtyMap.entries()].map(([productId, qty]) =>
        returnRequestItemRepo.create({
          returnRequestId: String(savedRequest.id),
          productId,
          qty,
        }),
      )
      await returnRequestItemRepo.save(requestItemEntities)
      if (order.businessStatus !== 'after_sale') {
        order.businessStatus = 'after_sale'
        await orderRepo.save(order)
      }
      return this.buildReturnRequestDetail(savedRequest)
    })
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
      merchantMessage: item.merchantMessage ?? null,
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

  async updateMerchantMessage(input: UpdateOrderMerchantMessageInput) {
    const order = await this.preorderRepo.findOne({ where: { id: input.orderId } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    order.merchantMessage = this.normalizeMerchantMessage(input.merchantMessage)
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

  private async markOrderAfterSaleStageInManager(
    manager: typeof AppDataSource.manager,
    order: O2oPreorder,
    excludeReturnRequestId?: string,
  ) {
    const pendingCount = await manager.getRepository(O2oReturnRequest).count({
      where: {
        orderId: String(order.id),
        status: 'pending',
        ...(excludeReturnRequestId ? { id: Not(excludeReturnRequestId) } : {}),
      },
    })
    order.businessStatus = pendingCount > 0 ? 'after_sale' : 'after_sale_done'
    await manager.getRepository(O2oPreorder).save(order)
  }

  // 详细注释：退货核销必须与原订单当前状态交叉校验。
  // 申请快照是“待取货”时，只允许对仍待取货的订单释放预订库存；
  // 申请快照是“已取货”时，只允许对仍已取货的订单执行重新入库。
  private async assertReturnRequestSourceOrderStatus(
    manager: typeof AppDataSource.manager,
    returnRequest: O2oReturnRequest,
    order: O2oPreorder,
  ) {
    if (returnRequest.sourceOrderStatus === 'pending') {
      if (await this.cancelTimedOutOrderInManager(manager, order)) {
        throw new BizError('原订单已超时取消，退货申请无需再核销', 409)
      }
      if (order.status !== 'pending') {
        throw new BizError('原订单状态已变化，请重新确认后再处理该退货申请', 409)
      }
      return
    }
    if (returnRequest.sourceOrderStatus === 'verified' && order.status !== 'verified') {
      throw new BizError('原订单未处于已取货状态，当前退货申请不可核销', 409)
    }
  }

  // 详细注释：核销前一次性装载“退货申请商品明细、订单商品映射、商品库存映射”，
  // 让后续逐项处理时只聚焦库存变更本身，避免核销主函数继续膨胀。
  private async loadReturnVerificationContext(
    manager: typeof AppDataSource.manager,
    returnRequest: O2oReturnRequest,
    order: O2oPreorder,
  ) {
    const requestItems = await manager.getRepository(O2oReturnRequestItem).find({
      where: { returnRequestId: String(returnRequest.id) },
      relations: { product: true },
      order: { id: 'ASC' },
    })
    if (!requestItems.length) {
      throw new BizError('退货申请明细为空，无法核销', 409)
    }

    const orderItems = await manager.getRepository(O2oPreorderItem).find({
      where: { orderId: String(order.id) },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
    })
    const orderItemMap = new Map(orderItems.map((item) => [String(item.productId), item]))
    const productIds = [...new Set(requestItems.map((item) => String(item.productId)))]
    const products = await manager.getRepository(BaseProduct).find({
      where: { id: In(productIds) },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
    })
    const productMap = new Map(products.map((item) => [String(item.id), item]))
    return { requestItems, orderItemMap, productMap }
  }

  // 详细注释：每个退货商品都单独核对订单数量与商品库存，
  // 然后根据“申请时订单状态”决定是释放预订库存，还是回补现货库存。
  private async applyReturnVerificationForItem(
    manager: typeof AppDataSource.manager,
    returnRequest: O2oReturnRequest,
    actor: AuthUserContext,
    requestItem: O2oReturnRequestItem,
    orderItemMap: Map<string, O2oPreorderItem>,
    productMap: Map<string, BaseProduct>,
  ) {
    const product = productMap.get(String(requestItem.productId))
    const orderItem = orderItemMap.get(String(requestItem.productId))
    if (!product || !orderItem) {
      throw new BizError('存在已失效商品，无法核销退货', 409)
    }
    const requestQty = Math.max(0, Number(requestItem.qty ?? 0))
    const currentOrderQty = Math.max(0, Number(orderItem.qty ?? 0))
    if (currentOrderQty < requestQty) {
      throw new BizError(`商品「${product.productName}」可退数量不足，无法核销`, 409)
    }

    const beforeCurrentStock = Math.max(0, Number(product.currentStock ?? 0))
    const beforePreOrderedStock = Math.max(0, Number(product.preOrderedStock ?? 0))
    if (returnRequest.sourceOrderStatus === 'pending') {
      product.preOrderedStock = Math.max(0, beforePreOrderedStock - requestQty)
      await manager.getRepository(BaseProduct).save(product)
      await manager.getRepository(InventoryLog).save(
        manager.getRepository(InventoryLog).create({
          productId: product.id,
          changeType: 'preorder_release',
          changeQty: requestQty,
          beforeCurrentStock,
          afterCurrentStock: beforeCurrentStock,
          beforePreorderedStock: beforePreOrderedStock,
          afterPreorderedStock: product.preOrderedStock,
          operatorType: 'admin',
          operatorId: actor.userId,
          operatorName: actor.displayName,
          refType: 'o2o_return_request',
          refId: String(returnRequest.id),
          remark: `退货核销释放预订库存，退货单号：${returnRequest.returnNo}`,
        }),
      )
    } else {
      product.currentStock = beforeCurrentStock + requestQty
      await manager.getRepository(BaseProduct).save(product)
      await manager.getRepository(InventoryLog).save(
        manager.getRepository(InventoryLog).create({
          productId: product.id,
          changeType: 'preorder_return_inbound',
          changeQty: requestQty,
          beforeCurrentStock,
          afterCurrentStock: product.currentStock,
          beforePreorderedStock: beforePreOrderedStock,
          afterPreorderedStock: beforePreOrderedStock,
          operatorType: 'admin',
          operatorId: actor.userId,
          operatorName: actor.displayName,
          refType: 'o2o_return_request',
          refId: String(returnRequest.id),
          remark: `退货核销重新入库，退货单号：${returnRequest.returnNo}`,
        }),
      )
    }

    orderItem.qty = currentOrderQty - requestQty
    await manager.getRepository(O2oPreorderItem).save(orderItem)
  }

  private async verifyReturnRequestInManager(
    manager: typeof AppDataSource.manager,
    returnRequest: O2oReturnRequest,
    actor: AuthUserContext,
  ): Promise<O2oVerifyResultView> {
    if (returnRequest.status !== 'pending') {
      throw new BizError('当前退货申请不可重复核销', 409)
    }
    const order = await manager.getRepository(O2oPreorder).findOne({
      where: { id: String(returnRequest.orderId) },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
    })
    if (!order) {
      throw new BizError('原预订单不存在，无法核销退货', 404)
    }
    await this.assertReturnRequestSourceOrderStatus(manager, returnRequest, order)

    const { requestItems, orderItemMap, productMap } = await this.loadReturnVerificationContext(
      manager,
      returnRequest,
      order,
    )
    for (const requestItem of requestItems) {
      await this.applyReturnVerificationForItem(
        manager,
        returnRequest,
        actor,
        requestItem,
        orderItemMap,
        productMap,
      )
    }

    order.totalQty = Math.max(0, Number(order.totalQty ?? 0) - Number(returnRequest.totalQty ?? 0))
    if (returnRequest.sourceOrderStatus === 'pending' && order.totalQty <= 0) {
      order.status = 'cancelled'
      order.cancelReason = 'manual'
    }
    await this.markOrderAfterSaleStageInManager(manager, order, String(returnRequest.id))

    returnRequest.status = 'verified'
    returnRequest.verifiedAt = new Date()
    returnRequest.verifiedBy = actor.displayName
    const savedReturnRequest = await manager.getRepository(O2oReturnRequest).save(returnRequest)
    return {
      operationType: 'return_verify',
      verifyTargetType: 'return_request',
      detail: await this.buildReturnRequestDetail(savedReturnRequest),
    }
  }

  private async verifyPreorderInManager(
    manager: typeof AppDataSource.manager,
    order: O2oPreorder,
    actor: AuthUserContext,
  ): Promise<O2oVerifyResultView> {
    if (await this.cancelTimedOutOrderInManager(manager, order)) {
      throw new BizError('预订单已超时取消，库存已释放，不可继续核销', 409)
    }
    if (order.status !== 'pending') {
      throw new BizError('当前预订单不可核销', 409)
    }
    const pendingReturnCount = await manager.getRepository(O2oReturnRequest).count({
      where: { orderId: String(order.id), status: 'pending' },
    })
    if (pendingReturnCount > 0) {
      throw new BizError('该订单存在待处理退货申请，请先完成退货核销后再执行取货核销', 409)
    }
    const items = await manager.getRepository(O2oPreorderItem).find({ where: { orderId: String(order.id) } })
    if (!items.length || items.every((item) => Number(item.qty ?? 0) <= 0)) {
      throw new BizError('当前订单已无可核销商品', 409)
    }
    const productIds = [...new Set(items.map((item) => String(item.productId)))]
    const products = await manager.getRepository(BaseProduct).find({
      where: { id: In(productIds) },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
    })
    const productMap = new Map(products.map((item) => [String(item.id), item]))
    for (const row of items) {
      const verifyQty = Math.max(0, Number(row.qty ?? 0))
      if (verifyQty <= 0) {
        continue
      }
      const product = productMap.get(String(row.productId))
      if (!product) {
        throw new BizError('商品不存在，无法核销', 409)
      }
      const beforeCurrentStock = Number(product.currentStock ?? 0)
      const beforePreOrderedStock = Number(product.preOrderedStock ?? 0)
      if (beforeCurrentStock < verifyQty || beforePreOrderedStock < verifyQty) {
        throw new BizError(`商品「${product.productName}」库存异常，请先补货后再核销`, 409)
      }
      product.currentStock = beforeCurrentStock - verifyQty
      product.preOrderedStock = beforePreOrderedStock - verifyQty
      await manager.getRepository(BaseProduct).save(product)
      await manager.getRepository(InventoryLog).save(
        manager.getRepository(InventoryLog).create({
          productId: product.id,
          changeType: 'preorder_verify',
          changeQty: verifyQty,
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
    order.status = 'verified'
    order.verifiedAt = new Date()
    order.verifiedBy = actor.displayName
    const savedOrder = await manager.getRepository(O2oPreorder).save(order)
    await this.createWalkInOutboundOrderFromVerifiedPreorder(manager, {
      preorder: savedOrder,
      items,
      productMap,
      actor,
    })
    return {
      operationType: 'preorder_verify',
      verifyTargetType: 'preorder',
      detail: await this.detailById(savedOrder.id),
    }
  }

  async verifyByCode(verifyCode: string, actor: AuthUserContext) {
    const normalizedVerifyCode = this.normalizeVerifyCode(verifyCode)
    await this.cancelTimeoutOrders()
    return AppDataSource.transaction(async (manager) => {
      const returnRequest = await manager.getRepository(O2oReturnRequest).findOne({
        where: { verifyCode: normalizedVerifyCode },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (returnRequest) {
        return this.verifyReturnRequestInManager(manager, returnRequest, actor)
      }
      const order = await manager.getRepository(O2oPreorder).findOne({
        where: { verifyCode: normalizedVerifyCode },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('核销单不存在', 404)
      }
      return this.verifyPreorderInManager(manager, order, actor)
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
    const returnRequest = await this.returnRequestRepo.findOne({ where: { verifyCode: normalizedVerifyCode } })
    if (returnRequest) {
      return {
        verifyTargetType: 'return_request',
        detail: await this.buildReturnRequestDetail(returnRequest),
      } satisfies O2oVerifyDetailView
    }
    const order = await this.preorderRepo.findOne({ where: { verifyCode: normalizedVerifyCode } })
    if (!order) {
      throw new BizError('核销单不存在', 404)
    }
    return {
      verifyTargetType: 'preorder',
      detail: await this.detailById(order.id),
    } satisfies O2oVerifyDetailView
  }

  async getVerifyDetailByShowNo(showNo: string) {
    const normalizedShowNo = showNo.trim()
    if (!normalizedShowNo) {
      throw new BizError('单号不能为空', 400)
    }
    await this.cancelTimeoutOrders()
    const returnRequest = await this.returnRequestRepo.findOne({ where: { returnNo: normalizedShowNo } })
    if (returnRequest) {
      return {
        verifyTargetType: 'return_request',
        detail: await this.buildReturnRequestDetail(returnRequest),
      } satisfies O2oVerifyDetailView
    }
    const order = await this.preorderRepo.findOne({ where: { showNo: normalizedShowNo } })
    if (!order) {
      throw new BizError('单据不存在', 404)
    }
    return {
      verifyTargetType: 'preorder',
      detail: await this.detailById(order.id),
    } satisfies O2oVerifyDetailView
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
