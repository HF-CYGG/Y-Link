/**
 * 模块说明：src/views/o2o/o2o-verify-console.helpers.ts
 * 文件职责：沉淀 O2O 核销台的纯函数、类型守卫与现场改单数据转换规则，减少页面脚本对业务细节的直接堆叠。
 * 实现逻辑：
 * - 把核销码归一化、单据类型守卫、业务单号识别等“纯规则”从页面脚本中剥离；
 * - 把现场改单项构造与库存上限计算抽成独立函数，便于后续继续拆子组件时复用；
 * - 所有导出函数都保持无副作用，页面层只负责状态编排与交互反馈。
 * 维护说明：
 * - 若后端扩展新的核销目标类型，需同步补充本文件的类型守卫；
 * - 若现场改单的库存口径调整，优先先改这里，再让页面模板自然消费新结果。
 */
import type { ProductRecord } from '@/api/modules/product'
import type { O2oPreorderDetail, O2oReturnRequestDetail, O2oVerifyDetailResult } from '@/api/modules/o2o'

export const O2O_RETURN_REJECT_REASON_MAX_LENGTH = 500
export const O2O_PREORDER_REMARK_MAX_LENGTH = 255
export const ORDER_TYPE_LABEL_MAP = {
  department: '部门订',
  walkin: '散客',
} as const

export interface EditableOnsiteOrderItem {
  productId: string
  productCode: string
  productName: string
  defaultPrice: string
  qty: number
  originalQty: number
  maxQty: number
  unavailableReason: string | null
}

/**
 * 查询接口会返回联合结构，这里先做类型守卫，供模板分支和交互按钮复用同一份结果收窄。
 */
export const isPreorderDetail = (
  detail: O2oVerifyDetailResult['detail'] | null | undefined,
): detail is O2oPreorderDetail => {
  return Boolean(detail && 'order' in detail)
}

/**
 * 退货申请详情守卫：
 * - 与预订单详情互斥；
 * - 通过业务主键字段判断类型最稳定。
 */
export const isReturnRequestDetail = (
  detail: O2oVerifyDetailResult['detail'] | null | undefined,
): detail is O2oReturnRequestDetail => {
  return Boolean(detail && 'returnNo' in detail)
}

/**
 * 核销台兼容预订单号 `PO...` 与退货申请单号 `RO...` 两类单据编号。
 */
export const isBizShowNo = (value: string) => /^(PO|RO)\d{8}\d{4}$/i.test(value)

/**
 * 统一归一化核销码：
 * - 兼容直接复制的 UUID、带 query 的二维码 URL、路径形式二维码 URL；
 * - 兼容带空格分组的展示码，自动恢复为标准 UUID 格式。
 */
export const normalizeVerifyCode = (rawValue: string) => {
  const value = rawValue.trim()
  if (!value) {
    return ''
  }

  try {
    const parsedUrl = new URL(value)
    const fromQuery = parsedUrl.searchParams.get('verifyCode')
    if (fromQuery?.trim()) {
      return fromQuery.trim()
    }
    const matched = /\/verify\/([^/?#]+)/i.exec(parsedUrl.pathname)
    if (matched?.[1]) {
      return decodeURIComponent(matched[1]).trim()
    }
  } catch {
    // 非 URL 文本按纯核销码处理。
  }

  const compact = value.replaceAll(/[^a-zA-Z0-9]/g, '')
  if (/^[a-fA-F0-9]{32}$/.exec(compact)) {
    const hex = compact.toLowerCase()
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return value
}

/**
 * 计算现场改单时某商品允许填写的最大数量：
 * - 可售商品使用“可用库存 + 原有数量”；
 * - 历史缺失商品只允许回落到原有数量以内。
 */
export const resolveEditableItemMaxQty = (product: ProductRecord, originalQty = 0) => {
  return Math.max(0, Number(product.availableStock ?? 0) + originalQty)
}

/**
 * 把订单详情转换为现场改单表单项：
 * - 保留历史订单中已不在可售目录里的商品，避免旧单无法编辑；
 * - 对缺失商品只允许减少或删除，不允许继续增加。
 */
export const buildOnsiteEditableItemsFromDetail = (
  detail: O2oPreorderDetail,
  productCatalog: ProductRecord[],
) => {
  const productMap = new Map(productCatalog.map((item) => [item.id, item]))
  return detail.items.map((item) => {
    const product = productMap.get(item.productId)
    const maxQty = product ? resolveEditableItemMaxQty(product, item.qty) : item.qty
    const unavailableReason = product
      ? null
      : '当前商品已不在可售目录中，仅支持减少或删除原有数量'
    return {
      productId: item.productId,
      productCode: item.productCode,
      productName: item.productName,
      defaultPrice: item.defaultPrice,
      qty: item.qty,
      originalQty: item.qty,
      maxQty,
      unavailableReason,
    } satisfies EditableOnsiteOrderItem
  })
}
