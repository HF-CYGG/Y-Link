/**
 * 文件说明：backend/src/constants/notification-event-catalog.ts
 * 文件职责：统一维护通知事件的业务分类、事件类型中文名、处理结果与外发渠道口径，供通知事件聚合查询与筛选项下发共用。
 * 实现逻辑：
 * - 业务分类（订单/客服/安全/系统）与处理阶段（规则命中、站内生成、外发、重试、失败）分层，不混为同一层级；
 * - 未登记的事件类型统一归入“系统通知”，保证后续新增库存、入库、系统维护等事件有稳定兜底；
 * - 处理结果由 notification_event 与 notification_dispatch 实际状态推导，不再以审计日志写入成功代替外发结果。
 * 维护说明：
 * - 新增通知事件类型时需在 NOTIFICATION_EVENT_TYPE_CATALOG 登记分类与中文名；
 * - 本文件不得引用 notification.service，避免常量层与服务层形成循环依赖。
 */

export const NOTIFICATION_EVENT_CATEGORY_KEYS = ['order', 'customer_service', 'security', 'system'] as const
export type NotificationEventCategoryKey = (typeof NOTIFICATION_EVENT_CATEGORY_KEYS)[number]

export const NOTIFICATION_EVENT_CATEGORIES: ReadonlyArray<{ key: NotificationEventCategoryKey; label: string }> = [
  { key: 'order', label: '订单通知' },
  { key: 'customer_service', label: '客服通知' },
  { key: 'security', label: '安全告警' },
  // 系统通知为库存、入库、系统维护等后续事件预留，未登记事件类型也归入此类。
  { key: 'system', label: '系统通知' },
]

export const NOTIFICATION_EVENT_TYPE_CATALOG: Readonly<Record<string, { label: string; category: NotificationEventCategoryKey }>> = {
  o2o_preorder_created: { label: '新预订单通知', category: 'order' },
  customer_service_client_message_created: { label: '客服新消息通知', category: 'customer_service' },
  mobile_refresh_replay_detected: { label: 'Mobile 刷新令牌重放告警', category: 'security' },
}

export const NOTIFICATION_EVENT_RESULT_STATUSES = [
  'pending',
  'retrying',
  'processing',
  'success',
  'partial_failed',
  'failed',
  'internal_only',
] as const
export type NotificationEventResultStatus = (typeof NOTIFICATION_EVENT_RESULT_STATUSES)[number]

export const NOTIFICATION_EVENT_RESULT_LABELS: Readonly<Record<NotificationEventResultStatus, string>> = {
  pending: '待处理',
  retrying: '重试中',
  processing: '处理中',
  success: '外发成功',
  partial_failed: '部分外发失败',
  failed: '处理失败',
  internal_only: '仅站内通知',
}

export const NOTIFICATION_EVENT_CHANNEL_LABELS: Readonly<Record<'email' | 'feishu', string>> = {
  email: '邮件',
  feishu: '飞书',
}

/** 通知事件最多处理次数：与通知 Outbox Worker 的重试上限保持一致，仅用于展示“重试次数/上限”。 */
export const NOTIFICATION_EVENT_MAX_ATTEMPTS = 5

const CATEGORY_LABEL_MAP = new Map(NOTIFICATION_EVENT_CATEGORIES.map((item) => [item.key, item.label]))

export const isNotificationEventCategoryKey = (value: unknown): value is NotificationEventCategoryKey =>
  typeof value === 'string' && (NOTIFICATION_EVENT_CATEGORY_KEYS as readonly string[]).includes(value)

export const isNotificationEventResultStatus = (value: unknown): value is NotificationEventResultStatus =>
  typeof value === 'string' && (NOTIFICATION_EVENT_RESULT_STATUSES as readonly string[]).includes(value)

export const resolveNotificationEventCategory = (eventType: string): NotificationEventCategoryKey =>
  NOTIFICATION_EVENT_TYPE_CATALOG[eventType]?.category ?? 'system'

export const getNotificationEventCategoryLabel = (key: NotificationEventCategoryKey) => CATEGORY_LABEL_MAP.get(key) ?? '系统通知'

export const getNotificationEventTypeLabel = (eventType: string) => NOTIFICATION_EVENT_TYPE_CATALOG[eventType]?.label ?? eventType

/** 某业务分类下已登记的事件类型；“系统通知”返回空数组，查询时以“未登记事件类型”兜底。 */
export const listNotificationEventTypesByCategory = (key: NotificationEventCategoryKey) =>
  Object.entries(NOTIFICATION_EVENT_TYPE_CATALOG)
    .filter(([, definition]) => definition.category === key)
    .map(([eventType]) => eventType)
