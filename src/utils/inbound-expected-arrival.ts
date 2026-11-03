/**
 * 模块说明：src/utils/inbound-expected-arrival.ts
 * 文件职责：统一送货单“预计送达时间”的前端可选日期范围，供供货方录入页与改单弹窗共用。
 * 维护说明：
 * - 后端 assertExpectedArrivalAt 只接受“今天零点 ~ 当前时间 + 90 天”；
 * - 前端按天禁用，最后一天取第 89 天，避免选中第 90 天晚于当前时刻的时间后被服务端拒绝。
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const INBOUND_EXPECTED_ARRIVAL_SELECTABLE_DAYS = 90

export const disabledInboundExpectedArrivalDate = (date: Date) => {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const lastSelectableDayEnd = todayStart.getTime() + INBOUND_EXPECTED_ARRIVAL_SELECTABLE_DAYS * DAY_MS
  return date.getTime() < todayStart.getTime() || date.getTime() >= lastSelectableDayEnd
}
