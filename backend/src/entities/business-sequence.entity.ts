/**
 * 文件说明：业务流水序列表实体，为出库单与 O2O 预订单提供常数时间的并发安全流水分配。
 * 实现逻辑：每种业务流水只维护一行 currentValue；MySQL 通过行锁、SQLite 通过单写事务完成递增。
 * 维护重点：该表是流水分配真源，system_configs 中的 current 仅保留为管理端兼容镜像。
 */

import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

const sequenceValueColumnOptions = entityColumnOptions.isSqlite
  ? ({ type: 'integer' as const })
  : ({ type: 'bigint' as const, unsigned: true })

@Entity({ name: 'business_sequence' })
export class BusinessSequence {
  @PrimaryColumn({ name: 'sequence_key', type: 'varchar', length: 64 })
  sequenceKey!: string

  @Column({ name: 'current_value', ...sequenceValueColumnOptions, default: 0, comment: '当前已分配流水值' })
  currentValue!: string | number

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
