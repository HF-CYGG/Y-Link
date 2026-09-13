/**
 * 文件说明：订单永久修订记录，保存每次业务号或分类等可审计字段的前后快照。
 * 实现逻辑：使用 orderUuid 与修订版本建立稳定索引，不建立订单外键，确保主单永久删除后修订历史仍可追溯。
 * 维护重点：快照只允许写入订单业务字段，不得写入密码、Token、Cookie 或敏感系统配置。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

const snapshotColumnType = entityColumnOptions.isSqlite ? 'text' : 'longtext'

@Index('uk_order_revision_uuid_version', ['orderUuid', 'revisionNo'], { unique: true })
@Index('idx_order_revision_order_id_snapshot', ['orderIdSnapshot'])
@Entity({ name: 'order_revision' })
export class OrderRevision {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'order_id_snapshot', type: 'varchar', length: 64, comment: '订单主键快照' })
  orderIdSnapshot!: string

  @Column({ name: 'order_uuid', ...entityColumnOptions.uuid, length: 36, comment: '订单稳定 UUID 快照' })
  orderUuid!: string

  @Column({ name: 'revision_no', type: 'integer', comment: '修订后的 editVersion' })
  revisionNo!: number

  @Column({ name: 'before_snapshot_json', type: snapshotColumnType, comment: '修订前业务字段 JSON' })
  beforeSnapshotJson!: string

  @Column({ name: 'after_snapshot_json', type: snapshotColumnType, comment: '修订后业务字段 JSON' })
  afterSnapshotJson!: string

  @Column({ name: 'reason', type: 'varchar', length: 500, nullable: true, comment: '修订原因' })
  reason!: string | null

  @Column({ name: 'actor_user_id', type: 'varchar', length: 64, nullable: true, comment: '操作人 ID 快照' })
  actorUserId!: string | null

  @Column({ name: 'actor_username', type: 'varchar', length: 64, comment: '操作人账号快照' })
  actorUsername!: string

  @Column({ name: 'actor_display_name', type: 'varchar', length: 64, comment: '操作人姓名快照' })
  actorDisplayName!: string

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true, comment: '来源 IP' })
  ipAddress!: string | null

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true, comment: '客户端 UA' })
  userAgent!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date
}
