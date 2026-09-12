/**
 * 文件说明：订单业务号永久占用表，记录每个业务号的首次分配事实。
 * 实现逻辑：业务号与“命名空间 + 数值流水”双重唯一，且不建立订单外键，保证订单永久删除后占用仍保留。
 * 维护重点：任何删除、作废或改单流程都不得删除占用记录，也不得把旧号重新分配给原订单或其他订单。
 */

import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

const serialValueColumnOptions = entityColumnOptions.isSqlite
  ? ({ type: 'integer' as const })
  : ({ type: 'bigint' as const, unsigned: true })

@Index('uk_order_business_no_occupancy_business_no', ['businessNo'], { unique: true })
@Index('uk_order_business_no_occupancy_namespace_serial', ['namespace', 'serialValue'], { unique: true })
@Index('idx_order_business_no_occupancy_order_uuid', ['orderUuid'])
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
}
