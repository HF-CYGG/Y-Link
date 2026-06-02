/**
 * 文件说明：客户端反馈消息实体，记录反馈会话中的逐条留言、客服回复、附件和双侧已读时间。
 * 实现逻辑：每条消息归属一条反馈会话，并用发送方类型、消息正文和已读时间支撑客服中心的消息流展示与未读统计。
 * 维护重点：若扩展附件类型、消息撤回或编辑能力，需要同步核对消息类型枚举、审计策略和前端渲染结构。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

const feedbackMessageContentColumnType = entityColumnOptions.isSqlite ? 'text' : 'longtext'
const feedbackJsonArrayDefaultColumnOptions = entityColumnOptions.isSqlite ? { default: '[]' } : {}

/**
 * 消息发送方类型：
 * - client：客户端用户发送；
 * - service：客服中心账号发送；
 * - system：系统自动消息，如状态变更通知。
 */
export const CLIENT_FEEDBACK_SENDER_TYPES = ['client', 'service', 'system'] as const
export type ClientFeedbackSenderType = (typeof CLIENT_FEEDBACK_SENDER_TYPES)[number]

/**
 * 消息类型：
 * - text：客户端与客服的普通可见消息；
 * - system：系统自动消息，如状态变更通知；
 * - internal_note：仅客服可见的内部备注，不回流到客户端会话。
 */
export const CLIENT_FEEDBACK_MESSAGE_TYPES = ['text', 'system', 'internal_note'] as const
export type ClientFeedbackMessageType = (typeof CLIENT_FEEDBACK_MESSAGE_TYPES)[number]

/**
 * 附件字段先沉淀为 JSON 文本，统一兼容 SQLite / MySQL，
 * 方便后续前端逐步接入上传、截图与文件类型校验。
 */
export interface ClientFeedbackMessageAttachment {
  name: string
  url: string
  mimeType?: string | null
  size?: number | null
}

@Entity({ name: 'client_feedback_message' })
export class ClientFeedbackMessage {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_client_feedback_message_conversation_id')
  @Column({ name: 'conversation_id', ...entityColumnOptions.foreignId, comment: '所属反馈会话 ID' })
  conversationId!: string

  @Index('idx_client_feedback_message_sender_type')
  @Column({ name: 'sender_type', type: 'varchar', length: 16, default: 'client', comment: '消息发送方类型' })
  senderType!: ClientFeedbackSenderType

  @Column({ name: 'sender_user_id', ...entityColumnOptions.foreignId, nullable: true, comment: '发送方用户 ID' })
  senderUserId!: string | null

  @Column({ name: 'sender_name', type: 'varchar', length: 128, nullable: true, comment: '发送方名称快照' })
  senderName!: string | null

  @Column({ name: 'message_type', type: 'varchar', length: 16, default: 'text', comment: '消息类型' })
  messageType!: ClientFeedbackMessageType

  @Column({ name: 'internal_only', type: 'boolean', default: false, comment: '是否仅客服内部可见' })
  internalOnly!: boolean

  @Column({ name: 'content', type: feedbackMessageContentColumnType, comment: '消息正文' })
  content!: string

  @Column({
    name: 'attachment_json',
    type: feedbackMessageContentColumnType,
    ...feedbackJsonArrayDefaultColumnOptions,
    comment: '消息附件 JSON 文本',
  })
  attachmentJson!: string

  @Column({ name: 'client_read_at', ...entityColumnOptions.timestamp, nullable: true, comment: '客户端已读时间' })
  clientReadAt!: Date | null

  @Column({ name: 'service_read_at', ...entityColumnOptions.timestamp, nullable: true, comment: '客服中心已读时间' })
  serviceReadAt!: Date | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date
}
