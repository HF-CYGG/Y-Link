/**
 * 模块说明：backend/src/entities/client-feedback-conversation.entity.ts
 * 文件职责：定义客户端反馈会话主表，承载反馈单基础信息、客服处理状态、未读计数与最近消息摘要。
 * 实现逻辑：
 * - 一条会话代表客户端与客服中心的一条反馈工单；
 * - 会话表只保留列表页与摘要页需要的聚合字段，具体消息明细下沉到消息表；
 * - 通过未读计数、最近消息时间和指派快照，降低客服列表查询时的二次聚合成本。
 * 维护说明：
 * - 若后续引入转派、标签或 SLA，请优先扩展本表聚合字段，再评估是否拆分附表；
 * - 涉及状态枚举变更时，需同步服务层校验、路由入参与前端状态映射。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

/**
 * 反馈会话状态：
 * - open：客户端新建或最新一条消息来自客户端，等待客服处理；
 * - processing：客服已接入处理中；
 * - resolved：客服已给出处理结论，等待客户端确认或补充；
 * - closed：会话已结束，客户端需新建会话再继续反馈。
 */
export const CLIENT_FEEDBACK_CONVERSATION_STATUSES = ['open', 'processing', 'resolved', 'closed'] as const
export type ClientFeedbackConversationStatus = (typeof CLIENT_FEEDBACK_CONVERSATION_STATUSES)[number]

/**
 * 优先级采用四档，便于客服工作台按问题影响范围做更细的处理排序。
 */
export const CLIENT_FEEDBACK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type ClientFeedbackPriority = (typeof CLIENT_FEEDBACK_PRIORITIES)[number]

/**
 * Issue 类型：
 * - suggestion：普通建议、咨询或体验反馈；
 * - bug：具备复现特征、需要结构化排查的专业问题。
 */
export const CLIENT_FEEDBACK_ISSUE_TYPES = ['suggestion', 'bug'] as const
export type ClientFeedbackIssueType = (typeof CLIENT_FEEDBACK_ISSUE_TYPES)[number]

/**
 * Issue 标签统一收敛为 JSON 数组，便于后续扩展颜色、来源或系统推荐标记。
 */
export interface ClientFeedbackConversationIssueTag {
  label: string
}

/**
 * 客户端满意度评价档位：
 * - satisfied：处理结果符合预期，整体体验较好；
 * - neutral：问题有推进，但体验或效率一般；
 * - unsatisfied：问题未达到预期，仍需要后续关注。
 */
export const CLIENT_FEEDBACK_SATISFACTION_LEVELS = ['satisfied', 'neutral', 'unsatisfied'] as const
export type ClientFeedbackSatisfactionLevel = (typeof CLIENT_FEEDBACK_SATISFACTION_LEVELS)[number]

/**
 * 最近消息发送方快照：
 * - client：最新消息来自客户端；
 * - service：最新消息来自客服/管理端；
 * - system：系统自动写入的状态消息。
 */
export const CLIENT_FEEDBACK_LAST_SENDER_TYPES = ['client', 'service', 'system'] as const
export type ClientFeedbackLastSenderType = (typeof CLIENT_FEEDBACK_LAST_SENDER_TYPES)[number]

@Entity({ name: 'client_feedback_conversation' })
export class ClientFeedbackConversation {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_client_feedback_conversation_no', { unique: true })
  @Column({ name: 'conversation_no', type: 'varchar', length: 48, comment: '反馈会话编号' })
  conversationNo!: string

  @Index('idx_client_feedback_client_user_id')
  @Column({ name: 'client_user_id', ...entityColumnOptions.foreignId, comment: '客户端用户 ID' })
  clientUserId!: string

  @Column({ name: 'client_username', type: 'varchar', length: 128, comment: '客户端用户名快照' })
  clientUsername!: string

  @Column({ name: 'client_account', type: 'varchar', length: 128, comment: '客户端账号快照' })
  clientAccount!: string

  @Column({ name: 'department_name_snapshot', type: 'varchar', length: 128, default: '', comment: '客户端部门快照' })
  departmentNameSnapshot!: string

  @Index('idx_client_feedback_category')
  @Column({ name: 'category', type: 'varchar', length: 32, default: 'general', comment: '反馈分类' })
  category!: string

  @Index('idx_client_feedback_issue_type')
  @Column({ name: 'issue_type', type: 'varchar', length: 16, default: 'suggestion', comment: 'Issue 类型' })
  issueType!: ClientFeedbackIssueType

  @Column({ name: 'source_code', type: 'varchar', length: 32, default: 'client_portal', comment: '反馈来源编码' })
  sourceCode!: string

  @Column({ name: 'source_label', type: 'varchar', length: 64, default: '在线反馈入口', comment: '反馈来源名称' })
  sourceLabel!: string

  @Column({ name: 'subject', type: 'varchar', length: 128, comment: '反馈主题' })
  subject!: string

  @Index('idx_client_feedback_status')
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'open', comment: '反馈会话状态' })
  status!: ClientFeedbackConversationStatus

  @Index('idx_client_feedback_priority')
  @Column({ name: 'priority', type: 'varchar', length: 16, default: 'normal', comment: '反馈优先级' })
  priority!: ClientFeedbackPriority

  @Index('idx_client_feedback_order_ref')
  @Column({ name: 'order_ref', type: 'varchar', length: 64, nullable: true, comment: '关联订单号或提货码' })
  orderRef!: string | null

  @Column({ name: 'expected_result', type: 'text', nullable: true, comment: '期望结果' })
  expectedResult!: string | null

  @Column({ name: 'actual_result', type: 'text', nullable: true, comment: '实际结果' })
  actualResult!: string | null

  @Column({ name: 'reproduction_steps', type: 'text', nullable: true, comment: '复现步骤' })
  reproductionSteps!: string | null

  @Column({ name: 'contact_preference', type: 'varchar', length: 64, nullable: true, comment: '联系偏好' })
  contactPreference!: string | null

  @Column({ name: 'tag_json', type: 'text', default: '[]', comment: '标签 JSON 文本' })
  tagJson!: string

  @Column({ name: 'internal_remark', type: 'text', nullable: true, comment: '仅客服可见的内部备注' })
  internalRemark!: string | null

  @Column({ name: 'internal_remark_updated_at', ...entityColumnOptions.timestamp, nullable: true, comment: '内部备注更新时间' })
  internalRemarkUpdatedAt!: Date | null

  @Column({ name: 'internal_remark_by_user_id', ...entityColumnOptions.foreignId, nullable: true, comment: '内部备注更新人 ID' })
  internalRemarkByUserId!: string | null

  @Column({ name: 'internal_remark_by_username', type: 'varchar', length: 64, nullable: true, comment: '内部备注更新人账号' })
  internalRemarkByUsername!: string | null

  @Column({ name: 'internal_remark_by_display_name', type: 'varchar', length: 64, nullable: true, comment: '内部备注更新人名称' })
  internalRemarkByDisplayName!: string | null

  @Column({ name: 'client_satisfaction_level', type: 'varchar', length: 16, nullable: true, comment: '客户端满意度评价档位' })
  clientSatisfactionLevel!: ClientFeedbackSatisfactionLevel | null

  @Column({ name: 'client_satisfaction_comment', type: 'text', nullable: true, comment: '客户端满意度补充说明' })
  clientSatisfactionComment!: string | null

  @Column({ name: 'client_satisfaction_rated_at', ...entityColumnOptions.timestamp, nullable: true, comment: '客户端满意度评价时间' })
  clientSatisfactionRatedAt!: Date | null

  @Column({ name: 'assigned_user_id', ...entityColumnOptions.foreignId, nullable: true, comment: '当前处理客服 ID' })
  assignedUserId!: string | null

  @Column({ name: 'assigned_username', type: 'varchar', length: 64, nullable: true, comment: '当前处理客服账号快照' })
  assignedUsername!: string | null

  @Column({ name: 'assigned_display_name', type: 'varchar', length: 64, nullable: true, comment: '当前处理客服姓名快照' })
  assignedDisplayName!: string | null

  @Column({ name: 'last_message_preview', type: 'varchar', length: 255, nullable: true, comment: '最近一条消息摘要' })
  lastMessagePreview!: string | null

  @Index('idx_client_feedback_last_sender_type')
  @Column({ name: 'last_message_sender_type', type: 'varchar', length: 16, default: 'client', comment: '最近消息发送方类型' })
  lastMessageSenderType!: ClientFeedbackLastSenderType

  @Index('idx_client_feedback_last_message_at')
  @Column({ name: 'last_message_at', ...entityColumnOptions.timestamp, comment: '最近消息时间' })
  lastMessageAt!: Date

  @Column({ name: 'unread_for_client_count', type: 'int', default: 0, comment: '客户端未读消息数' })
  unreadForClientCount!: number

  @Column({ name: 'unread_for_service_count', type: 'int', default: 0, comment: '客服中心未读消息数' })
  unreadForServiceCount!: number

  @Column({ name: 'closed_at', ...entityColumnOptions.timestamp, nullable: true, comment: '关闭时间' })
  closedAt!: Date | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
