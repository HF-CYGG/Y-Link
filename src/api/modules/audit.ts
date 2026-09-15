/**
 * 模块说明：审计日志治理 API 模块。
 * 文件职责：封装审计日志分页查询与导出能力，统一筛选参数与日志列表返回结构。
 * 维护说明：维护时重点关注时间范围筛选口径、导出接口参数复用与日志字段可空值兼容。
 */

import { http, request, type RequestConfig } from '@/api/http'
import type { PaginationQueryInput, PaginationResult } from '@/types/api'

/**
 * 审计日志查询参数：
 * - 与后端列表接口保持一致；
 * - startAt/endAt 用于本期新增的时间范围检索与导出筛选。
 */
export type AuditCategoryKey =
  | 'auth'
  | 'order_outbound'
  | 'inbound_supply'
  | 'product_inventory'
  | 'customer_service'
  | 'notification'
  | 'user_permission'
  | 'system_config'
  | 'data_database'
  | 'other'

/** 业务类别重要程度：审计业务类别与通知事件业务分类共用，由后端目录统一维护。 */
export type CategoryImportanceLevel = 'critical' | 'high' | 'normal' | 'low'

export interface AuditLogListQuery extends PaginationQueryInput {
  /** 业务类别：一级筛选，类别与动作映射由后端统一维护。 */
  category?: AuditCategoryKey
  actionType?: string
  targetType?: string
  actorUserId?: string
  targetId?: string
  startAt?: string
  endAt?: string
}

/**
 * 审计日志记录：
 * - 字段与后端实体保持基本一致；
 * - detailJson 保留字符串，页面层按需安全解析展示。
 */
export interface AuditLogRecord {
  id: string
  actionType: string
  actionLabel: string
  actorUserId: string | null
  actorUsername: string | null
  actorDisplayName: string | null
  targetType: string
  targetId: string | null
  targetCode: string | null
  resultStatus: 'success' | 'failed'
  detailJson: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  /** 后端按动作目录与前缀规则归类，未登记动作为 other。 */
  category: AuditCategoryKey
  categoryLabel: string
  categoryLevel: CategoryImportanceLevel
  actionTypeLabel: string
  targetTypeLabel: string
}

/**
 * 审计筛选项：
 * - categories 内含该类别下的操作类型，用于“业务类别 → 操作类型”二级联动；
 * - defaultHiddenActionTypes 为未选类别/操作类型时默认隐藏的通知内部处理动作。
 */
export interface AuditFilterOptions {
  categories: Array<{
    key: AuditCategoryKey
    label: string
    level: CategoryImportanceLevel
    actionTypes: Array<{ value: string; label: string }>
  }>
  targetTypes: Array<{ value: string; label: string }>
  defaultHiddenActionTypes: string[]
  notificationEvent: NotificationEventFilterOptions
}

export type NotificationEventCategoryKey = 'order' | 'customer_service' | 'security' | 'system'
export type NotificationEventResultStatus =
  | 'pending'
  | 'retrying'
  | 'processing'
  | 'success'
  | 'partial_failed'
  | 'failed'
  | 'internal_only'
export type NotificationDispatchChannel = 'email' | 'feishu'

export interface NotificationEventFilterOptions {
  categories: Array<{
    key: NotificationEventCategoryKey
    label: string
    level: CategoryImportanceLevel
    eventTypes: Array<{ value: string; label: string }>
  }>
  resultStatuses: Array<{ value: NotificationEventResultStatus; label: string }>
  channels: Array<{ value: NotificationDispatchChannel; label: string }>
}

export interface NotificationEventLogQuery extends PaginationQueryInput {
  category?: NotificationEventCategoryKey
  eventType?: string
  resultStatus?: NotificationEventResultStatus
  channel?: NotificationDispatchChannel
  eventId?: string
  startAt?: string
  endAt?: string
}

export interface NotificationChannelDispatchSummary {
  total: number
  sent: number
  failed: number
  pending: number
}

/**
 * 通知事件主记录：
 * - 同一 eventId 只对应一条记录；
 * - resultStatus 由事件状态与实际外发状态推导，“外发成功”不再等同于审计写入成功。
 */
export interface NotificationEventLogRecord {
  id: string
  eventType: string
  eventTypeLabel: string
  category: NotificationEventCategoryKey
  categoryLabel: string
  categoryLevel: CategoryImportanceLevel
  sourceType: string
  sourceId: string
  summary: string
  sourceUserDisplayName: string | null
  status: 'pending' | 'processing' | 'processed' | 'failed'
  attemptCount: number
  maxAttempts: number
  nextAttemptAt: string | null
  processedAt: string | null
  errorMessage: string | null
  resultStatus: NotificationEventResultStatus
  resultLabel: string
  dispatchSummary: Record<NotificationDispatchChannel, NotificationChannelDispatchSummary>
  inboxRecipientCount: number
  createdAt: string
  updatedAt: string
}

export interface NotificationEventLogDetail {
  event: NotificationEventLogRecord
  dispatches: Array<{
    id: string
    channel: NotificationDispatchChannel
    channelLabel: string
    target: string
    status: 'pending' | 'processing' | 'sent' | 'failed'
    attemptCount: number
    maxAttempts: number
    responseCode: number | null
    errorMessage: string | null
    sentAt: string | null
    lastAttemptAt: string | null
    createdAt: string
  }>
  processingAttempts: Array<{
    attemptNo: number
    occurredAt: string
    rules: Array<{
      ruleId: string
      ruleCode: string | null
      ruleName: string | null
      matchedAt: string | null
      externalTriggerMode: string | null
      externalAllowed: boolean | null
      recipientCount: number
      dispatch: null | {
        resultStatus: 'success' | 'failed'
        skipped: string | null
        emailSent: number
        emailAlreadySent: number
        emailFailed: number
        feishuSent: number
        feishuAlreadySent: number
        feishuFailed: number
        occurredAt: string
      }
    }>
  }>
  failureAudits: Array<{
    id: string
    createdAt: string
    attemptCount: number
    errorMessage: string | null
  }>
}

interface AuditLogListRawResult {
  page: number
  pageSize: number
  total: number
  list: AuditLogRecord[]
}

/**
 * 审计日志分页结果：
 * - 标准化为 records 供页面复用统一分页工具；
 * - 避免日志页再单独写一套 list 兼容逻辑。
 */
export type AuditLogListResult = PaginationResult<AuditLogRecord>

/**
 * 获取审计日志分页列表：
 * - 与页面当前筛选项一一对应；
 * - 导出接口会复用同一套查询参数，确保口径一致。
 */
export const getAuditLogList = async (
  params: AuditLogListQuery,
  requestConfig: RequestConfig = {},
): Promise<AuditLogListResult> => {
  const result = await request<AuditLogListRawResult>({
    ...requestConfig,
    method: 'GET',
    url: '/audit-logs',
    params,
  })

  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    records: result.list,
  }
}

/** 通知事件主列表：按 eventId 聚合，每个业务事件只返回一条主记录。 */
export const getNotificationEventLogList = async (
  params: NotificationEventLogQuery,
  requestConfig: RequestConfig = {},
): Promise<PaginationResult<NotificationEventLogRecord>> => {
  const result = await request<{ page: number; pageSize: number; total: number; list: NotificationEventLogRecord[] }>({
    ...requestConfig,
    method: 'GET',
    url: '/audit-logs/notification-events',
    params,
  })
  return {
    page: result.page,
    pageSize: result.pageSize,
    total: result.total,
    records: result.list,
  }
}

/** 通知事件详情：外发明细、处理轮次与终态失败记录。 */
export const getNotificationEventLogDetail = (eventId: string, requestConfig: RequestConfig = {}) =>
  request<NotificationEventLogDetail>({
    ...requestConfig,
    method: 'GET',
    url: `/audit-logs/notification-events/${encodeURIComponent(eventId)}`,
  })

/** 获取审计筛选项：业务类别、类别下操作类型与目标对象中文名。 */
export const getAuditLogFilterOptions = (requestConfig: RequestConfig = {}) =>
  request<AuditFilterOptions>({
    ...requestConfig,
    method: 'GET',
    url: '/audit-logs/filter-options',
  })

/**
 * 导出审计日志：
 * - 直接返回文件二进制与文件名；
 * - 调用方只需传入当前筛选条件，即可导出“当前筛选结果”。
 */
export const exportAuditLogs = async (params: AuditLogListQuery) => {
  const response = await http.request<Blob>({
    method: 'GET',
    url: '/audit-logs/export',
    params,
    responseType: 'blob',
  })

  const disposition = response.headers['content-disposition']
  const fileNamePattern = /filename="?([^";]+)"?/
  const matchedFileName = typeof disposition === 'string' ? fileNamePattern.exec(disposition) : null

  return {
    blob: response.data,
    fileName: matchedFileName?.[1] ?? 'audit-logs.csv',
  }
}
