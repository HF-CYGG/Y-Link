/**
 * 账号生命周期事件实体：独立保留两类账号的注销、恢复与永久删除证据。
 * 事件不关联用户外键，保证账号物理删除后仍可按脱敏账号快照追溯。
 */
import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

export const ACCOUNT_LIFECYCLE_EVENT_TYPES = ['deactivated', 'restored', 'permanently_deleted'] as const
export type AccountLifecycleEventType = (typeof ACCOUNT_LIFECYCLE_EVENT_TYPES)[number]

const jsonTextColumnType = entityColumnOptions.isSqlite ? 'text' : 'longtext'

@Entity({ name: 'account_lifecycle_event' })
@Check('ck_account_lifecycle_event_domain', `account_domain IN ('sys_user', 'client_user')`)
@Check('ck_account_lifecycle_event_type', `event_type IN ('deactivated', 'restored', 'permanently_deleted')`)
@Index('idx_account_lifecycle_event_account', ['accountDomain', 'accountIdSnapshot', 'id'])
@Index('idx_account_lifecycle_event_created_at', ['createdAt', 'id'])
export class AccountLifecycleEvent {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'account_domain', type: 'varchar', length: 16 })
  accountDomain!: 'sys_user' | 'client_user'

  @Column({ name: 'account_id_snapshot', type: 'varchar', length: 64 })
  accountIdSnapshot!: string

  @Column({ name: 'account_masked_snapshot', type: 'varchar', length: 160 })
  accountMaskedSnapshot!: string

  @Column({ name: 'event_type', type: 'varchar', length: 32 })
  eventType!: AccountLifecycleEventType

  @Column({ name: 'reason', type: 'varchar', length: 500 })
  reason!: string

  @Column({ name: 'actor_user_id_snapshot', type: 'varchar', length: 64, nullable: true })
  actorUserIdSnapshot!: string | null

  @Column({ name: 'actor_username_snapshot', type: 'varchar', length: 64 })
  actorUsernameSnapshot!: string

  @Column({ name: 'actor_display_name_snapshot', type: 'varchar', length: 64 })
  actorDisplayNameSnapshot!: string

  @Column({ name: 'reference_summary_json', type: jsonTextColumnType })
  referenceSummaryJson!: string

  @Column({ name: 'event_summary_json', type: jsonTextColumnType })
  eventSummaryJson!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date
}
