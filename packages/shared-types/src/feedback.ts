import type { ClientAccountType } from './auth.ts'
import type { PaginationListResult, PaginationQueryInput } from './common.ts'

export type ClientFeedbackConversationStatus = 'open' | 'processing' | 'resolved' | 'closed'
export type ClientFeedbackPriority = 'low' | 'normal' | 'high' | 'urgent'
export type ClientFeedbackIssueType = 'suggestion' | 'bug' | 'restock'
export type RestockStatus = 'requested' | 'accepted' | 'restocked' | 'cancelled'
export type RestockEffectiveStatus = RestockStatus | 'expired'

export interface ClientRestockRequest {
  id: string
  conversationId: string
  productId: string
  skuId: string
  productNameSnapshot: string
  productCodeSnapshot: string
  skuCodeSnapshot: string
  specTextSnapshot: string
  quantity: number
  latestPickupAt: string
  remark: string | null
  status: RestockStatus
  effectiveStatus: RestockEffectiveStatus
  handledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateRestockRequestInput {
  productId: string
  skuId: string
  quantity: number
  /** 带时区的 ISO 时间，秒和毫秒必须为零，界面按 UTC+8 展示。 */
  latestPickupAt: string
  remark?: string
  clientRequestId: string
}

export interface ActiveRestockRequestResult {
  restock: ClientRestockRequest | null
  serverNow: string
}

export interface CreateRestockRequestResult {
  created: boolean
  conversation: ClientFeedbackConversationSummary
  message: ClientFeedbackMessage | null
  serverNow: string
}

export interface UpdateRestockRequestInput {
  status: 'accepted' | 'restocked'
  publicNote?: string
}

export interface UpdateRestockRequestResult {
  changed: boolean
  conversation: ClientFeedbackConversationSummary
  message: ClientFeedbackMessage | null
  serverNow: string
}

export interface RestockRankingResult {
  range: { startDate: string; endDate: string; isDefault: boolean }
  list: Array<{ productId: string; productName: string; productCode: string; requestCount: number }>
  serverNow: string
}
export type ClientFeedbackSenderType = 'client' | 'service' | 'system'
export type ClientFeedbackMessageType = 'text' | 'system' | 'internal_note'
export type ClientFeedbackSatisfactionLevel = 'satisfied' | 'neutral' | 'unsatisfied'

export interface ClientFeedbackMessageAttachment {
  name: string
  url: string
  mimeType: string | null
  size: number | null
}

export interface ClientFeedbackAttachmentReference {
  id: string
}

export interface ClientFeedbackUploadedAttachment extends ClientFeedbackMessageAttachment {
  id: string
  expiresAt: string | null
}

/** `/client-feedback/attachments` 解包后的真实 data 结构；上传 module 尚未接入。 */
export interface ClientFeedbackAttachmentUploadResult {
  attachment: ClientFeedbackUploadedAttachment
}

export interface ClientFeedbackConversationFields {
  issueType: ClientFeedbackIssueType
  category: string
  orderRef: string | null
  expectedResult: string
  actualResult: string
  reproductionSteps: string | null
  contactPreference: string | null
  tags: string[]
  sourceLabel: string
}

export interface ClientFeedbackSatisfaction {
  level: ClientFeedbackSatisfactionLevel
  comment: string | null
  ratedAt: string
}

export interface ClientFeedbackConversationSummary {
  restock: ClientRestockRequest | null
  serverNow: string
  id: string
  conversationNo: string
  clientUserId: string
  clientUsername: string
  clientAccount: string
  clientAccountType: ClientAccountType
  staffNoSnapshot: string | null
  departmentNameSnapshot: string
  category: string
  subject: string
  status: ClientFeedbackConversationStatus
  priority: ClientFeedbackPriority
  assignedUserId: string | null
  assignedUsername: string | null
  assignedDisplayName: string | null
  lastMessagePreview: string
  lastMessageSenderType: ClientFeedbackSenderType
  lastMessageAt: string
  unreadForClientCount: number
  unreadForServiceCount: number
  closedAt: string | null
  fields: ClientFeedbackConversationFields
  satisfaction: ClientFeedbackSatisfaction | null
  createdAt: string
  updatedAt: string
  assignedToCurrentUser?: boolean
}

export interface ClientFeedbackMessage {
  id: string
  conversationId: string
  senderType: ClientFeedbackSenderType
  senderUserId: string | null
  senderName: string
  messageType: ClientFeedbackMessageType
  internalOnly: boolean
  content: string
  attachments: ClientFeedbackMessageAttachment[]
  clientReadAt: string | null
  serviceReadAt: string | null
  createdAt: string
  mine: boolean
}

export interface ClientFeedbackConversationDetail {
  conversation: ClientFeedbackConversationSummary
  messages: ClientFeedbackMessage[]
}

export interface ClientFeedbackFaqItem {
  question: string
  answer: string
}

export interface ClientFeedbackPortalAvailability {
  status: 'online' | 'offline'
  reason: 'within_work_hours' | 'outside_work_hours' | 'no_online_staff'
  isOnline: boolean
  withinWorkHours: boolean
  hasOnlineStaff: boolean
  serviceConnectedCount: number
  serverTime: string
  workHoursText: string
  offlineNotice: string
  offlineFaqs: ClientFeedbackFaqItem[]
}

export interface ClientFeedbackPortalConfig {
  enabled: boolean
  realtimeEnabled: boolean
  entryNotice: string
  workdayStart: string
  workdayEnd: string
  workdayWeekdays: number[]
  offlineNotice: string
  offlineFaqs: ClientFeedbackFaqItem[]
  sseKeepaliveSeconds: number
  availability: ClientFeedbackPortalAvailability
  updatedAt: string
}

export interface ClientFeedbackListQuery extends PaginationQueryInput {
  keyword?: string
  status?: ClientFeedbackConversationStatus
}

export type ClientFeedbackListResult = PaginationListResult<ClientFeedbackConversationSummary> & { serverNow: string }

export interface CustomerServiceRestockListQuery extends ClientFeedbackListQuery {
  issueType?: ClientFeedbackIssueType
  restockStatus?: RestockEffectiveStatus
  productId?: string
  dateRange?: string | [string, string]
  startDate?: string
  endDate?: string
  priority?: ClientFeedbackPriority
  assignedToMe?: boolean
  unreadOnly?: boolean
}

export interface CreateClientFeedbackConversationInput {
  issueType?: ClientFeedbackIssueType
  category?: string
  subject: string
  priority?: ClientFeedbackPriority
  content: string
  orderRef?: string
  expectedResult?: string
  actualResult?: string
  reproductionSteps?: string
  contactPreference?: string
  tags?: string[]
  sourceLabel?: string
  attachments?: ClientFeedbackAttachmentReference[]
}

export interface AppendClientFeedbackMessageInput {
  content: string
  attachments?: ClientFeedbackAttachmentReference[]
}

export interface SubmitClientFeedbackSatisfactionInput {
  level: ClientFeedbackSatisfactionLevel
  comment?: string
}

export interface ClientFeedbackConversationMutationResult {
  conversation: ClientFeedbackConversationSummary
  message: ClientFeedbackMessage
}

export interface ClientFeedbackConversationCloseResult {
  changed: boolean
  conversation: ClientFeedbackConversationSummary
}

export interface ClientFeedbackSatisfactionResult {
  conversation: ClientFeedbackConversationSummary
  satisfaction: ClientFeedbackSatisfaction | null
}
