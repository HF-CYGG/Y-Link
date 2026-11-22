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

import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { In, IsNull, LessThanOrEqual, MoreThan, type EntityManager } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { runInTransaction } from '../config/transaction-runner.js'
import { initializeDatabaseInfrastructure } from '../database/database-strategy.js'
import { databaseOperationGate } from '../database/operation-gate.js'
import { resolvePermissionsByRole, resolveUserPermissions } from '../constants/auth-permissions.js'
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
import { isRetryableMysqlTransactionError, isUniqueConstraintError } from '../utils/database-errors.js'
import { BizError } from '../utils/errors.js'
import { toSafeErrorLog } from '../utils/safe-error-log.js'
import { databaseMaintenanceModeService } from './database-maintenance-mode.service.js'
import {
  cleanupExpiredUploadTempFiles, ensureUploadCategoryDir, IMAGE_UPLOAD_MAX_FILE_SIZE,
  isRecoverableUploadFileCleanupError, isUploadPublicUrlForCategory, UPLOAD_PUBLIC_FILE_NAME_MATCHER,
} from '../utils/upload-storage.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { auditService } from './audit.service.js'
import {
  customerServiceRealtimeService,
  type CustomerServiceRealtimeEventPayload,
  type CustomerServiceRealtimeSessionSnapshot,
} from './customer-service-realtime.service.js'
import { systemConfigService } from './system-config.service.js'
import { persistentRiskStateService } from './persistent-risk-state.service.js'
import { isRedisEnabled } from '../redis/redis-client.js'
import { notificationService } from './notification.service.js'
import { ClientFeedbackAttachment } from '../entities/client-feedback-attachment.entity.js'
import { ClientRestockRequest, type RestockEffectiveStatus } from '../entities/client-restock-request.entity.js'
import { ClientRestockRequestKey } from '../entities/client-restock-request-key.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'
import { BaseProductSku } from '../entities/base-product-sku.entity.js'
import { buildRestockView, effectiveRestockStatus, effectiveRestockStatusSql, normalizeRestockRequest, type CreateRestockRequestInput } from './restock-policy.js'
import { resolveDashboardFilter } from './dashboard.service.js'
import { CLIENT_FEEDBACK_ATTACHMENT_POLICY } from './client-feedback-security-policy.js'
import {
  lockActiveClientAccountForBusiness,
  lockActiveSysAccountForBusiness,
  lockActiveSysAccountsForBusiness,
} from './account-business-guard.service.js'
import { runExclusive } from '../redis/redis-lease.js'
import { buildSqlLikeContains } from '../utils/sql-like.js'

const MYSQL_FEEDBACK_ATTACHMENT_COORDINATION_LOCK = 'ylink:feedback:attachment-quota-cleanup'
const MYSQL_FEEDBACK_ATTACHMENT_LOCK_TIMEOUT_SECONDS = 5

export interface ClientFeedbackAttachmentCleanupAnomaly {
  storageName: string
  reason: string
}

export interface ClientFeedbackAttachmentCleanupResult {
  scannedFiles: number
  removedExpiredDrafts: number
  removedOrphanFiles: number
  removedTempFiles: number
  retainedReferencedFiles: number
  anomalies: ClientFeedbackAttachmentCleanupAnomaly[]
}

type AttachmentCleanupRow = Pick<ClientFeedbackAttachment, 'id' | 'storageName' | 'ownerClientUserId' | 'conversationId' | 'messageId'>

interface AttachmentCleanupCandidate {
  storageName: string
  draft?: AttachmentCleanupRow
}

const feedbackAttachmentUrl = (id: string) => `/api/client-feedback/attachments/${id}`

const ATTACHMENT_CLEANUP_TRANSACTION_SIZE = 64
const ATTACHMENT_CLEANUP_READ_SIZE = 500
const FEEDBACK_SENDERS_BY_SIDE: Record<'client' | 'service', readonly ClientFeedbackSenderType[]> = {
  client: ['client'],
  service: ['service', 'system'],
}

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
export const CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE = CLIENT_FEEDBACK_ATTACHMENT_POLICY.maxAttachmentsPerMessage
export const CLIENT_FEEDBACK_MAX_TAGS = 10
export const CLIENT_FEEDBACK_MAX_TAG_LENGTH = 24
export const CLIENT_FEEDBACK_SATISFACTION_COMMENT_MAX_LENGTH = 300

const FEEDBACK_CONVERSATION_NO_UNIQUE_CONSTRAINT_MATCHER = {
  mysqlConstraint: 'uk_client_feedback_conversation_no',
  sqliteColumns: ['client_feedback_conversation.conversation_no'],
} as const

export interface ClientFeedbackConversationSummary {
  restock: ReturnType<typeof buildRestockView>
  serverNow: Date
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
  attachmentIds?: string[]
}

export interface AppendClientFeedbackMessageInput {
  content: string
  attachmentIds?: string[]
}

export interface ClientFeedbackListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: ClientFeedbackConversationStatus
}

export interface CustomerServiceConversationListQuery extends ClientFeedbackListQuery {
  issueType?: ClientFeedbackIssueType
  restockStatus?: RestockEffectiveStatus
  productId?: string
  startDate?: string
  endDate?: string
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

  private readonly attachmentUploadRateWindows = new Map<string, { startedAt: number; hits: number }>()

  private attachmentCleanupTimer: ReturnType<typeof globalThis.setInterval> | null = null

  private attachmentCleanupInFlight: Promise<ClientFeedbackAttachmentCleanupResult> | null = null
  private attachmentCleanupFileCursor = ''
  private attachmentCleanupDraftCursor = ''
  private attachmentCleanupTempCursor = ''

  private attachmentCleanupWorkerDesired = false

  constructor() {
    databaseOperationGate.registerWorker({
      name: 'client-feedback-attachment-cleanup',
      pause: () => this.pauseAttachmentCleanupWorker(),
      drain: async () => {
        if (this.attachmentCleanupInFlight) await this.attachmentCleanupInFlight
      },
      resume: () => {
        if (this.attachmentCleanupWorkerDesired) this.startAttachmentCleanupTimer()
      },
    })
  }

  /**
   * MySQL 用命名锁协调容量检查、草稿建档与回收。SQLite 复用统一写事务队列。
   */
  private async runAttachmentCoordinatedTransaction<T>(
    operation: (manager: EntityManager, isMysql: boolean) => Promise<T>,
  ): Promise<T> {
    const isMysql = AppDataSource.options.type === 'mysql'
    if (!isMysql) {
      return runInTransaction((manager) => operation(manager, false))
    }

    await initializeDatabaseInfrastructure(AppDataSource)
    const queryRunner = AppDataSource.createQueryRunner()
    let lockAcquired = false
    await queryRunner.connect()
    try {
      await queryRunner.startTransaction()
      const lockRows = await queryRunner.query(
        'SELECT GET_LOCK(?, ?) AS acquired',
        [MYSQL_FEEDBACK_ATTACHMENT_COORDINATION_LOCK, MYSQL_FEEDBACK_ATTACHMENT_LOCK_TIMEOUT_SECONDS],
      ) as Array<{ acquired?: number | string | null }>
      lockAcquired = Number(lockRows[0]?.acquired) === 1
      if (!lockAcquired) {
        throw new BizError('反馈附件配额检查繁忙，请稍后重试', 503)
      }
      const result = await operation(queryRunner.manager, true)
      await queryRunner.commitTransaction()
      return result
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction()
      throw error
    } finally {
      if (lockAcquired) {
        try {
          await queryRunner.query('SELECT RELEASE_LOCK(?)', [MYSQL_FEEDBACK_ATTACHMENT_COORDINATION_LOCK])
        } catch (error) {
          console.error('[client-feedback-attachment] 释放数据库协调锁失败', toSafeErrorLog(error))
        }
      }
      await queryRunner.release()
    }
  }

  private async lockAttachmentOwner(
    manager: EntityManager,
    clientUserId: string,
    requireEnabled: boolean,
  ): Promise<ClientUser | null> {
    const query = manager.getRepository(ClientUser)
      .createQueryBuilder('user')
      .where('user.id = :userId', { userId: clientUserId })
    if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
    const owner = await query.getOne()
    if (!owner) return null
    if (requireEnabled && owner.status !== 'enabled') {
      throw new BizError('客户端用户不存在或已停用', 403)
    }
    return owner
  }

  /**
   * 反馈附件上传频控：
   * - 路由必须在 multer 接收文件、sharp 解码重编码之前调用，失败的上传同样计次；
   * - 若只在建档阶段计次，校验失败的大图永远不会消耗额度，单个账号即可反复占满全局图片处理队列。
   */
  async consumeAttachmentUploadRate(clientUserId: string) {
    const now = Date.now()
    if (isRedisEnabled()) {
      // 多实例共享计数：Redis 优先、数据库兜底，避免 N 个实例把每账号额度放大 N 倍。
      const limit = CLIENT_FEEDBACK_ATTACHMENT_POLICY.uploadRateLimit
      const result = await persistentRiskStateService.consumeWindow(
        `feedback-attachment-upload:${clientUserId}`,
        CLIENT_FEEDBACK_ATTACHMENT_POLICY.uploadRateWindowMs,
        now,
        limit,
      )
      if (result.totalHits > limit) throw new BizError('反馈附件上传过于频繁，请稍后重试', 429)
      return
    }
    const previous = this.attachmentUploadRateWindows.get(clientUserId)
    const window = previous && now - previous.startedAt < CLIENT_FEEDBACK_ATTACHMENT_POLICY.uploadRateWindowMs
      ? previous
      : { startedAt: now, hits: 0 }
    window.hits += 1
    this.attachmentUploadRateWindows.set(clientUserId, window)
    if (window.hits > CLIENT_FEEDBACK_ATTACHMENT_POLICY.uploadRateLimit) {
      throw new BizError('反馈附件上传过于频繁，请稍后重试', 429)
    }
    if (this.attachmentUploadRateWindows.size > 2_000) {
      for (const [key, item] of this.attachmentUploadRateWindows) {
        if (now - item.startedAt >= CLIENT_FEEDBACK_ATTACHMENT_POLICY.uploadRateWindowMs) this.attachmentUploadRateWindows.delete(key)
      }
    }
  }

  private async assertFeedbackAttachmentDiskCapacity() {
    const directory = ensureUploadCategoryDir('client-feedback')
    try {
      const stats = await fs.promises.statfs(directory)
      const availableBytes = Number(stats.bavail) * Number(stats.bsize)
      if (Number.isFinite(availableBytes) && availableBytes < CLIENT_FEEDBACK_ATTACHMENT_POLICY.minFreeBytes) {
        throw new BizError('反馈附件存储空间不足，请稍后重试', 503)
      }
    } catch (error) {
      if (error instanceof BizError) throw error
      // 无法获得磁盘统计的运行环境不伪造容量结论，仍由数据库总量上限兜底。
    }
  }

  async createClientAttachment(input: {
    storageName: string
    originalName: string
    mimeType: string | null
    sizeBytes: number | null
  }, clientAuth: ClientAuthContext) {
    if (!UPLOAD_PUBLIC_FILE_NAME_MATCHER.test(input.storageName)) throw new BizError('反馈附件存储标识非法', 400)
    const sizeBytes = input.sizeBytes
    if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > IMAGE_UPLOAD_MAX_FILE_SIZE) {
      throw new BizError('反馈附件大小非法', 400)
    }
    // 上传频控已由路由在接收文件前通过 consumeAttachmentUploadRate 计次，这里不重复消耗额度。
    await this.assertFeedbackAttachmentDiskCapacity()
    const filePath = path.resolve(ensureUploadCategoryDir('client-feedback'), input.storageName)
    try {
      if (!(await fs.promises.stat(filePath)).isFile()) throw new Error('not-file')
    } catch {
      throw new BizError('反馈附件文件不存在，请重新上传', 404)
    }
    return this.runAttachmentCoordinatedTransaction(async (manager) => {
      // 回收也持有该协调锁，重新确认预检的路径没有在等待期间被清理。
      try {
        await fs.promises.access(filePath, fs.constants.F_OK)
      } catch {
        throw new BizError('反馈附件文件不存在，请重新上传', 404)
      }
      const now = new Date()
      const owner = await this.lockAttachmentOwner(manager, clientAuth.userId, true)
      if (!owner) throw new BizError('客户端用户不存在或已停用', 403)
      const repo = manager.getRepository(ClientFeedbackAttachment)
      const pending = await repo.find({
        where: {
          ownerClientUserId: clientAuth.userId,
          conversationId: IsNull(),
          messageId: IsNull(),
          expiresAt: MoreThan(now),
        },
      })
      const pendingBytes = pending.reduce((sum, item) => sum + Math.max(0, Number(item.sizeBytes) || 0), 0)
      const incomingBytes = Math.max(0, Number(input.sizeBytes) || 0)
      if (pending.length >= CLIENT_FEEDBACK_ATTACHMENT_POLICY.maxPendingAttachmentsPerClient || pendingBytes + incomingBytes > CLIENT_FEEDBACK_ATTACHMENT_POLICY.maxPendingBytesPerClient) {
        throw new BizError('待提交的反馈附件数量或体积已达到上限', 429)
      }
      const totalRaw = await repo.createQueryBuilder('attachment').select('COALESCE(SUM(attachment.sizeBytes), 0)', 'total').getRawOne<{ total: string | number }>()
      if ((Number(totalRaw?.total) || 0) + incomingBytes > CLIENT_FEEDBACK_ATTACHMENT_POLICY.maxTotalBytes) {
        throw new BizError('反馈附件总存储配额已达到上限，请稍后重试', 503)
      }
      const attachment = await repo.save(repo.create({
        ownerClientUserId: clientAuth.userId,
        conversationId: null,
        messageId: null,
        storageName: input.storageName,
        originalName: input.originalName.slice(0, 255),
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        expiresAt: new Date(now.getTime() + CLIENT_FEEDBACK_ATTACHMENT_POLICY.draftTtlMs),
      }))
      return {
        ...this.buildAttachmentReference(attachment),
        id: String(attachment.id),
        expiresAt: attachment.expiresAt,
      }
    })
  }

  private normalizeAttachmentIds(ids: string[] | undefined) {
    const normalizedIds = [...new Set((ids ?? []).map((id) => String(id).trim()).filter(Boolean))]
    if (normalizedIds.length > CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new BizError(`单条消息附件数量不能超过 ${CLIENT_FEEDBACK_MAX_ATTACHMENTS_PER_MESSAGE} 个`, 400)
    }
    if (normalizedIds.some((id) => id.length > 64)) throw new BizError('反馈附件标识非法', 400)
    return normalizedIds
  }

  private buildAttachmentReference(row: ClientFeedbackAttachment) {
    return {
      name: row.originalName,
      url: feedbackAttachmentUrl(row.id),
      mimeType: row.mimeType,
      size: row.sizeBytes,
    }
  }

  private async resolveOwnedAttachmentReferencesInTransaction(
    ids: string[],
    clientAuth: ClientAuthContext,
    manager: EntityManager,
  ): Promise<ClientFeedbackMessageAttachment[]> {
    const normalizedIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    if (!normalizedIds.length) return []
    const owner = await this.lockAttachmentOwner(manager, clientAuth.userId, true)
    if (!owner) throw new BizError('客户端用户不存在或已停用', 403)
    const rows = await manager.getRepository(ClientFeedbackAttachment).find({
      where: {
        id: In(normalizedIds),
        ownerClientUserId: clientAuth.userId,
        conversationId: IsNull(),
        messageId: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    })
    const now = new Date()
    if (rows.length !== normalizedIds.length || rows.some((row) => row.expiresAt && row.expiresAt <= now)) {
      throw new BizError('反馈附件不存在、已过期或已被使用', 404)
    }
    const byId = new Map(rows.map((row) => [String(row.id), row]))
    return normalizedIds.map((id) => this.buildAttachmentReference(byId.get(id)!))
  }

  private async resolveBoundAttachmentReferences(
    attachments: ClientFeedbackMessageAttachment[],
    conversation: ClientFeedbackConversation,
    manager: EntityManager,
  ): Promise<ClientFeedbackMessageAttachment[]> {
    if (!attachments.length) return []
    const ids = attachments.map(({ url }) => url.slice(url.lastIndexOf('/') + 1))
    if (ids.some((id) => !/^[1-9]\d{0,19}$/.test(id))) throw new BizError('反馈附件不存在', 404)
    const rows = await manager.getRepository(ClientFeedbackAttachment).findBy({
      id: In(ids), conversationId: conversation.id, ownerClientUserId: conversation.clientUserId,
    })
    const messageIds = rows.map((row) => row.messageId).filter((id): id is string => Boolean(id))
    const messages = new Map(messageIds.length
      ? (await manager.getRepository(ClientFeedbackMessage).findBy({ id: In(messageIds), conversationId: conversation.id }))
        .map((message) => [String(message.id), message])
      : [])
    const rowsById = new Map(rows.map((row) => [String(row.id), row]))
    return Promise.all(ids.map(async (id) => {
      const row = rowsById.get(id)
      const message = row?.messageId ? messages.get(row.messageId) : undefined
      if (!row || !message || !UPLOAD_PUBLIC_FILE_NAME_MATCHER.test(row.storageName)
        || !this.messageReferencesBoundAttachment(message, row)) throw new BizError('反馈附件不存在', 404)
      const file = path.join(ensureUploadCategoryDir('client-feedback'), row.storageName)
      try {
        if (!(await fs.promises.lstat(file)).isFile()) throw new BizError('反馈附件不存在', 404)
        await fs.promises.access(file, fs.constants.R_OK)
      } catch {
        throw new BizError('反馈附件不存在', 404)
      }
      return this.buildAttachmentReference(row)
    }))
  }

  private async bindOwnedAttachmentsToMessage(
    manager: EntityManager,
    attachmentIds: string[],
    clientAuth: ClientAuthContext,
    conversationId: string,
    messageId: string,
  ) {
    if (!attachmentIds.length) return
    const result = await manager.getRepository(ClientFeedbackAttachment).update(
      {
        id: In(attachmentIds),
        ownerClientUserId: clientAuth.userId,
        conversationId: IsNull(),
        messageId: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      { conversationId, messageId, expiresAt: null },
    )
    if (result.affected !== attachmentIds.length) {
      throw new BizError('反馈附件不存在、已过期或已被使用', 404)
    }
  }

  /** 清理使用数据库中的精确 ID，避开 SQLite 驱动对大整数的 Number 转换。 */
  private attachmentCleanupQuery(manager: EntityManager) {
    const textType = manager.connection.options.type === 'mysql' ? 'CHAR' : 'TEXT'
    return manager.getRepository(ClientFeedbackAttachment).createQueryBuilder('attachment')
      .select(`CAST(attachment.id AS ${textType})`, 'id')
      .addSelect(`CAST(attachment.ownerClientUserId AS ${textType})`, 'ownerClientUserId')
      .addSelect('attachment.storageName', 'storageName')
      .addSelect('attachment.conversationId', 'conversationId')
      .addSelect('attachment.messageId', 'messageId')
  }

  private async groupAttachmentStorageRows(names: string[], manager: EntityManager = AppDataSource.manager, now?: Date) {
    const result = new Map<string, Array<AttachmentCleanupRow & { expired?: number | string }>>()
    for (let start = 0; start < names.length; start += ATTACHMENT_CLEANUP_READ_SIZE) {
      const query = this.attachmentCleanupQuery(manager)
        .where('attachment.storageName IN (:...names)', { names: names.slice(start, start + ATTACHMENT_CLEANUP_READ_SIZE) })
      if (now) {
        query.addSelect('CASE WHEN attachment.expiresAt <= :now THEN 1 ELSE 0 END', 'expired').setParameter('now', now)
      }
      const rows = await query.getRawMany<AttachmentCleanupRow & { expired?: number | string }>()
      for (const row of rows) {
        const key = row.storageName.toLowerCase()
        const matches = result.get(key) ?? []
        matches.push(row)
        result.set(key, matches)
      }
    }
    return result
  }

  /** 批量定位候选文件的历史快照，所有消息读取和解析均在写锁之外。 */
  private async collectHistoricalAttachmentReferences(candidates: AttachmentCleanupCandidate[]) {
    const storageNames = new Map(candidates.map(({ storageName }) => [storageName.toLowerCase(), storageName]))
    const draftNamesById = new Map(candidates.flatMap(({ storageName, draft }) => draft ? [[draft.id, storageName] as const] : []))
    const references = new Map<string, 'referenced' | 'uncertain'>()
    if (!candidates.length) return references

    const repo = AppDataSource.getRepository(ClientFeedbackMessage)
    const sqlite = AppDataSource.options.type === 'sqlite'
    const textType = sqlite ? 'TEXT' : 'CHAR'
    const idType = sqlite ? 'INTEGER' : 'UNSIGNED'
    const [lastMessage] = await repo.createQueryBuilder('message')
      .select(`CAST(message.id AS ${textType})`, 'id')
      .orderBy('message.id', 'DESC').take(1)
      .getRawMany<{ id: string }>()
    if (!lastMessage) return references
    const uploadNamePattern = new RegExp(UPLOAD_PUBLIC_FILE_NAME_MATCHER.source.slice(1, -1), 'gi')
    const record = (storageName: string | undefined, evidence: 'referenced' | 'uncertain') => {
      if (storageName && references.get(storageName) !== 'referenced') references.set(storageName, evidence)
    }
    const inspect = (text: string, evidence: 'referenced' | 'uncertain') => {
      for (const match of text.matchAll(uploadNamePattern)) record(storageNames.get(match[0].toLowerCase()), evidence)
      for (const match of text.matchAll(/\/attachments\/(\d+)/g)) record(draftNamesById.get(match[1]!), evidence)
    }

    // 历史异常行可能引用未绑定草稿。数据库先筛可能含候选文件或附件 ID 的消息；
    // 带转义的 JSON 交回旧检查，避免漏掉 Unicode、转义斜杠等兼容格式。
    const identifiers = [...storageNames.keys(), ...draftNamesById.keys()]
    // 大批次限制 SQL 谓词数量，回退到识别潜在 UUID、路由 ID 与历史字段的粗筛。
    const needles = identifiers.length <= 128 ? identifiers : ['-', '/attachments/', 'attachmentid']
    const conditions = needles.map((_, index) => 'INSTR(LOWER(message.attachmentJson), :needle' + index + ') > 0')
    const parameters = Object.fromEntries(needles.map((needle, index) => ['needle' + index, needle]))
    conditions.push('INSTR(message.attachmentJson, :escape) > 0')

    // 消息只追加。新的合法引用只能绑定有效草稿或引用同会话已绑定附件，最终会二次校验登记行。
    let after = '0'
    while (true) {
      const page = await repo.createQueryBuilder('message')
        .select(`CAST(message.id AS ${textType})`, 'id')
        .addSelect('message.attachmentJson', 'attachmentJson')
        .where(`message.id > CAST(:after AS ${idType}) AND message.id <= CAST(:lastId AS ${idType})`, { after, lastId: lastMessage.id })
        .andWhere('(' + conditions.join(' OR ') + ')', { ...parameters, escape: '\\' })
        .orderBy('message.id', 'ASC')
        .take(ATTACHMENT_CLEANUP_READ_SIZE)
        .getRawMany<{ id: string; attachmentJson: string | null }>()
      for (const { attachmentJson } of page) {
        if (!attachmentJson || attachmentJson === '[]') continue
        const items = this.parseJsonArray<unknown>(attachmentJson, [], (key, value, context) => {
          if (key !== 'attachmentId' || typeof value !== 'number') return value
          // 旧快照可能将 BIGINT ID 写成 JSON 数字，避免先转成双精度再判定引用。
          return context?.source ?? (Number.isSafeInteger(value) ? String(value) : null)
        })
        if (items.length > 0) {
          for (const item of items) {
            if (!item || typeof item !== 'object') continue
            if ('url' in item && typeof item.url === 'string') inspect(item.url, 'referenced')
            if ('attachmentId' in item && typeof item.attachmentId === 'string') {
              record(draftNamesById.get(item.attachmentId.trim()), 'referenced')
            }
          }
        } else {
          inspect(attachmentJson.replaceAll('\\/', '/'), 'uncertain')
          for (const match of attachmentJson.matchAll(/"attachmentId"\s*:\s*"?(\d+)/g)) {
            record(draftNamesById.get(match[1]!), 'uncertain')
          }
        }
      }
      if (page.length < ATTACHMENT_CLEANUP_READ_SIZE || references.size === candidates.length) return references
      after = page.at(-1)!.id
    }
  }

  private async removeExpiredAttachmentDrafts(
    candidates: AttachmentCleanupRow[],
    now: Date,
    anomalies: ClientFeedbackAttachmentCleanupAnomaly[],
  ) {
    if (!candidates.length) return []
    return this.runAttachmentCoordinatedTransaction(async (manager, isMysql) => {
      const textType = isMysql ? 'CHAR' : 'TEXT'
      const idType = isMysql ? 'UNSIGNED' : 'INTEGER'
      const ownerQuery = manager.getRepository(ClientUser).createQueryBuilder('owner')
        .select(`CAST(owner.id AS ${textType})`, 'id')
        .where({ id: In([...new Set(candidates.map((item) => item.ownerClientUserId))]) })
        .orderBy('owner.id', 'ASC')
      if (isMysql) ownerQuery.setLock('pessimistic_write')
      const owners = await ownerQuery.getRawMany<{ id: string }>()
      const ownerIds = new Set(owners.map(({ id }) => id))
      const stored = await this.groupAttachmentStorageRows(candidates.map((item) => item.storageName), manager, now)
      const removable: AttachmentCleanupRow[] = []
      for (const previous of candidates) {
        const matches = stored.get(previous.storageName.toLowerCase()) ?? []
        if (matches.length > 1) {
          anomalies.push({ storageName: previous.storageName, reason: '同一存储名存在多条附件记录，保留待人工核查' })
          continue
        }
        const current = matches[0]
        if (!current || previous.id !== current.id || current.storageName !== previous.storageName
          || current.ownerClientUserId !== previous.ownerClientUserId || current.messageId || current.conversationId
          || Number(current.expired) !== 1) continue
        if (!ownerIds.has(current.ownerClientUserId)) {
          anomalies.push({ storageName: current.storageName, reason: '草稿所属用户不存在，保留记录与文件待人工核查' })
          continue
        }
        removable.push(current)
      }
      if (removable.length) {
        const parameters = Object.fromEntries(removable.map(({ id }, index) => [`draft${index}`, id]))
        const ids = Object.keys(parameters).map((key) => `CAST(:${key} AS ${idType})`).join(', ')
        await manager.getRepository(ClientFeedbackAttachment).createQueryBuilder().delete()
          .where(`id IN (${ids})`, parameters).execute()
      }
      return removable.map(({ storageName }) => storageName)
    })
  }

  private async removeUnregisteredAttachmentFiles(
    directory: string,
    expirationByName: ReadonlyMap<string, number>,
    anomalies: ClientFeedbackAttachmentCleanupAnomaly[],
  ) {
    if (!expirationByName.size || !(await fs.promises.lstat(directory)).isDirectory()) return new Set<string>()
    return this.runAttachmentCoordinatedTransaction(async (manager) => {
      const rows = await this.groupAttachmentStorageRows([...expirationByName.keys()], manager)
      const removed = new Set<string>()
      for (const [storageName, cutoff] of expirationByName) {
        if (rows.has(storageName.toLowerCase())) continue
        const file = path.join(directory, storageName)
        try {
          const info = await fs.promises.lstat(file)
          if (!info.isFile() || info.mtimeMs > cutoff) continue
          await fs.promises.unlink(file)
          removed.add(storageName)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          if (!isRecoverableUploadFileCleanupError(error)) throw error
          anomalies.push({ storageName, reason: '附件文件无法访问或正在使用，保留待下次核查' })
        }
      }
      return removed
    })
  }

  private async performAttachmentCleanup(): Promise<ClientFeedbackAttachmentCleanupResult> {
    const now = new Date()
    const { orphanGraceMs, cleanupBatchSize, tempFileGraceMs } = CLIENT_FEEDBACK_ATTACHMENT_POLICY
    const orphanCutoffTime = now.getTime() - orphanGraceMs
    const directory = ensureUploadCategoryDir('client-feedback')
    const anomalies: ClientFeedbackAttachmentCleanupAnomaly[] = []
    const directoryIsSafe = (await fs.promises.lstat(directory)).isDirectory()
    const entries = directoryIsSafe
      ? await fs.promises.readdir(directory, { withFileTypes: true })
      : []
    const names = entries.flatMap((entry) => {
      if (entry.isFile() && UPLOAD_PUBLIC_FILE_NAME_MATCHER.test(entry.name)) return [entry.name]
      if (anomalies.length < cleanupBatchSize) {
        anomalies.push({ storageName: entry.name, reason: '目录项不是受控 UUID 普通文件，保留待人工核查' })
      }
      return []
    }).sort()
    const scanLimit = Math.max(1_000, cleanupBatchSize * 2)
    const scanPage = names.filter((name) => name > this.attachmentCleanupFileCursor).slice(0, scanLimit)
    const idType = AppDataSource.options.type === 'mysql' ? 'UNSIGNED' : 'INTEGER'
    const drafts = !directoryIsSafe ? [] : await this.attachmentCleanupQuery(AppDataSource.manager)
      .where(`attachment.id > CAST(:cursor AS ${idType})`, { cursor: this.attachmentCleanupDraftCursor || '0' })
      .andWhere({ expiresAt: LessThanOrEqual(now), conversationId: IsNull(), messageId: IsNull() })
      .orderBy('attachment.id', 'ASC').take(cleanupBatchSize)
      .getRawMany<AttachmentCleanupRow>()
    const stored = await this.groupAttachmentStorageRows([...new Set([...scanPage, ...drafts.map(({ storageName }) => storageName)])])
    const candidates: AttachmentCleanupCandidate[] = []
    for (const draft of drafts) {
      if (!UPLOAD_PUBLIC_FILE_NAME_MATCHER.test(draft.storageName)) {
        anomalies.push({ storageName: draft.storageName, reason: '草稿存储名不符合受控 UUID 规则，保留待人工核查' })
      } else if (stored.get(draft.storageName.toLowerCase())?.length !== 1) {
        anomalies.push({ storageName: draft.storageName, reason: '草稿存储名对应的登记记录不一致，保留待人工核查' })
      } else {
        candidates.push({ storageName: draft.storageName, draft })
      }
    }

    const retainedReferencedNames = new Set<string>()
    let orphanCount = 0
    const observedBindings: AttachmentCleanupRow[] = []
    let visitedName = ''
    for (const storageName of scanPage) {
      visitedName = storageName
      const matches = stored.get(storageName.toLowerCase()) ?? []
      const attachment = matches[0]
      if (attachment) {
        retainedReferencedNames.add(storageName.toLowerCase())
        if (matches.length > 1 || Boolean(attachment.conversationId) !== Boolean(attachment.messageId)) {
          anomalies.push({ storageName, reason: '附件登记或绑定关系不一致，保留待人工核查' })
        } else if (attachment.messageId && attachment.conversationId) {
          observedBindings.push(attachment)
        }
        continue
      }
      try {
        const info = await fs.promises.lstat(path.join(directory, storageName))
        if (info.isFile() && info.mtimeMs <= orphanCutoffTime) {
          candidates.push({ storageName })
          orphanCount += 1
          if (orphanCount >= cleanupBatchSize) break
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        if (!isRecoverableUploadFileCleanupError(error)) throw error
        anomalies.push({ storageName, reason: '附件文件无法访问或正在使用，保留待下次核查' })
      }
    }

    for (let start = 0; start < observedBindings.length; start += ATTACHMENT_CLEANUP_READ_SIZE) {
      const watched = observedBindings.slice(start, start + ATTACHMENT_CLEANUP_READ_SIZE)
      const messages = await AppDataSource.getRepository(ClientFeedbackMessage).findBy({ id: In(watched.map(({ messageId }) => messageId!)) })
      const byId = new Map(messages.map((message) => [String(message.id), message]))
      for (const attachment of watched) {
        const message = byId.get(attachment.messageId!)
        if (!message || String(message.conversationId) !== String(attachment.conversationId)
          || !this.messageReferencesBoundAttachment(message, attachment)) {
          anomalies.push({ storageName: attachment.storageName, reason: '附件登记与绑定消息快照不一致，保留待人工核查' })
        }
      }
    }

    const references = await this.collectHistoricalAttachmentReferences(candidates)
    const eligible = candidates.filter(({ storageName, draft }) => {
      const evidence = references.get(storageName)
      if (!evidence) return true
      if (!draft) retainedReferencedNames.add(storageName.toLowerCase())
      anomalies.push({
        storageName,
        reason: evidence === 'uncertain' ? '消息附件历史格式无法确认，保留待人工核查' : '文件仍被历史消息引用，保留待人工核查',
      })
      return false
    })

    let removedExpiredDrafts = 0
    let removedOrphanFiles = 0
    for (let start = 0; start < eligible.length; start += ATTACHMENT_CLEANUP_TRANSACTION_SIZE) {
      const batch = eligible.slice(start, start + ATTACHMENT_CLEANUP_TRANSACTION_SIZE)
      const expired = await this.removeExpiredAttachmentDrafts(batch.flatMap(({ draft }) => draft ? [draft] : []), now, anomalies)
      removedExpiredDrafts += expired.length
      const cutoffByName = new Map(batch.filter(({ draft }) => !draft).map(({ storageName }) => [storageName, orphanCutoffTime]))
      for (const storageName of expired) {
        retainedReferencedNames.delete(storageName.toLowerCase())
        cutoffByName.set(storageName, now.getTime())
      }
      // 全部文件在删除前重新确认未登记。过期草稿必须先提交数据库删除，不能在回滚后遗留错误记录。
      const removed = await this.removeUnregisteredAttachmentFiles(directory, cutoffByName, anomalies)
      removedOrphanFiles += batch.filter(({ draft, storageName }) => !draft && removed.has(storageName)).length
    }

    const temp = await cleanupExpiredUploadTempFiles(now.getTime() - tempFileGraceMs, cleanupBatchSize, this.attachmentCleanupTempCursor)
    for (const storageName of temp.failed) {
      anomalies.push({ storageName, reason: '临时文件无法访问或正在使用，保留待下次核查' })
    }
    this.attachmentCleanupTempCursor = temp.cursor
    this.attachmentCleanupDraftCursor = drafts.length === cleanupBatchSize ? drafts.at(-1)!.id : ''
    this.attachmentCleanupFileCursor = visitedName && visitedName !== names.at(-1) ? visitedName : ''
    return {
      scannedFiles: entries.length,
      removedExpiredDrafts,
      removedOrphanFiles,
      removedTempFiles: temp.removed,
      retainedReferencedFiles: retainedReferencedNames.size,
      anomalies,
    }
  }

  async runAttachmentCleanupOnce(): Promise<ClientFeedbackAttachmentCleanupResult> {
    if (this.attachmentCleanupInFlight) return this.attachmentCleanupInFlight
    const run = databaseOperationGate.runOperation(() => this.performAttachmentCleanup())
    this.attachmentCleanupInFlight = run
    try {
      return await run
    } finally {
      if (this.attachmentCleanupInFlight === run) this.attachmentCleanupInFlight = null
    }
  }

  startAttachmentCleanupWorker(): void {
    this.attachmentCleanupWorkerDesired = true
    this.startAttachmentCleanupTimer()
  }

  private startAttachmentCleanupTimer(): void {
    if (databaseOperationGate.isFrozen() || this.attachmentCleanupTimer !== null) return
    const trigger = () => {
      // 多实例时同一轮只由抢到租约的实例执行（前提是各实例共享上传目录）；Redis 未启用或降级时各实例照常执行。
      void runExclusive('job:feedback-attachment-cleanup', 60_000, () => this.runAttachmentCleanupOnce()).then(({ value: result }) => {
        if (result?.anomalies.length) {
          console.warn(`[client-feedback-attachment] 清理发现 ${result.anomalies.length} 个不确定项，均已保留`)
        }
      }).catch((error) => {
        console.error('[client-feedback-attachment] 后台清理周期失败', toSafeErrorLog(error))
      })
    }
    this.attachmentCleanupTimer = globalThis.setInterval(trigger, CLIENT_FEEDBACK_ATTACHMENT_POLICY.cleanupIntervalMs)
    this.attachmentCleanupTimer.unref?.()
    queueMicrotask(trigger)
  }

  async stopAttachmentCleanupWorker(): Promise<void> {
    this.attachmentCleanupWorkerDesired = false
    this.pauseAttachmentCleanupWorker()
    if (this.attachmentCleanupInFlight) await this.attachmentCleanupInFlight
  }

  private pauseAttachmentCleanupWorker(): void {
    if (this.attachmentCleanupTimer !== null) {
      globalThis.clearInterval(this.attachmentCleanupTimer)
      this.attachmentCleanupTimer = null
    }
  }

  private async isAttachmentBoundToMessage(attachment: ClientFeedbackAttachment) {
    if (!attachment.messageId || !attachment.conversationId) return false
    const message = await AppDataSource.getRepository(ClientFeedbackMessage).findOne({
      where: { id: attachment.messageId, conversationId: attachment.conversationId },
    })
    if (!message) return false
    return this.messageReferencesBoundAttachment(message, attachment)
  }

  private messageReferencesBoundAttachment(message: ClientFeedbackMessage, attachment: Pick<ClientFeedbackAttachment, 'id'>) {
    const url = feedbackAttachmentUrl(attachment.id)
    return this.parseJsonArray<ClientFeedbackMessageAttachment>(message.attachmentJson, [])
      .some((item) => item?.url === url)
  }

  async getAttachmentForClient(id: string, clientAuth: ClientAuthContext) {
    const attachment = await this.attachmentRepo.findOne({ where: { id, ownerClientUserId: clientAuth.userId } })
    if (!attachment) throw new BizError('反馈附件不存在', 404)
    const isDraft = !attachment.messageId && !attachment.conversationId && Boolean(attachment.expiresAt && attachment.expiresAt > new Date())
    if (!isDraft && !(await this.isAttachmentBoundToMessage(attachment))) throw new BizError('反馈附件不存在', 404)
    return attachment
  }

  async getAttachmentForCustomerService(id: string) {
    const attachment = await this.attachmentRepo.findOne({ where: { id } })
    if (!attachment || !(await this.isAttachmentBoundToMessage(attachment))) throw new BizError('反馈附件不存在', 404)
    return attachment
  }

  private parseJsonArray<T>(
    rawValue: string | null | undefined,
    fallback: T[],
    reviver?: (key: string, value: unknown, context?: { source?: string }) => unknown,
  ): T[] {
    const text = rawValue?.trim()
    if (!text) {
      return fallback
    }
    try {
      const parsed = JSON.parse(text, reviver)
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
    serverNow = new Date(),
  ): ClientFeedbackConversationSummary {
    return {
      restock: buildRestockView(conversation.restock, serverNow),
      serverNow,
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
    const query = repository.createQueryBuilder('conversation')
      .leftJoinAndSelect('conversation.restock', 'restock')
      .where('conversation.id = :id', { id })
    if (manager && manager !== AppDataSource.manager && manager.connection.options.type === 'mysql') {
      query.setLock('pessimistic_write')
    }
    const conversation = await query.getOne()
    if (!conversation) {
      throw new BizError('反馈会话不存在', 404)
    }
    return conversation
  }

  /** 锁后复核目标负责人仍具备客服工作台处理能力。 */
  private assertAssignableServiceUser(user: SysUser) {
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

  private async requireEditableServiceConversation(id: string, actor: AuthUserContext, manager: EntityManager) {
    const account = await lockActiveSysAccountForBusiness(manager, actor.userId)
    if (!resolveUserPermissions(account).includes('customer_service:reply')) {
      throw new BizError('当前账号无客服处理权限', 403)
    }
    const conversation = await this.requireConversationById(id, manager)
    this.ensureConversationOwnedByActor(conversation, actor)
    if (conversation.status === 'closed') {
      throw new BizError('当前反馈会话已关闭，请先重新打开后再处理', 400)
    }
    return conversation
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
    return this.buildClientUserSnapshot(clientUser)
  }

  private buildClientUserSnapshot(clientUser: ClientUser) {
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
    attachmentIds: string[] = [],
    attachmentOwner?: ClientAuthContext,
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

    if (attachmentIds.length && attachmentOwner) {
      await this.bindOwnedAttachmentsToMessage(manager, attachmentIds, attachmentOwner, conversation.id, message.id)
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

  private countVisibleUnreadMessages(messages: ClientFeedbackMessage[], scope: 'client' | 'service'): number {
    const readAt = scope === 'client' ? 'clientReadAt' : 'serviceReadAt'
    let unread = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!
      // 自己发送消息已清掉此前的未读计数，即使历史消息的已读时间仍为空。
      if (FEEDBACK_SENDERS_BY_SIDE[scope].includes(message.senderType)) break
      if (!message[readAt]) unread += 1
    }
    return unread
  }

  private async markConversationRead(
    manager: EntityManager,
    conversation: ClientFeedbackConversation,
    scope: 'client' | 'service',
    lastVisibleId: string,
  ) {
    const client = scope === 'client'
    const unreadCount = client ? 'unreadForClientCount' : 'unreadForServiceCount'
    if (conversation[unreadCount] <= 0) return false
    const readAt = client ? 'clientReadAt' : 'serviceReadAt'
    const senderTypes = FEEDBACK_SENDERS_BY_SIDE[client ? 'service' : 'client']
    const filter = {
      conversationId: conversation.id,
      senderType: In(senderTypes),
      [readAt]: IsNull(),
      ...(client ? { internalOnly: false } : {}),
    }
    const messages = manager.getRepository(ClientFeedbackMessage)
    const { affected } = await messages.update({ ...filter, id: LessThanOrEqual(lastVisibleId) }, { [readAt]: new Date() })
    if (!affected) return false
    // 会话锁串行化追加与已读。并发的本方回复已清零此前的未读计数，其前面的旧消息不能被计回。
    const latestOwnReply = await messages.findOne({
      select: { id: true },
      where: { conversationId: conversation.id, senderType: In(FEEDBACK_SENDERS_BY_SIDE[scope]), id: MoreThan(lastVisibleId) },
      order: { id: 'DESC' },
    })
    conversation[unreadCount] = await messages.countBy({ ...filter, id: MoreThan(latestOwnReply?.id ?? lastVisibleId) })
    await manager.getRepository(ClientFeedbackConversation).save(conversation)
    return true
  }

  private async loadConversationMessages(manager: EntityManager, conversationId: string, lastVisibleId?: string) {
    return manager.getRepository(ClientFeedbackMessage).find({
      where: { conversationId, ...(lastVisibleId ? { id: LessThanOrEqual(lastVisibleId) } : {}) },
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
    const registrationTicket = customerServiceRealtimeService.captureOwnerGeneration('client', clientAuth.userId, clientAuth.sessionToken)
    const config = await this.getPortalConfigs()
    if (!config.realtimeEnabled) {
      throw new BizError('当前客服实时通道未启用', 403)
    }
    await customerServiceRealtimeService.assertOwnerCanRegister(registrationTicket, clientAuth.sessionToken)
    customerServiceRealtimeService.openClientStream(clientAuth.userId, clientAuth.sessionToken, res, config.sseKeepaliveSeconds, registrationTicket, {
      availability: config.availability,
    })
  }

  async openServiceRealtimeChannel(actor: AuthUserContext, res: import('express').Response) {
    const registrationTicket = customerServiceRealtimeService.captureOwnerGeneration('service', actor.userId, actor.sessionToken)
    const config = await this.getPortalConfigs()
    if (!config.realtimeEnabled) {
      throw new BizError('当前客服实时通道未启用', 403)
    }
    await customerServiceRealtimeService.assertOwnerCanRegister(registrationTicket, actor.sessionToken)
    customerServiceRealtimeService.openServiceStream(
      actor.userId,
      actor.sessionToken,
      res,
      config.sseKeepaliveSeconds,
      registrationTicket,
      (sessionSnapshot) => ({
        // 连接先注册再回填在线态，确保首个客服进入工作台时也能立即显示在线。
        availability: this.buildAvailability(config, sessionSnapshot),
      }),
    )
  }

  /** 当前读在账号锁之后执行，避免 MySQL REPEATABLE READ 读到锁等待之前的旧快照。 */
  private async findRestockInTransaction(manager: EntityManager, clientUserId: string, filter: { clientRequestId: string } | { skuId: string }, now: Date) {
    const query = manager.getRepository(ClientRestockRequest).createQueryBuilder('restock')
      .where('restock.clientUserId = :clientUserId', { clientUserId })
    if ('clientRequestId' in filter) query.andWhere('restock.clientRequestId = :clientRequestId', filter)
    else query.andWhere('restock.skuId = :skuId', filter)
      .andWhere(`(${effectiveRestockStatusSql('restock')}) IN ('requested', 'accepted')`, { restockNow: now })
    query.orderBy('restock.id', 'DESC')
    if (manager.connection.options.type === 'mysql') query.setLock('pessimistic_write')
    return query.getOne()
  }

  async getActiveRestockRequest(clientAuth: ClientAuthContext, skuId: string) {
    if (!/^[1-9]\d{0,19}$/.test(skuId)) throw new BizError('规格标识无效', 400)
    const serverNow = new Date()
    const restock = await AppDataSource.getRepository(ClientRestockRequest).createQueryBuilder('restock')
      .where('restock.clientUserId = :clientUserId AND restock.skuId = :skuId', { clientUserId: clientAuth.userId, skuId })
      .andWhere(`(${effectiveRestockStatusSql('restock')}) IN ('requested', 'accepted')`, { restockNow: serverNow })
      .orderBy('restock.id', 'DESC').getOne()
    return { restock: buildRestockView(restock, serverNow), serverNow }
  }

  async createRestockRequest(input: CreateRestockRequestInput, clientAuth: ClientAuthContext, requestMeta?: RequestMeta) {
    const normalized = normalizeRestockRequest(input)
    // 只读配置在事务外取值，不能在已获取业务锁之后触发配置的惰性初始化。
    const createOnce = (portalConfig: ClientFeedbackPortalConfigRecord) => runInTransaction(async (manager) => {
      const account = await lockActiveClientAccountForBusiness(manager, clientAuth.userId)
      const now = new Date()
      const keyRepo = manager.getRepository(ClientRestockRequestKey)
      const keyQuery = keyRepo.createQueryBuilder('key').where('key.clientUserId = :clientUserId AND key.clientRequestId = :clientRequestId', { clientUserId: clientAuth.userId, clientRequestId: normalized.clientRequestId })
      if (manager.connection.options.type === 'mysql') keyQuery.setLock('pessimistic_write')
      const existingKey = await keyQuery.getOne()
      if (existingKey && existingKey.payloadDigest !== normalized.payloadDigest) throw new BizError('相同请求标识不能提交不同补货内容', 409)
      let existing: ClientRestockRequest | null
      if (existingKey) {
        const requestQuery = manager.getRepository(ClientRestockRequest).createQueryBuilder('restock').where('restock.id = :id AND restock.clientUserId = :clientUserId', { id: existingKey.restockRequestId, clientUserId: clientAuth.userId })
        if (manager.connection.options.type === 'mysql') requestQuery.setLock('pessimistic_write')
        existing = await requestQuery.getOne()
        if (!existing) throw new BizError('补货请求记录异常，请联系客服', 409)
      } else existing = await this.findRestockInTransaction(manager, clientAuth.userId, { skuId: normalized.skuId }, now)
      // 活跃查询可能等待客服持有的行锁；等待期间到期的需求应立即释放新申请资格。
      if (!existingKey && existing && effectiveRestockStatus(existing, new Date()) === 'expired') existing = null
      if (existing) {
        if (!existingKey) await keyRepo.save(keyRepo.create({ clientUserId: clientAuth.userId, clientRequestId: normalized.clientRequestId, payloadDigest: normalized.payloadDigest, restockRequestId: existing.id }))
        // 这里不获取会话写锁：既有需求仅回读，避免与客服的“会话 -> 补货”锁序交叉。
        const conversation = await manager.getRepository(ClientFeedbackConversation).findOneBy({ id: existing.conversationId })
        if (!conversation) throw new BizError('补货会话记录异常，请联系客服', 409)
        conversation.restock = existing
        return { conversation, message: null as ClientFeedbackMessage | null, created: false }
      }
      if (!portalConfig.enabled) throw new BizError('当前系统暂未开放在线反馈入口', 403)
      if (normalized.latestPickupAt.getTime() <= Date.now()) throw new BizError('最晚取货时间必须晚于当前时间', 400)
      const productQuery = manager.getRepository(BaseProduct).createQueryBuilder('product').where('product.id = :id', { id: normalized.productId })
      if (manager.connection.options.type === 'mysql') productQuery.setLock('pessimistic_write')
      const product = await productQuery.getOne()
      if (!product || !product.isActive || product.o2oStatus !== 'listed') throw new BizError('商品已下架或停用，暂不能申请补货', 409)
      const skuQuery = manager.getRepository(BaseProductSku).createQueryBuilder('sku').where('sku.id = :id AND sku.productId = :productId', { id: normalized.skuId, productId: product.id })
      if (manager.connection.options.type === 'mysql') skuQuery.setLock('pessimistic_write')
      const sku = await skuQuery.getOne()
      if (!sku || !sku.isActive || !sku.isCurrent) throw new BizError('当前规格已停用或退役，请刷新商品后重试', 409)
      // 补货独立登记期望数量，不受现货或购物限购限制，也不预占库存。
      if (normalized.latestPickupAt.getTime() <= Date.now()) throw new BizError('最晚取货时间已到，请重新选择', 409)
      const snapshot = this.buildClientUserSnapshot(account)
      const pickupTime = new Date(normalized.latestPickupAt.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
      const content = `申请补货：${product.productName}（${sku.specText || '默认规格'}），数量 ${normalized.quantity}，最晚取货时间 ${pickupTime}（UTC+8）。${normalized.remark ? `备注：${normalized.remark}` : ''}`
      const repo = manager.getRepository(ClientFeedbackConversation)
      const conversationNo = await this.buildConversationNo(manager)
      // 编号分配也是可能等待的锁；必须在最后一次锁等待之后复核截止时间。
      if (normalized.latestPickupAt.getTime() <= Date.now()) throw new BizError('最晚取货时间已到，请重新选择', 409)
      const conversation = await repo.save(repo.create({
        ...snapshot, clientUserId: clientAuth.userId, conversationNo,
        issueType: 'restock', category: 'restock', sourceCode: 'client_mall', sourceLabel: '商城补货需求',
        subject: `补货需求：${product.productName}`.slice(0, CLIENT_FEEDBACK_SUBJECT_MAX_LENGTH), priority: 'normal',
        expectedResult: '请在最晚取货时间前安排补货', actualResult: '申请登记商品补货需求', tagJson: '[]',
        status: 'open', lastMessagePreview: this.previewMessage(content), lastMessageSenderType: 'client',
        lastMessageAt: now, unreadForClientCount: 0, unreadForServiceCount: 0,
      }))
      const restockRepo = manager.getRepository(ClientRestockRequest)
      conversation.restock = await restockRepo.save(restockRepo.create({ ...normalized,
        conversationId: conversation.id, clientUserId: clientAuth.userId, productNameSnapshot: product.productName,
        productCodeSnapshot: product.productCode, skuCodeSnapshot: sku.skuCode, specTextSnapshot: sku.specText || '默认规格',
        status: 'requested', handledAt: null,
      }))
      await keyRepo.save(keyRepo.create({ clientUserId: clientAuth.userId, clientRequestId: normalized.clientRequestId, payloadDigest: normalized.payloadDigest, restockRequestId: conversation.restock.id }))
      const message = await this.createMessage(manager, conversation, { senderType: 'client', senderUserId: clientAuth.userId,
        senderName: snapshot.clientUsername || snapshot.clientAccount, conversationStatus: 'open' }, content)
      await auditService.record({ actionType: 'client_feedback.restock_create', actionLabel: '客户端申请补货',
        targetType: 'feedback_conversation', targetId: conversation.id, targetCode: conversation.conversationNo,
        actor: { userId: clientAuth.userId, username: clientAuth.account, displayName: snapshot.clientUsername || snapshot.clientAccount }, requestMeta,
        detail: { productId: product.id, skuId: sku.id, quantity: normalized.quantity, latestPickupAt: normalized.latestPickupAt.toISOString() },
      }, manager)
      await notificationService.emitEvent({ eventType: 'customer_service_client_message_created', sourceType: 'client_feedback_conversation', sourceId: conversation.id,
        payload: { conversationNo: conversation.conversationNo, sourceUserId: clientAuth.userId, sourceUserDisplayName: snapshot.clientUsername || snapshot.clientAccount, summary: content.slice(0, 100) }, requestMeta,
      }, manager)
      return { conversation, message, created: true }
    })
    let result: Awaited<ReturnType<typeof createOnce>> | undefined
    const maxAttempts = AppDataSource.options.type === 'mysql' ? 4 : 3
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try { result = await createOnce(await this.getPortalConfigs()); break } catch (error) {
        const retryableMysqlLock = AppDataSource.options.type === 'mysql' && isRetryableMysqlTransactionError(error)
        if (attempt < maxAttempts && (retryableMysqlLock || isUniqueConstraintError(error, FEEDBACK_CONVERSATION_NO_UNIQUE_CONSTRAINT_MATCHER))) {
          if (retryableMysqlLock) await new Promise<void>((resolve) => setTimeout(resolve, 25 * (2 ** (attempt - 1)) + randomInt(25)))
          // 重放完整账号锁、当前读、商品/SKU与期限检查，所有副作用仍受同一事务边界保护。
          continue
        }
        throw error
      }
    }
    if (!result) throw new BizError('补货申请未能提交，请重试', 500)
    const message = result.message ? this.buildMessageView(result.message, { scope: 'client', userId: clientAuth.userId }) : null
    if (result.created) this.publishConversationEvent('conversation_created', result.conversation, { source: 'restock_create' }, message ?? undefined)
    const serverNow = new Date()
    return { created: result.created, conversation: this.buildConversationSummary(result.conversation, undefined, serverNow), message, serverNow }
  }

  private async cancelActiveRestock(manager: EntityManager, conversation: ClientFeedbackConversation) {
    const restock = conversation.restock
    if (!restock) return
    const status = effectiveRestockStatus(restock, new Date())
    if (status === 'requested' || status === 'accepted') {
      restock.status = 'cancelled'
      restock.handledAt = new Date()
      await manager.getRepository(ClientRestockRequest).save(restock)
    }
  }

  async updateRestockRequest(id: string, input: { status: 'accepted' | 'restocked'; publicNote?: string }, actor: AuthUserContext, requestMeta?: RequestMeta) {
    if (!['accepted', 'restocked'].includes(input.status)) throw new BizError('补货处理状态无效', 400)
    const publicNote = input.publicNote?.trim() || ''
    if (publicNote.length > CLIENT_FEEDBACK_MESSAGE_MAX_LENGTH - 100) throw new BizError('公开说明过长', 400)
    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const conversation = await this.requireConversationById(id, manager)
      this.ensureConversationOwnedByActor(conversation, actor)
      const restock = conversation.restock
      if (!restock) throw new BizError('该会话不是补货需求', 400)
      if (conversation.status === 'closed') throw new BizError('补货会话已关闭，不能继续处理', 409)
      const statusBefore = effectiveRestockStatus(restock, new Date())
      if (statusBefore === 'expired' || statusBefore === 'cancelled' || statusBefore === 'restocked') throw new BizError('补货需求已过期或已结束，不能继续处理', 409)
      if (statusBefore === input.status) return { conversation, message: null as ClientFeedbackMessage | null, changed: false }
      if (input.status === 'restocked' && statusBefore !== 'accepted') throw new BizError('请先受理补货需求，再标记已补货', 409)
      // 在所有锁与归属检查完成后再次用服务端时间判定，不能让等待锁的旧请求越过截止时间。
      if (effectiveRestockStatus(restock, new Date()) === 'expired') throw new BizError('补货需求已过期，不能继续处理', 409)
      restock.status = input.status
      restock.handledAt = new Date()
      await manager.getRepository(ClientRestockRequest).save(restock)
      const nextStatus = input.status === 'restocked' ? 'resolved' : 'processing'
      const content = `${input.status === 'restocked' ? '客服已标记补货完成，请返回商城查看库存并按现有流程下单。' : '客服已受理补货需求。'}${publicNote ? `\n公开说明：${publicNote}` : ''}`
      const message = await this.createMessage(manager, conversation, { senderType: 'system', senderUserId: null, senderName: '系统', conversationStatus: nextStatus }, content, 'system')
      await auditService.record({ actionType: 'customer_service.restock_status', actionLabel: '处理补货需求', targetType: 'feedback_conversation', targetId: conversation.id,
        targetCode: conversation.conversationNo, actor, requestMeta, detail: { statusBefore, statusAfter: input.status, publicNoteLength: publicNote.length },
      }, manager)
      return { conversation, message, changed: true }
    })
    const message = result.message ? this.buildMessageView(result.message, { scope: 'service', userId: actor.userId }) : null
    if (result.changed) this.publishConversationEvent('conversation_status_changed', result.conversation, { restockStatus: input.status }, message ?? undefined)
    const serverNow = new Date()
    return { changed: result.changed, conversation: this.buildConversationSummary(result.conversation, actor.userId, serverNow), message, serverNow }
  }

  async createConversation(input: CreateClientFeedbackConversationInput, clientAuth: ClientAuthContext, requestMeta?: RequestMeta) {
    if (input.issueType === 'restock') throw new BizError('请从商城商品补货入口提交补货需求', 400)
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
    const attachmentIds = this.normalizeAttachmentIds(input.attachmentIds)
    let result:
      | {
          conversation: ClientFeedbackConversation
          message: ClientFeedbackMessage
        }
      | undefined
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        result = await runInTransaction(async (manager) => {
          const activeClient = await lockActiveClientAccountForBusiness(manager, clientAuth.userId)
          const clientSnapshot = this.buildClientUserSnapshot(activeClient)
          const attachments = await this.resolveOwnedAttachmentReferencesInTransaction(attachmentIds, clientAuth, manager)
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
            attachmentIds,
            clientAuth,
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

          await notificationService.emitEvent({
            eventType: 'customer_service_client_message_created',
            sourceType: 'client_feedback_conversation',
            sourceId: conversation.id,
            payload: {
              conversationNo: conversation.conversationNo,
              sourceUserId: clientAuth.userId,
              sourceUserDisplayName: clientSnapshot.clientUsername || clientSnapshot.clientAccount,
              summary: content.slice(0, 100),
            },
            requestMeta,
          }, manager)

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
    return {
      conversation: this.buildConversationSummary(result.conversation),
      message: messageView,
    }
  }

  async listMyConversations(clientAuth: ClientAuthContext, query: ClientFeedbackListQuery) {
    const qb = this.conversationRepo
      .createQueryBuilder('conversation')
      .leftJoinAndSelect('conversation.restock', 'restock')
      .where('conversation.clientUserId = :clientUserId', { clientUserId: clientAuth.userId })

    if (query.status) {
      qb.andWhere('conversation.status = :status', { status: query.status })
    }
    if (query.keyword?.trim()) {
      qb.andWhere(
        `
          (
            conversation.subject LIKE :keyword ESCAPE '!'
            OR conversation.category LIKE :keyword ESCAPE '!'
            OR conversation.conversationNo LIKE :keyword ESCAPE '!'
            OR conversation.lastMessagePreview LIKE :keyword ESCAPE '!'
          )
        `,
        { keyword: buildSqlLikeContains(query.keyword.trim()) },
      )
    }

    const [list, total] = await qb
      .orderBy('conversation.lastMessageAt', 'DESC')
      .addOrderBy('conversation.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount()

    const serverNow = new Date()
    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      serverNow,
      list: list.map((item) => this.buildConversationSummary(item, undefined, serverNow)),
    }
  }

  async getMyConversationDetail(clientAuth: ClientAuthContext, id: string): Promise<ClientFeedbackConversationDetail> {
    let conversation = await this.requireOwnedConversation(id, clientAuth)
    const loadVisibleMessages = async (lastVisibleId?: string) => (await this.loadConversationMessages(AppDataSource.manager, conversation.id, lastVisibleId))
      .filter((message) => !message.internalOnly)
    let messages = await loadVisibleMessages()
    const lastVisibleId = messages.at(-1)?.id
    const visibleUnread = this.countVisibleUnreadMessages(messages, 'client')
    if (lastVisibleId && visibleUnread > 0 && !databaseMaintenanceModeService.isReadOnly()) {
      const result = await runInTransaction(async (manager) => {
        await lockActiveClientAccountForBusiness(manager, clientAuth.userId)
        const locked = await this.requireOwnedConversation(id, clientAuth, manager)
        const readChanged = !databaseMaintenanceModeService.isReadOnly()
          && await this.markConversationRead(manager, locked, 'client', lastVisibleId)
        return { conversation: locked, readChanged }
      })
      conversation = result.conversation
      if (result.readChanged) {
        this.publishConversationEvent('conversation_read_by_client', conversation, { readBy: 'client' })
      }
      // 在事务外回读已读时间，同时保持首次可见消息的上界。
      messages = await loadVisibleMessages(lastVisibleId)
    } else if (!databaseMaintenanceModeService.isReadOnly()) {
      conversation.unreadForClientCount = visibleUnread
    }

    return {
      conversation: this.buildConversationSummary(conversation),
      messages: messages.map((message) => this.buildMessageView(message, { scope: 'client', userId: clientAuth.userId })),
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
    const attachmentIds = this.normalizeAttachmentIds(input.attachmentIds)

    const result = await runInTransaction(async (manager) => {
      const activeClient = await lockActiveClientAccountForBusiness(manager, clientAuth.userId)
      const clientSnapshot = this.buildClientUserSnapshot(activeClient)
      const attachments = await this.resolveOwnedAttachmentReferencesInTransaction(attachmentIds, clientAuth, manager)
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
        attachmentIds,
        clientAuth,
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
      await notificationService.emitEvent({
        eventType: 'customer_service_client_message_created',
        sourceType: 'client_feedback_conversation',
        sourceId: conversation.id,
        payload: {
          conversationNo: conversation.conversationNo,
          sourceUserId: clientAuth.userId,
          sourceUserDisplayName: clientSnapshot.clientUsername || clientSnapshot.clientAccount,
          summary: content.slice(0, 100),
        },
        requestMeta,
      }, manager)
      return { conversation, message }
    })

    const messageView = this.buildMessageView(result.message, { scope: 'client', userId: clientAuth.userId })
    this.publishConversationEvent('message_created', result.conversation, { senderType: 'client' }, messageView)
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

    const result = await runInTransaction(async (manager) => {
      await lockActiveClientAccountForBusiness(manager, clientAuth.userId)
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

      if (conversation.restock && effectiveRestockStatus(conversation.restock, new Date()) !== 'restocked') {
        throw new BizError('补货需求尚未标记已补货，暂不能确认完成', 409)
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

    const result = await runInTransaction(async (manager) => {
      await lockActiveClientAccountForBusiness(manager, clientAuth.userId)
      const conversation = await this.requireOwnedConversation(id, clientAuth, manager)
      if (conversation.status === 'closed') {
        return {
          conversation,
          systemMessage: null as ClientFeedbackMessage | null,
          changed: false,
        }
      }

      const statusBefore = conversation.status
      await this.cancelActiveRestock(manager, conversation)
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

    const result = await runInTransaction(async (manager) => {
      await lockActiveClientAccountForBusiness(manager, clientAuth.userId)
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
      .leftJoinAndSelect('conversation.restock', 'restock')
    const serverNow = new Date()
    if (query.issueType) qb.andWhere('conversation.issueType = :issueType', { issueType: query.issueType })
    if (query.productId) qb.andWhere('restock.productId = :productId', { productId: query.productId })
    if (query.restockStatus) {
      qb.andWhere(`(${effectiveRestockStatusSql('restock')}) = :restockStatus`, { restockStatus: query.restockStatus, restockNow: serverNow })
    }
    if (query.startDate || query.endDate) {
      const range = resolveDashboardFilter({ startDate: query.startDate, endDate: query.endDate })
      qb.andWhere('COALESCE(restock.createdAt, conversation.createdAt) >= :restockStart AND COALESCE(restock.createdAt, conversation.createdAt) < :restockEnd', { restockStart: range.startAt, restockEnd: range.endExclusive })
    }

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
            conversation.subject LIKE :keyword ESCAPE '!'
            OR conversation.category LIKE :keyword ESCAPE '!'
            OR conversation.conversationNo LIKE :keyword ESCAPE '!'
            OR conversation.clientUsername LIKE :keyword ESCAPE '!'
            OR conversation.clientAccount LIKE :keyword ESCAPE '!'
            OR conversation.staffNoSnapshot LIKE :keyword ESCAPE '!'
            OR conversation.departmentNameSnapshot LIKE :keyword ESCAPE '!'
            OR conversation.lastMessagePreview LIKE :keyword ESCAPE '!'
          )
        `,
        { keyword: buildSqlLikeContains(query.keyword.trim()) },
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
      serverNow,
      list: list.map((item) => this.buildConversationSummary(item, actor.userId, serverNow)),
    }
  }

  async getServiceConversationDetail(id: string, actor: AuthUserContext): Promise<ClientFeedbackConversationDetail> {
    let conversation = await this.requireConversationById(id)
    let messages = await this.loadConversationMessages(AppDataSource.manager, conversation.id)
    const lastVisibleId = messages.at(-1)?.id
    const visibleUnread = this.countVisibleUnreadMessages(messages, 'service')
    if (lastVisibleId && visibleUnread > 0 && !databaseMaintenanceModeService.isReadOnly()) {
      const result = await runInTransaction(async (manager) => {
        const account = await lockActiveSysAccountForBusiness(manager, actor.userId)
        if (!resolveUserPermissions(account).includes('customer_service:view')) throw new BizError('当前账号无客服查看权限', 403)
        const locked = await this.requireConversationById(id, manager)
        const readChanged = !databaseMaintenanceModeService.isReadOnly()
          && await this.markConversationRead(manager, locked, 'service', lastVisibleId)
        return { conversation: locked, readChanged }
      })
      conversation = result.conversation
      if (result.readChanged) {
        this.publishConversationEvent('conversation_read_by_service', conversation, { readBy: 'service' })
      }
      messages = await this.loadConversationMessages(AppDataSource.manager, conversation.id, lastVisibleId)
    } else if (!databaseMaintenanceModeService.isReadOnly()) {
      conversation.unreadForServiceCount = visibleUnread
    }

    return {
      conversation: this.buildConversationSummary(conversation, actor.userId),
      messages: messages.map((message) => this.buildMessageView(message, { scope: 'service', userId: actor.userId })),
      internalRemark: this.buildInternalRemarkView(conversation),
    }
  }

  async appendServiceMessage(
    id: string,
    input: AppendCustomerServiceMessageInput,
    actor: AuthUserContext,
    requestMeta?: RequestMeta,
  ) {
    const content = this.normalizeMessageContent(input.content)
    const requestedAttachments = this.normalizeAttachments(input.attachments)

    const result = await runInTransaction(async (manager) => {
      const conversation = await this.requireEditableServiceConversation(id, actor, manager)
      const attachments = await this.resolveBoundAttachmentReferences(requestedAttachments, conversation, manager)

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

    const result = await runInTransaction(async (manager) => {
      await lockActiveSysAccountForBusiness(manager, actor.userId)
      const conversation = await this.requireConversationById(id, manager)
      this.ensureConversationOwnedByActor(conversation, actor)
      if (conversation.restock) {
        const effectiveStatus = effectiveRestockStatus(conversation.restock, new Date())
        if (input.status === 'resolved' && effectiveStatus !== 'restocked') throw new BizError('请通过补货处理入口标记已补货', 409)
        if (conversation.status === 'closed' && input.status !== 'closed') throw new BizError('补货会话关闭后不能重新打开，请保留历史需求', 409)
        if (input.status === 'closed') await this.cancelActiveRestock(manager, conversation)
      }
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
    if (!targetUserId) throw new BizError('负责人不能为空', 400)
    const result = await runInTransaction(async (manager) => {
      const lockedUsers = await lockActiveSysAccountsForBusiness(manager, [actor.userId, targetUserId])
      const conversation = await this.requireConversationById(id, manager)
      const targetUser = this.assertAssignableServiceUser(lockedUsers.get(targetUserId)!)
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
    const result = await runInTransaction(async (manager) => {
      const conversation = await this.requireEditableServiceConversation(id, actor, manager)
      const before = this.buildConversationFields(conversation)
      const subjectBefore = conversation.subject

      if (typeof input.issueType === 'string') {
        if ((conversation.issueType === 'restock' || input.issueType === 'restock') && input.issueType !== conversation.issueType) {
          throw new BizError('补货类型不能通过普通工单编辑进行转换', 409)
        }
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

    const result = await runInTransaction(async (manager) => {
      const conversation = await this.requireEditableServiceConversation(id, actor, manager)
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
      customerServiceRealtimeService.publishConversationEvent({
        ...this.buildRealtimePayload('conversation_internal_remark_updated', result.conversation),
        audience: 'service',
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
