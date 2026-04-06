import { request, type RequestConfig } from '@/api/http'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

/**
 * 提交明细行：
 * - productId 对应产品主键；
 * - qty、unitPrice 以 number 传递，后端统一做 decimal 落库与金额计算。
 */
export interface SubmitOrderItemPayload {
  productId: string
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
      id: string
      showNo: string
    }
    items: SubmitOrderItemPayload[]
  }>({
    method: 'POST',
    url: '/orders/submit',
    data: payload,
  })

  return {
    order: {
      id: result.order.id,
      showNo: result.order.showNo,
    },
    items: result.items,
  }
}

export interface OrderListQuery extends PaginationQueryInput {
  showNo?: string
  startDate?: string
  endDate?: string
}

/**
 * 出库单列表记录：
 * - 补齐开单账号与开单姓名快照，用于责任追溯；
 * - status 兼容后端原有字段，当前主要用于预留展示。
 */
export interface OrderRecord {
  id: string
  showNo: string
  customerName: string | null
  totalAmount: string
  totalQty: string
  status?: string | null
  remark: string | null
  creatorUserId: string | null
  creatorUsername: string | null
  creatorDisplayName: string | null
  createdAt: string
}

interface OrderListRawResult {
  page: number
  pageSize: number
  total: number
  list: OrderRecord[]
}

export type OrderListResult = PaginationResult<OrderRecord>

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
    records: result.list,
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
 * 归一化订单明细：
 * - 优先读取后端已对齐的新字段；
 * - 对旧接口返回做兜底，避免历史环境或缓存响应导致详情抽屉继续异常；
 * - 当产品编码暂不可得时退化为 productId，至少保证界面可辨识。
 */
const normalizeOrderItem = (item: OrderItemRawRecord): OrderItemRecord => ({
  id: item.id,
  productId: item.productId,
  productCode: normalizeTextField(item.productCode, item.productId),
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
  ...payload.order,
  totalAmount: normalizeDecimalField(payload.order.totalAmount),
  totalQty: normalizeDecimalField(payload.order.totalQty),
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
