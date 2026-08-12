import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

export const NOTIFICATION_DISPATCH_CHANNELS = ['email', 'feishu'] as const
export type NotificationDispatchChannel = (typeof NOTIFICATION_DISPATCH_CHANNELS)[number]

export const NOTIFICATION_DISPATCH_STATUSES = ['pending', 'processing', 'sent', 'failed'] as const
export type NotificationDispatchStatus = (typeof NOTIFICATION_DISPATCH_STATUSES)[number]

@Entity({ name: 'notification_dispatch' })
@Index('uk_notification_dispatch_event_channel_target', ['eventId', 'channel', 'dedupeKey'], { unique: true })
export class NotificationDispatch {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_notification_dispatch_event_id')
  @Column({ name: 'event_id', ...entityColumnOptions.foreignId, comment: '关联通知事件 ID' })
  eventId!: string

  @Index('idx_notification_dispatch_channel')
  @Column({ name: 'channel', type: 'varchar', length: 32, comment: '外发渠道' })
  channel!: NotificationDispatchChannel

  @Column({ name: 'target', type: 'varchar', length: 500, comment: '外发目标(邮箱/Webhook)' })
  target!: string

  @Column({ name: 'dedupe_key', type: 'varchar', length: 64, nullable: true, comment: '外发目标去重摘要' })
  dedupeKey!: string | null

  @Column({ name: 'status', type: 'varchar', length: 32, default: 'pending', comment: '投递状态' })
  status!: NotificationDispatchStatus

  @Column({ name: 'attempt_count', type: 'int', default: 0, comment: '已完成失败次数' })
  attemptCount!: number

  @Column({ name: 'error_message', type: 'varchar', length: 500, nullable: true, comment: '失败原因' })
  errorMessage!: string | null

  @Column({ name: 'response_code', type: 'int', nullable: true, comment: '响应状态码' })
  responseCode!: number | null

  @Column({ name: 'sent_at', ...entityColumnOptions.timestamp, nullable: true, comment: '发送时间' })
  sentAt!: Date | null

  @Column({ name: 'last_attempt_at', ...entityColumnOptions.timestamp, nullable: true, comment: '最近尝试时间' })
  lastAttemptAt!: Date | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
