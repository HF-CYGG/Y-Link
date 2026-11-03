/** 客户端详情页展示模型：主状态决定流程，只有实际事件字段可以提供节点时间。 */
import {
  getClientOrderStatusReportConfig,
  O2O_ORDER_TIMEOUT_SOON_WINDOW_MS,
  type ClientOrderReportScenario,
} from '../../constants/o2o-order-status'

export interface ClientOrderProgressInput {
  status?: string | null
  createdAt?: string | null
  verifiedAt?: string | null
  timeoutAt?: string | null
  statusReport?: {
    scenario?: string | null
    cancelReason?: string | null
    cancellationSource?: string | null
    cancellationRemark?: string | null
    cancelledAt?: string | null
  } | null
}

export interface ClientOrderProgressNode {
  key: string
  title: string
  state: 'occurred' | 'current' | 'future' | 'terminated'
  hint: string
  /** null 表示未记录；只有 event=true 的节点展示实际时间或“未记录”。 */
  event: boolean
  time: string | null
}

const validTime = (value?: string | null) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(value)
  if (!parts) return null
  const [, year, month, day, hour, minute, second = '0'] = parts
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return calendar.getUTCFullYear() === Number(year) && calendar.getUTCMonth() === Number(month) - 1
    && calendar.getUTCDate() === Number(day) && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 ? value : null
}

export const buildClientOrderProgress = (order: ClientOrderProgressInput, nowMs = Date.now()) => {
  const deadline = validTime(order.timeoutAt)
  const deadlineMs = deadline ? Date.parse(deadline) : null
  const pending = order.status === 'pending'
  const verified = order.status === 'verified'
  const cancelled = order.status === 'cancelled'
  const rawReport = order.statusReport
  // 不一致的报告不能改变主状态，也不借用其取消时间、来源或说明。
  const cancellationReport = cancelled && (!rawReport?.scenario || ['cancelled', 'timeout_cancelled'].includes(rawReport.scenario))
    ? rawReport : null
  const source = cancellationReport?.cancellationSource
  const cancellationSource = source && ['client', 'admin', 'system'].includes(source) ? source : null
  const manual = cancellationReport?.cancelReason === 'manual'
  const explicitTimeout = !manual && (cancellationReport?.cancelReason === 'timeout' || cancellationReport?.scenario === 'timeout_cancelled')
  let scenario: ClientOrderReportScenario = 'pending'
  if (verified) scenario = 'verified'
  else if (cancelled) scenario = explicitTimeout ? 'timeout_cancelled' : 'cancelled'
  else if (pending && deadlineMs !== null && deadlineMs > nowMs && deadlineMs - nowMs <= O2O_ORDER_TIMEOUT_SOON_WINDOW_MS) scenario = 'timeout_soon'

  let report = getClientOrderStatusReportConfig({
    status: verified ? 'verified' : cancelled ? 'cancelled' : 'pending',
    timeoutAt: deadline,
    statusReport: { scenario },
  }, nowMs)
  if (scenario === 'timeout_soon') {
    report = { ...report, cardClassName: `${report.cardClassName} dark:bg-orange-500/10 dark:text-orange-300` }
  }
  if (cancelled && !explicitTimeout) {
    const sourceLabel = cancellationSource === 'client' ? '你' : cancellationSource === 'admin' ? '管理端' : cancellationSource === 'system' ? '系统' : null
    const remark = cancellationReport?.cancellationRemark?.trim()
    report = {
      ...report,
      statusLabel: cancellationSource === 'client' ? '已撤回' : '已取消',
      cardTitle: cancellationSource === 'client' ? '订单已撤回' : '订单已取消',
      cardDescription: `${sourceLabel ? `订单已由${sourceLabel}取消` : '历史记录未留存取消来源'}${remark ? `：${remark}` : '，如有疑问请联系门店。'}`,
      timelineCurrentTitle: cancellationSource === 'client' ? '订单已撤回' : cancellationSource === 'admin' ? '管理端已取消' : cancellationSource === 'system' ? '系统已取消' : '订单已取消',
    }
  }
  if (pending && deadlineMs !== null && deadlineMs <= nowMs) {
    report = { ...report, cardDescription: '已到核销截止时间，当前仍为待核销，请刷新状态或联系门店确认。', timelineCurrentHint: '请刷新状态或联系门店确认' }
  }
  if (!pending && !verified && !cancelled) {
    report = { ...report, statusLabel: '未知状态', cardTitle: '订单状态待确认', cardDescription: '暂无法识别当前订单状态，请刷新或联系门店。', timelineCurrentTitle: '状态待确认', timelineCurrentHint: '请刷新或联系门店确认' }
  }
  const nodes: ClientOrderProgressNode[] = [
    { key: 'created', title: '已下单', state: 'occurred', event: true, time: validTime(order.createdAt), hint: '订单已提交' },
  ]
  if (verified) {
    nodes.push({ key: 'verified', title: '已核销，订单完成', state: 'occurred', event: true, time: validTime(order.verifiedAt), hint: report.cardDescription })
  } else if (cancelled) {
    nodes.push({ key: 'cancelled', title: report.timelineCurrentTitle, state: 'terminated', event: true, time: validTime(cancellationReport?.cancelledAt), hint: report.cardDescription })
  } else {
    nodes.push({ key: 'current', title: report.timelineCurrentTitle, state: 'current', event: false, time: null, hint: report.timelineCurrentHint })
    if (pending) nodes.push({ key: 'future', title: '核销完成', state: 'future', event: false, time: null, hint: '尚未发生 · 到店核销后完成订单' })
  }
  return {
    report, scenario, nodes, cancellationSource,
    deadline,
    deadlineLabel: pending ? '核销截止时间' : '原核销截止时间',
    deadlineHint: deadline ? '截止时间不代表备货、核销或取消的实际发生时间。' : order.timeoutAt ? '截止时间未记录' : '未设置核销截止时间',
  }
}
