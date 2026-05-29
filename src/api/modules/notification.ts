import { request } from '@/api/http'
import type { UserRole } from '@/api/modules/auth'

export const NOTIFICATION_EXTERNAL_TRIGGER_MODES = [
  'all_management_offline',
  'watched_accounts_offline',
] as const

export type NotificationExternalTriggerMode = (typeof NOTIFICATION_EXTERNAL_TRIGGER_MODES)[number]

export interface NotificationRuleRecord {
  id: string
  ruleCode: string
  ruleName: string
  eventType: 'o2o_preorder_created' | 'customer_service_client_message_created'
  enabled: boolean
  recipientUserIds: string[]
  emailEnabled: boolean
  feishuEnabled: boolean
  externalTriggerMode: NotificationExternalTriggerMode
  watchedUserIds: string[]
  feishuWebhookUrl: string
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
  rules: Array<{
    id: string
    enabled: boolean
    recipientUserIds: string[]
    emailEnabled: boolean
    feishuEnabled: boolean
    externalTriggerMode: NotificationExternalTriggerMode
    watchedUserIds: string[]
    feishuWebhookUrl: string
    emailSubjectPrefix: string
  }>
}

export interface UpdateNotificationRulesResult {
  changed: boolean
  list: NotificationRuleRecord[]
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
