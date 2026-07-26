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

import { request, type RequestConfig } from '@/api/http'
import { compressImageForUpload } from '@/utils/image-upload'

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
export type FeedbackSatisfactionLevel = 'satisfied' | 'neutral' | 'unsatisfied'

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
  id?: string
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

/**
 * 反馈单满意度评价结构：
 * - 只描述当前单据最终的客户端感受，不参与消息流本身；
 * - 详情页与后续客服工作台可共用同一结构展示“已评价结果”。
 */
export interface FeedbackSatisfactionRecord {
  level: FeedbackSatisfactionLevel
  comment: string | null
  ratedAt: string
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
  clientAccountType: 'personal' | 'department'
  clientStaffNo: string | null
  clientDepartmentName: string | null
  assigneeUserId: string | null
  assigneeUsername: string | null
  assigneeName: string | null
  lastMessagePreview: string
  lastMessageSenderRole: FeedbackMessageSenderRole
  lastMessageAt: string
  unreadForClient: number
  unreadForStaff: number
  createdAt: string
  updatedAt: string
  fields: FeedbackIssueFields
  satisfaction: FeedbackSatisfactionRecord | null
  messages: FeedbackConversationMessage[]
  internalRemark: FeedbackInternalRemarkRecord | null
  isWithdrawnByClient: boolean
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
  slaRisk: number
}

/**
 * 离线 FAQ 统一条目结构：
 * - 同时服务于入口页、详情页与离线状态卡片，避免各页面重复定义问答项；
 * - 当前真实来源为系统配置 `customer_service.offline_faq_json`。
 */
export interface FeedbackFaqEntry {
  question: string
  answer: string
}

/**
 * 数据来源元信息：
 * - 用于在任务梳理阶段明确“字段从哪里来”，避免页面实现时再回头猜；
 * - 当前只覆盖 FAQ 与快捷回复两类需要显式声明来源的数据。
 */
export interface FeedbackDataSourceMeta {
  sourceKey: string
  sourceLabel: string
  owner: 'system_config' | 'frontend_local'
  remark: string
}

/**
 * 客户端会话分组采用“当前更需要谁动作”的口径，而不是简单照搬底层状态值。
 */
export type ClientFeedbackConversationGroupKey = 'waiting_client' | 'waiting_staff' | 'done'

export interface ClientFeedbackConversationGroupMeta {
  key: ClientFeedbackConversationGroupKey
  label: string
  description: string
  emptyText: string
}

export interface ClientFeedbackConversationGroup {
  key: ClientFeedbackConversationGroupKey
  label: string
  description: string
  emptyText: string
  count: number
  conversations: FeedbackConversationRecord[]
}

/**
 * 详情页“下一步提示”最小结构：
 * - stageLabel 负责说明当前阶段；
 * - recentAction 负责用一句话概括最近发生了什么；
 * - nextStep 负责告诉客户端现在最适合做什么。
 */
export interface ClientFeedbackNextStepPrompt {
  groupKey: ClientFeedbackConversationGroupKey
  groupLabel: string
  stageLabel: string
  recentAction: string
  nextStep: string
}

/**
 * 客服工作台快捷视图采用“固定语义视图 + 实时统计”的结构，便于后续直接绑定左侧快捷区。
 */
export type SupportWorkbenchQuickViewKey =
  | 'pending_acceptance'
  | 'mine_processing'
  | 'waiting_client_reply'
  | 'high_priority'
  | 'sla_risk'

export interface SupportWorkbenchQuickViewDefinition {
  key: SupportWorkbenchQuickViewKey
  label: string
  description: string
  count: number
}

/**
 * 快捷回复最小模板结构：
 * - key 用于稳定标识与埋点；
 * - content 为插入到输入框的模板正文；
 * - suggestedStatuses 仅作为默认推荐，不强制限制使用范围。
 */
export interface SupportQuickReplyTemplate {
  key: string
  label: string
  description: string
  content: string
  suggestedStatuses?: FeedbackIssueStatus[]
}

/**
 * 客服可转派目标最小结构：
 * - 只暴露接单/转派动作所需的识别信息；
 * - 避免把完整用户治理字段直接带进客服工作台页面。
 */
export interface SupportAssignableUser {
  id: string
  username: string
  displayName: string
  role: string
}

export type SupportFeedbackSlaLevel = 'normal' | 'warning' | 'overtime' | 'paused'

/**
 * 客服工作台 SLA 统一展示结构：
 * - 共享层负责把“阶段 + 时限 + 倒计时”转成页面可直接消费的口径；
 * - 页面只关心标签、文案和排序，不再各自重复写时间判断。
 */
export interface SupportFeedbackConversationSlaMeta {
  level: SupportFeedbackSlaLevel
  label: string
  stageLabel: string
  description: string
  countdownText: string
  targetMinutes: number | null
  elapsedMinutes: number
  remainingMinutes: number | null
  deadlineAt: string | null
  shouldHighlight: boolean
  sortWeight: number
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
  offlineFaqs: FeedbackFaqEntry[]
}

export interface FeedbackPortalConfig {
  enabled: boolean
  realtimeEnabled: boolean
  entryNotice: string
  workdayStart: string
  workdayEnd: string
  workdayWeekdays: number[]
  offlineNotice: string
  offlineFaqs: FeedbackFaqEntry[]
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

export interface SubmitClientFeedbackSatisfactionInput {
  level: FeedbackSatisfactionLevel
  comment?: string
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
  clientAccountType: 'personal' | 'department'
  staffNoSnapshot: string | null
  departmentNameSnapshot: string
  subject: string
  status: BackendConversationStatus
  priority: BackendConversationPriority
  assignedUserId: string | null
  assignedUsername: string | null
  assignedDisplayName: string | null
  lastMessagePreview: string
  lastMessageSenderType: 'client' | 'service' | 'system'
  lastMessageAt: string
  unreadForClientCount: number
  unreadForServiceCount: number
  createdAt: string
  updatedAt: string
  satisfaction?: FeedbackSatisfactionRecord | null
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

const WITHDRAWN_STATUS_META: FeedbackIssueStatusMeta = {
  label: '已撤回',
  className: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200',
  dotClassName: 'bg-slate-400',
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

export const FEEDBACK_SATISFACTION_META_MAP: Record<
  FeedbackSatisfactionLevel,
  { label: string; className: string; description: string }
> = {
  satisfied: {
    label: '满意',
    className: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
    description: '本次处理结果符合预期，问题已得到较好解决。',
  },
  neutral: {
    label: '一般',
    className: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200',
    description: '问题有推进，但处理体验或效率仍有改进空间。',
  },
  unsatisfied: {
    label: '不满意',
    className: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200',
    description: '当前结果未达到预期，仍希望继续优化处理体验。',
  },
}

export const FEEDBACK_STATUS_OPTIONS: Array<{ label: string; value: FeedbackIssueStatus }> = [
  { label: '待受理', value: 'pending' },
  { label: '处理中', value: 'processing' },
  { label: '已解决', value: 'resolved' },
  { label: '已关闭', value: 'closed' },
]

/**
 * FAQ 数据来源已经在后端系统配置中落地，前端只需要消费统一问答结构。
 */
export const FEEDBACK_OFFLINE_FAQ_SOURCE_META: FeedbackDataSourceMeta = {
  sourceKey: 'customer_service.offline_faq_json',
  sourceLabel: '客服离线 FAQ 系统配置',
  owner: 'system_config',
  remark: '由 backend/system-config.service.ts 提供默认值，并通过 portal-config / presence 接口下发到前端。',
}

/**
 * 快捷回复暂以共享 API 模块内的本地预置模板起步：
 * - 这样可以先满足 V1 的高频回复效率；
 * - 后续若迁移到系统配置，只需替换此来源与读取方式，不必改页面契约。
 */
export const SUPPORT_QUICK_REPLY_SOURCE_META: FeedbackDataSourceMeta = {
  sourceKey: 'customer_service_feedback.local_quick_reply_templates',
  sourceLabel: '客服快捷回复本地预置模板',
  owner: 'frontend_local',
  remark: '首批模板先在前端共享层维护，页面只消费统一模板数组。',
}

export const CLIENT_FEEDBACK_CONVERSATION_GROUP_META_MAP: Record<
  ClientFeedbackConversationGroupKey,
  ClientFeedbackConversationGroupMeta
> = {
  waiting_client: {
    key: 'waiting_client',
    label: '待我补充',
    description: '客服已经给出回复或处理结论，当前更需要你确认结果或继续补充说明。',
    emptyText: '当前没有需要你补充的反馈单。',
  },
  waiting_staff: {
    key: 'waiting_staff',
    label: '待客服处理',
    description: '你的问题已进入队列，客服会在当前反馈单里继续受理和回复。',
    emptyText: '当前没有等待客服处理的反馈单。',
  },
  done: {
    key: 'done',
    label: '已完成',
    description: '当前反馈单已完成或关闭，可作为历史记录留存查询。',
    emptyText: '当前还没有已完成的反馈单。',
  },
}

export const SUPPORT_WORKBENCH_QUICK_VIEW_META = [
  {
    key: 'pending_acceptance',
    label: '待受理',
    description: '尚未由客服正式接入的反馈单，优先用于首轮响应。',
  },
  {
    key: 'mine_processing',
    label: '我的处理中',
    description: '当前客服本人已接手且仍在处理中，便于连续跟进。',
  },
  {
    key: 'waiting_client_reply',
    label: '待客户回复',
    description: '客服已经给出阶段性处理结果，下一步更依赖客户确认或补充。',
  },
  {
    key: 'high_priority',
    label: '高优先级',
    description: '优先级为高或紧急的反馈单，用于快速聚焦影响更大的问题。',
  },
  {
    key: 'sla_risk',
    label: 'SLA 风险',
    description: '即将超时或已经超时的反馈单，优先用于抢救处理时效。',
  },
] as const satisfies Array<Omit<SupportWorkbenchQuickViewDefinition, 'count'>>

export const DEFAULT_SUPPORT_QUICK_REPLY_TEMPLATES: SupportQuickReplyTemplate[] = [
  {
    key: 'acknowledge_received',
    label: '已收到反馈',
    description: '用于首次接入或快速确认已接单。',
    content: '已收到你的反馈，我们正在核对相关信息，会尽快继续跟进。',
    suggestedStatuses: ['pending', 'processing'],
  },
  {
    key: 'request_more_context',
    label: '补充更多信息',
    description: '用于排查前补充时间、步骤、截图等上下文。',
    content: '为便于继续排查，请补充问题出现时间、操作步骤以及相关截图或订单号。',
    suggestedStatuses: ['processing', 'resolved'],
  },
  {
    key: 'processing_sync',
    label: '处理中同步',
    description: '用于告知问题仍在处理中，减少用户重复追问。',
    content: '当前问题已转入处理中，如有新进展我们会第一时间在当前反馈单同步给你。',
    suggestedStatuses: ['processing'],
  },
  {
    key: 'resolved_confirm',
    label: '请确认结果',
    description: '用于阶段性处理完成后引导用户确认是否恢复正常。',
    content: '处理方案已同步给你，请确认是否已恢复正常；如仍有问题，可直接在当前反馈单继续补充。',
    suggestedStatuses: ['resolved'],
  },
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

const normalizeLastMessageSenderRole = (
  senderType: BackendConversationSummary['lastMessageSenderType'],
): FeedbackMessageSenderRole => {
  return senderType === 'service' ? 'staff' : senderType
}

const WITHDRAW_MESSAGE_KEYWORD = '撤回'

const resolveIsWithdrawnByClient = (
  status: FeedbackIssueStatus,
  lastMessageSenderRole: FeedbackMessageSenderRole,
  lastMessagePreview: string,
): boolean => {
  if (status !== 'closed') {
    return false
  }
  if (lastMessageSenderRole !== 'system') {
    return false
  }
  return lastMessagePreview.includes(WITHDRAW_MESSAGE_KEYWORD)
}

export const resolveFeedbackConversationStatusMeta = (
  conversation: Pick<FeedbackConversationRecord, 'status' | 'isWithdrawnByClient'>,
): FeedbackIssueStatusMeta => {
  if (conversation.status === 'closed' && conversation.isWithdrawnByClient) {
    return WITHDRAWN_STATUS_META
  }
  return FEEDBACK_STATUS_META_MAP[conversation.status]
}

/**
 * 客户端当前更需要谁动作的最小判断规则：
 * - `closed` 直接视为完成；
 * - `resolved` 明确表示客服已给出结论，等待客户确认或补充；
 * - 其余状态若客户端存在未读，则说明客服最近有新回复，优先归入“待我补充”；
 * - 其他场景默认仍由客服继续处理。
 */
export const resolveClientFeedbackConversationGroupKey = (
  conversation: FeedbackConversationRecord,
): ClientFeedbackConversationGroupKey => {
  if (conversation.status === 'closed') {
    return 'done'
  }
  if (conversation.status === 'resolved' || conversation.unreadForClient > 0) {
    return 'waiting_client'
  }
  return 'waiting_staff'
}

export const buildClientFeedbackConversationGroups = (
  records: FeedbackConversationRecord[],
): ClientFeedbackConversationGroup[] => {
  return (['waiting_client', 'waiting_staff', 'done'] as const).map((groupKey) => {
    const meta = CLIENT_FEEDBACK_CONVERSATION_GROUP_META_MAP[groupKey]
    const conversations = records.filter((item) => resolveClientFeedbackConversationGroupKey(item) === groupKey)
    return {
      key: meta.key,
      label: meta.label,
      description: meta.description,
      emptyText: meta.emptyText,
      count: conversations.length,
      conversations,
    }
  })
}

/**
 * 详情页下一步提示统一从共享层生成，避免客户端列表页、详情页和后续卡片模块各写一套口径。
 */
export const buildClientFeedbackNextStepPrompt = (
  conversation: FeedbackConversationRecord,
): ClientFeedbackNextStepPrompt => {
  const groupKey = resolveClientFeedbackConversationGroupKey(conversation)
  const groupMeta = CLIENT_FEEDBACK_CONVERSATION_GROUP_META_MAP[groupKey]

  if (conversation.status === 'closed') {
    return {
      groupKey,
      groupLabel: groupMeta.label,
      stageLabel: '当前反馈单已完成',
      recentAction: '当前反馈单已经关闭，历史沟通记录会继续保留供你查询。',
      nextStep: '如果仍有新的问题或出现新的异常，请重新创建一条反馈单。',
    }
  }

  if (conversation.status === 'resolved') {
    return {
      groupKey,
      groupLabel: groupMeta.label,
      stageLabel: '等待你确认处理结果',
      recentAction: '客服已给出阶段性处理结论或解决建议，等待你确认是否恢复正常。',
      nextStep: '请先查看最新回复；如果问题仍未解决，可直接在当前反馈单继续补充说明。',
    }
  }

  if (conversation.unreadForClient > 0) {
    return {
      groupKey,
      groupLabel: groupMeta.label,
      stageLabel: '客服刚刚有新回复',
      recentAction: '客服在当前反馈单里补充了新的处理信息，系统正在提醒你查看。',
      nextStep: '建议先阅读最新消息；若客服需要更多信息，可直接在下方继续回复。',
    }
  }

  if (conversation.unreadForStaff > 0) {
    return {
      groupKey,
      groupLabel: groupMeta.label,
      stageLabel: '等待客服继续跟进',
      recentAction: '你最近补充了新的问题说明，当前会话已回到客服处理队列。',
      nextStep: '当前无需重复提交，保持消息畅通即可，客服会继续在本单内回复你。',
    }
  }

  if (conversation.status === 'processing') {
    return {
      groupKey,
      groupLabel: groupMeta.label,
      stageLabel: '客服处理中',
      recentAction: '客服已经接入当前反馈单，正在结合现有信息持续排查和处理。',
      nextStep: '暂时无需重复描述，若后续有新增现象或线索，可直接补充到当前反馈单。',
    }
  }

  return {
    groupKey,
    groupLabel: groupMeta.label,
    stageLabel: '等待客服受理',
    recentAction: '你的问题已经提交成功，系统正在等待客服正式接入。',
    nextStep: '请保留当前反馈单；如问题影响范围扩大，可补充更具体的时间、现象与订单信息。',
  }
}

const matchesSupportWorkbenchQuickView = (
  conversation: FeedbackConversationRecord,
  quickViewKey: SupportWorkbenchQuickViewKey,
  currentUserId?: string | null,
) => {
  if (quickViewKey === 'pending_acceptance') {
    return conversation.status === 'pending'
  }
  if (quickViewKey === 'mine_processing') {
    return conversation.status === 'processing' && Boolean(currentUserId) && conversation.assigneeUserId === currentUserId
  }
  if (quickViewKey === 'waiting_client_reply') {
    return resolveClientFeedbackConversationGroupKey(conversation) === 'waiting_client'
  }
  if (quickViewKey === 'sla_risk') {
    const slaMeta = resolveSupportFeedbackConversationSla(conversation)
    return slaMeta.level === 'warning' || slaMeta.level === 'overtime'
  }
  return conversation.priority === 'high' || conversation.priority === 'urgent'
}

export const buildSupportWorkbenchQuickViews = (
  records: FeedbackConversationRecord[],
  currentUserId?: string | null,
): SupportWorkbenchQuickViewDefinition[] => {
  return SUPPORT_WORKBENCH_QUICK_VIEW_META.map((item) => ({
    ...item,
    count: records.filter((record) => matchesSupportWorkbenchQuickView(record, item.key, currentUserId)).length,
  }))
}

export const filterSupportFeedbackConversationsByQuickView = (
  records: FeedbackConversationRecord[],
  quickViewKey: SupportWorkbenchQuickViewKey,
  currentUserId?: string | null,
): FeedbackConversationRecord[] => {
  return records.filter((record) => matchesSupportWorkbenchQuickView(record, quickViewKey, currentUserId))
}

/**
 * 将分钟数压缩为适合工作台卡片展示的短文案：
 * - 60 分钟内用“X 分钟”；
 * - 超过 60 分钟后切换为“X 小时 Y 分钟”，便于快速感知积压量级。
 */
const formatSlaDuration = (minutes: number) => {
  const safeMinutes = Math.max(0, Math.floor(minutes))
  if (safeMinutes < 60) {
    return `${safeMinutes} 分钟`
  }

  const hours = Math.floor(safeMinutes / 60)
  const remainMinutes = safeMinutes % 60
  if (remainMinutes === 0) {
    return `${hours} 小时`
  }
  return `${hours} 小时 ${remainMinutes} 分钟`
}

/**
 * 客服工作台 SLA 规则：
 * - `pending` 视为首响阶段，要求更快接单；
 * - `processing` 视为处理中跟进阶段，允许更长处理窗口；
 * - `resolved/closed` 当前主要等待客户端动作或已完结，不纳入客服时效风险。
 */
export const resolveSupportFeedbackConversationSla = (
  conversation: FeedbackConversationRecord,
): SupportFeedbackConversationSlaMeta => {
  if (conversation.status === 'closed' && conversation.isWithdrawnByClient) {
    return {
      level: 'paused',
      label: '当前不计时',
      stageLabel: '会话已撤回',
      description: '当前反馈单已由客户端撤回，会话已结束，不再纳入客服 SLA 风险。',
      countdownText: '已暂停',
      targetMinutes: null,
      elapsedMinutes: 0,
      remainingMinutes: null,
      deadlineAt: null,
      shouldHighlight: false,
      sortWeight: 0,
    }
  }

  if (conversation.status === 'resolved' || conversation.status === 'closed') {
    return {
      level: 'paused',
      label: '当前不计时',
      stageLabel: conversation.status === 'resolved' ? '等待客户确认' : '会话已关闭',
      description: conversation.status === 'resolved' ? '当前阶段主要等待客户确认结果或继续补充。' : '当前会话已结束，不再纳入客服 SLA 风险。', // eslint-disable-line max-len
      countdownText: '已暂停',
      targetMinutes: null,
      elapsedMinutes: 0,
      remainingMinutes: null,
      deadlineAt: null,
      shouldHighlight: false,
      sortWeight: 0,
    }
  }

  const stageLabel = conversation.status === 'pending' ? '待接单首响' : '处理中跟进'
  const targetMinutes = conversation.status === 'pending' ? 15 : 240
  const warningMinutes = conversation.status === 'pending' ? 5 : 60
  const referenceTime = Date.parse(conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt)
  const now = Date.now()
  const safeReferenceTime = Number.isFinite(referenceTime) ? referenceTime : now
  const elapsedMinutes = Math.max(0, Math.floor((now - safeReferenceTime) / 60000))
  const remainingMinutes = targetMinutes - elapsedMinutes
  const deadlineAt = new Date(safeReferenceTime + targetMinutes * 60000).toISOString()

  if (remainingMinutes < 0) {
    return {
      level: 'overtime',
      label: '已超时',
      stageLabel,
      description: `当前阶段已超时 ${formatSlaDuration(Math.abs(remainingMinutes))}，建议立即接单、回复或转派。`,
      countdownText: `超时 ${formatSlaDuration(Math.abs(remainingMinutes))}`,
      targetMinutes,
      elapsedMinutes,
      remainingMinutes,
      deadlineAt,
      shouldHighlight: true,
      sortWeight: 3,
    }
  }

  if (remainingMinutes <= warningMinutes) {
    return {
      level: 'warning',
      label: '即将超时',
      stageLabel,
      description: `距离当前阶段超时还有 ${formatSlaDuration(remainingMinutes)}，建议优先处理。`,
      countdownText: `剩余 ${formatSlaDuration(remainingMinutes)}`,
      targetMinutes,
      elapsedMinutes,
      remainingMinutes,
      deadlineAt,
      shouldHighlight: true,
      sortWeight: 2,
    }
  }

  return {
    level: 'normal',
    label: '时效正常',
    stageLabel,
    description: `距离当前阶段超时还有 ${formatSlaDuration(remainingMinutes)}。`,
    countdownText: `剩余 ${formatSlaDuration(remainingMinutes)}`,
    targetMinutes,
    elapsedMinutes,
    remainingMinutes,
    deadlineAt,
    shouldHighlight: false,
    sortWeight: 1,
  }
}

/**
 * 客服列表排序优先级：
 * - 先按 SLA 风险暴露真正需要马上处理的单据；
 * - 再按剩余时间与最近消息时间排序，减少高风险单据被普通新消息淹没。
 */
export const compareSupportFeedbackConversationPriority = (
  left: FeedbackConversationRecord,
  right: FeedbackConversationRecord,
) => {
  const leftSla = resolveSupportFeedbackConversationSla(left)
  const rightSla = resolveSupportFeedbackConversationSla(right)

  if (leftSla.sortWeight !== rightSla.sortWeight) {
    return rightSla.sortWeight - leftSla.sortWeight
  }

  if (leftSla.remainingMinutes !== rightSla.remainingMinutes) {
    if (leftSla.remainingMinutes == null) {
      return 1
    }
    if (rightSla.remainingMinutes == null) {
      return -1
    }
    return leftSla.remainingMinutes - rightSla.remainingMinutes
  }

  return right.lastMessageAt.localeCompare(left.lastMessageAt)
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
  const status = BACKEND_STATUS_TO_FRONTEND_MAP[conversation.status]
  const lastMessageSenderRole = normalizeLastMessageSenderRole(conversation.lastMessageSenderType)
  const lastMessagePreview = conversation.lastMessagePreview || ''

  return {
    id: conversation.id,
    issueNo: conversation.conversationNo,
    title: conversation.subject,
    summary: conversation.fields.actualResult || conversation.subject,
    status,
    priority: BACKEND_PRIORITY_TO_FRONTEND_MAP[conversation.priority],
    clientUserId: conversation.clientUserId,
    clientAccount: conversation.clientAccount,
    clientDisplayName: conversation.clientUsername || conversation.clientAccount || '客户端用户',
    clientAccountType: conversation.clientAccountType === 'department' ? 'department' : 'personal',
    clientStaffNo: conversation.staffNoSnapshot?.trim() || null,
    clientDepartmentName: conversation.departmentNameSnapshot || null,
    assigneeUserId: conversation.assignedUserId ?? null,
    assigneeUsername: conversation.assignedUsername ?? null,
    assigneeName: conversation.assignedDisplayName || null,
    lastMessagePreview,
    lastMessageSenderRole,
    lastMessageAt: conversation.lastMessageAt,
    unreadForClient: conversation.unreadForClientCount,
    unreadForStaff: conversation.unreadForServiceCount,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    satisfaction: conversation.satisfaction ?? null,
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
    isWithdrawnByClient: resolveIsWithdrawnByClient(status, lastMessageSenderRole, lastMessagePreview),
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

const resolveApiOrigin = () => {
  const apiBaseUrl = buildApiBaseUrl()
  if (/^https?:\/\//.test(apiBaseUrl)) {
    return new URL(apiBaseUrl).origin
  }
  return globalThis.window?.location.origin ?? ''
}

const buildStreamUrl = (path: string) => {
  const apiBaseUrl = buildApiBaseUrl()
  const base = /^https?:\/\//.test(apiBaseUrl)
    ? apiBaseUrl
    : new URL(apiBaseUrl, globalThis.window.location.origin).toString()
  const url = new URL(path.replace(/^\//, ''), `${base.replace(/\/$/, '')}/`)
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
    unassigned: records.filter((item) => !item.assigneeUserId).length,
    waitingClientReply: records.filter((item) => matchesSupportWorkbenchQuickView(item, 'waiting_client_reply')).length,
    waitingStaffReply: records.filter((item) => resolveClientFeedbackConversationGroupKey(item) === 'waiting_staff').length,
    slaRisk: records.filter((item) => {
      const slaMeta = resolveSupportFeedbackConversationSla(item)
      return slaMeta.level === 'warning' || slaMeta.level === 'overtime'
    }).length,
  }
}

/**
 * 统一把后端返回的相对附件地址解析成前端可直接访问的 URL：
 * - 同源部署时直接保留 `/uploads/...`；
 * - API 独立域名部署时自动补齐资源域名来源，避免详情页缩略图与新窗口预览失效。
 */
export const resolveFeedbackAttachmentUrl = (url?: string | null) => {
  const normalizedUrl = url?.trim()
  if (!normalizedUrl) {
    return ''
  }
  if (/^https?:\/\//.test(normalizedUrl)) {
    return normalizedUrl
  }
  const origin = resolveApiOrigin()
  return origin ? new URL(normalizedUrl.replace(/^\//, ''), `${origin}/`).toString() : normalizedUrl
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

/**
 * 获取客户端反馈详情：
 * - 允许页面透传 `signal`，供自动刷新、路由切换与显式动作并发时取消旧请求；
 * - 这样可以与稳定请求通道配合，避免旧详情在更晚返回后覆盖当前页面状态。
 */
export const getClientFeedbackConversation = async (
  conversationId: string,
  requestConfig: RequestConfig = {},
): Promise<FeedbackConversationRecord | null> => {
  const response = await request<BackendConversationDetail>({
    ...requestConfig,
    url: `/client-feedback/conversations/${conversationId}`,
    method: 'GET',
  })
  return mapConversation(
    response.conversation,
    response.messages.filter((item) => !item.internalOnly).map(mapMessage),
    null,
  )
}

export const uploadClientFeedbackAttachment = async (file: File): Promise<FeedbackConversationMessageAttachment> => {
  const { file: normalizedUploadFile } = await compressImageForUpload(file)
  const formData = new FormData()
  formData.append('file', normalizedUploadFile)
  const response = await request<{
    attachment: FeedbackConversationMessageAttachment
  }>({
    url: '/client-feedback/attachments',
    method: 'POST',
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  })
  return response.attachment
}

export const createClientFeedbackConversation = async (input: CreateClientFeedbackConversationInput): Promise<FeedbackConversationRecord> => {
  const normalizedSummary = input.summary?.trim()
  if (!normalizedSummary) {
    throw new Error('反馈内容不能为空')
  }

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
      content: normalizedSummary,
      orderRef: input.orderRef,
      expectedResult: input.expectedResult,
      actualResult: input.actualResult,
      reproductionSteps: input.reproductionSteps,
      contactPreference: input.contactPreference,
      tags: input.tags,
      sourceLabel: '客户端反馈页',
      attachments: (input.attachments ?? []).map((attachment) => ({ id: attachment.id })),
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
      attachments: (input.attachments ?? []).map((attachment) => ({ id: attachment.id })),
    },
  })
}

export const confirmClientFeedbackResolved = async (
  conversationId: string,
): Promise<void> => {
  await request({
    url: `/client-feedback/conversations/${conversationId}/confirm-resolved`,
    method: 'PATCH',
  })
}

export const withdrawClientFeedbackConversation = async (
  conversationId: string,
): Promise<void> => {
  await request({
    url: `/client-feedback/conversations/${conversationId}/withdraw`,
    method: 'PATCH',
  })
}

export const submitClientFeedbackSatisfaction = async (
  conversationId: string,
  input: SubmitClientFeedbackSatisfactionInput,
): Promise<FeedbackSatisfactionRecord | null> => {
  const response = await request<{
    satisfaction: FeedbackSatisfactionRecord | null
  }>({
    url: `/client-feedback/conversations/${conversationId}/satisfaction`,
    method: 'POST',
    data: {
      level: input.level,
      comment: input.comment,
    },
  })
  return response.satisfaction
}

export const listSupportFeedbackConversations = async (
  query: SupportFeedbackListQuery = {},
  requestConfig: RequestConfig = {},
): Promise<FeedbackConversationRecord[]> => {
  const response = await request<BackendListResult<BackendConversationSummary>>({
    ...requestConfig,
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

export const getSupportFeedbackConversation = async (
  conversationId: string,
  requestConfig: RequestConfig = {},
): Promise<FeedbackConversationRecord | null> => {
  const response = await request<BackendConversationDetail>({
    ...requestConfig,
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

export const getCustomerServicePresence = async (requestConfig: RequestConfig = {}): Promise<FeedbackServicePresence> => {
  return request<FeedbackServicePresence>({
    ...requestConfig,
    url: '/customer-service/presence',
    method: 'GET',
  })
}

/**
 * 转派目标统一走客服域接口：
 * - 避免客服工作台依赖管理员专用的用户治理接口权限；
 * - 后端会提前过滤不可接单的角色与停用账号。
 */
export const listSupportAssignableUsers = async (requestConfig: RequestConfig = {}): Promise<SupportAssignableUser[]> => {
  return request<SupportAssignableUser[]>({
    ...requestConfig,
    url: '/customer-service/assignees',
    method: 'GET',
  })
}

/**
 * 显式更新负责人：
 * - 当前客服接单时传自己的用户 ID；
 * - 转派时传目标客服用户 ID，负责人变更与系统轨迹统一由后端收口。
 */
export const updateSupportConversationAssignee = async (conversationId: string, assigneeUserId: string): Promise<void> => {
  await request({
    url: `/customer-service/conversations/${conversationId}/assignee`,
    method: 'PATCH',
    data: {
      assigneeUserId,
    },
  })
}

export const openFeedbackRealtimeStream = (
  scope: 'client' | 'service',
  handlers: FeedbackRealtimeHandlers,
): FeedbackRealtimeConnection | null => {
  if (globalThis.window === undefined || globalThis.EventSource === undefined) {
    return null
  }

  /**
   * 实时流鉴权策略：
   * - 客户端和管理端都依赖浏览器自动附带的安全 Cookie，不再把 token 放进 URL；
   * - `withCredentials` 便于未来切到独立 API 域名时继续携带 Cookie；
   * - 历史 `access_token` 查询参数已停用，避免日志、引用页和浏览器历史泄露会话。
   */
  const eventSource = new EventSource(
    buildStreamUrl(scope === 'client' ? '/client-feedback/stream' : '/customer-service/stream'),
    {
      withCredentials: true,
    },
  )

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
