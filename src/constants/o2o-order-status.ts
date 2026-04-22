/**
 * 模块说明：src/constants/o2o-order-status.ts
 * 文件职责：集中维护 O2O 订单状态枚举、展示文案和客户端状态报告推导规则。
 * 维护说明：
 * - 客户端列表、详情、核销台等页面都依赖这里的状态语义，修改时必须统一校验前后端口径；
 * - 若新增状态，需同步补全 type、label、class、report config 与判定函数，避免页面出现空文案。
 */

export const O2O_ORDER_STATUSES = ['pending', 'verified', 'cancelled'] as const
export const O2O_ORDER_BUSINESS_STATUSES = [
  'preparing',
  'ready',
  'awaiting_shipment',
  'shipped',
  'partially_shipped',
  'closed',
  'after_sale',
  'after_sale_done',
  'verifying',
  'verify_failed',
] as const
export const O2O_ORDER_TIMEOUT_SOON_WINDOW_MS = 2 * 60 * 60 * 1000

export type O2oOrderStatus = (typeof O2O_ORDER_STATUSES)[number]
export type O2oOrderBusinessStatus = (typeof O2O_ORDER_BUSINESS_STATUSES)[number]
export type ClientOrderReportScenario = 'pending' | 'timeout_soon' | 'cancelled' | 'timeout_cancelled' | 'verified'
export type O2oOrderCancelReason = 'timeout' | 'manual'

export interface ClientOrderStatusReportLike {
  scenario?: ClientOrderReportScenario
  cancelReason?: O2oOrderCancelReason | null
}

export const O2O_ORDER_BUSINESS_STATUS_META: Record<
  O2oOrderBusinessStatus,
  {
    label: string
    clientDescription: string
    consoleDescription: string
    className: string
  }
> = {
  preparing: {
    label: '备货中（已接单）',
    clientDescription: '门店已接单，正在备货，请耐心等待。',
    consoleDescription: '订单已接单，门店正在处理货品与备货。',
    className: 'bg-sky-50 text-sky-700',
  },
  ready: {
    label: '请取货（等待取货）',
    clientDescription: '货品已备妥，请尽快携带二维码到店核销取货。',
    consoleDescription: '货品已备妥，等待用户到店取货。',
    className: 'bg-cyan-50 text-cyan-700',
  },
  awaiting_shipment: {
    label: '待发货（等待接单）',
    clientDescription: '订单已提交，等待门店接单处理。',
    consoleDescription: '订单已提交，等待门店确认接单。',
    className: 'bg-blue-50 text-blue-700',
  },
  shipped: {
    label: '已发货',
    clientDescription: '订单已发货，请留意收货或到店通知。',
    consoleDescription: '订单已完成发货处理。',
    className: 'bg-indigo-50 text-indigo-700',
  },
  partially_shipped: {
    label: '部分发货',
    clientDescription: '订单部分商品已发出，其余商品待继续处理。',
    consoleDescription: '订单存在部分发货，需继续跟进剩余商品。',
    className: 'bg-violet-50 text-violet-700',
  },
  closed: {
    label: '已关闭',
    clientDescription: '商家已关闭该订单，请联系门店了解详情。',
    consoleDescription: '订单已被商家关闭。',
    className: 'bg-slate-100 text-slate-600',
  },
  after_sale: {
    label: '其他（售后）',
    clientDescription: '订单已进入售后处理，请等待门店进一步处理。',
    consoleDescription: '订单当前处于售后处理场景。',
    className: 'bg-amber-50 text-amber-700',
  },
  after_sale_done: {
    label: '售后完成',
    clientDescription: '售后处理已完成，可查看最新结果。',
    consoleDescription: '订单售后处理已完成。',
    className: 'bg-emerald-50 text-emerald-700',
  },
  verifying: {
    label: '核销中',
    clientDescription: '门店正在处理核销，请稍候确认结果。',
    consoleDescription: '订单正在核销流程中。',
    className: 'bg-teal-50 text-teal-700',
  },
  verify_failed: {
    label: '核销失败',
    clientDescription: '本次核销失败，请联系门店重新处理。',
    consoleDescription: '订单核销失败，需人工介入处理。',
    className: 'bg-rose-50 text-rose-700',
  },
}

// 统一提供业务状态元数据读取入口，页面无需直接访问底层映射表。
export const getO2oOrderBusinessStatusMeta = (status: O2oOrderBusinessStatus | null | undefined) => {
  if (!status) {
    return null
  }
  return O2O_ORDER_BUSINESS_STATUS_META[status] ?? null
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

// 客户端状态报告场景需要优先区分“超时取消”和“主动撤回”，避免用户误解。
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
