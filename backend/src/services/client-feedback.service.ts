/**
 * 模块说明：backend/src/services/client-feedback.service.ts
 * 文件职责：统一承载客户端反馈与客服中心业务，包括建单、回复、状态流转、已读处理与实时事件发布。
 * 实现逻辑：
 * - 以“会话表 + 消息表”组织反馈中心数据，既能支持客户端提交反馈，也能支持客服中心持续跟进；
 * - 所有关键写操作统一通过事务收口，确保会话摘要、未读计数、消息明细与审计日志保持一致；
 * - 实时能力先采用进程内 SSE 广播，仅解决单实例下的基础即时通知需求。
 * 维护说明：
 * - 若未来接入多客服排班、自动分配或机器人分流，应优先在本服务中扩展领域方法，不要把规则散落到路由层；
 * - 若前端需要独立的会话标签、附件或评价体系，请在现有会话/消息模型上平滑扩展，避免破坏当前接口语义。
 */

import { In, LessThan, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { resolvePermissionsByRole } from '../constants/auth-permissions.js'
import {
  ClientFeedbackConversation,
  CLIENT_FEEDBACK_CONVERSATION_STATUSES,
  CLIENT_FEEDBACK_ISSUE_TYPES,
  CLIENT_FEEDBACK_LAST_SENDER_TYPES,
  CLIENT_FEEDBACK_PRIORITIES,
  CLIENT_FEEDBACK_SATISFACTION_LEVELS,
  type ClientFeedbackIssueType,
  type ClientFeedbackConversationIssueTag,
  type ClientFeedbackConversationStatus,
  type ClientFeedbackPriority,
  type ClientFeedbackSatisfactionLevel,
} from '../entities/client-feedback-conversation.entity.js'
import {
  ClientFeedbackMessage,
  type ClientFeedbackMessageAttachment,
  type ClientFeedbackMessageType,
  type ClientFeedbackSenderType,
} from '../entities/client-feedback-message.entity.js'
import { ClientUser } from '../entities/client-user.entity.js'
import { SysUser } from '../entities/sys-user.entity.js'
import type { AuthUserContext } from '../types/auth.js'
import type { ClientAuthContext } from '../types/client-auth.js'
import { isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import {
  customerServiceRealtimeService,
  type CustomerServiceRealtimeEventPayload,
  type CustomerServiceRealtimeSessionSnapshot,
} from './customer-service-realtime.service.js'
import { systemConfigService } from './system-config.service.js'
import { notificationService } from './notification.service.js'
import { ClientFeedbackAttachment } from '../entities/client-feedback-attachment.entity.js'

export const CLIENT_FEEDBACK_SUBJECT_MAX_LENGTH = 128
export const CLIENT_FEEDBACK_CATEGORY_MAX_LENGTH = 32
export const CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH = 4000
export const CLIENT_FEEDBACK_ORDER_REF_MAX_LENGTH = 64
export const CLIENT_FEEDBACK_CONTACT_PREFERENCE_MAX_LENGTH = 64
export const CLIENT_FEEDBACK_SOURCE_LABEL_MAX_LENGTH = 64
export const CLIENT_FEEDBACK_INTERNAL_REMARK_MAX_LENGTH = 4000
export const CLIENT_FEEDBACK_ATTACHMENT_NAME_MAX_LENGTH = 128
export const CLIENT_FEEDBACK_ATTACHMENT_URL_MAX_LENGTH = 1000
export const CLIENT_FEEDBACK_ATTACHMENT_MIME_TYPE_MAX_LENGTH = 128
export const CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE = 9
export const CLIENT_FEEDBACK_MAX_TAGS = 10
export const CLIENT_FEEDBACK_MAX_TAG_LENGTH = 24
export const CLIENT_FEEDBACK_SATISFACTION_COMMENT_MAX_LENGTH = 300

const FEEDBACK_CONVERSATION_NO_UNIQUE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_client_feedback_conversation_no',
  sqliteColumns: ['client_feedback_conversation.conversation_no'],
} as const

export interface ClientFeedbackConversationSummary {
  id: string
  conversationNo: string
  clientUserId: string
  clientUsername: string
  clientAccount: string
  clientAccountType: ClientUser['accountType']
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
  lastMessageSenderType: (typeof CLIENT_FEEDBACK_LAST_SENDER_TYPES)[number]
  lastMessageAt: Date
  unreadForClientCount: number
  unreadForServiceCount: number
  closedAt: Date | null
  fields: ClientFeedbackConversationFields
  satisfaction: ClientFeedbackSatisfactionView | null
  createdAt: Date
  updatedAt: Date
  assignedToCurrentUser?: boolean
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

export interface ClientFeedbackMessageView {
  id: string
  conversationId: string
  senderType: ClientFeedbackSenderType
  senderUserId: string | null
  senderName: string
  messageType: ClientFeedbackMessageType
  internalOnly: boolean
  content: string
  attachments: ClientFeedbackMessageAttachment[]
  clientReadAt: Date | null
  serviceReadAt: Date | null
  createdAt: Date
  mine: boolean
}

export interface ClientFeedbackInternalRemarkView {
  content: string
  updatedAt: Date | null
  updatedByUserId: string | null
  updatedByUsername: string | null
  updatedByDisplayName: string | null
}

export interface ClientFeedbackSatisfactionView {
  level: ClientFeedbackSatisfactionLevel
  comment: string | null
  ratedAt: Date
}

export interface ClientFeedbackConversationDetail {
  conversation: ClientFeedbackConversationSummary
  messages: ClientFeedbackMessageView[]
  internalRemark?: ClientFeedbackInternalRemarkView | null
}

export interface CustomerServiceFaqItem {
  question: string
  answer: string
}

export interface CustomerServiceAvailabilityRecord {
  status: 'online' | 'offline'
  reason: 'within_work_hours' | 'outside_work_hours' | 'no_online_staff'
  isOnline: boolean
  withinWorkHours: boolean
  hasOnlineStaff: boolean
  serviceConnectedCount: number
  serverTime: string
  workHoursText: string
  offlineNotice: string
  offlineFaqs: CustomerServiceFaqItem[]
}

export interface ClientFeedbackPortalConfigRecord {
  enabled: boolean
  realtimeEnabled: boolean
  entryNotice: string
  workdayStart: string
  workdayEnd: string
  workdayWeekdays: number[]
  offlineNotice: string
  offlineFaqs: CustomerServiceFaqItem[]
  sseKeepaliveSeconds: number
  availability: CustomerServiceAvailabilityRecord
  updatedAt: Date
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
  attachments?: ClientFeedbackMessageAttachment[]
}

export interface AppendClientFeedbackMessageInput {
  content: string
  attachments?: ClientFeedbackMessageAttachment[]
}

export interface ClientFeedbackListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: ClientFeedbackConversationStatus
}

export interface CustomerServiceConversationListQuery extends ClientFeedbackListQuery {
  assignedToMe?: boolean
  unreadOnly?: boolean
  priority?: ClientFeedbackPriority
}

export interface AppendCustomerServiceMessageInput {
  content: string
  attachments?: ClientFeedbackMessageAttachment[]
}

/**
 * 接单/转派统一入参：
 * - 当前客服接单时直接传自己的用户 ID；
 * - 转派时传目标客服用户 ID，避免路由层拆出两套近似结构。
 */
export interface UpdateCustomerServiceConversationAssigneeInput {
  assigneeUserId: string
}

export interface UpdateCustomerServiceConversationStatusInput {
  status: ClientFeedbackConversationStatus
}

export interface UpdateCustomerServiceIssueFieldsInput {
  issueType?: ClientFeedbackIssueType
  subject?: string
  category?: string
  priority?: ClientFeedbackPriority
  orderRef?: string | null
  expectedResult?: string
  actualResult?: string
  reproductionSteps?: string | null
  contactPreference?: string | null
  tags?: string[]
  sourceLabel?: string
}

export interface UpdateCustomerServiceInternalRemarkInput {
  content: string
}

export interface SubmitClientFeedbackSatisfactionInput {
  level: ClientFeedbackSatisfactionLevel
  comment?: string
}

/**
 * 客服工作台可选负责人结构：
 * - 仅保留转派选择所需字段；
 * - 不暴露密码、最后登录等与客服处理无关的信息。
 */
export interface CustomerServiceAssignableUser {
  id: string
  username: string
  displayName: string
  role: string
}

type ConversationMessageWriter =
  | {
      senderType: 'client'
      senderUserId: string
      senderName: string
      conversationStatus: ClientFeedbackConversationStatus
    }
  | {
      senderType: 'service'
      senderUserId: string
      senderName: string
      conversationStatus: ClientFeedbackConversationStatus
    }
  | {
      senderType: 'system'
      senderUserId: null
      senderName: string
      conversationStatus: ClientFeedbackConversationStatus
    }

class ClientFeedbackService {
  private readonly conversationRepo = AppDataSource.getRepository(ClientFeedbackConversation)

  private readonly clientUserRepo = AppDataSource.getRepository(ClientUser)

  private readonly sysUserRepo = AppDataSource.getRepository(SysUser)

  private readonly attachmentRepo = AppDataSource.getRepository(ClientFeedbackAttachment)

  async createClientAttachment(input: {
    storageName: string
    originalName: string
    mimeType: string | null
    sizeBytes: number | null
  }, clientAuth: ClientAuthContext) {
    await this.attachmentRepo.delete({ expiresAt: LessThan(new Date()) })
    const attachment = await this.attachmentRepo.save(this.attachmentRepo.create({
      ownerClientUserId: clientAuth.userId,
      conversationId: null,
      messageId: null,
      storageName: input.storageName,
      originalName: input.originalName.slice(0, 255),
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }))
    return {
      id: String(attachment.id),
      name: attachment.originalName,
      url: `/api/client-feedback/attachments/${attachment.id}`,
      mimeType: attachment.mimeType,
      size: attachment.sizeBytes,
      expiresAt: attachment.expiresAt,
    }
  }

  async resolveOwnedAttachmentReferences(ids: string[], clientAuth: ClientAuthContext): Promise<ClientFeedbackMessageAttachment[]> {
    const normalizedIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    if (!normalizedIds.length) return []
    const rows = await this.attachmentRepo.find({ where: { id: In(normalizedIds) } })
    const now = new Date()
    if (rows.length !== normalizedIds.length || rows.some((row) => String(row.ownerClientUserId) !== String(clientAuth.userId) || Boolean(row.messageId) || (row.expiresAt && row.expiresAt <= now))) {
      throw new BizError('反馈附件不存在、已过期或无权使用', 403)
    }
    const byId = new Map(rows.map((row) => [String(row.id), row]))
    return normalizedIds.map((id) => {
      const row = byId.get(id)!
      return {
        name: row.originalName,
        url: `/api/client-feedback/attachments/${row.id}`,
        mimeType: row.mimeType,
        size: row.sizeBytes,
      }
    })
  }

  async getAttachmentForClient(id: string, clientAuth: ClientAuthContext) {
    const attachment = await this.attachmentRepo.findOne({ where: { id, ownerClientUserId: clientAuth.userId } })
    if (!attachment || (attachment.expiresAt && attachment.expiresAt <= new Date())) throw new BizError('反馈附件不存在', 404)
    return attachment
  }

  async getAttachmentForCustomerService(id: string) {
    const attachment = await this.attachmentRepo.findOne({ where: { id } })
    if (!attachment) throw new BizError('反馈附件不存在', 404)
    return attachment
  }

  private parseJsonArray<T>(rawValue: string | null | undefined, fallback: T[]): T[] {
    const text = rawValue?.trim()
    if (!text) {
      return fallback
    }
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? (parsed as T[]) : fallback
    } catch {
      return fallback
    }
  }

  private normalizeOptionalLongText(value: string | null | undefined, fieldLabel: string, maxLength = CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH) {
    const normalized = value?.trim() || ''
    if (!normalized) {
      return null
    }
    if (normalized.length > maxLength) {
      throw new BizError(`${fieldLabel}长度不能超过 ${maxLength} 个字符`, 400)
    }
    return normalized
  }

  private normalizeOptionalShortText(value: string | null | undefined, fieldLabel: string, maxLength: number) {
    return this.normalizeOptionalLongText(value, fieldLabel, maxLength)
  }

  private normalizeSourceLabel(value?: string) {
    const normalized = value?.trim() || '客户端反馈页'
    if (!normalized) {
      throw new BizError('来源入口不能为空', 400)
    }
    if (normalized.length > CLIENT_FEEDBACK_SOURCE_LABEL_MAX_LENGTH) {
      throw new BizError(`来源入口长度不能超过 ${CLIENT_FEEDBACK_SOURCE_LABEL_MAX_LENGTH} 个字符`, 400)
    }
    return normalized
  }

  private normalizeTags(tags?: string[]) {
    const input = Array.isArray(tags) ? tags : []
    const normalized = Array.from(
      new Set(
        input
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => {
            if (item.length > CLIENT_FEEDBACK_MAX_TAG_LENGTH) {
              throw new BizError(`问题标签长度不能超过 ${CLIENT_FEEDBACK_MAX_TAG_LENGTH} 个字符`, 400)
            }
            return item
          }),
      ),
    )
    if (normalized.length > CLIENT_FEEDBACK_MAX_TAGS) {
      throw new BizError(`问题标签数量不能超过 ${CLIENT_FEEDBACK_MAX_TAGS} 个`, 400)
    }
    return normalized
  }

  private normalizeAttachments(attachments?: ClientFeedbackMessageAttachment[]) {
    const input = Array.isArray(attachments) ? attachments : []
    if (input.length > CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new BizError(`单条消息附件数量不能超过 ${CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE} 个`, 400)
    }
    return input.map((attachment, index) => {
      const name = attachment.name?.trim() || ''
      const url = attachment.url?.trim() || ''
      const mimeType = attachment.mimeType?.trim() || null
      const size = attachment.size == null ? null : Number(attachment.size)
      if (!name) {
        throw new BizError(`第 ${index + 1} 个附件名称不能为空`, 400)
      }
      if (name.length > CLIENT_FEEDBACK_ATTACHMENT_NAME_MAX_LENGTH) {
        throw new BizError(`附件名称长度不能超过 ${CLIENT_FEEDBACK_ATTACHMENT_NAME_MAX_LENGTH} 个字符`, 400)
      }
      if (!url) {
        throw new BizError(`第 ${index + 1} 个附件地址不能为空`, 400)
      }
      if (url.length > CLIENT_FEEDBACK_ATTACHMENT_URL_MAX_LENGTH) {
        throw new BizError(`附件地址长度不能超过 ${CLIENT_FEEDBACK_ATTACHMENT_URL_MAX_LENGTH} 个字符`, 400)
      }
      if (!/^\/api\/client-feedback\/attachments\/[^/?#]+$/.test(url)) {
        throw new BizError(`第 ${index + 1} 个附件地址必须来自反馈附件上传接口`, 400)
      }
      if (mimeType && mimeType.length > CLIENT_FEEDBACK_ATTACHMENT_MIME_TYPE_MAX_LENGTH) {
        throw new BizError(`附件类型长度不能超过 ${CLIENT_FEEDBACK_ATTACHMENT_MIME_TYPE_MAX_LENGTH} 个字符`, 400)
      }
      if (size != null && (!Number.isFinite(size) || size < 0)) {
        throw new BizError(`第 ${index + 1} 个附件大小非法`, 400)
      }
      return {
        name,
        url,
        mimeType,
        size: size == null ? null : Math.floor(size),
      }
    })
  }

  private buildConversationFields(conversation: ClientFeedbackConversation): ClientFeedbackConversationFields {
    const tagLabels = this.parseJsonArray<ClientFeedbackConversationIssueTag>(conversation.tagJson, [])
      .map((item) => item?.label?.trim() || '')
      .filter(Boolean)
    return {
      issueType: conversation.issueType,
      category: conversation.category,
      orderRef: conversation.orderRef?.trim() || null,
      expectedResult: conversation.expectedResult?.trim() || '',
      actualResult: conversation.actualResult?.trim() || '',
      reproductionSteps: conversation.reproductionSteps?.trim() || null,
      contactPreference: conversation.contactPreference?.trim() || null,
      tags: tagLabels,
      sourceLabel: conversation.sourceLabel?.trim() || '客户端反馈页',
    }
  }

  private buildInternalRemarkView(conversation: ClientFeedbackConversation): ClientFeedbackInternalRemarkView | null {
    const content = conversation.internalRemark?.trim() || ''
    if (!content) {
      return null
    }
    return {
      content,
      updatedAt: conversation.internalRemarkUpdatedAt,
      updatedByUserId: conversation.internalRemarkByUserId,
      updatedByUsername: conversation.internalRemarkByUsername,
      updatedByDisplayName: conversation.internalRemarkByDisplayName,
    }
  }

  private normalizeCategory(category?: string) {
    const normalized = category?.trim() || 'general'
    if (!normalized) {
      throw new BizError('反馈分类不能为空', 400)
    }
    if (normalized.length > CLIENT_FEEDBACK_CATEGORY_MAX_LENGTH) {
      throw new BizError(`反馈分类长度不能超过 ${CLIENT_FEEDBACK_CATEGORY_MAX_LENGTH} 个字符`, 400)
    }
    return normalized
  }

  private normalizeIssueType(issueType: ClientFeedbackIssueType = 'suggestion') {
    const normalized = issueType
    if (!CLIENT_FEEDBACK_ISSUE_TYPES.includes(normalized)) {
      throw new BizError('Issue 类型非法', 400)
    }
    return normalized
  }

  private normalizeSubject(subject: string) {
    const normalized = subject.trim()
    if (!normalized) {
      throw new BizError('反馈主题不能为空', 400)
    }
    if (normalized.length > CLIENT_FEEDBACK_SUBJECT_MAX_LENGTH) {
      throw new BizError(`反馈主题长度不能超过 ${CLIENT_FEEDBACK_SUBJECT_MAX_LENGTH} 个字符`, 400)
    }
    return normalized
  }

  private normalizeMessageContent(content: string) {
    const normalized = content.trim()
    if (!normalized) {
      throw new BizError('消息内容不能为空', 400)
    }
    if (normalized.length > CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH) {
      throw new BizError(`消息内容长度不能超过 ${CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH} 个字符`, 400)
    }
    return normalized
  }

  private normalizePriority(priority?: ClientFeedbackPriority) {
    if (!priority) {
      return 'normal' as const
    }
    if (!CLIENT_FEEDBACK_PRIORITIES.includes(priority)) {
      throw new BizError('反馈优先级非法', 400)
    }
    return priority
  }

  private normalizeSatisfactionLevel(level: ClientFeedbackSatisfactionLevel) {
    if (!CLIENT_FEEDBACK_SATISFACTION_LEVELS.includes(level)) {
      throw new BizError('满意度评价档位非法', 400)
    }
    return level
  }

  private buildAvailability(
    config: Awaited<ReturnType<typeof systemConfigService.getCustomerServiceConfigs>>,
    session: CustomerServiceRealtimeSessionSnapshot = customerServiceRealtimeService.buildServiceSessionSnapshot(),
  ): CustomerServiceAvailabilityRecord {
    /**
     * 在线可用性统一复用系统配置服务口径：
     * - 工作时间、离线提示、FAQ 与服务端时间全部沿用系统配置服务已计算结果；
     * - 这里只根据当前实时会话快照覆写“在线客服人数”与最终在线态，避免再次写死工时。
     */
    const baseAvailability = config.availability
    const serviceConnectedCount = session.serviceConnectionCount
    const hasOnlineStaff = serviceConnectedCount > 0
    const withinWorkHours = baseAvailability.withinWorkHours
    /**
     * 在线状态修正规则：
     * - 只要客服工作台存在有效驻留连接，就视为在线；
     * - 工作时间信息仍保留给页面展示，但不再阻断在线状态，避免“有人值守却显示离线”。
     */
    const isOnline = config.enabled && config.realtimeEnabled && hasOnlineStaff
    let reason: CustomerServiceAvailabilityRecord['reason'] = 'within_work_hours'
    if (!isOnline && !withinWorkHours) {
      reason = 'outside_work_hours'
    } else if (!hasOnlineStaff) {
      reason = 'no_online_staff'
    }

    return {
      ...baseAvailability,
      status: isOnline ? 'online' : 'offline',
      reason,
      isOnline,
      withinWorkHours,
      hasOnlineStaff,
      serviceConnectedCount,
    }
  }

  private previewMessage(content: string) {
    return content.trim().slice(0, 120)
  }

  private buildConversationSummary(
    conversation: ClientFeedbackConversation,
    currentServiceUserId?: string,
  ): ClientFeedbackConversationSummary {
    return {
      id: conversation.id,
      conversationNo: conversation.conversationNo,
      clientUserId: conversation.clientUserId,
      clientUsername: conversation.clientUsername,
      clientAccount: conversation.clientAccount,
      clientAccountType: conversation.clientAccountType,
      staffNoSnapshot: conversation.staffNoSnapshot?.trim() || null,
      departmentNameSnapshot: conversation.departmentNameSnapshot,
      category: conversation.category,
      subject: conversation.subject,
      status: conversation.status,
      priority: conversation.priority,
      assignedUserId: conversation.assignedUserId,
      assignedUsername: conversation.assignedUsername,
      assignedDisplayName: conversation.assignedDisplayName,
      lastMessagePreview: conversation.lastMessagePreview ?? '',
      lastMessageSenderType: conversation.lastMessageSenderType,
      lastMessageAt: conversation.lastMessageAt,
      unreadForClientCount: conversation.unreadForClientCount,
      unreadForServiceCount: conversation.unreadForServiceCount,
      closedAt: conversation.closedAt,
      fields: this.buildConversationFields(conversation),
      satisfaction: this.buildSatisfactionView(conversation),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      assignedToCurrentUser: currentServiceUserId ? conversation.assignedUserId === currentServiceUserId : undefined,
    }
  }

  private buildMessageView(
    message: ClientFeedbackMessage,
    viewer: { scope: 'client'; userId: string } | { scope: 'service'; userId: string },
  ): ClientFeedbackMessageView {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderType: message.senderType,
      senderUserId: message.senderUserId,
      senderName: message.senderName ?? '',
      messageType: message.messageType,
      internalOnly: Boolean(message.internalOnly),
      content: message.content,
      attachments: this.parseJsonArray<ClientFeedbackMessageAttachment>(message.attachmentJson, []).map((item) => ({
        name: item?.name?.trim() || '',
        url: viewer.scope === 'service'
          ? (item?.url?.trim() || '').replace('/api/client-feedback/attachments/', '/api/customer-service/attachments/')
          : item?.url?.trim() || '',
        mimeType: item?.mimeType?.trim() || null,
        size: typeof item?.size === 'number' && Number.isFinite(item.size) ? item.size : null,
      }))
        .filter((item) => Boolean(item.name && item.url)),
      clientReadAt: message.clientReadAt,
      serviceReadAt: message.serviceReadAt,
      createdAt: message.createdAt,
      mine:
        viewer.scope === 'client'
          ? message.senderType === 'client'
          : message.senderType === 'service' && message.senderUserId === viewer.userId,
    }
  }

  private buildRealtimePayload(
    eventType: string,
    conversation: ClientFeedbackConversation,
    detail: Record<string, unknown> = {},
    message?: ClientFeedbackMessageView,
  ): CustomerServiceRealtimeEventPayload {
    return {
      eventType,
      conversationId: conversation.id,
      clientUserId: conversation.clientUserId,
      occurredAt: new Date().toISOString(),
      conversation: this.buildConversationSummary(conversation),
      message,
      detail,
    }
  }

  private publishConversationEvent(
    eventType: string,
    conversation: ClientFeedbackConversation,
    detail: Record<string, unknown> = {},
    message?: ClientFeedbackMessageView,
  ) {
    customerServiceRealtimeService.publishConversationEvent(this.buildRealtimePayload(eventType, conversation, detail, message))
  }

  private async requireConversationById(id: string, manager?: EntityManager) {
    const repository = (manager ?? AppDataSource.manager).getRepository(ClientFeedbackConversation)
    const conversation = await repository.findOne({ where: { id } })
    if (!conversation) {
      throw new BizError('反馈会话不存在', 404)
    }
    return conversation
  }

  /**
   * 负责人合法性校验：
   * - 只能转派给启用中的后台用户；
   * - 目标用户必须具备客服工作台查看与回复权限，避免把工单挂给无处理能力的账号。
   */
  private async requireAssignableServiceUser(userId: string, manager?: EntityManager) {
    const normalizedUserId = userId.trim()
    if (!normalizedUserId) {
      throw new BizError('负责人不能为空', 400)
    }

    const repository = (manager ?? AppDataSource.manager).getRepository(SysUser)
    const user = await repository.findOne({ where: { id: normalizedUserId } })
    if (!user) {
      throw new BizError('目标负责人不存在', 404)
    }
    if (user.status !== 'enabled') {
      throw new BizError('目标负责人已停用，暂不能接单', 400)
    }

    const permissions = resolvePermissionsByRole(user.role)
    const hasCustomerServicePermission = permissions.includes('customer_service:view') && permissions.includes('customer_service:reply')
    if (!hasCustomerServicePermission) {
      throw new BizError('目标负责人不具备客服工作台处理权限', 400)
    }
    return user
  }

  /**
   * 明确会话当前由谁负责：
   * - 显式接单/转派模型下，回复和状态流转应由负责人执行；
   * - 若未接单或当前负责人不是操作者，需要先通过接单/转派入口完成归属确认。
   */
  private ensureConversationOwnedByActor(conversation: ClientFeedbackConversation, actor: AuthUserContext) {
    if (!conversation.assignedUserId) {
      throw new BizError('当前会话尚未接单，请先接单后再继续处理', 400)
    }
    if (conversation.assignedUserId !== actor.userId) {
      throw new BizError(`当前会话由 ${conversation.assignedDisplayName || conversation.assignedUsername || '其他客服'} 负责，请先转派或接回自己后再操作`, 400)
    }
  }

  private buildAssignableUserView(user: SysUser): CustomerServiceAssignableUser {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    }
  }

  private async requireOwnedConversation(id: string, clientAuth: ClientAuthContext, manager?: EntityManager) {
    const conversation = await this.requireConversationById(id, manager)
    if (conversation.clientUserId !== clientAuth.userId) {
      throw new BizError('反馈会话不存在', 404)
    }
    return conversation
  }

  private async buildConversationNo(manager: EntityManager) {
    const now = new Date()
    const yyyy = now.getFullYear().toString()
    const mm = `${now.getMonth() + 1}`.padStart(2, '0')
    const dd = `${now.getDate()}`.padStart(2, '0')
    const prefix = `FK-${yyyy}${mm}${dd}-`
    const databaseType = manager.connection.options.type
    const rows: Array<{ conversation_no?: string }> = await manager.query(
      databaseType === 'mysql'
        ? `
            SELECT \`conversation_no\`
            FROM \`client_feedback_conversation\`
            WHERE \`conversation_no\` LIKE ?
            ORDER BY \`conversation_no\` DESC
            LIMIT 1
            FOR UPDATE
          `
        : `
            SELECT "conversation_no"
            FROM "client_feedback_conversation"
            WHERE "conversation_no" LIKE ?
            ORDER BY "conversation_no" DESC
            LIMIT 1
          `,
      [`${prefix}%`],
    )
    const current = rows[0]?.conversation_no ?? ''
    const currentSeq = current ? Number.parseInt(current.slice(-4), 10) : 0
    if (!Number.isInteger(currentSeq) || currentSeq < 0) {
      throw new BizError('历史反馈编号格式异常，无法继续生成新编号', 500)
    }
    if (currentSeq >= 9999) {
      throw new BizError('当日反馈编号已达到上限，请联系管理员处理', 409)
    }
    return `${prefix}${String(currentSeq + 1).padStart(4, '0')}`
  }

  private async getClientUserSnapshot(userId: string) {
    const clientUser = await this.clientUserRepo.findOne({ where: { id: userId } })
    if (!clientUser) {
      throw new BizError('客户端用户不存在', 404)
    }
    return {
      clientUsername: clientUser.realName?.trim() || '',
      clientAccount: clientUser.email?.trim() || clientUser.mobile?.trim() || clientUser.realName?.trim() || '',
      clientAccountType: clientUser.accountType,
      staffNoSnapshot: clientUser.staffNo?.trim() || null,
      departmentNameSnapshot: clientUser.departmentName?.trim() || '',
    }
  }

  private async createMessage(
    manager: EntityManager,
    conversation: ClientFeedbackConversation,
    writer: ConversationMessageWriter,
    content: string,
    messageType: ClientFeedbackMessageType = 'text',
    attachments: ClientFeedbackMessageAttachment[] = [],
  ) {
    const now = new Date()
    const messageRepo = manager.getRepository(ClientFeedbackMessage)
    const message = await messageRepo.save(
      messageRepo.create({
        conversationId: conversation.id,
        senderType: writer.senderType,
        senderUserId: writer.senderUserId,
        senderName: writer.senderName,
        messageType,
        content,
        attachmentJson: JSON.stringify(attachments),
        clientReadAt: writer.senderType === 'client' ? now : null,
        serviceReadAt: writer.senderType === 'service' || writer.senderType === 'system' ? now : null,
      }),
    )

    const attachmentIds = attachments
      .map((attachment) => /\/api\/client-feedback\/attachments\/([^/?#]+)/.exec(attachment.url)?.[1] ?? '')
      .filter(Boolean)
    if (attachmentIds.length) {
      await manager.getRepository(ClientFeedbackAttachment).update(
        { id: In(attachmentIds) },
        { conversationId: conversation.id, messageId: message.id, expiresAt: null },
      )
    }

    conversation.lastMessagePreview = this.previewMessage(content)
    conversation.lastMessageAt = now
    conversation.lastMessageSenderType = writer.senderType
    conversation.status = writer.conversationStatus
    conversation.updatedAt = now
    if (writer.senderType === 'client') {
      conversation.unreadForClientCount = 0
      conversation.unreadForServiceCount += 1
    } else {
      conversation.unreadForClientCount += 1
      conversation.unreadForServiceCount = 0
    }
    if (writer.conversationStatus === 'closed') {
      conversation.closedAt = now
    } else if (conversation.closedAt) {
      conversation.closedAt = null
    }
    await manager.getRepository(ClientFeedbackConversation).save(conversation)
    return message
  }

  private async markConversationReadForClient(manager: EntityManager, conversation: ClientFeedbackConversation) {
    if (conversation.unreadForClientCount <= 0) {
      return false
    }
    const now = new Date()
    await manager
      .createQueryBuilder()
      .update(ClientFeedbackMessage)
      .set({ clientReadAt: now })
      .where('conversation_id = :conversationId', { conversationId: conversation.id })
      .andWhere('sender_type IN (:...senderTypes)', { senderTypes: ['service', 'system'] })
      .andWhere('client_read_at IS NULL')
      .execute()
    conversation.unreadForClientCount = 0
    await manager.getRepository(ClientFeedbackConversation).save(conversation)
    return true
  }

  private async markConversationReadForService(manager: EntityManager, conversation: ClientFeedbackConversation) {
    if (conversation.unreadForServiceCount <= 0) {
      return false
    }
    const now = new Date()
    await manager
      .createQueryBuilder()
      .update(ClientFeedbackMessage)
      .set({ serviceReadAt: now })
      .where('conversation_id = :conversationId', { conversationId: conversation.id })
      .andWhere('sender_type = :senderType', { senderType: 'client' })
      .andWhere('service_read_at IS NULL')
      .execute()
    conversation.unreadForServiceCount = 0
    await manager.getRepository(ClientFeedbackConversation).save(conversation)
    return true
  }

  private async loadConversationMessages(manager: EntityManager, conversationId: string) {
    return manager.getRepository(ClientFeedbackMessage).find({
      where: { conversationId },
      order: {
        id: 'ASC',
      },
    })
  }

  async getPortalConfigs(): Promise<ClientFeedbackPortalConfigRecord> {
    const config = await systemConfigService.getCustomerServiceConfigs()
    return {
      enabled: config.enabled,
      realtimeEnabled: config.realtimeEnabled,
      entryNotice: config.entryNotice,
      workdayStart: config.workdayStart,
      workdayEnd: config.workdayEnd,
      workdayWeekdays: [...config.workdayWeekdays],
      offlineNotice: config.offlineNotice,
      offlineFaqs: config.offlineFaqs.map((item) => ({ ...item })),
      sseKeepaliveSeconds: config.sseKeepaliveSeconds,
      availability: this.buildAvailability(config),
      updatedAt: config.updatedAt,
    }
  }

  async openClientRealtimeChannel(clientAuth: ClientAuthContext, res: import('express').Response) {
    const config = await this.getPortalConfigs()
    if (!config.realtimeEnabled) {
      throw new BizError('当前客服实时通道未启用', 403)
    }
    customerServiceRealtimeService.openClientStream(clientAuth.userId, res, config.sseKeepaliveSeconds, {
      availability: config.availability,
    })
  }

  async openServiceRealtimeChannel(actor: AuthUserContext, res: import('express').Response) {
    const config = await this.getPortalConfigs()
    if (!config.realtimeEnabled) {
      throw new BizError('当前客服实时通道未启用', 403)
    }
    customerServiceRealtimeService.openServiceStream(
      actor.userId,
      res,
      config.sseKeepaliveSeconds,
      (sessionSnapshot) => ({
        // 连接先注册再回填在线态，确保首个客服进入工作台时也能立即显示在线。
        availability: this.buildAvailability(config, sessionSnapshot),
      }),
    )
  }

  async createConversation(input: CreateClientFeedbackConversationInput, clientAuth: ClientAuthContext, requestMeta?: RequestMeta) {
    const portalConfig = await this.getPortalConfigs()
    if (!portalConfig.enabled) {
      throw new BizError('当前系统暂未开放在线反馈入口', 403)
    }
    const issueType = this.normalizeIssueType(input.issueType)
    const category = this.normalizeCategory(input.category)
    const subject = this.normalizeSubject(input.subject)
    const content = this.normalizeMessageContent(input.content)
    const priority = this.normalizePriority(input.priority)
    const orderRef = this.normalizeOptionalShortText(input.orderRef, '关联订单号', CLIENT_FEEDBACK_ORDER_REF_MAX_LENGTH)
    const expectedResult = this.normalizeOptionalLongText(input.expectedResult, '期望结果') ?? subject
    const actualResult = this.normalizeOptionalLongText(input.actualResult, '实际结果') ?? content
    const reproductionSteps = this.normalizeOptionalLongText(input.reproductionSteps, '复现步骤')
    const contactPreference = this.normalizeOptionalShortText(
      input.contactPreference,
      '联系偏好',
      CLIENT_FEEDBACK_CONTACT_PREFERENCE_MAX_LENGTH,
    )
    const tags = this.normalizeTags(input.tags)
    const sourceLabel = this.normalizeSourceLabel(input.sourceLabel)
    const attachments = this.normalizeAttachments(input.attachments)
    const clientSnapshot = await this.getClientUserSnapshot(clientAuth.userId)

    let result:
      | {
          conversation: ClientFeedbackConversation
          message: ClientFeedbackMessage
        }
      | undefined
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        result = await AppDataSource.transaction(async (manager) => {
          const conversationRepo = manager.getRepository(ClientFeedbackConversation)
          const conversation = await conversationRepo.save(
            conversationRepo.create({
              conversationNo: await this.buildConversationNo(manager),
              clientUserId: clientAuth.userId,
              clientUsername: clientSnapshot.clientUsername,
              clientAccount: clientSnapshot.clientAccount,
              clientAccountType: clientSnapshot.clientAccountType,
              staffNoSnapshot: clientSnapshot.staffNoSnapshot,
              departmentNameSnapshot: clientSnapshot.departmentNameSnapshot,
              issueType,
              category,
              sourceCode: 'client_portal',
              orderRef,
              subject,
              expectedResult,
              actualResult,
              reproductionSteps,
              contactPreference,
              tagJson: JSON.stringify(tags.map((label) => ({ label }))),
              sourceLabel,
              priority,
              status: 'open',
              lastMessagePreview: this.previewMessage(content),
              lastMessageSenderType: 'client',
              lastMessageAt: new Date(),
              unreadForClientCount: 0,
              unreadForServiceCount: 0,
            }),
          )
          const message = await this.createMessage(
            manager,
            conversation,
            {
              senderType: 'client',
              senderUserId: clientAuth.userId,
              senderName: clientSnapshot.clientUsername || clientSnapshot.clientAccount,
              conversationStatus: 'open',
            },
            content,
            'text',
            attachments,
          )

          await auditService.record(
            {
              actionType: 'client_feedback.create',
              actionLabel: '客户端提交反馈',
              targetType: 'feedback_conversation',
              targetId: conversation.id,
              targetCode: conversation.conversationNo,
              actor: {
                userId: clientAuth.userId,
                username: clientAuth.account,
                displayName: clientAuth.realName || clientSnapshot.clientUsername || clientSnapshot.clientAccount,
              },
              requestMeta,
              detail: {
                issueType,
                category,
                subject,
                priority,
                orderRef,
                sourceLabel,
                attachmentCount: attachments.length,
                attempt,
              },
            },
            manager,
          )

          return {
            conversation,
            message,
          }
        })
        break
      } catch (error) {
        lastError = error
        if (
          attempt < 3
          && isUniqueConstraintError(error, FEEDBACK_CONVERSATION_NO_UNIQUE_CONSTRAINT_MATCHER)
        ) {
          continue
        }
        throw error
      }
    }
    if (!result) {
      throw (lastError ?? new BizError('创建反馈会话失败，请稍后重试', 500))
    }

    const messageView = this.buildMessageView(result.message, { scope: 'client', userId: clientAuth.userId })
    this.publishConversationEvent('conversation_created', result.conversation, { source: 'client_create' }, messageView)
    await notificationService.emitEvent({
      eventType: 'customer_service_client_message_created',
      sourceType: 'client_feedback_conversation',
      sourceId: result.conversation.id,
      payload: {
        conversationNo: result.conversation.conversationNo,
        sourceUserId: clientAuth.userId,
        sourceUserDisplayName: clientSnapshot.clientUsername || clientSnapshot.clientAccount,
        summary: content.slice(0, 100),
      },
      requestMeta,
    })
    return {
      conversation: this.buildConversationSummary(result.conversation),
      message: messageView,
    }
  }

  async listMyConversations(clientAuth: ClientAuthContext, query: ClientFeedbackListQuery) {
    const qb = this.conversationRepo
      .createQueryBuilder('conversation')
      .where('conversation.clientUserId = :clientUserId', { clientUserId: clientAuth.userId })

    if (query.status) {
      qb.andWhere('conversation.status = :status', { status: query.status })
    }
    if (query.keyword?.trim()) {
      qb.andWhere(
        `
          (
            conversation.subject LIKE :keyword
            OR conversation.category LIKE :keyword
            OR conversation.conversationNo LIKE :keyword
            OR conversation.lastMessagePreview LIKE :keyword
          )
        `,
        { keyword: `%${query.keyword.trim()}%` },
      )
    }

    const [list, total] = await qb
      .orderBy('conversation.lastMessageAt', 'DESC')
      .addOrderBy('conversation.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: list.map((item) => this.buildConversationSummary(item)),
    }
  }

  async getMyConversationDetail(clientAuth: ClientAuthContext, id: string): Promise<ClientFeedbackConversationDetail> {
    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireOwnedConversation(id, clientAuth, manager)
      const readChanged = await this.markConversationReadForClient(manager, conversation)
      const messages = (await this.loadConversationMessages(manager, conversation.id))
        .filter((message) => !message.internalOnly)
      return {
        conversation,
        messages,
        readChanged,
      }
    })

    if (result.readChanged) {
      this.publishConversationEvent('conversation_read_by_client', result.conversation, { readBy: 'client' })
    }

    return {
      conversation: this.buildConversationSummary(result.conversation),
      messages: result.messages.map((message) => this.buildMessageView(message, { scope: 'client', userId: clientAuth.userId })),
    }
  }

  async appendClientMessage(
    id: string,
    input: AppendClientFeedbackMessageInput,
    clientAuth: ClientAuthContext,
    requestMeta?: RequestMeta,
  ) {
    const portalConfig = await this.getPortalConfigs()
    if (!portalConfig.enabled) {
      throw new BizError('当前系统暂未开放在线反馈入口', 403)
    }
    const content = this.normalizeMessageContent(input.content)
    const attachments = this.normalizeAttachments(input.attachments)
    const clientSnapshot = await this.getClientUserSnapshot(clientAuth.userId)

    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireOwnedConversation(id, clientAuth, manager)
      if (conversation.status === 'closed') {
        throw new BizError('当前反馈会话已关闭，请新建反馈后继续沟通', 400)
      }
      const message = await this.createMessage(
        manager,
        conversation,
        {
          senderType: 'client',
          senderUserId: clientAuth.userId,
          senderName: clientSnapshot.clientUsername || clientSnapshot.clientAccount,
          conversationStatus: 'open',
        },
        content,
        'text',
        attachments,
      )
      await auditService.record(
        {
          actionType: 'client_feedback.reply_by_client',
          actionLabel: '客户端追加反馈消息',
          targetType: 'feedback_conversation',
          targetId: conversation.id,
          targetCode: conversation.conversationNo,
          actor: {
            userId: clientAuth.userId,
            username: clientAuth.account,
            displayName: clientAuth.realName || clientSnapshot.clientUsername || clientSnapshot.clientAccount,
          },
          requestMeta,
          detail: {
            messageLength: content.length,
            attachmentCount: attachments.length,
          },
        },
        manager,
      )
      return { conversation, message }
    })

    const messageView = this.buildMessageView(result.message, { scope: 'client', userId: clientAuth.userId })
    this.publishConversationEvent('message_created', result.conversation, { senderType: 'client' }, messageView)
    await notificationService.emitEvent({
      eventType: 'customer_service_client_message_created',
      sourceType: 'client_feedback_conversation',
      sourceId: result.conversation.id,
      payload: {
        conversationNo: result.conversation.conversationNo,
        sourceUserId: clientAuth.userId,
        sourceUserDisplayName: clientSnapshot.clientUsername || clientSnapshot.clientAccount,
        summary: content.slice(0, 100),
      },
      requestMeta,
    })
    return {
      conversation: this.buildConversationSummary(result.conversation),
      message: messageView,
    }
  }

  async confirmConversationResolvedByClient(
    id: string,
    clientAuth: ClientAuthContext,
    requestMeta?: RequestMeta,
  ) {
    const clientSnapshot = await this.getClientUserSnapshot(clientAuth.userId)

    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireOwnedConversation(id, clientAuth, manager)
      if (conversation.status === 'closed') {
        return {
          conversation,
          systemMessage: null as ClientFeedbackMessage | null,
          changed: false,
        }
      }
      if (conversation.status !== 'resolved') {
        throw new BizError('当前反馈单还未进入待确认阶段，暂不能确认完成', 400)
      }

      conversation.status = 'closed'
      conversation.closedAt = new Date()
      await manager.getRepository(ClientFeedbackConversation).save(conversation)

      const systemMessage = await this.createMessage(
        manager,
        conversation,
        {
          senderType: 'system',
          senderUserId: null,
          senderName: '系统',
          conversationStatus: 'closed',
        },
        '客户端已确认该反馈单处理完成，当前会话已关闭。',
        'system',
      )

      await auditService.record(
        {
          actionType: 'client_feedback.confirm_resolved',
          actionLabel: '客户端确认反馈已解决',
          targetType: 'feedback_conversation',
          targetId: conversation.id,
          targetCode: conversation.conversationNo,
          actor: {
            userId: clientAuth.userId,
            username: clientAuth.account,
            displayName: clientAuth.realName || clientSnapshot.clientUsername || clientSnapshot.clientAccount,
          },
          requestMeta,
          detail: {
            statusAfter: 'closed',
          },
        },
        manager,
      )

      return {
        conversation,
        systemMessage,
        changed: true,
      }
    })

    if (result.changed) {
      const systemMessageView = result.systemMessage
        ? this.buildMessageView(result.systemMessage, { scope: 'client', userId: clientAuth.userId })
        : undefined
      this.publishConversationEvent('conversation_status_changed', result.conversation, { status: 'closed', confirmedBy: 'client' }, systemMessageView)
    }

    return {
      changed: result.changed,
      conversation: this.buildConversationSummary(result.conversation),
    }
  }

  async withdrawConversationByClient(
    id: string,
    clientAuth: ClientAuthContext,
    requestMeta?: RequestMeta,
  ) {
    const clientSnapshot = await this.getClientUserSnapshot(clientAuth.userId)

    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireOwnedConversation(id, clientAuth, manager)
      if (conversation.status === 'closed') {
        return {
          conversation,
          systemMessage: null as ClientFeedbackMessage | null,
          changed: false,
        }
      }

      const statusBefore = conversation.status
      conversation.status = 'closed'
      conversation.closedAt = new Date()
      await manager.getRepository(ClientFeedbackConversation).save(conversation)

      const systemMessage = await this.createMessage(
        manager,
        conversation,
        {
          senderType: 'system',
          senderUserId: null,
          senderName: '系统',
          conversationStatus: 'closed',
        },
        '客户端已撤回当前反馈单，会话已关闭。',
        'system',
      )

      await auditService.record(
        {
          actionType: 'client_feedback.withdraw',
          actionLabel: '客户端撤回反馈单',
          targetType: 'feedback_conversation',
          targetId: conversation.id,
          targetCode: conversation.conversationNo,
          actor: {
            userId: clientAuth.userId,
            username: clientAuth.account,
            displayName: clientAuth.realName || clientSnapshot.clientUsername || clientSnapshot.clientAccount,
          },
          requestMeta,
          detail: {
            statusBefore,
            statusAfter: 'closed',
          },
        },
        manager,
      )

      return {
        conversation,
        systemMessage,
        changed: true,
      }
    })

    if (result.changed) {
      const systemMessageView = result.systemMessage
        ? this.buildMessageView(result.systemMessage, { scope: 'client', userId: clientAuth.userId })
        : undefined
      this.publishConversationEvent('conversation_status_changed', result.conversation, { status: 'closed', withdrawnBy: 'client' }, systemMessageView)
    }

    return {
      changed: result.changed,
      conversation: this.buildConversationSummary(result.conversation),
    }
  }

  async submitConversationSatisfactionByClient(
    id: string,
    input: SubmitClientFeedbackSatisfactionInput,
    clientAuth: ClientAuthContext,
    requestMeta?: RequestMeta,
  ) {
    const clientSnapshot = await this.getClientUserSnapshot(clientAuth.userId)
    const level = this.normalizeSatisfactionLevel(input.level)
    const comment = this.normalizeOptionalLongText(
      input.comment,
      '满意度补充说明',
      CLIENT_FEEDBACK_SATISFACTION_COMMENT_MAX_LENGTH,
    )

    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireOwnedConversation(id, clientAuth, manager)
      if (conversation.status !== 'resolved' && conversation.status !== 'closed') {
        throw new BizError('当前反馈单尚未进入可评价阶段', 400)
      }

      const before = this.buildSatisfactionView(conversation)
      const now = new Date()
      conversation.clientSatisfactionLevel = level
      conversation.clientSatisfactionComment = comment
      conversation.clientSatisfactionRatedAt = now
      await manager.getRepository(ClientFeedbackConversation).save(conversation)

      await auditService.record(
        {
          actionType: 'client_feedback.submit_satisfaction',
          actionLabel: '客户端提交反馈满意度评价',
          targetType: 'feedback_conversation',
          targetId: conversation.id,
          targetCode: conversation.conversationNo,
          actor: {
            userId: clientAuth.userId,
            username: clientAuth.account,
            displayName: clientAuth.realName || clientSnapshot.clientUsername || clientSnapshot.clientAccount,
          },
          requestMeta,
          detail: {
            before,
            after: this.buildSatisfactionView(conversation),
          },
        },
        manager,
      )

      return {
        conversation,
      }
    })

    this.publishConversationEvent('conversation_satisfaction_updated', result.conversation, {
      ratedBy: 'client',
      satisfaction: this.buildSatisfactionView(result.conversation),
    })

    return {
      conversation: this.buildConversationSummary(result.conversation),
      satisfaction: this.buildSatisfactionView(result.conversation),
    }
  }

  /**
   * 客户端满意度评价统一按可空对象输出：
   * - 未评价时返回 null，前端据此决定展示“去评价”还是“已评价结果”；
   * - 已评价时保留时间与补充说明，避免详情页只能看到档位看不到上下文。
   */
  private buildSatisfactionView(conversation: ClientFeedbackConversation): ClientFeedbackSatisfactionView | null {
    if (!conversation.clientSatisfactionLevel || !conversation.clientSatisfactionRatedAt) {
      return null
    }
    return {
      level: conversation.clientSatisfactionLevel,
      comment: conversation.clientSatisfactionComment?.trim() || null,
      ratedAt: conversation.clientSatisfactionRatedAt,
    }
  }

  async listServiceConversations(query: CustomerServiceConversationListQuery, actor: AuthUserContext) {
    const qb = this.conversationRepo.createQueryBuilder('conversation')

    if (query.status) {
      qb.andWhere('conversation.status = :status', { status: query.status })
    }
    if (query.priority) {
      qb.andWhere('conversation.priority = :priority', { priority: query.priority })
    }
    if (query.keyword?.trim()) {
      qb.andWhere(
        `
          (
            conversation.subject LIKE :keyword
            OR conversation.category LIKE :keyword
            OR conversation.conversationNo LIKE :keyword
            OR conversation.clientUsername LIKE :keyword
            OR conversation.clientAccount LIKE :keyword
            OR conversation.staffNoSnapshot LIKE :keyword
            OR conversation.departmentNameSnapshot LIKE :keyword
            OR conversation.lastMessagePreview LIKE :keyword
          )
        `,
        { keyword: `%${query.keyword.trim()}%` },
      )
    }
    if (query.assignedToMe) {
      qb.andWhere('conversation.assignedUserId = :assignedUserId', { assignedUserId: actor.userId })
    }
    if (query.unreadOnly) {
      qb.andWhere('conversation.unreadForServiceCount > 0')
    }

    const [list, total] = await qb
      .orderBy('conversation.lastMessageAt', 'DESC')
      .addOrderBy('conversation.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      list: list.map((item) => this.buildConversationSummary(item, actor.userId)),
    }
  }

  async getServiceConversationDetail(id: string, actor: AuthUserContext): Promise<ClientFeedbackConversationDetail> {
    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireConversationById(id, manager)
      const readChanged = await this.markConversationReadForService(manager, conversation)
      const messages = await this.loadConversationMessages(manager, conversation.id)
      return {
        conversation,
        messages,
        readChanged,
      }
    })

    if (result.readChanged) {
      this.publishConversationEvent('conversation_read_by_service', result.conversation, { readBy: 'service' })
    }

    return {
      conversation: this.buildConversationSummary(result.conversation, actor.userId),
      messages: result.messages.map((message) => this.buildMessageView(message, { scope: 'service', userId: actor.userId })),
      internalRemark: this.buildInternalRemarkView(result.conversation),
    }
  }

  async appendServiceMessage(
    id: string,
    input: AppendCustomerServiceMessageInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    const content = this.normalizeMessageContent(input.content)
    const attachments = this.normalizeAttachments(input.attachments)

    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireConversationById(id, manager)
      if (conversation.status === 'closed') {
        throw new BizError('当前反馈会话已关闭，请先重新打开后再回复', 400)
      }
      this.ensureConversationOwnedByActor(conversation, actor)

      // 客服回复只应把“待处理”推进到“处理中”。
      // 若会话已被人工标记为“已解决”，继续补充回复时应保持已解决状态，不应回退。
      const nextConversationStatus = conversation.status === 'open' ? 'processing' : conversation.status

      const message = await this.createMessage(
        manager,
        conversation,
        {
          senderType: 'service',
          senderUserId: actor.userId,
          senderName: actor.displayName,
          conversationStatus: nextConversationStatus,
        },
        content,
        'text',
        attachments,
      )
      await auditService.record(
        {
          actionType: 'customer_service.reply',
          actionLabel: '客服回复反馈消息',
          targetType: 'feedback_conversation',
          targetId: conversation.id,
          targetCode: conversation.conversationNo,
          actor,
          requestMeta,
          detail: {
            messageLength: content.length,
            assignedUserId: actor.userId,
            assignedUsername: actor.username,
            attachmentCount: attachments.length,
          },
        },
        manager,
      )
      return { conversation, message }
    })

    const messageView = this.buildMessageView(result.message, { scope: 'service', userId: actor.userId })
    this.publishConversationEvent('message_created', result.conversation, { senderType: 'service' }, messageView)
    return {
      conversation: this.buildConversationSummary(result.conversation, actor.userId),
      message: messageView,
    }
  }

  async updateConversationStatus(
    id: string,
    input: UpdateCustomerServiceConversationStatusInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    if (!CLIENT_FEEDBACK_CONVERSATION_STATUSES.includes(input.status)) {
      throw new BizError('反馈会话状态非法', 400)
    }

    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireConversationById(id, manager)
      this.ensureConversationOwnedByActor(conversation, actor)
      if (conversation.status === input.status) {
        return {
          conversation,
          systemMessage: null as ClientFeedbackMessage | null,
          changed: false,
        }
      }

      const statusBefore = conversation.status
      conversation.status = input.status
      conversation.closedAt = input.status === 'closed' ? new Date() : null
      await manager.getRepository(ClientFeedbackConversation).save(conversation)

      const systemMessage = await this.createMessage(
        manager,
        conversation,
        {
          senderType: 'system',
          senderUserId: null,
          senderName: '系统',
          conversationStatus: input.status,
        },
        `客服已将会话状态更新为：${input.status}`,
        'system',
      )

      await auditService.record(
        {
          actionType: 'customer_service.update_status',
          actionLabel: '更新反馈会话状态',
          targetType: 'feedback_conversation',
          targetId: conversation.id,
          targetCode: conversation.conversationNo,
          actor,
          requestMeta,
          detail: {
            statusBefore,
            statusAfter: input.status,
          },
        },
        manager,
      )

      return {
        conversation,
        systemMessage,
        changed: true,
      }
    })

    if (result.changed) {
      const systemMessageView = result.systemMessage
        ? this.buildMessageView(result.systemMessage, { scope: 'service', userId: actor.userId })
        : undefined
      this.publishConversationEvent('conversation_status_changed', result.conversation, { status: result.conversation.status }, systemMessageView)
    }

    return {
      changed: result.changed,
      conversation: this.buildConversationSummary(result.conversation, actor.userId),
    }
  }

  /**
   * 可接单客服列表：
   * - 当前仅筛选启用中的 admin/operator；
   * - 再通过权限集合二次过滤，避免后续角色权限变化时漏网。
   */
  async listAssignableServiceUsers(): Promise<CustomerServiceAssignableUser[]> {
    const list = await this.sysUserRepo
      .createQueryBuilder('user')
      .where('user.status = :status', { status: 'enabled' })
      .andWhere('user.role IN (:...roles)', { roles: ['admin', 'operator'] })
      .orderBy('user.displayName', 'ASC')
      .addOrderBy('user.id', 'DESC')
      .getMany()

    return list
      .filter((user) => {
        const permissions = resolvePermissionsByRole(user.role)
        return permissions.includes('customer_service:view') && permissions.includes('customer_service:reply')
      })
      .map((user) => this.buildAssignableUserView(user))
  }

  /**
   * 显式更新负责人：
   * - 未分配 -> 当前自己：视为接单；
   * - 任意负责人 -> 其他客服：视为转派；
   * - 未分配 -> 其他客服：视为明确指派，同样保留系统消息与审计痕迹。
   */
  async updateConversationAssignee(
    id: string,
    input: UpdateCustomerServiceConversationAssigneeInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    const targetUserId = input.assigneeUserId.trim()
    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireConversationById(id, manager)
      const targetUser = await this.requireAssignableServiceUser(targetUserId, manager)
      const beforeAssignee = {
        userId: conversation.assignedUserId,
        username: conversation.assignedUsername,
        displayName: conversation.assignedDisplayName,
      }
      const statusBefore = conversation.status

      if (beforeAssignee.userId === targetUser.id) {
        return {
          changed: false,
          conversation,
          systemMessage: null as ClientFeedbackMessage | null,
        }
      }

      conversation.assignedUserId = targetUser.id
      conversation.assignedUsername = targetUser.username
      conversation.assignedDisplayName = targetUser.displayName
      if (conversation.status === 'open') {
        conversation.status = 'processing'
      }
      await manager.getRepository(ClientFeedbackConversation).save(conversation)

      const isTakeOver = targetUser.id === actor.userId
      const hasBeforeAssignee = Boolean(beforeAssignee.userId)
      let systemMessageContent = `会话已由 ${beforeAssignee.displayName || beforeAssignee.username || '原负责人'} 转派给 ${targetUser.displayName}，当前负责人已更新。`
      if (!hasBeforeAssignee) {
        systemMessageContent = isTakeOver
          ? `客服 ${targetUser.displayName} 已接单，当前负责人已更新为 ${targetUser.displayName}。`
          : `会话已指派给客服 ${targetUser.displayName} 跟进，当前负责人已更新。`
      }

      let actionType = 'customer_service.transfer'
      if (!hasBeforeAssignee) {
        actionType = isTakeOver ? 'customer_service.take_over' : 'customer_service.assign'
      }

      let actionLabel = '转派反馈负责人'
      if (!hasBeforeAssignee) {
        actionLabel = isTakeOver ? '客服接单' : '指派反馈负责人'
      }

      const systemMessage = await this.createMessage(
        manager,
        conversation,
        {
          senderType: 'system',
          senderUserId: null,
          senderName: '系统',
          conversationStatus: conversation.status,
        },
        systemMessageContent,
        'system',
      )

      await auditService.record(
        {
          actionType,
          actionLabel,
          targetType: 'feedback_conversation',
          targetId: conversation.id,
          targetCode: conversation.conversationNo,
          actor,
          requestMeta,
          detail: {
            assigneeBeforeUserId: beforeAssignee.userId,
            assigneeBeforeUsername: beforeAssignee.username,
            assigneeBeforeDisplayName: beforeAssignee.displayName,
            assigneeAfterUserId: targetUser.id,
            assigneeAfterUsername: targetUser.username,
            assigneeAfterDisplayName: targetUser.displayName,
            statusBefore,
            statusAfter: conversation.status,
          },
        },
        manager,
      )

      return {
        changed: true,
        conversation,
        systemMessage,
        beforeAssignee,
        targetUser,
      }
    })

    if (result.changed) {
      const systemMessageView = result.systemMessage
        ? this.buildMessageView(result.systemMessage, { scope: 'service', userId: actor.userId })
        : undefined
      this.publishConversationEvent(
        'conversation_assignee_updated',
        result.conversation,
        {
          assigneeBeforeUserId: result.beforeAssignee?.userId ?? null,
          assigneeBeforeDisplayName: result.beforeAssignee?.displayName ?? null,
          assigneeAfterUserId: result.targetUser?.id ?? null,
          assigneeAfterDisplayName: result.targetUser?.displayName ?? null,
        },
        systemMessageView,
      )
    }

    return {
      changed: result.changed,
      conversation: this.buildConversationSummary(result.conversation, actor.userId),
    }
  }

  async updateConversationIssueFields(
    id: string,
    input: UpdateCustomerServiceIssueFieldsInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireConversationById(id, manager)
      const before = this.buildConversationFields(conversation)
      const subjectBefore = conversation.subject

      if (typeof input.issueType === 'string') {
        conversation.issueType = this.normalizeIssueType(input.issueType)
      }
      if (typeof input.subject === 'string') {
        conversation.subject = this.normalizeSubject(input.subject)
      }
      if (typeof input.category === 'string') {
        conversation.category = this.normalizeCategory(input.category)
      }
      if (typeof input.priority === 'string') {
        conversation.priority = this.normalizePriority(input.priority)
      }
      if (Object.hasOwn(input, 'orderRef')) {
        conversation.orderRef = this.normalizeOptionalShortText(
          input.orderRef ?? null,
          '关联订单号',
          CLIENT_FEEDBACK_ORDER_REF_MAX_LENGTH,
        )
      }
      if (typeof input.expectedResult === 'string') {
        conversation.expectedResult = this.normalizeOptionalLongText(input.expectedResult, '期望结果') ?? ''
      }
      if (typeof input.actualResult === 'string') {
        conversation.actualResult = this.normalizeOptionalLongText(input.actualResult, '实际结果') ?? ''
      }
      if (Object.hasOwn(input, 'reproductionSteps')) {
        conversation.reproductionSteps = this.normalizeOptionalLongText(input.reproductionSteps ?? null, '复现步骤')
      }
      if (Object.hasOwn(input, 'contactPreference')) {
        conversation.contactPreference = this.normalizeOptionalShortText(
          input.contactPreference ?? null,
          '联系偏好',
          CLIENT_FEEDBACK_CONTACT_PREFERENCE_MAX_LENGTH,
        )
      }
      if (Array.isArray(input.tags)) {
        const tags = this.normalizeTags(input.tags)
        conversation.tagJson = JSON.stringify(tags.map((label) => ({ label })))
      }
      if (typeof input.sourceLabel === 'string') {
        conversation.sourceLabel = this.normalizeSourceLabel(input.sourceLabel)
      }

      const after = this.buildConversationFields(conversation)
      const changed = JSON.stringify(before) !== JSON.stringify(after) || conversation.subject !== subjectBefore
      if (!changed) {
        return { conversation, changed: false, before, after }
      }

      await manager.getRepository(ClientFeedbackConversation).save(conversation)
      await auditService.record(
        {
          actionType: 'customer_service.update_issue_fields',
          actionLabel: '更新反馈结构化问题字段',
          targetType: 'feedback_conversation',
          targetId: conversation.id,
          targetCode: conversation.conversationNo,
          actor,
          requestMeta,
          detail: {
            before: {
              subject: subjectBefore,
              fields: before,
            },
            after: {
              subject: conversation.subject,
              fields: after,
            },
          },
        },
        manager,
      )
      return { conversation, changed: true, before, after }
    })

    if (result.changed) {
      this.publishConversationEvent('conversation_fields_updated', result.conversation, {
        updatedBy: actor.userId,
        fields: this.buildConversationFields(result.conversation),
      })
    }

    return {
      changed: result.changed,
      conversation: this.buildConversationSummary(result.conversation, actor.userId),
    }
  }

  async updateConversationInternalRemark(
    id: string,
    input: UpdateCustomerServiceInternalRemarkInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    const normalizedRemark = this.normalizeOptionalLongText(
      input.content,
      '内部备注',
      CLIENT_FEEDBACK_INTERNAL_REMARK_MAX_LENGTH,
    )

    const result = await AppDataSource.transaction(async (manager) => {
      const conversation = await this.requireConversationById(id, manager)
      const before = this.buildInternalRemarkView(conversation)
      const beforeContent = before?.content ?? null
      if (beforeContent === normalizedRemark) {
        return { conversation, changed: false }
      }

      const now = new Date()
      conversation.internalRemark = normalizedRemark
      conversation.internalRemarkUpdatedAt = normalizedRemark ? now : null
      conversation.internalRemarkByUserId = normalizedRemark ? actor.userId : null
      conversation.internalRemarkByUsername = normalizedRemark ? actor.username : null
      conversation.internalRemarkByDisplayName = normalizedRemark ? actor.displayName : null
      await manager.getRepository(ClientFeedbackConversation).save(conversation)

      await auditService.record(
        {
          actionType: 'customer_service.update_internal_remark',
          actionLabel: '更新反馈内部备注',
          targetType: 'feedback_conversation',
          targetId: conversation.id,
          targetCode: conversation.conversationNo,
          actor,
          requestMeta,
          detail: {
            beforeLength: beforeContent?.length ?? 0,
            afterLength: normalizedRemark?.length ?? 0,
          },
        },
        manager,
      )
      return { conversation, changed: true }
    })

    if (result.changed) {
      this.publishConversationEvent('conversation_internal_remark_updated', result.conversation, {
        updatedBy: actor.userId,
      })
    }

    return {
      changed: result.changed,
      conversation: this.buildConversationSummary(result.conversation, actor.userId),
      internalRemark: this.buildInternalRemarkView(result.conversation),
    }
  }

  async getServicePresence() {
    const config = await this.getPortalConfigs()
    return {
      availability: config.availability,
      session: customerServiceRealtimeService.buildServiceSessionSnapshot(),
    }
  }
}

export const clientFeedbackService = new ClientFeedbackService()
