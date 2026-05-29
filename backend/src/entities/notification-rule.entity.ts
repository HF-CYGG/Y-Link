import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

export const NOTIFICATION_EXTERNAL_TRIGGER_MODES = [
  'all_management_offline',
  'watched_accounts_offline',
] as const

export type NotificationExternalTriggerMode = (typeof NOTIFICATION_EXTERNAL_TRIGGER_MODES)[number]

@Entity({ name: 'notification_rule' })
export class NotificationRule {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_notification_rule_code', { unique: true })
  @Column({ name: 'rule_code', type: 'varchar', length: 64, comment: '规则唯一编码' })
  ruleCode!: string

  @Column({ name: 'rule_name', type: 'varchar', length: 128, comment: '规则名称' })
  ruleName!: string

  @Column({ name: 'event_type', type: 'varchar', length: 64, comment: '事件类型' })
  eventType!: string

  @Column({ name: 'enabled', ...entityColumnOptions.booleanFlag, comment: '是否启用规则' })
  enabled!: number

  @Column({ name: 'recipient_user_ids_json', type: 'text', comment: '站内通知接收账号 ID 列表(JSON)' })
  recipientUserIdsJson!: string

  @Column({ name: 'email_enabled', ...entityColumnOptions.booleanFlag, comment: '是否启用邮件提醒' })
  emailEnabled!: number

  @Column({ name: 'feishu_enabled', ...entityColumnOptions.booleanFlag, comment: '是否启用飞书提醒' })
  feishuEnabled!: number

  @Column({ name: 'external_trigger_mode', type: 'varchar', length: 64, comment: '外发触发模式' })
  externalTriggerMode!: NotificationExternalTriggerMode

  @Column({ name: 'watched_user_ids_json', type: 'text', comment: '离线监测账号 ID 列表(JSON)' })
  watchedUserIdsJson!: string

  @Column({ name: 'feishu_webhook_url', type: 'varchar', length: 500, nullable: true, comment: '飞书群机器人 Webhook 地址' })
  feishuWebhookUrl!: string | null

  @Column({ name: 'email_subject_prefix', type: 'varchar', length: 128, default: '', comment: '邮件主题前缀' })
  emailSubjectPrefix!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
