import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'notification_inbox' })
export class NotificationInbox {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_notification_inbox_event_id')
  @Column({ name: 'event_id', ...entityColumnOptions.foreignId, comment: '关联通知事件 ID' })
  eventId!: string

  @Index('idx_notification_inbox_user_id')
  @Column({ name: 'user_id', ...entityColumnOptions.foreignId, comment: '接收账号 ID' })
  userId!: string

  @Column({ name: 'event_type', type: 'varchar', length: 64, comment: '事件类型' })
  eventType!: string

  @Column({ name: 'title', type: 'varchar', length: 200, comment: '通知标题' })
  title!: string

  @Column({ name: 'content', type: 'text', comment: '通知正文' })
  content!: string

  @Column({ name: 'payload_json', type: 'text', comment: '通知数据快照(JSON)' })
  payloadJson!: string

  @Column({ name: 'is_read', ...entityColumnOptions.booleanFlag, comment: '是否已读' })
  isRead!: number

  @Column({ name: 'read_at', ...entityColumnOptions.timestamp, nullable: true, comment: '已读时间' })
  readAt!: Date | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
