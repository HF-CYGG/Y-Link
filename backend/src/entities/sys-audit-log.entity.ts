import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'
import type { AuditResultStatus } from '../types/auth.js'

const jsonTextColumnType = entityColumnOptions.isSqlite ? 'text' : 'longtext'

@Entity({ name: 'sys_audit_log' })
export class SysAuditLog {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_sys_audit_log_action_type')
  @Column({ name: 'action_type', type: 'varchar', length: 64, comment: '动作类型，如 auth.login / order.create' })
  actionType!: string

  @Column({ name: 'action_label', type: 'varchar', length: 128, comment: '动作中文描述' })
  actionLabel!: string

  @Index('idx_sys_audit_log_actor_user_id')
  @Column({ name: 'actor_user_id', ...entityColumnOptions.foreignId, nullable: true, comment: '操作人ID' })
  actorUserId!: string | null

  @Column({ name: 'actor_username', type: 'varchar', length: 64, nullable: true, comment: '操作人账号快照' })
  actorUsername!: string | null

  @Column({ name: 'actor_display_name', type: 'varchar', length: 64, nullable: true, comment: '操作人姓名快照' })
  actorDisplayName!: string | null

  @Index('idx_sys_audit_log_target_type')
  @Column({ name: 'target_type', type: 'varchar', length: 64, comment: '目标类型，如 user / order / session' })
  targetType!: string

  @Index('idx_sys_audit_log_target_id')
  @Column({ name: 'target_id', type: 'varchar', length: 64, nullable: true, comment: '目标主键' })
  targetId!: string | null

  @Column({ name: 'target_code', type: 'varchar', length: 128, nullable: true, comment: '目标业务标识，如账号/单号' })
  targetCode!: string | null

  @Index('idx_sys_audit_log_result_status')
  @Column({ name: 'result_status', type: 'varchar', length: 32, default: 'success', comment: '执行结果：success/failed' })
  resultStatus!: AuditResultStatus

  @Column({ name: 'detail_json', type: jsonTextColumnType, nullable: true, comment: '关键上下文 JSON 文本' })
  detailJson!: string | null

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true, comment: '来源 IP' })
  ipAddress!: string | null

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true, comment: '客户端 UA' })
  userAgent!: string | null

  @Index('idx_sys_audit_log_created_at')
  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date
}
