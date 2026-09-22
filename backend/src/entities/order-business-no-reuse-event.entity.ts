/**
 * 文件说明：订单业务号回收复用事件表，永久保存每次最后持有人转移链路。
 * 实现逻辑：不建立订单外键，避免任一订单永久删除后破坏事件；操作者、目标订单、请求来源均保存操作时快照。
 * 维护重点：事件只能追加，不得保存永久删除密码、Cookie、Token 或其他认证凭据。
 */

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

const serialValueColumnOptions = entityColumnOptions.isSqlite
  ? ({ type: 'integer' as const })
  : ({ type: 'bigint' as const, unsigned: true })

@Index('idx_order_business_no_reuse_event_business_no', ['businessNo'])
@Index('idx_order_business_no_reuse_event_to_order_uuid', ['toOrderUuid'])
@Entity({ name: 'order_business_no_reuse_event' })
@Check('ck_order_business_no_reuse_event_namespace', "`business_namespace` IN ('hyyzjd', 'hyyz')")
export class OrderBusinessNoReuseEvent {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'business_namespace', type: 'varchar', length: 16, comment: '业务号命名空间：hyyzjd/hyyz' })
  namespace!: string

  @Column({ name: 'serial_value', ...serialValueColumnOptions, comment: '命名空间内数值流水' })
  serialValue!: string | number

  @Column({ name: 'business_no', type: 'varchar', length: 32, comment: '被回收复用的业务号' })
  businessNo!: string

  @Column({ name: 'from_order_uuid', ...entityColumnOptions.uuid, length: 36, comment: '上一次获配订单 UUID 快照' })
  fromOrderUuid!: string

  @Column({ name: 'to_order_uuid', ...entityColumnOptions.uuid, length: 36, comment: '本次获配订单 UUID 快照' })
  toOrderUuid!: string

  @Column({ name: 'target_order_id_snapshot', type: 'varchar', length: 64, comment: '目标订单主键快照' })
  targetOrderIdSnapshot!: string

  @Column({ name: 'target_show_no_snapshot', type: 'varchar', length: 64, comment: '目标订单不可变 systemNo 快照' })
  targetSystemNoSnapshot!: string

  @Column({ name: 'reuse_count', type: 'integer', comment: '本次完成后的累计复用次数' })
  reuseCount!: number

  @Column({ name: 'reason', type: 'varchar', length: 500, comment: '本次回收原因' })
  reason!: string

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
