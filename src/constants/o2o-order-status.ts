export const O2O_ORDER_STATUSES = ['pending', 'verified', 'cancelled'] as const
export const O2O_ORDER_TIMEOUT_SOON_WINDOW_MS = 2 * 60 * 60 * 1000

export type O2oOrderStatus = (typeof O2O_ORDER_STATUSES)[number]
export type ClientOrderReportScenario = 'pending' | 'timeout_soon' | 'cancelled' | 'timeout_cancelled' | 'verified'
export type O2oOrderCancelReason = 'timeout' | 'manual'

export interface ClientOrderStatusReportLike {
  scenario?: ClientOrderReportScenario
  cancelReason?: O2oOrderCancelReason | null
}

export const CLIENT_O2O_ORDER_STATUS_LABEL_MAP: Record<O2oOrderStatus, string> = {
  pending: '待取货',
  verified: '已核销',
  cancelled: '已取消',
}

export const VERIFY_CONSOLE_O2O_ORDER_STATUS_LABEL_MAP: Record<O2oOrderStatus, string> = {
  pending: '待核销',
  verified: '已核销',
  cancelled: '已取消',
}

export const CLIENT_O2O_ORDER_STATUS_CLASS_MAP: Record<O2oOrderStatus, string> = {
  pending: 'bg-amber-50 text-amber-600',
  verified: 'bg-emerald-50 text-emerald-600',
  cancelled: 'bg-slate-100 text-slate-500',
}

export const VERIFY_CONSOLE_O2O_ORDER_STATUS_CLASS_MAP: Record<O2oOrderStatus, string> = {
  pending: 'status-chip--pending',
  verified: 'status-chip--verified',
  cancelled: 'status-chip--cancelled',
}

export const O2O_ORDER_STATUS_TABS: Array<{ key: 'all' | O2oOrderStatus; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待提货' },
  { key: 'verified', label: '已核销' },
  { key: 'cancelled', label: '已取消' },
]

export const isO2oOrderStatus = (status: unknown): status is O2oOrderStatus => {
  return typeof status === 'string' && O2O_ORDER_STATUSES.includes(status as O2oOrderStatus)
}

export const isO2oOrderPending = (status: O2oOrderStatus | null | undefined): status is 'pending' => {
  return status === 'pending'
}

export const isO2oOrderVerified = (status: O2oOrderStatus | null | undefined): status is 'verified' => {
  return status === 'verified'
}

export const isO2oOrderCancelled = (status: O2oOrderStatus | null | undefined): status is 'cancelled' => {
  return status === 'cancelled'
}

export const isO2oOrderTimeoutReached = (timeoutAt: string | null | undefined, nowMs = Date.now()) => {
  return Boolean(timeoutAt && new Date(timeoutAt).getTime() <= nowMs)
}

export const isO2oOrderTimeoutCancelled = (
  status: O2oOrderStatus | null | undefined,
  timeoutAt: string | null | undefined,
  nowMs = Date.now(),
) => {
  return isO2oOrderCancelled(status) && isO2oOrderTimeoutReached(timeoutAt, nowMs)
}

export const isO2oOrderTimeoutSoon = (
  status: O2oOrderStatus | null | undefined,
  timeoutAt: string | null | undefined,
  nowMs = Date.now(),
  soonWindowMs = O2O_ORDER_TIMEOUT_SOON_WINDOW_MS,
) => {
  if (!isO2oOrderPending(status) || !timeoutAt) {
    return false
  }
  const timeoutAtMs = new Date(timeoutAt).getTime()
  return timeoutAtMs > nowMs && timeoutAtMs - nowMs <= soonWindowMs
}

export const getClientOrderReportScenario = (
  status: O2oOrderStatus | null | undefined,
  timeoutAt: string | null | undefined,
  nowMs = Date.now(),
): ClientOrderReportScenario => {
  if (isO2oOrderVerified(status)) {
    return 'verified'
  }
  if (isO2oOrderTimeoutCancelled(status, timeoutAt, nowMs)) {
    return 'timeout_cancelled'
  }
  if (isO2oOrderCancelled(status)) {
    return 'cancelled'
  }
  if (isO2oOrderTimeoutSoon(status, timeoutAt, nowMs)) {
    return 'timeout_soon'
  }
  return 'pending'
}

export const CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG: Record<
  ClientOrderReportScenario,
  {
    statusLabel: string
    cardClassName: string
    cardTitle: string
    cardDescription: string
    timelineCurrentTitle: string
    timelineCurrentHint: string
  }
> = {
  pending: {
    statusLabel: '待取货',
    cardClassName: 'bg-amber-50 text-amber-700',
    cardTitle: '待到店核销',
    cardDescription: '请在有效时段内到店出示核销码完成领取。',
    timelineCurrentTitle: '待核销',
    timelineCurrentHint: '请按门店通知到店领取',
  },
  timeout_soon: {
    statusLabel: '临近超时',
    cardClassName: 'bg-orange-50 text-orange-700',
    cardTitle: '临近超时，请尽快核销',
    cardDescription: '当前订单距离超时不足 2 小时，请尽快到店完成核销。',
    timelineCurrentTitle: '待核销（临近超时）',
    timelineCurrentHint: '建议优先到店，避免自动取消',
  },
  cancelled: {
    statusLabel: '已取消',
    cardClassName: 'bg-slate-100 text-slate-600',
    cardTitle: '订单已取消',
    cardDescription: '订单已取消，如需领取请重新下单。',
    timelineCurrentTitle: '订单已取消',
    timelineCurrentHint: '订单已关闭',
  },
  timeout_cancelled: {
    statusLabel: '超时取消',
    cardClassName: 'bg-rose-50 text-rose-700',
    cardTitle: '订单已超时取消',
    cardDescription: '订单因超时未核销自动取消，库存已释放。',
    timelineCurrentTitle: '超时自动取消',
    timelineCurrentHint: '库存已自动释放',
  },
  verified: {
    statusLabel: '已核销',
    cardClassName: 'bg-emerald-50 text-emerald-700',
    cardTitle: '订单已核销完成',
    cardDescription: '核销已完成，可在订单记录中查看本次领取详情。',
    timelineCurrentTitle: '已核销',
    timelineCurrentHint: '订单已完成',
  },
}

/**
 * 客户端状态展示文案解析：
 * - 默认沿用场景配置表，保持列表页、详情页、状态卡片展示一致；
 * - 当后端明确返回 manual 时，客户端统一展示“已撤回”，避免与系统超时取消混淆；
 * - 超时取消仍走 timeout_cancelled，保持风险提示更明确。
 */
export const getClientOrderStatusReportConfig = (
  input: {
    statusReport?: ClientOrderStatusReportLike | null
    status: O2oOrderStatus | null | undefined
    timeoutAt: string | null | undefined
  },
  nowMs = Date.now(),
) => {
  const scenario = input.statusReport?.scenario ?? getClientOrderReportScenario(input.status, input.timeoutAt, nowMs)
  const baseConfig = CLIENT_O2O_ORDER_STATUS_REPORT_CONFIG[scenario]
  if (scenario === 'cancelled' && input.statusReport?.cancelReason === 'manual') {
    return {
      ...baseConfig,
      statusLabel: '已撤回',
      cardTitle: '订单已撤回',
      cardDescription: '订单已由你主动撤回，预订库存已释放。',
      timelineCurrentTitle: '订单已撤回',
      timelineCurrentHint: '订单已关闭',
    }
  }
  return baseConfig
}
