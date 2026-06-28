/**
 * 文件说明：该文件负责 O2O 预订单主服务，统一处理客户端下单、我的订单、后台核销、退货申请、库存占用释放与订单状态流转。
 * 实现逻辑：
 * 1. 以预订单、预订单明细、退货申请、库存日志和正式出库单等实体为核心，串起商城下单到门店履约的完整链路；
 * 2. 同时承接客户端与管理端两侧查询、修改与核销动作，确保同一订单在不同入口下保持一致的业务口径；
 * 3. 关键写操作会联动单号服务、系统配置与通知能力，保证库存、状态和派发消息在同一业务语义下收口。
 */

import { randomUUID } from 'node:crypto'
import { Brackets, type EntityManager, In, LessThanOrEqual, Not } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { RelProductTag } from '../entities/rel-product-tag.entity.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BizOutboundOrderItem } from '../entities/biz-outbound-order-item.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { InventoryLog } from '../entities/inventory-log.entity.js'
import {
  O2O_CLIENT_ORDER_TYPES,
  O2O_PREORDER_BUSINESS_STATUSES,
  type O2oClientOrderType,
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
import { orderSerialService, type OrderSerialRecalibrationResult } from './order-serial.service.js'
import { systemConfigService } from './system-config.service.js'
import { notificationService } from './notification.service.js'
import { auditService } from './audit.service.js'
import type { PaginationResult } from '../types/api.js'
import type { RequestMeta } from '../utils/request-meta.js'
import {
  buildDiscountPriceSnapshot,
  calculateDiscountedPrice,
  formatMoneyFromCents,
  normalizeDiscountRate,
  parseMoneyToCents,
} from '../utils/discount-price.js'

export interface SubmitPreorderItemInput {
  productId: string | number
  skuId?: string | number | null
  qty: number
}

export interface SubmitPreorderInput {
  items: SubmitPreorderItemInput[]
  remark?: string
  isSystemApplied: boolean
  pickupContact: string
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

export interface UpdateOrderComplianceFlagsInput {
  orderId: string
  hasCustomerOrder?: boolean
  isSystemApplied?: boolean
}

export interface UpdateOnsitePreorderInput {
  orderId: string
  items: SubmitPreorderItemInput[]
  remark?: string
}

export interface SubmitReturnRequestItemInput {
  productId: string | number
  skuId?: string | number | null
  qty: number
}

export interface SubmitReturnRequestInput {
  reason: string
  items: SubmitReturnRequestItemInput[]
}

export interface RejectReturnRequestInput {
  returnRequestId: string
  rejectReason: string
}

export interface DeleteConsolePreorderInput {
  orderId: string
  confirmShowNo: string
}

export interface DeletedConsolePreorderView {
  id: string
  showNo: string
  status: O2oPreorderStatus
  clientOrderType: O2oClientOrderType
  releasedPreorderedQty: number
  returnRequestCount: number
  outboundOrderShowNo: string | null
  outboundOrderDeleted: boolean
  preorderSerialRolledBack: boolean
  outboundSerialRolledBack: boolean
}

export interface InventoryLogView {
  id: string
  productId: string
  productName: string
  changeType: string
  changeQty: number
  beforeCurrentStock: number
  afterCurrentStock: number
  beforePreorderedStock: number
  afterPreorderedStock: number
  operatorType: string
  operatorName: string | null
  refType: string | null
  refId: string | null
  createdAt: Date
}

type O2oNumericLike = string | number | null

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
  customerOrderShowNo: string | null
  verifyCode: string
  status: O2oPreorder['status']
  businessStatus: O2oPreorder['businessStatus']
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  merchantMessage: string | null
  clientOrderType: O2oPreorder['clientOrderType']
  departmentNameSnapshot: string | null
  staffNoSnapshot: string | null
  returnRequestCount: number
  pendingReturnRequestCount: number
  latestReturnRequest: {
    id: string
    returnNo: string
    status: O2oReturnRequestStatus
    createdAt: Date
    handledAt: Date | null
    rejectedReason: string | null
  } | null
  totalQty: number
  timeoutAt: Date | null
  createdAt: Date
}

export interface O2oPreorderDetailItemView {
  id: string
  productId: string
  skuId: string | null
  productCode: string
  productName: string
  skuCode: string | null
  specText: string | null
  skuImage: string | null
  defaultPrice: string
  originalPrice: string
  discountRate: string
  discountedPrice: string
  unitPrice: string
  lineAmount: string
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
    customerOrderShowNo: string | null
    verifyCode: string
    status: O2oPreorder['status']
    businessStatus: O2oPreorder['businessStatus']
    hasCustomerOrder: boolean
    isSystemApplied: boolean
    pickupContact: string | null
    merchantMessage: string | null
    clientOrderType: O2oPreorder['clientOrderType']
    departmentNameSnapshot: string | null
    staffNoSnapshot: string | null
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
    realName: string | null
    mobile: string | null
    email: string | null
    departmentName: string | null
    accountType: ClientUser['accountType']
    staffNo: string | null
  } | null
  items: O2oPreorderDetailItemView[]
  returnRequests: O2oReturnRequestView[]
  amountSummary: {
    totalAmount: string
    totalQty: number
    totalItemCount: number
  }
  storefront: {
    businessHoursText: string
    mallAnnouncementText: string
  }
  qrPayload: string
}

export interface O2oReturnRequestItemView {
  id: string
  productId: string
  skuId: string | null
  productCode: string
  productName: string
  skuCode: string | null
  specText: string | null
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
  handledAt: Date | null
  handledBy: string | null
  verifiedAt: Date | null
  verifiedBy: string | null
  rejectedReason: string | null
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
export const O2O_RETURN_REJECT_REASON_MAX_LENGTH = 500
export const O2O_PICKUP_CONTACT_MAX_LENGTH = 32

const LIKE_ESCAPE_CHAR = String.raw`\\`
const LIKE_SPECIAL_CHAR_PATTERN = /[%_\\]/g
const O2O_TIMEOUT_RECYCLE_RECENT_WINDOW_MS = 15 * 1000
const O2O_TIMEOUT_BACKGROUND_RECYCLE_INTERVAL_MS = 60 * 1000

class O2oPreorderService {
  private readonly productRepo = AppDataSource.getRepository(BaseProduct)
  private readonly preorderRepo = AppDataSource.getRepository(O2oPreorder)
  private readonly preorderItemRepo = AppDataSource.getRepository(O2oPreorderItem)
  private readonly returnRequestRepo = AppDataSource.getRepository(O2oReturnRequest)
  private readonly returnRequestItemRepo = AppDataSource.getRepository(O2oReturnRequestItem)
  private readonly clientUserRepo = AppDataSource.getRepository(ClientUser)
  private readonly inventoryLogRepo = AppDataSource.getRepository(InventoryLog)
  private cancelTimeoutOrdersInFlight: Promise<{ cancelledCount: number }> | null = null
  private lastCancelTimeoutOrdersAt = 0
  private lastCancelTimeoutOrdersResult = { cancelledCount: 0 }
  private timeoutRecycleLoopTimer: ReturnType<typeof globalThis.setInterval> | null = null

  /**
   * 客户端改单次数上限：
   * - 统一从系统配置读取，避免业务规则硬编码在服务常量中；
   * - 便于后续通过系统配置调整，不需要再次发版。
   */
  private async getClientPreorderUpdateLimit() {
    const config = await systemConfigService.getO2oRuleConfigs()
    return config.clientPreorderUpdateLimit
  }

  // 详细注释：订单 updateCount 在历史数据或跨库同步场景下可能出现 string/null/异常值，
  // 这里统一做“十进制整数解析 + 非负兜底”，避免 Number(...) 导致 NaN 传播到权限与剩余次数计算。
  private normalizeOrderUpdateCount(rawUpdateCount: unknown) {
    if (rawUpdateCount === null || rawUpdateCount === undefined) {
      return 0
    }
    let parsedCount = 0
    if (typeof rawUpdateCount === 'number') {
      parsedCount = Math.trunc(rawUpdateCount)
    } else if (typeof rawUpdateCount === 'string') {
      parsedCount = Number.parseInt(rawUpdateCount, 10)
    } else {
      // 非 number/string 的异常类型（如 object/boolean）统一回退为 0，避免隐式字符串化污染解析结果。
      // parsedCount 已以 0 初始化，这里无需重复赋值。
    }
    if (!Number.isFinite(parsedCount)) {
      return 0
    }
    return Math.max(0, parsedCount)
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

  private buildPreorderItemSnapshot(product: BaseProduct, qty: number) {
    return buildDiscountPriceSnapshot(product.defaultPrice, product.discountRate, qty)
  }

  private buildPreorderSkuItemSnapshot(product: BaseProduct, sku: BaseProductSku, qty: number) {
    const priceSnapshot = buildDiscountPriceSnapshot(sku.defaultPrice, sku.discountRate, qty)
    return {
      ...priceSnapshot,
      skuId: String(sku.id),
      skuCode: sku.skuCode,
      specText: sku.specText || '默认规格',
      skuImage: sku.thumbnail ?? product.thumbnail ?? null,
    }
  }

  private hasPreorderItemSnapshotValue(value: string | number | null | undefined) {
    return value !== null && value !== undefined && String(value).trim() !== ''
  }

  private resolvePreorderItemSnapshot(item: O2oPreorderItem) {
    const productOriginalPrice = item.product?.defaultPrice ?? '0.00'
    const originalPrice =
      this.hasPreorderItemSnapshotValue(item.originalPrice)
        ? this.normalizeDecimalText(item.originalPrice)
        : this.normalizeDecimalText(productOriginalPrice)
    const discountRate = normalizeDiscountRate(item.discountRate ?? item.product?.discountRate ?? '10.0')
    const unitPrice =
      this.hasPreorderItemSnapshotValue(item.unitPrice)
        ? this.normalizeDecimalText(item.unitPrice)
        : calculateDiscountedPrice(originalPrice, discountRate)
    const fallbackLineAmount = formatMoneyFromCents(parseMoneyToCents(unitPrice) * Math.max(0, Number(item.qty ?? 0)))
    const lineAmount =
      this.hasPreorderItemSnapshotValue(item.lineAmount)
        ? this.normalizeDecimalText(item.lineAmount)
        : fallbackLineAmount
    return {
      originalPrice,
      discountRate,
      unitPrice,
      lineAmount,
    }
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

  private normalizeReturnRejectReason(value: string | null | undefined): string {
    const normalizedValue = value?.trim() ?? ''
    if (!normalizedValue) {
      throw new BizError('请填写拒绝原因', 400)
    }
    if (normalizedValue.length > O2O_RETURN_REJECT_REASON_MAX_LENGTH) {
      throw new BizError(`拒绝原因长度不能超过${O2O_RETURN_REJECT_REASON_MAX_LENGTH}个字符`, 400)
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

  // 提货人必须按客户端本次填写结果落单：
  // - 统一去首尾空格并校验长度；
  // - 不允许继续由服务端静默回退成账号名，否则无法区分“本人账号”和“实际提货人”。
  private normalizePickupContact(value: string | null | undefined): string {
    // 运行时兜底：即使上游传来 null/undefined 或非字符串脏值，
    // 这里也先统一转成字符串再裁剪空白，避免在 trim 阶段失稳。
    const normalizedValue = (value ?? '').toString().trim()
    if (!normalizedValue) {
      throw new BizError('请填写提货人', 400)
    }
    if (normalizedValue.length > O2O_PICKUP_CONTACT_MAX_LENGTH) {
      throw new BizError(`提货人长度不能超过${O2O_PICKUP_CONTACT_MAX_LENGTH}个字符`, 400)
    }
    return normalizedValue
  }

  // 客户端下单归属类型必须显式传入，只允许“部门订 / 散客”两种固定枚举值。
  private normalizeClientOrderType(value: string | null | undefined): O2oClientOrderType {
    const normalizedValue = value?.trim().toLowerCase() ?? ''
    if (!O2O_CLIENT_ORDER_TYPES.includes(normalizedValue as O2oClientOrderType)) {
      throw new BizError('下单类型非法，仅支持部门订或散客', 400)
    }
    return normalizedValue as O2oClientOrderType
  }

  // 订单归属必须按“下单时快照”固化：
  // - 散客单不保留部门快照；
  // - 部门订单强制要求当前账号存在部门名称。
  private resolveDepartmentNameSnapshot(
    clientOrderType: O2oClientOrderType,
    clientUser: Pick<ClientUser, 'departmentName'> | null,
  ): string | null {
    if (clientOrderType !== 'department') {
      return null
    }
    const departmentName = clientUser?.departmentName?.trim() ?? ''
    if (!departmentName) {
      throw new BizError('部门订必须先完善账号部门信息', 400)
    }
    return departmentName
  }

  // 正式出库单必须沿用预订单在“下单当时”沉淀的归属快照：
  // - 避免用户后续改资料后，把历史部门单串改成最新部门；
  // - 若历史脏数据缺少快照，则直接阻断并提示修复，而不是继续用当前资料兜底。
  private resolveDepartmentNameSnapshotFromPreorder(preorder: Pick<O2oPreorder, 'clientOrderType' | 'departmentNameSnapshot'>) {
    if (preorder.clientOrderType !== 'department') {
      return null
    }
    const departmentNameSnapshot = preorder.departmentNameSnapshot?.trim() ?? ''
    if (!departmentNameSnapshot) {
      throw new BizError('部门订单缺少下单部门快照，无法生成正式出库单', 409)
    }
    return departmentNameSnapshot
  }

  private resolveStaffNoSnapshot(
    clientOrderType: O2oClientOrderType,
    clientUser: Pick<ClientUser, 'staffNo'> | null,
  ): string | null {
    if (clientOrderType !== 'department') {
      return null
    }
    const staffNo = clientUser?.staffNo?.trim() ?? ''
    if (!staffNo) {
      throw new BizError('部门账户缺少教职工号，无法创建部门订单', 400)
    }
    return staffNo
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
    const mergedQtyMap = new Map<string, { productId: string; skuId: string | null; qty: number }>()
    items.forEach((item) => {
      const productId = String(item.productId).trim()
      const skuId = item.skuId === null || item.skuId === undefined ? null : String(item.skuId).trim() || null
      const qty = Math.floor(Number(item.qty))
      if (!productId || !Number.isInteger(qty) || qty <= 0) {
        throw new BizError('商品数量必须为正整数', 400)
      }
      const mergeKey = `${productId}::${skuId ?? ''}`
      const current = mergedQtyMap.get(mergeKey)
      mergedQtyMap.set(mergeKey, {
        productId,
        skuId,
        qty: (current?.qty ?? 0) + qty,
      })
    })
    return [...mergedQtyMap.values()]
  }

  private resolveProductLimitQty(product: BaseProduct, o2oRules: Awaited<ReturnType<typeof systemConfigService.getO2oRuleConfigs>>) {
    return o2oRules.limitEnabled
      ? Math.min(Number(product.limitPerUser || 5), o2oRules.limitQty)
      : Number(product.limitPerUser || 5)
  }

  private getRequiredProduct(productMap: Map<string, BaseProduct>, productId: string) {
    const product = productMap.get(productId)
    if (!product) {
      throw new BizError('存在无效商品', 400)
    }
    return product
  }

  private buildOrderItemKey(productId: string, skuId: string | null) {
    return `${productId}::${skuId ?? ''}`
  }

  private buildPreorderItemKey(item: Pick<O2oPreorderItem, 'productId' | 'skuId'>) {
    return this.buildOrderItemKey(String(item.productId), item.skuId ? String(item.skuId) : null)
  }

  private getRequiredSku(
    skuMap: Map<string, BaseProductSku>,
    skuByProductMap: Map<string, BaseProductSku[]>,
    productId: string,
    skuId: string | null,
  ) {
    if (skuId) {
      const sku = skuMap.get(skuId)
      if (!sku || String(sku.productId) !== productId) {
        throw new BizError('存在无效规格', 400)
      }
      return sku
    }
    const fallbackSku = (skuByProductMap.get(productId) ?? []).find((sku) => Boolean(sku.isActive))
    if (!fallbackSku) {
      throw new BizError('商品暂无可售规格', 409)
    }
    return fallbackSku
  }

  private groupSkusByProduct(skus: BaseProductSku[]) {
    const skuMap = new Map<string, BaseProductSku>()
    const skuByProductMap = new Map<string, BaseProductSku[]>()
    skus.forEach((sku) => {
      const skuId = String(sku.id)
      const productId = String(sku.productId)
      skuMap.set(skuId, sku)
      const currentSkus = skuByProductMap.get(productId) ?? []
      currentSkus.push(sku)
      skuByProductMap.set(productId, currentSkus)
    })
    return { skuMap, skuByProductMap }
  }

  private resolveMallPreviewSku<T extends {
    availableStock: number
    isActive: boolean
    o2oRecommended: boolean
    sortOrder: number
  }>(skuViews: T[], productRecommended: boolean): T | null {
    const sortedActiveSkus = skuViews
      .filter((sku) => sku.isActive)
      .slice()
      .sort((leftSku, rightSku) => leftSku.sortOrder - rightSku.sortOrder)
    if (!sortedActiveSkus.length) {
      return null
    }

    const recommendedPreviewSkus = productRecommended
      ? sortedActiveSkus
      : sortedActiveSkus.filter((sku) => sku.o2oRecommended)
    const candidateSkus = recommendedPreviewSkus.length ? recommendedPreviewSkus : sortedActiveSkus
    const stockPreferredSkus = candidateSkus.filter((sku) => sku.availableStock > 0)
    return stockPreferredSkus[0] ?? candidateSkus[0] ?? sortedActiveSkus[0] ?? null
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

  // 线上预订核销成功后，同步沉淀为出库单：
  // - 订单类型严格取预订单下单快照，避免“有部门账号的散客单”被误归类；
  // - 部门单继续沿用部门流水号，散客单沿用散客流水号；
  // - 通过 idempotencyKey 绑定预订单ID，防止重复核销或重试时重复落单。
  private async createOutboundOrderFromVerifiedPreorder(
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
    const outboundOrderType = input.preorder.clientOrderType === 'department' ? 'department' : 'walkin'
    const departmentNameSnapshot = this.resolveDepartmentNameSnapshotFromPreorder(input.preorder)
    const showNo = await orderSerialService.generateOrderNo(outboundOrderType, manager)

    let totalQty = 0
    let totalAmountCents = 0
    const itemEntities: BizOutboundOrderItem[] = []

    input.items.forEach((row, index) => {
      const product = input.productMap.get(String(row.productId))
      if (!product) {
        throw new BizError('商品不存在，无法生成对应出库单', 409)
      }
      const qty = Number(row.qty ?? 0)
      const snapshot = this.resolvePreorderItemSnapshot(row)
      const unitPriceCents = parseMoneyToCents(snapshot.unitPrice)
      const lineAmountCents = parseMoneyToCents(snapshot.lineAmount)
      totalQty += qty
      totalAmountCents += lineAmountCents
      itemEntities.push(
        itemRepo.create({
          lineNo: index + 1,
          productId: product.id,
          productNameSnapshot: row.specTextSnapshot ? `${product.productName}（${row.specTextSnapshot}）` : product.productName,
          qty: qty.toFixed(2),
          unitPrice: formatMoneyFromCents(unitPriceCents),
          lineAmount: formatMoneyFromCents(lineAmountCents),
          remark: `线上预订核销，预订单号：${input.preorder.showNo}`,
        }),
      )
    })

    const outboundOrder = orderRepo.create({
      orderUuid: generateOrderUuid(),
      showNo,
      orderType: outboundOrderType,
      hasCustomerOrder: Boolean(input.preorder.hasCustomerOrder),
      isSystemApplied: Boolean(input.preorder.isSystemApplied),
      issuerName: input.actor.displayName || input.actor.username,
      customerDepartmentName: departmentNameSnapshot,
      idempotencyKey,
      // 正式出库单上的客户名称应优先使用下单时填写的提货人，
      // 这样线下打印/核销后回看单据时，仍能还原真实领取人而不是账号用户名。
      customerName: input.preorder.pickupContact?.trim() || clientUser?.realName?.trim() || null,
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

  private async syncOutboundOrderComplianceFlags(
    manager: EntityManager,
    preorderId: string,
    payload: {
      hasCustomerOrder?: boolean
      isSystemApplied?: boolean
    },
  ) {
    const idempotencyKey = `o2o-preorder-verify:${preorderId}`
    const outboundOrderRepo = manager.getRepository(BizOutboundOrder)
    const outboundOrder = await outboundOrderRepo.findOne({ where: { idempotencyKey } })
    if (!outboundOrder) {
      return
    }
    if (typeof payload.hasCustomerOrder === 'boolean') {
      outboundOrder.hasCustomerOrder = payload.hasCustomerOrder
    }
    if (typeof payload.isSystemApplied === 'boolean') {
      outboundOrder.isSystemApplied = payload.isSystemApplied
    }
    await outboundOrderRepo.save(outboundOrder)
  }

  // 详细注释：客户端展示正式出库单号时，不能再直接复用 O2O 预订单号。
  // 这里统一通过核销时写入的 idempotencyKey 回查正式出库单，确保客户端与管理端引用同一张正式单据。
  private buildVerifiedPreorderOutboundOrderIdempotencyKey(preorderId: string) {
    return `o2o-preorder-verify:${preorderId}`
  }

  private async loadLinkedOutboundOrderInManager(manager: EntityManager, preorderId: string) {
    return manager.getRepository(BizOutboundOrder).findOne({
      where: {
        idempotencyKey: this.buildVerifiedPreorderOutboundOrderIdempotencyKey(preorderId),
      },
    })
  }

  private async releasePendingPreorderStockForDeleteInManager(
    manager: EntityManager,
    order: O2oPreorder,
    actor: AuthUserContext,
  ) {
    if (order.status !== 'pending') {
      return 0
    }

    const items = await manager.getRepository(O2oPreorderItem).find({
      where: { orderId: String(order.id) },
    })
    let releasedQty = 0
    for (const row of items) {
      const qty = Math.max(0, Number(row.qty ?? 0))
      if (qty <= 0) {
        continue
      }
      const product = await manager.getRepository(BaseProduct).findOne({
        where: { id: String(row.productId) },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!product) {
        continue
      }
      const beforeCurrentStock = Number(product.currentStock ?? 0)
      const beforePreOrderedStock = Number(product.preOrderedStock ?? 0)
      product.preOrderedStock = Math.max(0, beforePreOrderedStock - qty)
      if (row.skuId) {
        const sku = await manager.getRepository(BaseProductSku).findOne({
          where: { id: String(row.skuId) },
          lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
        })
        if (sku) {
          sku.preOrderedStock = Math.max(0, Number(sku.preOrderedStock ?? 0) - qty)
          await manager.getRepository(BaseProductSku).save(sku)
        }
      }
      await manager.getRepository(BaseProduct).save(product)
      await manager.getRepository(InventoryLog).save(
        manager.getRepository(InventoryLog).create({
          productId: product.id,
          changeType: 'preorder_release',
          changeQty: qty,
          beforeCurrentStock,
          afterCurrentStock: beforeCurrentStock,
          beforePreorderedStock: beforePreOrderedStock,
          afterPreorderedStock: product.preOrderedStock,
          operatorType: 'admin',
          operatorId: actor.userId,
          operatorName: actor.displayName,
          refType: 'o2o_preorder',
          refId: String(order.id),
          remark: `管理员删除订单池订单，释放预订库存；订单号：${order.showNo}`,
        }),
      )
      releasedQty += qty
    }
    return releasedQty
  }

  // 详细注释：批量回查正式出库单号，供“我的订单列表”和“订单详情”共用。
  // - 未核销或尚未生成正式出库单时返回空映射；
  // - 命中后以预订单 ID 为键，便于前端页面继续保留原订单实体，同时替换展示单号。
  private async resolveCustomerOrderShowNoMap(preorderIds: string[]) {
    if (!preorderIds.length) {
      return new Map<string, string>()
    }
    const idempotencyKeyToPreorderIdMap = new Map(
      preorderIds.map((preorderId) => [this.buildVerifiedPreorderOutboundOrderIdempotencyKey(preorderId), preorderId]),
    )
    const outboundOrders = await AppDataSource.getRepository(BizOutboundOrder).find({
      select: ['idempotencyKey', 'showNo'],
      where: {
        idempotencyKey: In([...idempotencyKeyToPreorderIdMap.keys()]),
        isDeleted: false,
      },
    })
    const customerOrderShowNoMap = new Map<string, string>()
    outboundOrders.forEach((outboundOrder) => {
      const preorderId = idempotencyKeyToPreorderIdMap.get(outboundOrder.idempotencyKey)
      if (!preorderId || !outboundOrder.showNo?.trim()) {
        return
      }
      customerOrderShowNoMap.set(preorderId, outboundOrder.showNo.trim())
    })
    return customerOrderShowNoMap
  }

  // 详细注释：当客户端已切换为展示正式出库单号后，关键词搜索也必须支持这个单号。
  // 这里先从正式出库单表按“精确匹配 + 前缀匹配”回查，再反推出对应预订单 ID，避免页面显示与搜索口径脱节。
  private async resolveMatchedPreorderIdsByCustomerOrderKeyword(keyword: string) {
    const normalizedKeyword = keyword.trim()
    if (!normalizedKeyword) {
      return []
    }
    const escapedKeyword = this.escapeLikeKeyword(normalizedKeyword)
    const rows = await AppDataSource.getRepository(BizOutboundOrder)
      .createQueryBuilder('outboundOrder')
      .select(['outboundOrder.idempotencyKey AS idempotencyKey'])
      .where('outboundOrder.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere(
        new Brackets((showNoQb) => {
          showNoQb
            .where('outboundOrder.showNo = :showNoExact', { showNoExact: normalizedKeyword })
            .orWhere(String.raw`outboundOrder.showNo LIKE :showNoPrefix ESCAPE '\'`, { showNoPrefix: `${escapedKeyword}%` })
        }),
      )
      .getRawMany<{ idempotencyKey: string | null }>()
    const preorderIdPrefix = this.buildVerifiedPreorderOutboundOrderIdempotencyKey('')
    const preorderIdSet = new Set<string>()
    rows.forEach((row) => {
      const idempotencyKey = row.idempotencyKey?.trim() ?? ''
      if (!idempotencyKey.startsWith(preorderIdPrefix)) {
        return
      }
      const preorderId = idempotencyKey.slice(preorderIdPrefix.length).trim()
      if (!preorderId) {
        return
      }
      preorderIdSet.add(preorderId)
    })
    return [...preorderIdSet]
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

  // 详细注释：客户端订单列表的“归属关键词”允许用户输入中文或英文习惯称呼。
  // 这里统一把关键词映射为订单归属枚举，保证“部门订 / 散客 / department / walkin”等输入都能命中服务端查询。
  private resolveClientOrderTypeByKeyword(keyword: string): O2oClientOrderType | null {
    const normalizedKeyword = keyword.trim().toLowerCase()
    if (!normalizedKeyword) {
      return null
    }
    if (
      normalizedKeyword.includes('department')
      || normalizedKeyword.includes('部门')
      || normalizedKeyword.includes('部门订')
    ) {
      return 'department'
    }
    if (
      normalizedKeyword.includes('walkin')
      || normalizedKeyword.includes('walk in')
      || normalizedKeyword.includes('散客')
    ) {
      return 'walkin'
    }
    return null
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
      if (row.skuId) {
        const sku = await manager.getRepository(BaseProductSku).findOne({
          where: { id: String(row.skuId) },
          lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
        })
        if (sku) {
          sku.preOrderedStock = Math.max(0, Number(sku.preOrderedStock ?? 0) - Number(row.qty ?? 0))
          await manager.getRepository(BaseProductSku).save(sku)
        }
      }
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
      const skuId = item.skuId ? String(item.skuId) : null
      const itemKey = this.buildOrderItemKey(productId, skuId)
      const currentQty = returnedQtyMap.get(itemKey) ?? 0
      returnedQtyMap.set(itemKey, currentQty + Math.max(0, Number(item.qty ?? 0)))
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
      handledAt: returnRequest.handledAt,
      handledBy: returnRequest.handledBy ?? null,
      verifiedAt: returnRequest.verifiedAt,
      verifiedBy: returnRequest.verifiedBy ?? null,
      rejectedReason: returnRequest.rejectedReason ?? null,
      qrPayload: `y-link://o2o/return/${returnRequest.verifyCode}`,
      items: requestItems.map((item) => ({
        id: String(item.id),
        productId: String(item.productId),
        skuId: item.skuId ? String(item.skuId) : null,
        productCode: item.product?.productCode ?? '',
        productName: item.product?.productName ?? '',
        skuCode: item.skuCodeSnapshot ?? null,
        specText: item.specTextSnapshot ?? null,
        qty: Number(item.qty ?? 0),
      })),
    }
  }

  private async buildReturnRequestDetail(returnRequest: O2oReturnRequest): Promise<O2oReturnRequestView> {
    const requestItems = await this.listReturnRequestItemsByRequestIds([String(returnRequest.id)])
    return this.buildReturnRequestView(returnRequest, requestItems)
  }

  async getReturnRequestDetailById(id: string) {
    const returnRequest = await this.returnRequestRepo.findOne({ where: { id } })
    if (!returnRequest) {
      throw new BizError('退货申请不存在', 404)
    }
    return this.buildReturnRequestDetail(returnRequest)
  }

  private async buildOrderDetail(order: O2oPreorder): Promise<O2oPreorderDetailView> {
    const id = String(order.id)
    const clientPreorderUpdateLimit = await this.getClientPreorderUpdateLimit()
    const customerOrderShowNoMap = await this.resolveCustomerOrderShowNoMap([id])
    const customerOrderShowNo = customerOrderShowNoMap.get(id) ?? null
    const clientUser = await this.clientUserRepo.findOne({
      where: { id: String(order.clientUserId) },
      select: ['id', 'realName', 'mobile', 'email', 'departmentName', 'accountType', 'staffNo'],
    })
    // 历史库与不同驱动下 order_id 参数类型可能出现 number/string 混用，
    // 这里做双口径兼容查询，避免订单详情“总件数存在但明细为空”。
    let items = await this.preorderItemRepo.find({
      where: { orderId: String(order.id) },
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
    let totalAmountCents = 0
    const normalizedItems = items.map((item) => {
      const snapshot = this.resolvePreorderItemSnapshot(item)
      const totalQty = Math.max(0, Number(item.qty ?? 0))
      const itemKey = this.buildPreorderItemKey(item)
      const legacyProductReturnedQty = item.skuId ? 0 : Number(returnedQtyMap.get(String(item.productId)) ?? 0)
      const returnedQty = Math.min(
        totalQty,
        Math.max(0, Number(returnedQtyMap.get(itemKey) ?? legacyProductReturnedQty)),
      )
      totalAmountCents += parseMoneyToCents(snapshot.lineAmount)
      return {
        id: String(item.id),
        productId: String(item.productId),
        skuId: item.skuId ? String(item.skuId) : null,
        productCode: item.product?.productCode ?? '',
        productName: item.product?.productName ?? '',
        skuCode: item.skuCodeSnapshot ?? null,
        specText: item.specTextSnapshot ?? null,
        skuImage: item.skuImageSnapshot ?? null,
        defaultPrice: snapshot.unitPrice,
        originalPrice: snapshot.originalPrice,
        discountRate: snapshot.discountRate,
        discountedPrice: snapshot.unitPrice,
        unitPrice: snapshot.unitPrice,
        lineAmount: snapshot.lineAmount,
        qty: totalQty,
        returnedQty,
        availableReturnQty: Math.max(0, totalQty - returnedQty),
        subTotal: snapshot.lineAmount,
      }
    })
    const nowMs = Date.now()
    const totalAmount = formatMoneyFromCents(totalAmountCents)
    const updateCount = this.normalizeOrderUpdateCount(order.updateCount)
    const resolvedPickupContact = order.pickupContact?.trim() || clientUser?.realName?.trim() || clientUser?.mobile?.trim() || null
    const o2oRules = await systemConfigService.getO2oRuleConfigs()
    return {
      order: {
        statusReport: this.resolveOrderStatusReport(order, nowMs),
        totalAmount,
        expireInSeconds: this.resolveExpireInSeconds(order, nowMs),
        id,
        showNo: order.showNo,
        customerOrderShowNo,
        verifyCode: order.verifyCode,
        status: order.status,
        businessStatus: order.businessStatus ?? null,
        hasCustomerOrder: Boolean(order.hasCustomerOrder),
        isSystemApplied: Boolean(order.isSystemApplied),
        pickupContact: resolvedPickupContact,
        merchantMessage: order.merchantMessage ?? null,
        clientOrderType: order.clientOrderType === 'department' ? 'department' : 'walkin',
        departmentNameSnapshot: order.departmentNameSnapshot?.trim() || null,
        staffNoSnapshot: order.staffNoSnapshot?.trim() || null,
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
        ? (() => {
            const normalizedUsername = clientUser.realName?.trim() || '未命名用户'
            return {
              id: String(clientUser.id),
              // `username` 是当前前端应优先消费的字段；
              // `realName` 先作为兼容别名返回，避免旧页面与新页面出现字段理解分叉。
              username: normalizedUsername,
              realName: normalizedUsername,
              mobile: clientUser.mobile?.trim() || null,
              email: clientUser.email?.trim() || null,
              departmentName: clientUser.departmentName?.trim() || null,
              accountType: clientUser.accountType,
              staffNo: clientUser.staffNo?.trim() || null,
            }
          })()
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
      storefront: {
        businessHoursText: o2oRules.storeBusinessHoursText,
        mallAnnouncementText: o2oRules.mallAnnouncementText,
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
      if (product) {
        const snapshot = this.buildPreorderItemSnapshot(product, fallbackItem.qty)
        fallbackItem.originalPrice = snapshot.originalPrice
        fallbackItem.discountRate = snapshot.discountRate
        fallbackItem.unitPrice = snapshot.unitPrice
        fallbackItem.lineAmount = snapshot.lineAmount
      }
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
      .addSelect('SUM(CASE WHEN COALESCE(item.lineAmount, 0) > 0 THEN item.lineAmount ELSE item.qty * COALESCE(item.unitPrice, product.defaultPrice, 0) END)', 'totalAmount')
      .where('item.orderId IN (:...orderIds)', { orderIds })
      .groupBy('item.orderId')
      .getRawMany<{ orderId: string; totalAmount: O2oNumericLike }>()
    return new Map(rows.map((item) => [String(item.orderId), this.normalizeDecimalText(item.totalAmount)]))
  }

  /**
   * 汇总订单关联的退货申请数量：
   * - 订单池列表只需要知道“该订单是否存在退货记录、是否还有待处理退货”；
   * - 统一在后端按订单聚合，避免前端为分类筛选逐单拉详情。
   */
  private async resolveOrderReturnRequestCountMap(orderIds: string[]) {
    if (!orderIds.length) {
      return new Map<string, { total: number; pending: number }>()
    }
    const rows = await this.returnRequestRepo
      .createQueryBuilder('returnRequest')
      .select('returnRequest.orderId', 'orderId')
      .addSelect('COUNT(1)', 'totalCount')
      .addSelect("SUM(CASE WHEN returnRequest.status = 'pending' THEN 1 ELSE 0 END)", 'pendingCount')
      .where('returnRequest.orderId IN (:...orderIds)', { orderIds })
      .groupBy('returnRequest.orderId')
      .getRawMany<{ orderId: string; totalCount: O2oNumericLike; pendingCount: O2oNumericLike }>()
    return new Map(
      rows.map((item) => [
        String(item.orderId),
        {
          total: Number(item.totalCount ?? 0),
          pending: Number(item.pendingCount ?? 0),
        },
      ]),
    )
  }

  /**
   * 汇总订单最近一笔退货申请摘要：
   * - 客户端订单列表只需要展示“最新退货状态”，无需把完整退货商品明细都塞进列表接口；
   * - 这里按 createdAt / id 倒序取每个订单的第一笔，保证多笔退货时仍能优先看到最新进度。
   */
  private async resolveLatestReturnRequestSummaryMap(orderIds: string[]) {
    if (!orderIds.length) {
      return new Map<
        string,
        {
          id: string
          returnNo: string
          status: O2oReturnRequestStatus
          createdAt: Date
          handledAt: Date | null
          rejectedReason: string | null
        }
      >()
    }
    const rows = await this.returnRequestRepo.find({
      where: { orderId: In(orderIds) },
      order: { createdAt: 'DESC', id: 'DESC' },
    })
    const summaryMap = new Map<
      string,
      {
        id: string
        returnNo: string
        status: O2oReturnRequestStatus
        createdAt: Date
        handledAt: Date | null
        rejectedReason: string | null
      }
    >()
    rows.forEach((item) => {
      const orderId = String(item.orderId)
      if (summaryMap.has(orderId)) {
        return
      }
      summaryMap.set(orderId, {
        id: String(item.id),
        returnNo: item.returnNo,
        status: item.status,
        createdAt: item.createdAt,
        handledAt: item.handledAt,
        rejectedReason: item.rejectedReason ?? null,
      })
    })
    return summaryMap
  }

  private async resolveProductSoldQtyMap(productIds: string[]) {
    if (!productIds.length) {
      return new Map<string, number>()
    }

    const soldRows = await this.preorderItemRepo
      .createQueryBuilder('item')
      .leftJoin('item.order', 'preorder')
      .select('item.productId', 'productId')
      .addSelect('SUM(item.qty)', 'soldQty')
      .where('item.productId IN (:...productIds)', { productIds })
      .andWhere('preorder.status = :status', { status: 'verified' })
      .groupBy('item.productId')
      .getRawMany<{ productId: string; soldQty: O2oNumericLike }>()

    // 退货核销会同步扣减原预订单明细 qty，因此已核销订单明细本身就是净销量。
    return new Map(
      soldRows.map((item) => [
        String(item.productId),
        Math.max(0, Number(item.soldQty ?? 0)),
      ]),
    )
  }

  /**
   * 统一构建订单摘要视图：
   * - 列表页与“单条摘要刷新”接口复用同一套聚合口径，避免金额、退货统计和状态报告在不同接口间漂移；
   * - 保持传入顺序输出，方便调用方直接把结果映射回当前列表缓存。
   */
  private async buildOrderSummaryViews(
    orders: O2oPreorder[],
    options?: {
      nowMs?: number
    },
  ): Promise<O2oPreorderSummaryView[]> {
    if (!orders.length) {
      return []
    }
    const orderIds = orders.map((item) => String(item.id))
    const nowMs = options?.nowMs ?? Date.now()
    const customerOrderShowNoMap = await this.resolveCustomerOrderShowNoMap(orderIds)
    const totalAmountMap = await this.resolveOrderTotalAmountMap(orderIds)
    const returnRequestCountMap = await this.resolveOrderReturnRequestCountMap(orderIds)
    const latestReturnRequestMap = await this.resolveLatestReturnRequestSummaryMap(orderIds)
    return orders.map((item) => ({
      statusReport: this.resolveOrderStatusReport(item, nowMs),
      totalAmount: totalAmountMap.get(String(item.id)) ?? '0.00',
      expireInSeconds: this.resolveExpireInSeconds(item, nowMs),
      id: String(item.id),
      showNo: item.showNo,
      customerOrderShowNo: customerOrderShowNoMap.get(String(item.id)) ?? null,
      verifyCode: item.verifyCode,
      status: item.status,
      businessStatus: item.businessStatus ?? null,
      hasCustomerOrder: Boolean(item.hasCustomerOrder),
      isSystemApplied: Boolean(item.isSystemApplied),
      merchantMessage: item.merchantMessage ?? null,
      clientOrderType: item.clientOrderType === 'department' ? 'department' : 'walkin',
      departmentNameSnapshot: item.departmentNameSnapshot?.trim() || null,
      staffNoSnapshot: item.staffNoSnapshot?.trim() || null,
      returnRequestCount: returnRequestCountMap.get(String(item.id))?.total ?? 0,
      pendingReturnRequestCount: returnRequestCountMap.get(String(item.id))?.pending ?? 0,
      latestReturnRequest: latestReturnRequestMap.get(String(item.id)) ?? null,
      totalQty: item.totalQty,
      timeoutAt: item.timeoutAt,
      createdAt: item.createdAt,
    }))
  }

  /**
   * 单条摘要构建器：
   * - 供客户端订单列表的“增量刷新单条订单”接口复用；
   * - 内部仍走与列表页一致的聚合逻辑，避免出现“单条刷新后摘要字段缺失”。
   */
  private async buildOrderSummaryView(
    order: O2oPreorder,
    options?: {
      nowMs?: number
    },
  ): Promise<O2oPreorderSummaryView> {
    const [summary] = await this.buildOrderSummaryViews([order], options)
    return summary
  }

  async listMallProducts() {
    // 商城端只暴露“可售且已上架”的商品，并把库存口径统一换算成前端直接可用的 availableStock。
    // 同时把允许对客户端公开的门店展示配置一并返回，避免客户端误调后台系统配置接口。
    const o2oRules = await systemConfigService.getO2oRuleConfigs()
    const products = await this.productRepo.find({
      select: {
        id: true,
        productCode: true,
        productName: true,
        defaultPrice: true,
        discountRate: true,
        o2oRecommended: true,
        thumbnail: true,
        detailContent: true,
        limitPerUser: true,
        currentStock: true,
        preOrderedStock: true,
      },
      where: { isActive: true, o2oStatus: 'listed' },
      order: { id: 'DESC' },
    })

    if (!products.length) {
      return {
        list: [],
        storefront: {
          businessHoursText: o2oRules.storeBusinessHoursText,
          mallAnnouncementText: o2oRules.mallAnnouncementText,
        },
      }
    }

    const productIds = products.map((p) => String(p.id))
    const relations = await AppDataSource.manager.getRepository(RelProductTag).find({
      where: { productId: In(productIds) },
      relations: { tag: true },
    })
    const skus = await AppDataSource.manager.getRepository(BaseProductSku).find({
      select: {
        id: true,
        productId: true,
        skuCode: true,
        specValuesJson: true,
        specText: true,
        defaultPrice: true,
        discountRate: true,
        currentStock: true,
        preOrderedStock: true,
        isActive: true,
        o2oRecommended: true,
        thumbnail: true,
        sortOrder: true,
      },
      where: { productId: In(productIds) },
      order: { productId: 'ASC', sortOrder: 'ASC', id: 'ASC' },
    })
    const soldQtyMap = await this.resolveProductSoldQtyMap(productIds)

    const productTagMap = new Map<string, string[]>()
    relations.forEach((relation) => {
      const productId = String(relation.productId)
      const currentTags = productTagMap.get(productId) ?? []
      if (relation.tag?.tagName) {
        currentTags.push(relation.tag.tagName)
      }
      productTagMap.set(productId, currentTags)
    })
    const skuByProductMap = new Map<string, BaseProductSku[]>()
    skus.forEach((sku) => {
      const productId = String(sku.productId)
      const currentSkus = skuByProductMap.get(productId) ?? []
      currentSkus.push(sku)
      skuByProductMap.set(productId, currentSkus)
    })

    return {
      list: products.map((item) => {
        const productSkus = skuByProductMap.get(String(item.id)) ?? []
        const skuViews = productSkus.map((sku) => {
          const currentStock = Math.max(0, Number(sku.currentStock ?? 0))
          const preOrderedStock = Math.max(0, Number(sku.preOrderedStock ?? 0))
          return {
            id: String(sku.id),
            productId: String(sku.productId),
            skuCode: sku.skuCode,
            specText: sku.specText || '默认规格',
            specValues: (() => {
              try {
                return JSON.parse(sku.specValuesJson || '{}') as Record<string, string>
              } catch {
                return {}
              }
            })(),
            defaultPrice: this.normalizeDecimalText(sku.defaultPrice),
            originalPrice: this.normalizeDecimalText(sku.defaultPrice),
            discountRate: normalizeDiscountRate(sku.discountRate),
            discountedPrice: calculateDiscountedPrice(sku.defaultPrice, sku.discountRate),
            currentStock,
            preOrderedStock,
            availableStock: Math.max(0, currentStock - preOrderedStock),
            isActive: Boolean(sku.isActive),
            o2oRecommended: Boolean(sku.o2oRecommended),
            thumbnail: sku.thumbnail ?? item.thumbnail,
            sortOrder: Number(sku.sortOrder ?? 0),
          }
        })
        const activeSkuViews = skuViews.filter((sku) => sku.isActive)
        const currentStock = skuViews.length
          ? activeSkuViews.reduce((sum, sku) => sum + sku.currentStock, 0)
          : Number(item.currentStock ?? 0)
        const preOrderedStock = skuViews.length
          ? activeSkuViews.reduce((sum, sku) => sum + sku.preOrderedStock, 0)
          : Number(item.preOrderedStock ?? 0)
        const previewSku = this.resolveMallPreviewSku(skuViews, Boolean(item.o2oRecommended))
        const defaultPrice = previewSku?.defaultPrice ?? item.defaultPrice
        const originalPrice = previewSku?.originalPrice ?? this.normalizeDecimalText(item.defaultPrice)
        const discountRate = previewSku?.discountRate ?? normalizeDiscountRate(item.discountRate)
        const discountedPrice = previewSku?.discountedPrice ?? calculateDiscountedPrice(item.defaultPrice, item.discountRate)
        return {
          id: String(item.id),
          productCode: item.productCode,
          productName: item.productName,
          defaultPrice,
          originalPrice,
          discountRate,
          discountedPrice,
          o2oRecommended: Boolean(item.o2oRecommended),
          tags: productTagMap.get(String(item.id)) ?? [],
          thumbnail: item.thumbnail,
          detailContent: item.detailContent,
          limitPerUser: Number(item.limitPerUser ?? 5),
          currentStock,
          preOrderedStock,
          availableStock: Math.max(0, currentStock - preOrderedStock),
          soldQty: Math.max(0, Math.floor(soldQtyMap.get(String(item.id)) ?? 0)),
          skus: skuViews,
        }
      }),
      storefront: {
        businessHoursText: o2oRules.storeBusinessHoursText,
        mallAnnouncementText: o2oRules.mallAnnouncementText,
      },
    }
  }

  async getMallStorefrontConfig() {
    const o2oRules = await systemConfigService.getO2oRuleConfigs()
    return {
      businessHoursText: o2oRules.storeBusinessHoursText,
      mallAnnouncementText: o2oRules.mallAnnouncementText,
    }
  }

  private async generatePreorderShowNo(
    clientOrderType: O2oClientOrderType,
    manager = AppDataSource.manager,
  ): Promise<string> {
    // 预订单展示单号与正式出库单统一前缀规则：
    // - 部门单：hyyzjdxxxx
    // - 散客单：hyyzxxxx
    // 这样客户端下单后立即显示业务单号口径，不再先出现 PO 前缀。
    const orderType = clientOrderType === 'department' ? 'department' : 'walkin'
    return orderSerialService.generateOrderNo(orderType, manager)
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
      const itemKey = this.buildOrderItemKey(productId, item.skuId ? String(item.skuId) : null)
      const currentQty = pendingQtyMap.get(itemKey) ?? 0
      pendingQtyMap.set(itemKey, currentQty + Math.max(0, Number(item.qty ?? 0)))
    })
    return pendingQtyMap
  }

  // 详细注释：把同一商品的多行请求先合并，再与订单原始数量、待核销量逐项比对，
  // 统一产出本次退货申请需要写入数据库的商品映射和总件数。
  private validateReturnRequestItems(
    orderItems: O2oPreorderItem[],
    pendingQtyMap: Map<string, number>,
    normalizedItems: Array<{ productId: string; skuId: string | null; qty: number }>,
  ) {
    const orderItemMap = new Map(orderItems.map((item) => [this.buildPreorderItemKey(item), item]))
    const mergedRequestQtyMap = new Map<string, { productId: string; skuId: string | null; qty: number }>()
    normalizedItems.forEach((item) => {
      const itemKey = this.buildOrderItemKey(item.productId, item.skuId)
      const current = mergedRequestQtyMap.get(itemKey)
      mergedRequestQtyMap.set(itemKey, {
        productId: item.productId,
        skuId: item.skuId,
        qty: (current?.qty ?? 0) + item.qty,
      })
    })

    let totalQty = 0
    for (const [itemKey, requestItem] of mergedRequestQtyMap) {
      const productId = requestItem.productId
      const orderItem = orderItemMap.get(itemKey)
      if (!orderItem) {
        throw new BizError('存在不属于当前订单的商品，无法申请退货', 409)
      }
      const orderQty = Math.max(0, Number(orderItem.qty ?? 0))
      const pendingQty = Math.max(0, Number(pendingQtyMap.get(itemKey) ?? 0))
      const availableReturnQty = Math.max(0, orderQty - pendingQty)
      if (availableReturnQty <= 0) {
        throw new BizError(`商品「${orderItem.product?.productName ?? productId}」暂无可退数量`, 409)
      }
      if (requestItem.qty > availableReturnQty) {
        throw new BizError(`商品「${orderItem.product?.productName ?? productId}」最多可退 ${availableReturnQty} 件`, 409)
      }
      totalQty += requestItem.qty
    }

    return { mergedRequestQtyMap, totalQty }
  }

  async submit(auth: ClientAuthContext, input: SubmitPreorderInput) {
    const normalizedItems = this.normalizePreorderItems(input.items)
    const normalizedRemark = this.normalizePreorderRemark(input.remark)
    // 详细注释：是否系统申请必须以客户端本次明确选择为准，不再使用服务端默认兜底。
    const normalizedIsSystemApplied = Boolean(input.isSystemApplied)

    const o2oRules = await systemConfigService.getO2oRuleConfigs()
    const detail = await AppDataSource.transaction(async (manager) => {
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
      const skus = await manager.getRepository(BaseProductSku).find({
        where: { productId: In(productIds) },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      const { skuMap, skuByProductMap } = this.groupSkusByProduct(skus)
      let totalQty = 0
      for (const row of normalizedItems) {
        const product = this.getRequiredProduct(productMap, row.productId)
        const sku = this.getRequiredSku(skuMap, skuByProductMap, row.productId, row.skuId)
        if (!product.isActive || product.o2oStatus !== 'listed') {
          throw new BizError(`商品「${product.productName}」已下架，不可预订`, 409)
        }
        if (!sku.isActive) {
          throw new BizError(`规格「${sku.specText}」已下架，不可预订`, 409)
        }
        // 预订库存不直接扣 currentStock，而是先增加 preOrderedStock 占位，
        // 这样线下真正核销时再把现货库存扣减，符合“线上预留、线下履约”的业务模型。
        const availableStock = Number(sku.currentStock ?? 0) - Number(sku.preOrderedStock ?? 0)
        if (availableStock < row.qty) {
          throw new BizError(`规格「${sku.specText}」库存不足`, 409)
        }
        const limitQty = this.resolveProductLimitQty(product, o2oRules)
        if (o2oRules.limitEnabled && row.qty > limitQty) {
          throw new BizError(`商品「${product.productName}」超过限购数量`, 409)
        }
        totalQty += row.qty
      }

      const clientUser = await manager.getRepository(ClientUser).findOne({
        where: { id: auth.userId },
        select: ['id', 'realName', 'accountType', 'departmentName', 'staffNo'],
      })
      if (!clientUser) {
        throw new BizError('客户端账号不存在，请重新登录后再试', 401)
      }
      // 订单归属由服务端按当前登录账号强制判定：
      // - 部门账号一律沉淀为部门单；
      // - 个人账号一律沉淀为散客单；
      // - 这样可避免客户端伪造归属类型，保持账号身份与订单归属一致。
      const normalizedClientOrderType = this.normalizeClientOrderType(clientUser.accountType === 'department' ? 'department' : 'walkin')
      const departmentNameSnapshot = this.resolveDepartmentNameSnapshot(normalizedClientOrderType, clientUser)
      const staffNoSnapshot = this.resolveStaffNoSnapshot(normalizedClientOrderType, clientUser)
      const normalizedPickupContact = this.normalizePickupContact(
        normalizedClientOrderType === 'department'
          ? (clientUser.realName || auth.realName)
          : input.pickupContact,
      )

      // verifyCode 既用于用户端展示二维码，也作为管理端核销入口的核心识别码。
      const showNo = await this.generatePreorderShowNo(normalizedClientOrderType, manager)
      const timeoutAt = o2oRules.autoCancelEnabled ? new Date(Date.now() + o2oRules.autoCancelHours * 60 * 60 * 1000) : null
      const savedOrder = await manager.getRepository(O2oPreorder).save(
        manager.getRepository(O2oPreorder).create({
          showNo,
          clientUserId: auth.userId,
          verifyCode: randomUUID(),
          status: 'pending',
          clientOrderType: normalizedClientOrderType,
          departmentNameSnapshot,
          staffNoSnapshot,
          isSystemApplied: normalizedIsSystemApplied,
          hasCustomerOrder: false,
          pickupContact: normalizedPickupContact,
          totalQty,
          remark: normalizedRemark,
          timeoutAt,
        }),
      )
      const itemEntities = normalizedItems.map((item) =>
        (() => {
          const product = this.getRequiredProduct(productMap, item.productId)
          const sku = this.getRequiredSku(skuMap, skuByProductMap, item.productId, item.skuId)
          const snapshot = this.buildPreorderSkuItemSnapshot(product, sku, item.qty)
          return manager.getRepository(O2oPreorderItem).create({
            orderId: savedOrder.id,
            productId: item.productId,
            skuId: snapshot.skuId,
            skuCodeSnapshot: snapshot.skuCode,
            specTextSnapshot: snapshot.specText,
            skuImageSnapshot: snapshot.skuImage,
            qty: item.qty,
            originalPrice: snapshot.originalPrice,
            discountRate: snapshot.discountRate,
            unitPrice: snapshot.unitPrice,
            lineAmount: snapshot.lineAmount,
          })
        })(),
      )
      await manager.getRepository(O2oPreorderItem).save(itemEntities)

      for (const row of normalizedItems) {
        const product = this.getRequiredProduct(productMap, row.productId)
        const sku = this.getRequiredSku(skuMap, skuByProductMap, row.productId, row.skuId)
        const beforeCurrentStock = Number(product.currentStock ?? 0)
        const beforePreOrderedStock = Number(product.preOrderedStock ?? 0)
        const beforeSkuPreOrderedStock = Number(sku.preOrderedStock ?? 0)
        // 下单成功后只增加预订占用库存，不减少现货库存；
        // 真正出库动作发生在 verifyByCode。
        product.preOrderedStock = beforePreOrderedStock + row.qty
        sku.preOrderedStock = beforeSkuPreOrderedStock + row.qty
        await manager.getRepository(BaseProductSku).save(sku)
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
    await notificationService.emitEvent({
      eventType: 'o2o_preorder_created',
      sourceType: 'o2o_preorder',
      sourceId: detail.order.id,
      payload: {
        showNo: detail.order.showNo,
        sourceUserId: auth.userId,
        sourceUserDisplayName: auth.realName || auth.account,
      },
    })
    return detail
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
    const currentUpdateCount = this.normalizeOrderUpdateCount(order.updateCount)
    if (currentUpdateCount >= clientPreorderUpdateLimit) {
      throw new BizError(`订单最多仅可修改 ${clientPreorderUpdateLimit} 次`, 409)
    }

    const returnRequestCount = await manager.getRepository(O2oReturnRequest).count({
      where: { orderId: String(order.id) },
    })
    if (returnRequestCount > 0) {
      throw new BizError('当前订单已存在退货申请记录，暂不支持修改订单', 409)
    }
  }

  private async assertCanOnsiteAdjustOrderInManager(manager: EntityManager, order: O2oPreorder) {
    if (await this.cancelTimedOutOrderInManager(manager, order)) {
      throw new BizError('订单已超时取消，无法现场改单', 409)
    }
    if (order.status === 'verified') {
      throw new BizError('订单已核销，无法现场改单', 409)
    }
    if (order.status === 'cancelled') {
      throw new BizError('订单已取消，无法现场改单', 409)
    }
    if (order.status !== 'pending') {
      throw new BizError('当前订单状态不可现场改单', 409)
    }

    const returnRequestCount = await manager.getRepository(O2oReturnRequest).count({
      where: { orderId: String(order.id) },
    })
    if (returnRequestCount > 0) {
      throw new BizError('当前订单已存在退货申请记录，暂不支持现场改单', 409)
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
    normalizedItems: Array<{ productId: string; skuId: string | null; qty: number }>,
    existingQtyMap: Map<string, number>,
    productMap: Map<string, BaseProduct>,
    skuMap: Map<string, BaseProductSku>,
    skuByProductMap: Map<string, BaseProductSku[]>,
    o2oRules: Awaited<ReturnType<typeof systemConfigService.getO2oRuleConfigs>>,
  ) {
    let totalQty = 0
    normalizedItems.forEach((row) => {
      const product = productMap.get(row.productId)
      if (!product) {
        throw new BizError('存在无效商品，无法修改订单', 400)
      }
      const sku = this.getRequiredSku(skuMap, skuByProductMap, row.productId, row.skuId)
      const itemKey = this.buildOrderItemKey(row.productId, String(sku.id))
      const originalQty = existingQtyMap.get(itemKey) ?? 0
      if (!sku.isActive && row.qty > originalQty) {
        throw new BizError(`规格「${sku.specText}」已下架，不能增加数量`, 409)
      }
      if (!product.isActive || product.o2oStatus !== 'listed') {
        if (originalQty <= 0) {
          throw new BizError(`商品「${product.productName}」已下架，不能加入订单`, 409)
        }
        if (row.qty > originalQty) {
          throw new BizError(`商品「${product.productName}」已下架，只能维持或减少原有数量`, 409)
        }
      }

      const effectiveAvailableStock = Math.max(
        0,
        Number(sku.currentStock ?? 0) - Number(sku.preOrderedStock ?? 0) + originalQty,
      )
      if (effectiveAvailableStock < row.qty) {
        throw new BizError(`规格「${sku.specText}」库存不足，当前最多可保留 ${effectiveAvailableStock} 件`, 409)
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
    operator: {
      operatorType: 'client' | 'admin'
      operatorId: string
      operatorName: string | null
      logRemark: string
    },
    order: O2oPreorder,
    existingQtyMap: Map<string, number>,
    nextQtyMap: Map<string, number>,
    itemKeyMap: Map<string, { productId: string; skuId: string | null }>,
    productMap: Map<string, BaseProduct>,
    skuMap: Map<string, BaseProductSku>,
  ) {
    const productRepo = manager.getRepository(BaseProduct)
    const skuRepo = manager.getRepository(BaseProductSku)
    const inventoryLogRepo = manager.getRepository(InventoryLog)
    const changedProductIds = [...new Set([...existingQtyMap.keys(), ...nextQtyMap.keys()])]

    for (const itemKey of changedProductIds) {
      const itemRef = itemKeyMap.get(itemKey)
      if (!itemRef) {
        continue
      }
      const previousQty = existingQtyMap.get(itemKey) ?? 0
      const nextQty = nextQtyMap.get(itemKey) ?? 0
      const deltaQty = nextQty - previousQty
      if (deltaQty === 0) {
        continue
      }

      const product = productMap.get(itemRef.productId)
        ?? await productRepo.findOne({
          where: { id: itemRef.productId },
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
      const sku = itemRef.skuId ? skuMap.get(itemRef.skuId) : null
      if (sku) {
        sku.preOrderedStock = deltaQty > 0
          ? Number(sku.preOrderedStock ?? 0) + deltaQty
          : Math.max(0, Number(sku.preOrderedStock ?? 0) - changeQty)
        await skuRepo.save(sku)
      }

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
          operatorType: operator.operatorType,
          operatorId: operator.operatorId,
          operatorName: operator.operatorName,
          refType: 'o2o_preorder',
          refId: String(order.id),
          remark: operator.logRemark,
        }),
      )
    }
  }

  private async saveUpdatedPreorderItemsInManager(
    manager: EntityManager,
    order: O2oPreorder,
    existingItems: O2oPreorderItem[],
    normalizedItems: Array<{ productId: string; skuId: string | null; qty: number }>,
    nextQtyMap: Map<string, number>,
    productMap: Map<string, BaseProduct>,
    skuMap: Map<string, BaseProductSku>,
    skuByProductMap: Map<string, BaseProductSku[]>,
  ) {
    const orderItemRepo = manager.getRepository(O2oPreorderItem)
    const existingItemMap = new Map(existingItems.map((item) => [this.buildPreorderItemKey(item), item]))
    const nextItemEntities = normalizedItems.map((item) => {
      const product = this.getRequiredProduct(productMap, item.productId)
      const sku = this.getRequiredSku(skuMap, skuByProductMap, item.productId, item.skuId)
      const itemKey = this.buildOrderItemKey(item.productId, String(sku.id))
      const existedItem = existingItemMap.get(itemKey)
      const snapshot = this.buildPreorderSkuItemSnapshot(product, sku, item.qty)
      if (existedItem) {
        existedItem.qty = item.qty
        existedItem.skuId = snapshot.skuId
        existedItem.skuCodeSnapshot = snapshot.skuCode
        existedItem.specTextSnapshot = snapshot.specText
        existedItem.skuImageSnapshot = snapshot.skuImage
        existedItem.originalPrice = snapshot.originalPrice
        existedItem.discountRate = snapshot.discountRate
        existedItem.unitPrice = snapshot.unitPrice
        existedItem.lineAmount = snapshot.lineAmount
        return existedItem
      }
      return orderItemRepo.create({
        orderId: String(order.id),
        productId: item.productId,
        skuId: snapshot.skuId,
        skuCodeSnapshot: snapshot.skuCode,
        specTextSnapshot: snapshot.specText,
        skuImageSnapshot: snapshot.skuImage,
        qty: item.qty,
        originalPrice: snapshot.originalPrice,
        discountRate: snapshot.discountRate,
        unitPrice: snapshot.unitPrice,
        lineAmount: snapshot.lineAmount,
      })
    })
    await orderItemRepo.save(nextItemEntities)

    const removedItems = existingItems.filter((item) => !nextQtyMap.has(this.buildPreorderItemKey(item)))
    if (removedItems.length) {
      await orderItemRepo.remove(removedItems)
    }
  }

  async updateMyOrder(auth: ClientAuthContext, orderId: string, input: UpdateMyPreorderInput) {
    const normalizedItems = this.normalizePreorderItems(input.items)
    const normalizedRemark = this.normalizePreorderRemark(input.remark)
    const o2oRules = await systemConfigService.getO2oRuleConfigs()

    return AppDataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(O2oPreorder)
      const orderItemRepo = manager.getRepository(O2oPreorderItem)

      const order = await orderRepo.findOne({
        where: { id: orderId, clientUserId: auth.userId, isDeleted: false },
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
      const existingQtyMap = new Map(existingItems.map((item) => [this.buildPreorderItemKey(item), Math.max(0, Number(item.qty ?? 0))]))

      const productIds = [...new Set([
        ...normalizedItems.map((item) => item.productId),
        ...existingItems.map((item) => String(item.productId)),
      ])]
      const productMap = await this.loadEditableOrderProductsInManager(manager, productIds)
      const skus = await manager.getRepository(BaseProductSku).find({
        where: { productId: In(productIds) },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      const { skuMap, skuByProductMap } = this.groupSkusByProduct(skus)
      const normalizedItemRefs = normalizedItems.map((item) => {
        const sku = this.getRequiredSku(skuMap, skuByProductMap, item.productId, item.skuId)
        return {
          productId: item.productId,
          skuId: String(sku.id),
          qty: item.qty,
          itemKey: this.buildOrderItemKey(item.productId, String(sku.id)),
        }
      })
      const itemKeyMap = new Map<string, { productId: string; skuId: string | null }>()
      existingItems.forEach((item) => itemKeyMap.set(this.buildPreorderItemKey(item), {
        productId: String(item.productId),
        skuId: item.skuId ? String(item.skuId) : null,
      }))
      normalizedItemRefs.forEach((item) => itemKeyMap.set(item.itemKey, { productId: item.productId, skuId: item.skuId }))
      const totalQty = this.validateUpdatedPreorderItems(normalizedItems, existingQtyMap, productMap, skuMap, skuByProductMap, o2oRules)

      const nextQtyMap = new Map(normalizedItemRefs.map((item) => [item.itemKey, item.qty]))
      await this.applyPreorderItemStockDeltaInManager(
        manager,
        {
          operatorType: 'client',
          operatorId: auth.userId,
          operatorName: auth.realName || auth.mobile,
          logRemark: `客户端修改订单，订单号：${order.showNo}`,
        },
        order,
        existingQtyMap,
        nextQtyMap,
        itemKeyMap,
        productMap,
        skuMap,
      )
      await this.saveUpdatedPreorderItemsInManager(manager, order, existingItems, normalizedItems, nextQtyMap, productMap, skuMap, skuByProductMap)

      order.totalQty = totalQty
      order.remark = normalizedRemark
      order.updateCount = this.normalizeOrderUpdateCount(order.updateCount) + 1
      await orderRepo.save(order)
      return this.buildOrderDetail(order)
    })
  }

  async updateOrderOnsite(auth: AuthUserContext, input: UpdateOnsitePreorderInput) {
    await this.cancelTimeoutOrders()
    const normalizedItems = this.normalizePreorderItems(input.items)
    const normalizedRemark = this.normalizePreorderRemark(input.remark)
    const o2oRules = await systemConfigService.getO2oRuleConfigs()

    return AppDataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(O2oPreorder)
      const orderItemRepo = manager.getRepository(O2oPreorderItem)
      const order = await orderRepo.findOne({
        where: { id: input.orderId, isDeleted: false },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('预订单不存在', 404)
      }
      await this.assertCanOnsiteAdjustOrderInManager(manager, order)

      const existingItems = await orderItemRepo.find({
        where: { orderId: String(order.id) },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      const existingQtyMap = new Map(existingItems.map((item) => [this.buildPreorderItemKey(item), Math.max(0, Number(item.qty ?? 0))]))
      const productIds = [...new Set([
        ...normalizedItems.map((item) => item.productId),
        ...existingItems.map((item) => String(item.productId)),
      ])]
      const productMap = await this.loadEditableOrderProductsInManager(manager, productIds)
      const skus = await manager.getRepository(BaseProductSku).find({
        where: { productId: In(productIds) },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      const { skuMap, skuByProductMap } = this.groupSkusByProduct(skus)
      const normalizedItemRefs = normalizedItems.map((item) => {
        const sku = this.getRequiredSku(skuMap, skuByProductMap, item.productId, item.skuId)
        return {
          productId: item.productId,
          skuId: String(sku.id),
          qty: item.qty,
          itemKey: this.buildOrderItemKey(item.productId, String(sku.id)),
        }
      })
      const itemKeyMap = new Map<string, { productId: string; skuId: string | null }>()
      existingItems.forEach((item) => itemKeyMap.set(this.buildPreorderItemKey(item), {
        productId: String(item.productId),
        skuId: item.skuId ? String(item.skuId) : null,
      }))
      normalizedItemRefs.forEach((item) => itemKeyMap.set(item.itemKey, { productId: item.productId, skuId: item.skuId }))
      const totalQty = this.validateUpdatedPreorderItems(normalizedItems, existingQtyMap, productMap, skuMap, skuByProductMap, o2oRules)
      const nextQtyMap = new Map(normalizedItemRefs.map((item) => [item.itemKey, item.qty]))

      await this.applyPreorderItemStockDeltaInManager(
        manager,
        {
          operatorType: 'admin',
          operatorId: auth.userId,
          operatorName: auth.displayName,
          logRemark: `门店现场改单，订单号：${order.showNo}`,
        },
        order,
        existingQtyMap,
        nextQtyMap,
        itemKeyMap,
        productMap,
        skuMap,
      )
      await this.saveUpdatedPreorderItemsInManager(manager, order, existingItems, normalizedItems, nextQtyMap, productMap, skuMap, skuByProductMap)

      order.totalQty = totalQty
      order.remark = normalizedRemark
      await orderRepo.save(order)
      return this.buildOrderDetail(order)
    })
  }

  async listMyOrders(auth: ClientAuthContext, query?: Partial<MyOrderListQuery>): Promise<PaginationResult<O2oPreorderSummaryView>> {
    // Timeout recycling runs in the background and on write paths; this read path stays query-only.
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
      .andWhere('order.isDeleted = :isDeleted', { isDeleted: false })
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
      const matchedClientOrderType = this.resolveClientOrderTypeByKeyword(normalizedKeyword)
      const matchedCustomerOrderPreorderIds = await this.resolveMatchedPreorderIdsByCustomerOrderKeyword(normalizedKeyword)
      const keywordContains = `%${escapedKeyword}%`

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
            // 部门名称是用户端“归属”常见搜索入口，允许做包含匹配覆盖历史使用习惯。
            .orWhere(String.raw`order.departmentNameSnapshot LIKE :departmentKeyword ESCAPE '\'`, {
              departmentKeyword: keywordContains,
            })
            // 工号快照已在列表卡片展示，这里必须同步纳入关键词命中，避免出现“看得到但搜不到”。
            .orWhere(String.raw`order.staffNoSnapshot LIKE :staffNoKeyword ESCAPE '\'`, {
              staffNoKeyword: keywordContains,
            })
          if (matchedCustomerOrderPreorderIds.length) {
            keywordQb.orWhere('order.id IN (:...matchedCustomerOrderPreorderIds)', {
              matchedCustomerOrderPreorderIds,
            })
          }
          if (matchedClientOrderType) {
            keywordQb.orWhere('order.clientOrderType = :clientOrderType', {
              clientOrderType: matchedClientOrderType,
            })
          }
        }),
      )
    }

    const [rows, total] = await queryBuilder.getManyAndCount()
    const nowMs = Date.now()
    return {
      page: normalizedPage,
      pageSize: normalizedPageSize,
      total,
      list: await this.buildOrderSummaryViews(rows, { nowMs }),
    }
  }

  async getMyOrderDetail(auth: ClientAuthContext, id: string) {
    const order = await this.preorderRepo.findOne({ where: { id, clientUserId: auth.userId, isDeleted: false } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    return this.buildOrderDetail(order)
  }

  async getMyOrderSummary(auth: ClientAuthContext, id: string) {
    const order = await this.preorderRepo.findOne({ where: { id, clientUserId: auth.userId, isDeleted: false } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    return this.buildOrderSummaryView(order)
  }

  async createReturnRequest(auth: ClientAuthContext, orderId: string, input: SubmitReturnRequestInput) {
    await this.cancelTimeoutOrders()
    const normalizedReason = this.normalizeReturnReason(input.reason)
    if (!Array.isArray(input.items) || !input.items.length) {
      throw new BizError('至少选择一个商品申请退货', 400)
    }
    const normalizedItems = input.items.map((item) => ({
      productId: String(item.productId).trim(),
      skuId: item.skuId === null || item.skuId === undefined ? null : String(item.skuId).trim() || null,
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
        where: { id: orderId, clientUserId: auth.userId, isDeleted: false },
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
      const orderItemMap = new Map(orderItems.map((item) => [this.buildPreorderItemKey(item), item]))
      const requestItemEntities = [...mergedRequestQtyMap.entries()].map(([itemKey, requestItem]) => {
        const orderItem = orderItemMap.get(itemKey)
        return returnRequestItemRepo.create({
          returnRequestId: String(savedRequest.id),
          productId: requestItem.productId,
          skuId: requestItem.skuId,
          skuCodeSnapshot: orderItem?.skuCodeSnapshot ?? null,
          specTextSnapshot: orderItem?.specTextSnapshot ?? null,
          qty: requestItem.qty,
        })
      })
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
    accountType?: ClientUser['accountType']
    departmentName?: string
    staffNo?: string
    startTime?: string
    endTime?: string
    limit?: number
  }) {
    const normalizedKeyword = input.keyword?.trim() ?? ''
    const normalizedDepartmentName = input.departmentName?.trim() ?? ''
    const normalizedStaffNo = input.staffNo?.trim() ?? ''
    const normalizedLimit = Math.max(1, Math.min(200, Number(input.limit) || 50))
    const startTime = this.parseTimeFilter(input.startTime, '开始时间')
    const endTime = this.parseTimeFilter(input.endTime, '结束时间')
    if (startTime && endTime && startTime.getTime() > endTime.getTime()) {
      throw new BizError('开始时间不能晚于结束时间', 400)
    }
    const queryBuilder = this.preorderRepo
      .createQueryBuilder('order')
      .where('order.isDeleted = :isDeleted', { isDeleted: false })
      .orderBy('order.id', 'DESC')
      .take(normalizedLimit)

    if (input.status) {
      queryBuilder.andWhere('order.status = :status', { status: input.status })
    }
    if (input.accountType === 'department') {
      queryBuilder.andWhere('order.clientOrderType = :accountTypeOrderType', { accountTypeOrderType: 'department' })
    }
    if (input.accountType === 'personal') {
      queryBuilder.andWhere('order.clientOrderType = :accountTypeOrderType', { accountTypeOrderType: 'walkin' })
    }
    if (normalizedDepartmentName) {
      queryBuilder.andWhere('order.departmentNameSnapshot = :departmentName', { departmentName: normalizedDepartmentName })
    }
    if (normalizedStaffNo) {
      const escapedStaffNo = this.escapeLikeKeyword(normalizedStaffNo)
      queryBuilder.andWhere(String.raw`order.staffNoSnapshot LIKE :staffNo ESCAPE '\'`, { staffNo: `%${escapedStaffNo}%` })
    }

    if (startTime) {
      queryBuilder.andWhere('order.createdAt >= :startTime', { startTime })
    }
    if (endTime) {
      queryBuilder.andWhere('order.createdAt <= :endTime', { endTime })
    }

    if (normalizedKeyword) {
      const escapedKeyword = this.escapeLikeKeyword(normalizedKeyword)
      const keyword = `%${escapedKeyword}%`
      const clientKeywordSubQuery = this.preorderRepo
        .createQueryBuilder('order_keyword_client')
        .subQuery()
        .select('1')
        .from(ClientUser, 'clientUser')
        .where('clientUser.id = order.clientUserId')
        .andWhere(
          String.raw`(
            clientUser.realName LIKE :keyword ESCAPE '\'
            OR clientUser.mobile LIKE :keyword ESCAPE '\'
            OR clientUser.email LIKE :keyword ESCAPE '\'
            OR clientUser.departmentName LIKE :keyword ESCAPE '\'
            OR clientUser.staffNo LIKE :keyword ESCAPE '\'
          )`,
        )
        .getQuery()
      const itemKeywordSubQuery = this.preorderRepo
        .createQueryBuilder('order_keyword_item')
        .subQuery()
        .select('1')
        .from(O2oPreorderItem, 'item')
        .leftJoin(BaseProduct, 'product', 'product.id = item.productId')
        .where('item.orderId = order.id')
        .andWhere(String.raw`(product.productName LIKE :keyword ESCAPE '\' OR product.productCode LIKE :keyword ESCAPE '\')`)
        .getQuery()
      queryBuilder.andWhere(
        new Brackets((keywordQb) => {
          keywordQb
            .where(String.raw`order.showNo LIKE :keyword ESCAPE '\'`, { keyword })
            .orWhere(String.raw`order.verifyCode LIKE :keyword ESCAPE '\'`, { keyword })
            .orWhere(String.raw`order.remark LIKE :keyword ESCAPE '\'`, { keyword })
            .orWhere(String.raw`order.verifiedBy LIKE :keyword ESCAPE '\'`, { keyword })
            .orWhere(String.raw`order.departmentNameSnapshot LIKE :keyword ESCAPE '\'`, { keyword })
            .orWhere(String.raw`order.staffNoSnapshot LIKE :keyword ESCAPE '\'`, { keyword })
            .orWhere(`EXISTS ${clientKeywordSubQuery}`, { keyword })
            .orWhere(`EXISTS ${itemKeywordSubQuery}`, { keyword })
        }),
      )
    }

    const rows = await queryBuilder.getMany()
    const nowMs = Date.now()
    return this.buildOrderSummaryViews(rows, { nowMs })
  }

  async detailById(id: string) {
    const order = await this.preorderRepo.findOne({ where: { id, isDeleted: false } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    return this.buildOrderDetail(order)
  }

  async updateBusinessStatus(input: UpdateOrderBusinessStatusInput) {
    const order = await this.preorderRepo.findOne({ where: { id: input.orderId, isDeleted: false } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    order.businessStatus = this.normalizeBusinessStatus(input.businessStatus)
    await this.preorderRepo.save(order)
    return this.detailById(order.id)
  }

  async updateMerchantMessage(input: UpdateOrderMerchantMessageInput) {
    const order = await this.preorderRepo.findOne({ where: { id: input.orderId, isDeleted: false } })
    if (!order) {
      throw new BizError('预订单不存在', 404)
    }
    order.merchantMessage = this.normalizeMerchantMessage(input.merchantMessage)
    await this.preorderRepo.save(order)
    return this.detailById(order.id)
  }

  async markCustomerOrderPrintedByClient(auth: ClientAuthContext, orderId: string) {
    await this.cancelTimeoutOrders()
    return AppDataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(O2oPreorder)
      const order = await orderRepo.findOne({
        where: { id: orderId, clientUserId: auth.userId, isDeleted: false },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('预订单不存在', 404)
      }
      if (order.clientOrderType !== 'department') {
        throw new BizError('散客单不适用出库单打印状态', 409)
      }
      if (!order.hasCustomerOrder) {
        order.hasCustomerOrder = true
        await orderRepo.save(order)
      }
      await this.syncOutboundOrderComplianceFlags(manager, String(order.id), { hasCustomerOrder: true })
      return this.buildOrderDetail(order)
    })
  }

  async updateComplianceFlagsByAdmin(input: UpdateOrderComplianceFlagsInput) {
    if (typeof input.hasCustomerOrder !== 'boolean' && typeof input.isSystemApplied !== 'boolean') {
      throw new BizError('请至少传入一个可更新字段', 400)
    }
    return AppDataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(O2oPreorder)
      const order = await orderRepo.findOne({
        where: { id: input.orderId, isDeleted: false },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('预订单不存在', 404)
      }
      if (order.clientOrderType !== 'department') {
        throw new BizError('散客单不适用该状态编辑', 409)
      }
      if (typeof input.hasCustomerOrder === 'boolean') {
        order.hasCustomerOrder = input.hasCustomerOrder
      }
      if (typeof input.isSystemApplied === 'boolean') {
        order.isSystemApplied = input.isSystemApplied
      }
      await orderRepo.save(order)
      await this.syncOutboundOrderComplianceFlags(manager, String(order.id), {
        hasCustomerOrder: input.hasCustomerOrder,
        isSystemApplied: input.isSystemApplied,
      })
      return this.buildOrderDetail(order)
    })
  }

  async deleteConsoleOrder(
    input: DeleteConsolePreorderInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ): Promise<DeletedConsolePreorderView> {
    const normalizedConfirmShowNo = input.confirmShowNo.trim()
    if (!normalizedConfirmShowNo) {
      throw new BizError('请填写订单号完成二次确认', 400)
    }

    return AppDataSource.transaction(async (manager) => {
      const preorderRepo = manager.getRepository(O2oPreorder)
      const preorderItemRepo = manager.getRepository(O2oPreorderItem)
      const returnRequestRepo = manager.getRepository(O2oReturnRequest)
      const returnRequestItemRepo = manager.getRepository(O2oReturnRequestItem)
      const outboundOrderRepo = manager.getRepository(BizOutboundOrder)
      const outboundOrderItemRepo = manager.getRepository(BizOutboundOrderItem)
      const order = await preorderRepo.findOne({
        where: { id: input.orderId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('订单池订单不存在', 404)
      }
      if (order.showNo !== normalizedConfirmShowNo) {
        throw new BizError('二次确认失败：订单号不匹配', 400)
      }

      const linkedOutboundOrder = await this.loadLinkedOutboundOrderInManager(manager, String(order.id))
      const returnRequests = await returnRequestRepo.find({
        where: { orderId: String(order.id) },
      })
      const returnRequestIds = returnRequests.map((item) => String(item.id))
      const releasedPreorderedQty = await this.releasePendingPreorderStockForDeleteInManager(manager, order, actor)
      const affectedOrderTypes = new Set<string>([order.clientOrderType])
      if (linkedOutboundOrder) {
        affectedOrderTypes.add(linkedOutboundOrder.orderType)
      }

      if (linkedOutboundOrder) {
        await outboundOrderItemRepo.delete({ orderId: String(linkedOutboundOrder.id) })
        const deleteOutboundResult = await outboundOrderRepo.delete({ id: String(linkedOutboundOrder.id) })
        if ((deleteOutboundResult.affected ?? 0) <= 0) {
          throw new BizError('关联出库单删除失败，请稍后重试', 500)
        }
      }

      if (returnRequestIds.length) {
        await returnRequestItemRepo.delete({ returnRequestId: In(returnRequestIds) })
        await returnRequestRepo.delete({ id: In(returnRequestIds) })
      }
      await preorderItemRepo.delete({ orderId: String(order.id) })
      const deletePreorderResult = await preorderRepo.delete({ id: String(order.id) })
      if ((deletePreorderResult.affected ?? 0) <= 0) {
        throw new BizError('订单池订单删除失败，请稍后重试', 500)
      }

      const serialCalibrations: OrderSerialRecalibrationResult[] = []
      for (const orderType of affectedOrderTypes) {
        serialCalibrations.push(await orderSerialService.recalibrateCurrentFromOccupancy(orderType, manager))
      }
      const serialCalibrationMap = new Map(serialCalibrations.map((item) => [item.orderType, item]))
      const preorderSerialCalibration = serialCalibrationMap.get(order.clientOrderType)
      const outboundSerialCalibration = linkedOutboundOrder
        ? serialCalibrationMap.get(linkedOutboundOrder.orderType as OrderSerialRecalibrationResult['orderType'])
        : undefined
      const preorderSerialRolledBack = Boolean(preorderSerialCalibration?.rolledBack)
      const outboundSerialRolledBack = Boolean(outboundSerialCalibration?.rolledBack)

      await auditService.record(
        {
          actionType: 'o2o.preorder.delete',
          actionLabel: '删除订单池订单',
          targetType: 'o2o_order',
          targetId: String(order.id),
          targetCode: order.showNo,
          actor,
          requestMeta,
          detail: {
            status: order.status,
            clientOrderType: order.clientOrderType,
            releasedPreorderedQty,
            returnRequestCount: returnRequests.length,
            outboundOrderId: linkedOutboundOrder ? String(linkedOutboundOrder.id) : null,
            outboundOrderShowNo: linkedOutboundOrder?.showNo ?? null,
            outboundOrderDeleted: Boolean(linkedOutboundOrder),
            outboundSerialRolledBack,
            preorderSerialRolledBack,
            serialCalibrations,
          },
        },
        manager,
      )

      return {
        id: String(order.id),
        showNo: order.showNo,
        status: order.status,
        clientOrderType: order.clientOrderType,
        releasedPreorderedQty,
        returnRequestCount: returnRequests.length,
        outboundOrderShowNo: linkedOutboundOrder?.showNo ?? null,
        outboundOrderDeleted: Boolean(linkedOutboundOrder),
        preorderSerialRolledBack,
        outboundSerialRolledBack,
      }
    })
  }

  async cancelMyOrder(auth: ClientAuthContext, id: string) {
    await this.cancelTimeoutOrders()
    await AppDataSource.transaction(async (manager) => {
      const order = await manager.getRepository(O2oPreorder).findOne({
        where: { id, isDeleted: false },
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
    const orderItemMap = new Map(orderItems.map((item) => [this.buildPreorderItemKey(item), item]))
    const productIds = [...new Set(requestItems.map((item) => String(item.productId)))]
    const products = await manager.getRepository(BaseProduct).find({
      where: { id: In(productIds) },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
    })
    const productMap = new Map(products.map((item) => [String(item.id), item]))
    const skuIds = [...new Set(requestItems.map((item) => item.skuId ? String(item.skuId) : '').filter(Boolean))]
    const skus = skuIds.length
      ? await manager.getRepository(BaseProductSku).find({
          where: { id: In(skuIds) },
          lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
        })
      : []
    const skuMap = new Map(skus.map((item) => [String(item.id), item]))
    return { requestItems, orderItemMap, productMap, skuMap }
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
    skuMap: Map<string, BaseProductSku>,
  ) {
    const product = productMap.get(String(requestItem.productId))
    const itemKey = this.buildOrderItemKey(String(requestItem.productId), requestItem.skuId ? String(requestItem.skuId) : null)
    const orderItem = orderItemMap.get(itemKey)
    const sku = requestItem.skuId ? skuMap.get(String(requestItem.skuId)) : null
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
      if (sku) {
        sku.preOrderedStock = Math.max(0, Number(sku.preOrderedStock ?? 0) - requestQty)
        await manager.getRepository(BaseProductSku).save(sku)
      }
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
      if (sku) {
        sku.currentStock = Math.max(0, Number(sku.currentStock ?? 0)) + requestQty
        await manager.getRepository(BaseProductSku).save(sku)
      }
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
      if (returnRequest.status === 'rejected') {
        throw new BizError('退货申请已拒绝，不可继续回库核销', 409)
      }
      throw new BizError('当前退货申请不可重复核销', 409)
    }
    const order = await manager.getRepository(O2oPreorder).findOne({
      where: { id: String(returnRequest.orderId), isDeleted: false },
      lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
    })
    if (!order) {
      throw new BizError('原预订单不存在，无法核销退货', 404)
    }
    await this.assertReturnRequestSourceOrderStatus(manager, returnRequest, order)

    const { requestItems, orderItemMap, productMap, skuMap } = await this.loadReturnVerificationContext(
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
        skuMap,
      )
    }

    order.totalQty = Math.max(0, Number(order.totalQty ?? 0) - Number(returnRequest.totalQty ?? 0))
    if (returnRequest.sourceOrderStatus === 'pending' && order.totalQty <= 0) {
      order.status = 'cancelled'
      order.cancelReason = 'manual'
    }
    await this.markOrderAfterSaleStageInManager(manager, order, String(returnRequest.id))

    returnRequest.status = 'verified'
    returnRequest.handledAt = new Date()
    returnRequest.handledBy = actor.displayName
    returnRequest.verifiedAt = new Date()
    returnRequest.verifiedBy = actor.displayName
    returnRequest.rejectedReason = null
    const savedReturnRequest = await manager.getRepository(O2oReturnRequest).save(returnRequest)
    return {
      operationType: 'return_verify',
      verifyTargetType: 'return_request',
      detail: await this.buildReturnRequestDetail(savedReturnRequest),
    }
  }

  async rejectReturnRequest(input: RejectReturnRequestInput, actor: AuthUserContext) {
    const normalizedRejectReason = this.normalizeReturnRejectReason(input.rejectReason)
    return AppDataSource.transaction(async (manager) => {
      const returnRequestRepo = manager.getRepository(O2oReturnRequest)
      const orderRepo = manager.getRepository(O2oPreorder)
      const returnRequest = await returnRequestRepo.findOne({
        where: { id: input.returnRequestId },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!returnRequest) {
        throw new BizError('退货申请不存在', 404)
      }
      if (returnRequest.status === 'verified') {
        throw new BizError('退货申请已核销，不可再拒绝', 409)
      }
      if (returnRequest.status === 'rejected') {
        throw new BizError('退货申请已拒绝，请勿重复操作', 409)
      }
      if (returnRequest.status !== 'pending') {
        throw new BizError('当前退货申请不可拒绝', 409)
      }

      const order = await orderRepo.findOne({
        where: { id: String(returnRequest.orderId), isDeleted: false },
        lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
      })
      if (!order) {
        throw new BizError('原预订单不存在，无法拒绝退货申请', 404)
      }

      returnRequest.status = 'rejected'
      returnRequest.handledAt = new Date()
      returnRequest.handledBy = actor.displayName
      returnRequest.rejectedReason = normalizedRejectReason
      await this.markOrderAfterSaleStageInManager(manager, order, String(returnRequest.id))
      const savedReturnRequest = await returnRequestRepo.save(returnRequest)
      return this.buildReturnRequestDetail(savedReturnRequest)
    })
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
    const skuIds = [...new Set(items.map((item) => item.skuId ? String(item.skuId) : '').filter(Boolean))]
    const skus = skuIds.length
      ? await manager.getRepository(BaseProductSku).find({
          where: { id: In(skuIds) },
          lock: manager.connection.options.type === 'sqlite' ? undefined : { mode: 'pessimistic_write' },
        })
      : []
    const skuMap = new Map(skus.map((item) => [String(item.id), item]))
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
      const sku = row.skuId ? skuMap.get(String(row.skuId)) : null
      if (sku) {
        const beforeSkuCurrentStock = Number(sku.currentStock ?? 0)
        const beforeSkuPreOrderedStock = Number(sku.preOrderedStock ?? 0)
        if (beforeSkuCurrentStock < verifyQty || beforeSkuPreOrderedStock < verifyQty) {
          throw new BizError(`规格「${sku.specText}」库存异常，请先补货后再核销`, 409)
        }
        sku.currentStock = beforeSkuCurrentStock - verifyQty
        sku.preOrderedStock = beforeSkuPreOrderedStock - verifyQty
        await manager.getRepository(BaseProductSku).save(sku)
      }
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
    await this.createOutboundOrderFromVerifiedPreorder(manager, {
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
        where: { verifyCode: normalizedVerifyCode, isDeleted: false },
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

  startTimeoutRecycleLoop() {
    if (this.timeoutRecycleLoopTimer !== null) {
      return
    }
    this.timeoutRecycleLoopTimer = globalThis.setInterval(() => {
      void this.cancelTimeoutOrders({ skipRecentMs: O2O_TIMEOUT_RECYCLE_RECENT_WINDOW_MS }).catch(() => undefined)
    }, O2O_TIMEOUT_BACKGROUND_RECYCLE_INTERVAL_MS)
  }

  async cancelTimeoutOrders(options?: { skipRecentMs?: number }) {
    const config = await systemConfigService.getO2oRuleConfigs()
    if (!config.autoCancelEnabled) {
      this.lastCancelTimeoutOrdersAt = Date.now()
      this.lastCancelTimeoutOrdersResult = { cancelledCount: 0 }
      return this.lastCancelTimeoutOrdersResult
    }
    const normalizedSkipRecentMs = Math.max(0, Number(options?.skipRecentMs ?? 0))
    const nowMs = Date.now()
    if (this.cancelTimeoutOrdersInFlight !== null) {
      return this.cancelTimeoutOrdersInFlight
    }
    if (
      normalizedSkipRecentMs > 0 &&
      nowMs - this.lastCancelTimeoutOrdersAt < normalizedSkipRecentMs
    ) {
      return this.lastCancelTimeoutOrdersResult
    }

    const recyclePromise = (async () => {
      let cancelledCount = 0
      // 分批循环回收，避免单次只处理 100 条导致仍有超时订单残留。
      // 这样即使门店长时间未触发查询，也能在下一次入口访问时尽量回收完整。
      while (true) {
        const timeoutOrders = await this.preorderRepo.find({
          where: {
            status: 'pending',
            isDeleted: false,
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
    })()

    this.cancelTimeoutOrdersInFlight = recyclePromise
    try {
      const result = await recyclePromise
      this.lastCancelTimeoutOrdersAt = Date.now()
      this.lastCancelTimeoutOrdersResult = result
      return result
    } finally {
      if (this.cancelTimeoutOrdersInFlight === recyclePromise) {
        this.cancelTimeoutOrdersInFlight = null
      }
    }
  }

  async getVerifyDetail(verifyCode: string) {
    const normalizedVerifyCode = this.normalizeVerifyCode(verifyCode)
    const returnRequest = await this.returnRequestRepo.findOne({ where: { verifyCode: normalizedVerifyCode } })
    if (returnRequest) {
      return {
        verifyTargetType: 'return_request',
        detail: await this.buildReturnRequestDetail(returnRequest),
      } satisfies O2oVerifyDetailView
    }
    const order = await this.preorderRepo.findOne({ where: { verifyCode: normalizedVerifyCode, isDeleted: false } })
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
    const returnRequest = await this.returnRequestRepo.findOne({ where: { returnNo: normalizedShowNo } })
    if (returnRequest) {
      return {
        verifyTargetType: 'return_request',
        detail: await this.buildReturnRequestDetail(returnRequest),
      } satisfies O2oVerifyDetailView
    }
    const order = await this.preorderRepo.findOne({ where: { showNo: normalizedShowNo, isDeleted: false } })
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
    return rows.map((item) => this.buildInventoryLogView(item))
  }

  async listInventoryLogsPage(query: { page?: number; pageSize?: number }): Promise<PaginationResult<InventoryLogView>> {
    const page = Math.max(1, Math.floor(Number(query.page || 1)))
    const pageSize = Math.min(50, Math.max(10, Math.floor(Number(query.pageSize || 10))))
    const [rows, total] = await this.inventoryLogRepo.findAndCount({
      order: { id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      relations: { product: true },
    })
    return {
      page,
      pageSize,
      total,
      list: rows.map((item) => this.buildInventoryLogView(item)),
    }
  }

  private buildInventoryLogView(item: InventoryLog): InventoryLogView {
    return {
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
    }
  }
}

export const o2oPreorderService = new O2oPreorderService()
