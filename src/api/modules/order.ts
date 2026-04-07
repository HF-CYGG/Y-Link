import { request, type RequestConfig } from '@/api/http'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

/**
 * 提交明细行：
 * - productId 对应产品主键；
 * - qty、unitPrice 以 number 传递，后端统一做 decimal 落库与金额计算。
 */
export interface SubmitOrderItemPayload {
  productId: string | number
  qty: number
  unitPrice: number
  remark?: string
}

/**
 * 出库整单提交参数：
 * - idempotencyKey 为防重关键字段，重复请求可返回同一单据；
 * - customerName、remark 为主单补充信息。
 */
export interface SubmitOrderPayload {
  idempotencyKey: string
  orderType?: 'department' | 'walkin'
  hasCustomerOrder?: boolean
  isSystemApplied?: boolean
  issuerName?: string
  customerDepartmentName?: string
  customerName?: string
  remark?: string
  items: SubmitOrderItemPayload[]
}

/**
 * 出库主单（精简返回）：
 * - 仅声明开单页成功提示所需的 showNo；
 * - 如后续详情页需要更多字段可在此扩展。
 */
export interface SubmittedOrderRecord {
  id: string
  showNo: string
}

/**
 * 提交结果：
 * - 返回主单与明细，开单页当前仅使用 order.showNo 做反馈；
 * - 保留 items 结构以便后续扩展提交成功回显。
 */
export interface SubmitOrderResult {
  order: SubmittedOrderRecord
  items: SubmitOrderItemPayload[]
}

/**
 * 提交出库单：
 * - 对接后端 /orders/submit 事务接口；
 * - 由调用方控制 loading 与重复点击防护。
 */
export const submitOrder = async (payload: SubmitOrderPayload): Promise<SubmitOrderResult> => {
  const result = await request<{
    order: {
      id: PrimitiveTextValue
      showNo: PrimitiveTextValue
    }
    items: Array<{
      productId: PrimitiveTextValue
      qty: PrimitiveTextValue
      unitPrice: PrimitiveTextValue
      remark?: PrimitiveTextValue
    }>
  }>({
    method: 'POST',
    url: '/orders/submit',
    data: payload,
  })

  return {
    order: {
      id: normalizeTextField(result.order.id),
      showNo: normalizeTextField(result.order.showNo),
    },
    items: result.items.map((item) => ({
      productId: normalizeTextField(item.productId),
      qty: Number(normalizeDecimalField(item.qty)),
      unitPrice: Number(normalizeDecimalField(item.unitPrice)),
      remark: normalizeTextField(item.remark) || undefined,
    })),
  }
}

export interface OrderListQuery extends PaginationQueryInput {
  showNo?: string
  startDate?: string
  endDate?: string
  includeDeleted?: boolean
  onlyDeleted?: boolean
}

/**
 * 出库单列表记录：
 * - 补齐开单账号与开单姓名快照，用于责任追溯；
 * - status 兼容后端原有字段，当前主要用于预留展示。
 */
export interface OrderRecord {
  id: string
  showNo: string
  orderType: 'department' | 'walkin'
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  issuerName: string | null
  customerDepartmentName: string | null
  customerName: string | null
  totalAmount: string
  totalQty: string
  status?: string | null
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

interface OrderListRawResult {
  page: number
  pageSize: number
  total: number
  list: OrderRecordRaw[]
}

export type OrderListResult = PaginationResult<OrderRecord>

interface OrderRecordRaw {
  id: PrimitiveTextValue
  showNo: PrimitiveTextValue
  orderType?: PrimitiveTextValue
  hasCustomerOrder?: boolean | PrimitiveTextValue
  isSystemApplied?: boolean | PrimitiveTextValue
  issuerName?: PrimitiveTextValue
  customerDepartmentName?: PrimitiveTextValue
  customerName: PrimitiveTextValue
  totalAmount: PrimitiveTextValue
  totalQty: PrimitiveTextValue
  status?: PrimitiveTextValue
  remark: PrimitiveTextValue
  creatorUserId: PrimitiveTextValue
  creatorUsername: PrimitiveTextValue
  creatorDisplayName: PrimitiveTextValue
  isDeleted?: boolean | PrimitiveTextValue
  deletedAt?: PrimitiveTextValue
  deletedByUserId?: PrimitiveTextValue
  deletedByUsername?: PrimitiveTextValue
  deletedByDisplayName?: PrimitiveTextValue
  createdAt: PrimitiveTextValue
}

/**
 * 获取出库单分页列表：
 * - 后端返回 list，这里归一化为 records；
 * - 页面层因此无需关心接口字段差异。
 */
export const getOrderList = async (params: OrderListQuery, requestConfig: RequestConfig = {}): Promise<OrderListResult> => {
  const result = await request<OrderListRawResult>({
    ...requestConfig,
    method: 'GET',
    url: '/orders',
    params,
  })

  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    records: result.list.map(normalizeOrderRecord),
  }
}

export interface OrderItemRecord {
  id: string
  productId: string
  productCode: string
  productName: string
  qty: string
  unitPrice: string
  subTotal: string
  remark: string | null
}

export interface OrderDetailResult extends OrderRecord {
  items: OrderItemRecord[]
}

type PrimitiveTextValue = string | number | null | undefined

const normalizeNullableTextField = (value: PrimitiveTextValue): string | null => {
  return normalizeTextField(value) || null
}

const normalizeOrderRecord = (record: OrderRecordRaw): OrderRecord => ({
  id: normalizeTextField(record.id),
  showNo: normalizeTextField(record.showNo),
  orderType: normalizeOrderTypeField(record.orderType),
  hasCustomerOrder: normalizeBooleanField(record.hasCustomerOrder),
  isSystemApplied: normalizeBooleanField(record.isSystemApplied),
  issuerName: normalizeNullableTextField(record.issuerName),
  customerDepartmentName: normalizeNullableTextField(record.customerDepartmentName),
  customerName: normalizeNullableTextField(record.customerName),
  totalAmount: normalizeDecimalField(record.totalAmount),
  totalQty: normalizeDecimalField(record.totalQty),
  status: normalizeNullableTextField(record.status),
  remark: normalizeNullableTextField(record.remark),
  creatorUserId: normalizeNullableTextField(record.creatorUserId),
  creatorUsername: normalizeNullableTextField(record.creatorUsername),
  creatorDisplayName: normalizeNullableTextField(record.creatorDisplayName),
  isDeleted: normalizeBooleanField(record.isDeleted),
  deletedAt: normalizeNullableTextField(record.deletedAt),
  deletedByUserId: normalizeNullableTextField(record.deletedByUserId),
  deletedByUsername: normalizeNullableTextField(record.deletedByUsername),
  deletedByDisplayName: normalizeNullableTextField(record.deletedByDisplayName),
  createdAt: normalizeTextField(record.createdAt),
})

/**
 * 订单详情明细原始结构：
 * - 兼容后端旧字段 productNameSnapshot / lineAmount；
 * - 兼容修复后的标准字段 productCode / productName / subTotal；
 * - 模块层统一归一化后，页面组件无需感知接口演进差异。
 */
interface OrderItemRawRecord {
  id: string
  productId: string
  productCode?: PrimitiveTextValue
  productName?: PrimitiveTextValue
  productNameSnapshot?: PrimitiveTextValue
  qty: PrimitiveTextValue
  unitPrice: PrimitiveTextValue
  subTotal?: PrimitiveTextValue
  lineAmount?: PrimitiveTextValue
  remark: PrimitiveTextValue
}

interface OrderDetailOrderRaw extends Omit<OrderRecord, 'totalAmount' | 'totalQty'> {
  totalAmount: PrimitiveTextValue
  totalQty: PrimitiveTextValue
}

interface OrderDetailRawResult {
  order: OrderDetailOrderRaw
  items: OrderItemRawRecord[]
}

/**
 * 文本字段归一化：
 * - 后端金额/名称字段在不同环境下可能返回 string 或 number；
 * - 统一先转成字符串再 trim，避免直接调用 trim 触发运行时异常；
 * - 空值时回退为传入默认值，保证组件收到稳定字段。
 */
const normalizeTextField = (value: PrimitiveTextValue, fallback = ''): string => {
  if (value === null || value === undefined) {
    return fallback
  }

  const normalizedValue = String(value).trim()
  return normalizedValue || fallback
}

/**
 * 数值文本归一化：
 * - 详情抽屉的数量、单价、小计在页面层按字符串协议消费；
 * - 这里统一输出格式化后的字符串，兼容 number/string 两类输入；
 * - 非法值回退默认金额，避免渲染 NaN 或再次触发类型错误。
 */
const normalizeDecimalField = (value: PrimitiveTextValue, fallback = '0.00'): string => {
  const normalizedText = normalizeTextField(value)
  if (!normalizedText) {
    return fallback
  }

  const normalizedNumber = Number(normalizedText)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : fallback
}

/**
 * 布尔字段归一化：
 * - 兼容 boolean / number / string 等多种返回值；
 * - 用于软删除状态等标记字段的稳定解析。
 */
const normalizeBooleanField = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  const normalizedText = normalizeTextField(value as PrimitiveTextValue).toLowerCase()
  return normalizedText === '1' || normalizedText === 'true' || normalizedText === 'yes'
}

const normalizeOrderTypeField = (value: PrimitiveTextValue): 'department' | 'walkin' => {
  return normalizeTextField(value).toLowerCase() === 'department' ? 'department' : 'walkin'
}

/**
 * 归一化订单明细：
 * - 优先读取后端已对齐的新字段；
 * - 对旧接口返回做兜底，避免历史环境或缓存响应导致详情抽屉继续异常；
 * - 当产品编码暂不可得时退化为 productId，至少保证界面可辨识。
 */
const normalizeOrderItem = (item: OrderItemRawRecord): OrderItemRecord => ({
  id: normalizeTextField(item.id),
  productId: normalizeTextField(item.productId),
  productCode: normalizeTextField(item.productCode, normalizeTextField(item.productId)),
  productName: normalizeTextField(item.productName, normalizeTextField(item.productNameSnapshot, '-')),
  qty: normalizeDecimalField(item.qty),
  unitPrice: normalizeDecimalField(item.unitPrice),
  subTotal: normalizeDecimalField(item.subTotal, normalizeDecimalField(item.lineAmount)),
  remark: normalizeTextField(item.remark) || null,
})

/**
 * 归一化详情响应：
 * - 后端返回 { order, items }；
 * - 前端详情组件更适合直接消费扁平主单结构，因此在模块层展开。
 */
const normalizeOrderDetail = (payload: OrderDetailRawResult): OrderDetailResult => ({
  ...normalizeOrderRecord(payload.order),
  items: payload.items.map(normalizeOrderItem),
})

/**
 * 根据主键获取出库单详情
 */
export const getOrderDetailById = async (id: string, requestConfig: RequestConfig = {}): Promise<OrderDetailResult> => {
  const result = await request<OrderDetailRawResult>({
    ...requestConfig,
    method: 'GET',
    url: `/orders/${id}`,
  })

  return normalizeOrderDetail(result)
}

/**
 * 根据业务单号获取出库单详情
 */
export const getOrderDetailByShowNo = async (
  showNo: string,
  requestConfig: RequestConfig = {},
): Promise<OrderDetailResult> => {
  const result = await request<OrderDetailRawResult>({
    ...requestConfig,
    method: 'GET',
    url: `/orders/show-no/${showNo}`,
  })

  return normalizeOrderDetail(result)
}

export interface DeleteOrderPayload {
  confirmShowNo: string
}

/**
 * 软删除出库单（管理员）：
 * - 服务端会校验业务单号完成二次确认；
 * - 删除后单据可通过 restore 接口找回。
 */
export const deleteOrderById = (id: string, payload: DeleteOrderPayload) =>
  request<OrderRecord>({
    method: 'DELETE',
    url: `/orders/${id}`,
    data: payload,
  }).then(normalizeOrderRecord)

/**
 * 恢复已删除出库单（管理员）：
 * - 恢复后该单据会重新进入默认列表；
 * - 明细与金额等历史信息保持不变。
 */
export const restoreOrderById = (id: string) =>
  request<OrderRecord>({
    method: 'POST',
    url: `/orders/${id}/restore`,
  }).then(normalizeOrderRecord)
