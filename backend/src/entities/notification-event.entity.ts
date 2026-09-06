import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

export const NOTIFICATION_EVENT_STATUSES = ['pending', 'processing', 'processed', 'failed'] as const
export type NotificationEventStatus = (typeof NOTIFICATION_EVENT_STATUSES)[number]

@Entity({ name: 'notification_event' })
@Index('idx_notification_event_pending_claim', ['status', 'nextAttemptAt', 'id'])
@Index('idx_notification_event_processing_recovery', ['status', 'processingStartedAt', 'id'])
export class NotificationEvent {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_notification_event_event_type')
  @Column({ name: 'event_type', type: 'varchar', length: 64, comment: '事件类型' })
  eventType!: string

  @Column({ name: 'source_type', type: 'varchar', length: 64, comment: '事件来源类型' })
  sourceType!: string

  @Column({ name: 'source_id', type: 'varchar', length: 128, comment: '事件来源业务 ID' })
  sourceId!: string

  @Column({ name: 'payload_json', type: 'text', comment: '事件载荷(JSON)' })
  payloadJson!: string

  @Column({ name: 'status', type: 'varchar', length: 32, default: 'pending', comment: '事件处理状态' })
  status!: NotificationEventStatus

  @Column({ name: 'attempt_count', type: 'int', default: 0, comment: '后台处理已完成失败次数' })
  attemptCount!: number

  @Column({ name: 'next_attempt_at', ...entityColumnOptions.timestamp, nullable: true, comment: '下次可重试时间' })
  nextAttemptAt!: Date | null

  @Column({ name: 'processing_started_at', ...entityColumnOptions.timestamp, nullable: true, comment: '当前领取开始时间' })
  processingStartedAt!: Date | null

  @Column({ name: 'processing_owner', type: 'varchar', length: 128, nullable: true, comment: '当前 Worker 实例标识' })
  processingOwner!: string | null

  @Column({ name: 'processed_at', ...entityColumnOptions.timestamp, nullable: true, comment: '处理完成时间' })
  processedAt!: Date | null

  @Column({ name: 'error_message', type: 'varchar', length: 500, nullable: true, comment: '处理失败原因' })
  errorMessage!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
