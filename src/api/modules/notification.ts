import { request, type RequestConfig } from '@/api/http'
import type { UserRole } from '@/api/modules/auth'

export const NOTIFICATION_EXTERNAL_TRIGGER_MODES = [
  'all_management_offline',
  'watched_accounts_offline',
] as const

export type NotificationExternalTriggerMode = (typeof NOTIFICATION_EXTERNAL_TRIGGER_MODES)[number]

export type NotificationEventType =
  | 'o2o_preorder_created'
  | 'customer_service_client_message_created'
  | 'mobile_refresh_replay_detected'
  | 'inbound_order_submitted'
  | 'inbound_order_status_changed'

export interface NotificationInboxItem {
  id: string
  eventType: NotificationEventType
  title: string
  content: string
  isRead: boolean
  readAt: string | null
  createdAt: string
}

export interface NotificationInboxQuery {
  page?: number
  pageSize?: number
  unreadOnly?: boolean
  eventType?: NotificationEventType
}

export interface NotificationRuleRecord {
  id: string
  ruleCode: string
  ruleName: string
  eventType: NotificationEventType
  enabled: boolean
  recipientUserIds: string[]
  emailRecipientAdminUserIds: string[]
  emailRecipientSupplierUserIds: string[]
  emailEnabled: boolean
  feishuEnabled: boolean
  externalTriggerMode: NotificationExternalTriggerMode
  watchedUserIds: string[]
  feishuWebhookUrl: string
  feishuWebhookConfigured: boolean
  feishuSignSecretMasked: boolean
  feishuSignSecret?: string
  emailSubjectPrefix: string
  updatedAt: string
}

export interface NotificationPresenceUser {
  userId: string
  username: string
  displayName: string
  role: UserRole
  isOnline: boolean
  activeSessionCount: number
  lastAccessAt: string | null
}

export interface NotificationPresenceSnapshot {
  serverTime: string
  onlineWindowSeconds: number
  users: NotificationPresenceUser[]
}

export interface UpdateNotificationRulesPayload {
  offlineWindowSeconds: number
  rules: Array<{
    id: string
    enabled: boolean
    recipientUserIds: string[]
    emailRecipientAdminUserIds: string[]
    emailRecipientSupplierUserIds: string[]
    emailEnabled: boolean
    feishuEnabled: boolean
    externalTriggerMode: NotificationExternalTriggerMode
    watchedUserIds: string[]
    feishuWebhookUrl: string
    clearFeishuWebhook?: boolean
    feishuSignSecret: string
    emailSubjectPrefix: string
  }>
}

export interface UpdateNotificationRulesResult {
  changed: boolean
  list: NotificationRuleRecord[]
}

export interface TestNotificationRuleSendPayload {
  ruleId: string
  channel: 'email' | 'feishu'
  draft: UpdateNotificationRulesPayload['rules'][number]
}

export interface TestNotificationRuleSendResult {
  channel: 'email' | 'feishu'
  success: boolean
  message: string
  summary: {
    attempted: number
    succeeded: number
    failed: number
  }
  failures: Array<{
    target: string
    reason: string
  }>
}

export const getNotificationRules = () =>
  request<{ list: NotificationRuleRecord[] }>({
    method: 'GET',
    url: '/notifications/rules',
  })

export const updateNotificationRules = (payload: UpdateNotificationRulesPayload) =>
  request<UpdateNotificationRulesResult>({
    method: 'PUT',
    url: '/notifications/rules',
    data: payload,
  })

export const getNotificationPresenceSnapshot = () =>
  request<NotificationPresenceSnapshot>({
    method: 'GET',
    url: '/notifications/presence-snapshot',
  })

export const testNotificationRuleSend = (payload: TestNotificationRuleSendPayload) =>
  request<TestNotificationRuleSendResult>({
    method: 'POST',
    url: '/notifications/rules/test-send',
    data: payload,
  })

// 站内通知收件箱：只返回当前登录账号自己的通知，可按事件类型过滤。
export const getNotificationInbox = (query: NotificationInboxQuery = {}, requestConfig: RequestConfig = {}) =>
  request<{ page: number; pageSize: number; total: number; list: NotificationInboxItem[] }>({
    ...requestConfig,
    method: 'GET',
    url: '/notifications/inbox',
    params: {
      page: query.page,
      pageSize: query.pageSize,
      unreadOnly: query.unreadOnly ? '1' : undefined,
      eventType: query.eventType,
    },
  })

export const markNotificationInboxRead = (id: string) =>
  request<{ changed: boolean }>({
    method: 'POST',
    url: `/notifications/inbox/${id}/read`,
  })

/**
 * 把当前账号某一事件类型的未读提醒全部标记已读，返回实际变更条数。
 */
export const markNotificationInboxReadByEventType = (eventType: NotificationEventType) =>
  request<{ changed: number }>({
    method: 'POST',
    url: '/notifications/inbox/read-by-event-type',
    data: { eventType },
  })
