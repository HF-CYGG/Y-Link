/**
 * 模块说明：src/api/modules/customer-service-feedback.ts
 * 文件职责：统一封装客户端反馈页与客服工作台共用的真实后端接口、字段映射与 SSE 续接能力。
 * 实现逻辑：
 * - 以前端可读模型为中心，对后端客服会话结构做一次统一映射，避免页面层直接处理状态枚举与字段差异；
 * - 客户端与客服端共用同一份会话/消息类型，但按角色分别调用不同接口，保证权限边界清晰；
 * - SSE 连接在本模块集中处理，页面只关心在线、离线、续接与会话变更事件，不再自己拼接流地址。
 * 维护说明：
 * - 若后端继续扩展附件、标签或客服在线规则，应优先在本文件补映射，避免页面散落兼容逻辑；
 * - 若需要切换到 WebSocket，仅需替换本模块的流连接实现，页面事件回调签名可保持不变。
 */

import { request } from '@/api/http'
import { getPersistedAuthToken } from '@/utils/auth-storage'
import { getPersistedClientAuthToken } from '@/utils/client-auth-storage'

/**
 * 会话列表统一分页口径：
 * - 客户端与客服工作台都只拉取首页高频会话，避免页面层散落魔法数字；
 * - 数值需与后端路由允许的最大 pageSize 保持一致，防止请求直接被 400 拦截。
 */
const FEEDBACK_CONVERSATION_LIST_PAGE_SIZE = 100

export type FeedbackIssueStatus = 'pending' | 'processing' | 'resolved' | 'closed'
export type FeedbackIssuePriority = 'low' | 'medium' | 'high' | 'urgent'
export type FeedbackIssueType = 'suggestion' | 'bug'
export type FeedbackIssueCategory = 'account' | 'order' | 'product' | 'delivery' | 'invoice' | 'other'
export type FeedbackMessageSenderRole = 'client' | 'staff' | 'system'

export interface FeedbackIssueStatusMeta {
  label: string
  className: string
  dotClassName: string
}

export interface FeedbackIssuePriorityMeta {
  label: string
  className: string
}

export interface FeedbackConversationMessageAttachment {
  name: string
  url: string
  mimeType: string | null
  size: number | null
}

export interface FeedbackConversationMessage {
  id: string
  senderRole: FeedbackMessageSenderRole
  senderName: string
  body: string
  createdAt: string
  internalOnly: boolean
  attachments: FeedbackConversationMessageAttachment[]
}

export interface FeedbackIssueFields {
  issueType: FeedbackIssueType
  category: FeedbackIssueCategory
  orderRef: string | null
  expectedResult: string
  actualResult: string
  reproductionSteps: string | null
  contactPreference: string | null
  tags: string[]
  sourceLabel: string
}

export interface FeedbackInternalRemarkRecord {
  content: string
  updatedAt: string | null
  updatedByUserId: string | null
  updatedByUsername: string | null
  updatedByDisplayName: string | null
}

export interface FeedbackConversationRecord {
  id: string
  issueNo: string
  title: string
  summary: string
  status: FeedbackIssueStatus
  priority: FeedbackIssuePriority
  clientUserId: string
  clientAccount: string
  clientDisplayName: string
  clientDepartmentName: string | null
  assigneeName: string | null
  lastMessageAt: string
  unreadForClient: number
  unreadForStaff: number
  createdAt: string
  updatedAt: string
  fields: FeedbackIssueFields
  messages: FeedbackConversationMessage[]
  internalRemark: FeedbackInternalRemarkRecord | null
}

export interface ClientFeedbackConversationSummary {
  all: number
  pending: number
  processing: number
  resolved: number
  closed: number
}

export interface SupportFeedbackSummary extends ClientFeedbackConversationSummary {
  urgent: number
  unassigned: number
  waitingClientReply: number
  waitingStaffReply: number
}

export interface FeedbackPortalAvailability {
  status: 'online' | 'offline'
  reason: 'within_work_hours' | 'outside_work_hours' | 'no_online_staff'
  isOnline: boolean
  withinWorkHours: boolean
  hasOnlineStaff: boolean
  serviceConnectedCount: number
  serverTime: string
  workHoursText: string
  offlineNotice: string
  offlineFaqs: Array<{ question: string; answer: string }>
}

export interface FeedbackPortalConfig {
  enabled: boolean
  realtimeEnabled: boolean
  entryNotice: string
  workdayStart: string
  workdayEnd: string
  workdayWeekdays: number[]
  offlineNotice: string
  offlineFaqs: Array<{ question: string; answer: string }>
  sseKeepaliveSeconds: number
  availability: FeedbackPortalAvailability
  updatedAt: string
}

export interface FeedbackRealtimeSessionSnapshot {
  currentConversationEventId: number
  clientConnectionCount: number
  serviceConnectionCount: number
  recentConnections: Array<{
    subscriberId: string
    scope: 'client' | 'service'
    ownerKey: string
    connectedAt: string
  }>
}

export interface FeedbackServicePresence {
  availability: FeedbackPortalAvailability
  session: FeedbackRealtimeSessionSnapshot
}

export interface CreateClientFeedbackConversationInput {
  title: string
  summary: string
  issueType: FeedbackIssueType
  priority: FeedbackIssuePriority
  category: FeedbackIssueCategory
  orderRef?: string
  expectedResult?: string
  actualResult?: string
  reproductionSteps?: string
  contactPreference?: string
  tags?: string[]
  attachments?: FeedbackConversationMessageAttachment[]
}

export interface AppendClientFeedbackMessageInput {
  body: string
  attachments?: FeedbackConversationMessageAttachment[]
}

export interface AppendStaffFeedbackMessageInput {
  body: string
  attachments?: FeedbackConversationMessageAttachment[]
}

export interface UpdateFeedbackIssueInput {
  title?: string
  status?: FeedbackIssueStatus
  priority?: FeedbackIssuePriority
  issueType?: FeedbackIssueType
  category?: FeedbackIssueCategory
  orderRef?: string | null
  expectedResult?: string
  actualResult?: string
  reproductionSteps?: string | null
  contactPreference?: string | null
  tags?: string[]
  sourceLabel?: string
}

export interface SupportFeedbackListQuery {
  keyword?: string
  status?: FeedbackIssueStatus | ''
  priority?: FeedbackIssuePriority | ''
  assigneeScope?: 'all' | 'mine' | 'unassigned'
}

type BackendConversationStatus = 'open' | 'processing' | 'resolved' | 'closed'
type BackendConversationPriority = 'low' | 'normal' | 'high' | 'urgent'
type BackendConversationIssueType = 'suggestion' | 'bug'

interface BackendConversationSummary {
  id: string
  conversationNo: string
  clientUserId: string
  clientUsername: string
  clientAccount: string
  departmentNameSnapshot: string
  subject: string
  status: BackendConversationStatus
  priority: BackendConversationPriority
  assignedDisplayName: string | null
  lastMessageAt: string
  unreadForClientCount: number
  unreadForServiceCount: number
  createdAt: string
  updatedAt: string
  fields: {
    issueType: BackendConversationIssueType
    category: string
    orderRef: string | null
    expectedResult: string
    actualResult: string
    reproductionSteps: string | null
    contactPreference: string | null
    tags: string[]
    sourceLabel: string
  }
}

interface BackendConversationDetail {
  conversation: BackendConversationSummary
  messages: Array<{
    id: string
    conversationId: string
    senderType: 'client' | 'service' | 'system'
    senderName: string
    messageType: 'text' | 'system' | 'internal_note'
    internalOnly: boolean
    content: string
    attachments: FeedbackConversationMessageAttachment[]
    createdAt: string
  }>
  internalRemark?: FeedbackInternalRemarkRecord | null
}

interface BackendRealtimeConversationEventPayload {
  eventType: string
  conversationId: string
  clientUserId: string
  occurredAt: string
  conversation: BackendConversationSummary
  message?: BackendConversationDetail['messages'][number]
  detail?: Record<string, unknown>
}

interface BackendListResult<T> {
  page: number
  pageSize: number
  total: number
  list: T[]
}

export interface FeedbackRealtimeHandlers {
  onOpen?: (payload: { availability?: FeedbackPortalAvailability; session?: FeedbackRealtimeSessionSnapshot }) => void
  onConversation?: (payload: FeedbackRealtimeConversationEvent | null) => void
  onError?: () => void
}

export interface FeedbackRealtimeConnection {
  close: () => void
}

export interface FeedbackRealtimeConversationEvent {
  eventType: string
  conversationId: string
  clientUserId: string
  occurredAt: string
  conversation: FeedbackConversationRecord
  message?: FeedbackConversationMessage
  detail?: Record<string, unknown>
}

export const FEEDBACK_STATUS_META_MAP: Record<FeedbackIssueStatus, FeedbackIssueStatusMeta> = {
  pending: {
    label: '待受理',
    className: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200',
    dotClassName: 'bg-amber-500',
  },
  processing: {
    label: '处理中',
    className: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200',
    dotClassName: 'bg-sky-500',
  },
  resolved: {
    label: '已解决',
    className: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
    dotClassName: 'bg-emerald-500',
  },
  closed: {
    label: '已关闭',
    className: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200',
    dotClassName: 'bg-slate-400',
  },
}

export const FEEDBACK_PRIORITY_META_MAP: Record<FeedbackIssuePriority, FeedbackIssuePriorityMeta> = {
  low: { label: '低优先级', className: 'bg-slate-100 text-slate-600' },
  medium: { label: '中优先级', className: 'bg-cyan-50 text-cyan-700' },
  high: { label: '高优先级', className: 'bg-amber-50 text-amber-700' },
  urgent: { label: '紧急', className: 'bg-rose-50 text-rose-700' },
}

export const FEEDBACK_ISSUE_TYPE_OPTIONS: Array<{ label: string; value: FeedbackIssueType; hint: string }> = [
  { label: '普通建议', value: 'suggestion', hint: '适合咨询、建议、体验反馈和一般诉求。' },
  { label: '专业 BUG', value: 'bug', hint: '适合存在明确异常、需要复现与排查的问题。' },
]

export const FEEDBACK_CATEGORY_OPTIONS: Array<{ label: string; value: FeedbackIssueCategory }> = [
  { label: '账号与登录', value: 'account' },
  { label: '订单与售后', value: 'order' },
  { label: '商品与库存', value: 'product' },
  { label: '履约与配送', value: 'delivery' },
  { label: '开票与对账', value: 'invoice' },
  { label: '其他建议', value: 'other' },
]

export const FEEDBACK_PRIORITY_OPTIONS: Array<{ label: string; value: FeedbackIssuePriority }> = [
  { label: '低优先级', value: 'low' },
  { label: '中优先级', value: 'medium' },
  { label: '高优先级', value: 'high' },
  { label: '紧急', value: 'urgent' },
]

export const FEEDBACK_STATUS_OPTIONS: Array<{ label: string; value: FeedbackIssueStatus }> = [
  { label: '待受理', value: 'pending' },
  { label: '处理中', value: 'processing' },
  { label: '已解决', value: 'resolved' },
  { label: '已关闭', value: 'closed' },
]

const BACKEND_STATUS_TO_FRONTEND_MAP: Record<BackendConversationStatus, FeedbackIssueStatus> = {
  open: 'pending',
  processing: 'processing',
  resolved: 'resolved',
  closed: 'closed',
}

const FRONTEND_STATUS_TO_BACKEND_MAP: Record<FeedbackIssueStatus, BackendConversationStatus> = {
  pending: 'open',
  processing: 'processing',
  resolved: 'resolved',
  closed: 'closed',
}

const BACKEND_PRIORITY_TO_FRONTEND_MAP: Record<BackendConversationPriority, FeedbackIssuePriority> = {
  low: 'low',
  normal: 'medium',
  high: 'high',
  urgent: 'urgent',
}

const FRONTEND_PRIORITY_TO_BACKEND_MAP: Record<FeedbackIssuePriority, BackendConversationPriority> = {
  low: 'low',
  medium: 'normal',
  high: 'high',
  urgent: 'urgent',
}

const normalizeCategory = (value: string): FeedbackIssueCategory => {
  return FEEDBACK_CATEGORY_OPTIONS.some((item) => item.value === value)
    ? (value as FeedbackIssueCategory)
    : 'other'
}

const mapMessage = (message: BackendConversationDetail['messages'][number]): FeedbackConversationMessage => {
  return {
    id: message.id,
    senderRole: message.senderType === 'service' ? 'staff' : message.senderType,
    senderName: message.senderName,
    body: message.content,
    createdAt: message.createdAt,
    internalOnly: Boolean(message.internalOnly),
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
  }
}

const mapConversation = (
  conversation: BackendConversationSummary,
  messages: FeedbackConversationMessage[] = [],
  internalRemark: FeedbackInternalRemarkRecord | null = null,
): FeedbackConversationRecord => {
  return {
    id: conversation.id,
    issueNo: conversation.conversationNo,
    title: conversation.subject,
    summary: conversation.fields.actualResult || conversation.subject,
    status: BACKEND_STATUS_TO_FRONTEND_MAP[conversation.status],
    priority: BACKEND_PRIORITY_TO_FRONTEND_MAP[conversation.priority],
    clientUserId: conversation.clientUserId,
    clientAccount: conversation.clientAccount,
    clientDisplayName: conversation.clientUsername || conversation.clientAccount || '客户端用户',
    clientDepartmentName: conversation.departmentNameSnapshot || null,
    assigneeName: conversation.assignedDisplayName || null,
    lastMessageAt: conversation.lastMessageAt,
    unreadForClient: conversation.unreadForClientCount,
    unreadForStaff: conversation.unreadForServiceCount,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    fields: {
      issueType: conversation.fields.issueType,
      category: normalizeCategory(conversation.fields.category),
      orderRef: conversation.fields.orderRef,
      expectedResult: conversation.fields.expectedResult,
      actualResult: conversation.fields.actualResult,
      reproductionSteps: conversation.fields.reproductionSteps,
      contactPreference: conversation.fields.contactPreference,
      tags: conversation.fields.tags ?? [],
      sourceLabel: conversation.fields.sourceLabel,
    },
    messages,
    internalRemark,
  }
}

const mapRealtimeConversationEvent = (
  payload: BackendRealtimeConversationEventPayload,
): FeedbackRealtimeConversationEvent => {
  return {
    eventType: payload.eventType,
    conversationId: payload.conversationId,
    clientUserId: payload.clientUserId,
    occurredAt: payload.occurredAt,
    conversation: mapConversation(payload.conversation),
    message: payload.message ? mapMessage(payload.message) : undefined,
    detail: payload.detail,
  }
}

const summarizeRecords = (records: FeedbackConversationRecord[]): ClientFeedbackConversationSummary => {
  return {
    all: records.length,
    pending: records.filter((item) => item.status === 'pending').length,
    processing: records.filter((item) => item.status === 'processing').length,
    resolved: records.filter((item) => item.status === 'resolved').length,
    closed: records.filter((item) => item.status === 'closed').length,
  }
}

const buildApiBaseUrl = () => {
  return import.meta.env.VITE_API_BASE_URL ?? '/api'
}

const buildStreamUrl = (path: string, token: string) => {
  const apiBaseUrl = buildApiBaseUrl()
  const base = /^https?:\/\//.test(apiBaseUrl)
    ? apiBaseUrl
    : new URL(apiBaseUrl, globalThis.window.location.origin).toString()
  const url = new URL(path.replace(/^\//, ''), `${base.replace(/\/$/, '')}/`)
  url.searchParams.set('access_token', token)
  return url.toString()
}

export const summarizeClientFeedbackConversations = (records: FeedbackConversationRecord[]): ClientFeedbackConversationSummary => {
  return summarizeRecords(records)
}

export const summarizeSupportFeedbackConversations = (records: FeedbackConversationRecord[]): SupportFeedbackSummary => {
  const summary = summarizeRecords(records)
  return {
    ...summary,
    urgent: records.filter((item) => item.priority === 'urgent').length,
    unassigned: records.filter((item) => !item.assigneeName).length,
    waitingClientReply: records.filter((item) => item.unreadForClient > 0).length,
    waitingStaffReply: records.filter((item) => item.unreadForStaff > 0).length,
  }
}

export const getClientFeedbackPortalConfig = async (): Promise<FeedbackPortalConfig> => {
  return request<FeedbackPortalConfig>({
    url: '/client-feedback/portal-config',
    method: 'GET',
  })
}

export const listClientFeedbackConversations = async (): Promise<FeedbackConversationRecord[]> => {
  const response = await request<BackendListResult<BackendConversationSummary>>({
    url: '/client-feedback/conversations',
    method: 'GET',
    params: {
      page: 1,
      pageSize: FEEDBACK_CONVERSATION_LIST_PAGE_SIZE,
    },
  })
  return response.list.map((item) => mapConversation(item))
}

export const getClientFeedbackConversation = async (conversationId: string): Promise<FeedbackConversationRecord | null> => {
  const response = await request<BackendConversationDetail>({
    url: `/client-feedback/conversations/${conversationId}`,
    method: 'GET',
  })
  return mapConversation(
    response.conversation,
    response.messages.filter((item) => !item.internalOnly).map(mapMessage),
    null,
  )
}

export const createClientFeedbackConversation = async (input: CreateClientFeedbackConversationInput): Promise<FeedbackConversationRecord> => {
  const response = await request<{
    conversation: BackendConversationSummary
  }>({
    url: '/client-feedback/conversations',
    method: 'POST',
    data: {
      issueType: input.issueType,
      category: input.category,
      subject: input.title,
      priority: FRONTEND_PRIORITY_TO_BACKEND_MAP[input.priority],
      content: input.summary,
      orderRef: input.orderRef,
      expectedResult: input.expectedResult,
      actualResult: input.actualResult,
      reproductionSteps: input.reproductionSteps,
      contactPreference: input.contactPreference,
      tags: input.tags,
      sourceLabel: '客户端反馈页',
      attachments: input.attachments ?? [],
    },
  })
  return mapConversation(response.conversation)
}

export const appendClientFeedbackMessage = async (
  conversationId: string,
  input: AppendClientFeedbackMessageInput,
): Promise<void> => {
  await request({
    url: `/client-feedback/conversations/${conversationId}/messages`,
    method: 'POST',
    data: {
      content: input.body,
      attachments: input.attachments ?? [],
    },
  })
}

export const listSupportFeedbackConversations = async (query: SupportFeedbackListQuery = {}): Promise<FeedbackConversationRecord[]> => {
  const response = await request<BackendListResult<BackendConversationSummary>>({
    url: '/customer-service/conversations',
    method: 'GET',
    params: {
      page: 1,
      pageSize: FEEDBACK_CONVERSATION_LIST_PAGE_SIZE,
      keyword: query.keyword || undefined,
      status: query.status ? FRONTEND_STATUS_TO_BACKEND_MAP[query.status] : undefined,
      priority: query.priority ? FRONTEND_PRIORITY_TO_BACKEND_MAP[query.priority] : undefined,
      assignedToMe: query.assigneeScope === 'mine' ? true : undefined,
    },
  })

  const records = response.list.map((item) => mapConversation(item))
  if (query.assigneeScope === 'unassigned') {
    return records.filter((item) => !item.assigneeName)
  }
  return records
}

export const getSupportFeedbackConversation = async (conversationId: string): Promise<FeedbackConversationRecord | null> => {
  const response = await request<BackendConversationDetail>({
    url: `/customer-service/conversations/${conversationId}`,
    method: 'GET',
  })
  return mapConversation(
    response.conversation,
    response.messages.map(mapMessage),
    response.internalRemark ?? null,
  )
}

export const appendStaffFeedbackMessage = async (
  conversationId: string,
  input: AppendStaffFeedbackMessageInput,
): Promise<void> => {
  await request({
    url: `/customer-service/conversations/${conversationId}/messages`,
    method: 'POST',
    data: {
      content: input.body,
      attachments: input.attachments ?? [],
    },
  })
}

export const updateFeedbackIssue = async (conversationId: string, input: UpdateFeedbackIssueInput): Promise<void> => {
  const status = input.status === undefined ? undefined : FRONTEND_STATUS_TO_BACKEND_MAP[input.status]
  if (status !== undefined) {
    await request({
      url: `/customer-service/conversations/${conversationId}/status`,
      method: 'PATCH',
      data: { status },
    })
  }

  const hasFieldChange = [
    input.title,
    input.priority,
    input.issueType,
    input.category,
    input.orderRef,
    input.expectedResult,
    input.actualResult,
    input.reproductionSteps,
    input.contactPreference,
    input.tags,
    input.sourceLabel,
  ].some((item) => item !== undefined)

  if (!hasFieldChange) {
    return
  }

  await request({
    url: `/customer-service/conversations/${conversationId}/fields`,
    method: 'PATCH',
    data: {
      subject: input.title,
      issueType: input.issueType,
      priority: input.priority ? FRONTEND_PRIORITY_TO_BACKEND_MAP[input.priority] : undefined,
      category: input.category,
      orderRef: input.orderRef,
      expectedResult: input.expectedResult,
      actualResult: input.actualResult,
      reproductionSteps: input.reproductionSteps,
      contactPreference: input.contactPreference,
      tags: input.tags,
      sourceLabel: input.sourceLabel,
    },
  })
}

export const updateFeedbackInternalRemark = async (conversationId: string, content: string): Promise<FeedbackInternalRemarkRecord | null> => {
  const response = await request<{
    internalRemark: FeedbackInternalRemarkRecord | null
  }>({
    url: `/customer-service/conversations/${conversationId}/internal-remark`,
    method: 'PUT',
    data: { content },
  })
  return response.internalRemark
}

export const getCustomerServicePresence = async (): Promise<FeedbackServicePresence> => {
  return request<FeedbackServicePresence>({
    url: '/customer-service/presence',
    method: 'GET',
  })
}

export const openFeedbackRealtimeStream = (
  scope: 'client' | 'service',
  handlers: FeedbackRealtimeHandlers,
): FeedbackRealtimeConnection | null => {
  if (globalThis.window === undefined || globalThis.EventSource === undefined) {
    return null
  }

  const token = scope === 'client' ? getPersistedClientAuthToken() : getPersistedAuthToken()
  if (!token) {
    return null
  }

  const eventSource = new EventSource(buildStreamUrl(scope === 'client' ? '/client-feedback/stream' : '/customer-service/stream', token))

  eventSource.addEventListener('connected', (event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        availability?: FeedbackPortalAvailability
        session?: FeedbackRealtimeSessionSnapshot
      }
      handlers.onOpen?.(payload)
    } catch {
      handlers.onOpen?.({})
    }
  })

  eventSource.addEventListener('conversation', (event) => {
    try {
      handlers.onConversation?.(
        mapRealtimeConversationEvent(
          JSON.parse((event as MessageEvent<string>).data) as BackendRealtimeConversationEventPayload,
        ),
      )
    } catch {
      handlers.onConversation?.(null)
    }
  })

  eventSource.onerror = () => {
    handlers.onError?.()
  }

  return {
    close: () => eventSource.close(),
  }
}
