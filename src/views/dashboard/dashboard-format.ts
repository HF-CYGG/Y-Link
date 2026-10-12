/**
 * 模块说明：src/views/dashboard/dashboard-format.ts
 * 文件职责：工作台看板各卡片、抽屉共用的金额、数量与订单类型展示格式。
 * 实现逻辑：
 * - 看板金额与业务数量（允许小数）统一保留两位小数，空值或非法值兜底为 0.00，防止接口波动导致空白；
 * - 原先 7 个看板文件各自复制同一实现，收拢后排行榜、趋势、饼图与下钻抽屉口径天然一致。
 * 维护说明：
 * - 若要调整看板展示精度，只改这里；出库凭证、送货单等打印模板有独立的格式规则，不要复用本文件。
 */

type DashboardNumericValue = string | number | null | undefined

const formatTwoDecimals = (value: DashboardNumericValue): string => {
  const normalizedNumber = Number(value ?? 0)
  return Number.isFinite(normalizedNumber) ? normalizedNumber.toFixed(2) : '0.00'
}

/** 看板金额：两位小数，兜底 0.00。 */
export const formatAmount = formatTwoDecimals

/** 看板数量：业务数量允许小数，与金额同样保留两位。 */
export const formatQty = formatTwoDecimals

/** 下钻明细的订单类型文案。 */
export const formatOrderType = (value: 'department' | 'walkin'): string => {
  return value === 'department' ? '部门单' : '散客单'
}
