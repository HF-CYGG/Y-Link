/**
 * 文件说明：订单业务号永久占用表，记录每个业务号的首次分配与最后一次获配事实。
 * 实现逻辑：业务号与“命名空间 + 数值流水”双重唯一，且不建立订单外键；首次持有人不可改，最后持有人仅能由管理员回收事务推进。
 * 维护重点：任何删除、作废或普通改单流程都不得删除占用记录；复用必须同时追加不可变事件并递增 reuseCount。
 */

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

const serialValueColumnOptions = entityColumnOptions.isSqlite
  ? ({ type: 'integer' as const })
  : ({ type: 'bigint' as const, unsigned: true })

@Index('uk_order_business_no_occupancy_business_no', ['businessNo'], { unique: true })
@Index('uk_order_business_no_occupancy_namespace_serial', ['namespace', 'serialValue'], { unique: true })
@Index('idx_order_business_no_occupancy_order_uuid', ['orderUuid'])
@Index('idx_order_business_no_occupancy_last_assigned_order_uuid', ['lastAssignedOrderUuid'])
@Entity({ name: 'order_business_no_occupancy' })
@Check('ck_order_business_no_occupancy_namespace', "`business_namespace` IN ('hyyzjd', 'hyyz')")
export class OrderBusinessNoOccupancy {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'business_namespace', type: 'varchar', length: 16, comment: '业务号命名空间：hyyzjd/hyyz' })
  namespace!: string

  @Column({ name: 'serial_value', ...serialValueColumnOptions, comment: '命名空间内数值流水' })
  serialValue!: string | number

  @Column({ name: 'business_no', type: 'varchar', length: 32, comment: '永久占用的订单业务号' })
  businessNo!: string

  @Column({ name: 'order_uuid', ...entityColumnOptions.uuid, length: 36, comment: '首次获得该号码的订单 UUID 快照' })
  orderUuid!: string

  @Column({ name: 'assigned_reason', type: 'varchar', length: 128, comment: '分配来源' })
  assignedReason!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @Column({ name: 'last_assigned_order_uuid', ...entityColumnOptions.uuid, length: 36, comment: '最后一次获配该号码的订单 UUID 快照' })
  lastAssignedOrderUuid!: string

  @Column({ name: 'last_assigned_at', ...entityColumnOptions.timestamp, comment: '最后一次分配时间' })
  lastAssignedAt!: Date

  @Column({ name: 'reuse_count', type: 'integer', default: 0, comment: '管理员回收复用次数' })
  reuseCount!: number
}
