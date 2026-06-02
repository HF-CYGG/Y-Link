/**
 * 模块说明：src/utils/client-order-summary.ts
 * 文件职责：沉淀客户端订单摘要构建与本地筛选匹配逻辑，供订单列表、详情与缓存 Store 复用。
 * 实现逻辑：
 * - 统一把订单详情裁剪成列表摘要，避免列表页与详情页各自维护一套字段映射；
 * - 统一封装状态筛选与关键词匹配规则，让编辑成功后的局部回写能复用同一判断口径；
 * - 关键词仅覆盖客户端订单列表真实暴露的查询维度，保证本地局部同步与服务端接口含义一致。
 * 维护说明：
 * - 若订单列表查询条件新增字段，需要同时补齐 `matchesClientOrderKeyword()` 的匹配项；
 * - 若详情返回结构新增摘要字段，优先在 `buildClientOrderSummaryFromDetail()` 中统一补齐。
 */

import { resolveO2oDisplayShowNo, type O2oPreorderDetail, type O2oPreorderSummary } from '@/api/modules/o2o'

const CLIENT_ORDER_TYPE_KEYWORDS: Record<O2oPreorderSummary['clientOrderType'], string[]> = {
  department: ['部门订', '部门', 'department'],
  walkin: ['散客', 'walkin'],
}

export const buildClientOrderSummaryFromDetail = (detail: O2oPreorderDetail): O2oPreorderSummary => {
  const { order } = detail
  const latestReturnRequest = detail.returnRequests
    .slice()
    .sort((prev, next) => new Date(next.createdAt).getTime() - new Date(prev.createdAt).getTime())[0] ?? null

  return {
    id: order.id,
    showNo: resolveO2oDisplayShowNo(order),
    customerOrderShowNo: order.customerOrderShowNo ?? null,
    verifyCode: order.verifyCode,
    status: order.status,
    businessStatus: order.businessStatus,
    hasCustomerOrder: Boolean(order.hasCustomerOrder),
    isSystemApplied: order.isSystemApplied,
    merchantMessage: order.merchantMessage,
    clientOrderType: order.clientOrderType,
    departmentNameSnapshot: order.departmentNameSnapshot,
    staffNoSnapshot: order.staffNoSnapshot,
    returnRequestCount: detail.returnRequests.length,
    pendingReturnRequestCount: detail.returnRequests.filter((item) => item.status === 'pending').length,
    latestReturnRequest: latestReturnRequest
      ? {
          id: latestReturnRequest.id,
          returnNo: latestReturnRequest.returnNo,
          status: latestReturnRequest.status,
          createdAt: latestReturnRequest.createdAt,
          handledAt: latestReturnRequest.handledAt,
          rejectedReason: latestReturnRequest.rejectedReason,
        }
      : null,
    statusReport: order.statusReport,
    totalAmount: order.totalAmount,
    expireInSeconds: order.expireInSeconds,
    totalQty: order.totalQty,
    timeoutAt: order.timeoutAt,
    createdAt: order.createdAt,
  }
}

export const matchesClientOrderStatus = (
  order: O2oPreorderSummary,
  activeStatus: 'all' | O2oPreorderSummary['status'],
) => {
  return activeStatus === 'all' || order.status === activeStatus
}

export const matchesClientOrderKeyword = (order: O2oPreorderSummary, keyword: string) => {
  const normalizedKeyword = keyword.trim().toLowerCase()
  if (!normalizedKeyword) {
    return true
  }

  const normalizedTargets = [
    order.showNo,
    order.customerOrderShowNo || '',
    order.verifyCode,
    order.departmentNameSnapshot || '',
    order.staffNoSnapshot || '',
    ...CLIENT_ORDER_TYPE_KEYWORDS[order.clientOrderType],
  ]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)

  return normalizedTargets.some((item) => item.includes(normalizedKeyword))
}

export const matchesClientOrderQuery = (
  order: O2oPreorderSummary,
  query: {
    activeStatus: 'all' | O2oPreorderSummary['status']
    keyword: string
  },
) => {
  return matchesClientOrderStatus(order, query.activeStatus) && matchesClientOrderKeyword(order, query.keyword)
}
