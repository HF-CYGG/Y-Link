/**
 * 文件说明：盘点单主表实体，记录盘点范围、盲盘开关与“盘点中 → 待确认 → 已完成 / 已取消”状态流转。
 * 实现逻辑：建单时按范围生成明细；确认完成时对差异行调用共享记账函数生成盘盈、盘亏或报损流水。
 * 维护重点：盲盘模式下账面数只允许有审核权限的人读取，接口层负责裁剪，不能只靠前端隐藏。
 */

import { Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryGeneratedColumn, type Relation, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'
import { InvStocktakeItem } from './inv-stocktake-item.entity.js'

@Entity({ name: 'inv_stocktake' })
@Index('idx_inv_stocktake_status_created', ['status', 'createdAt', 'id'])
export class InvStocktake {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_inv_stocktake_no', { unique: true })
  @Column({ name: 'stocktake_no', type: 'varchar', length: 32, comment: '盘点单号' })
  stocktakeNo!: string

  @Column({ name: 'scope_type', type: 'varchar', length: 16, comment: '盘点范围类型' })
  scopeType!: string

  @Column({ name: 'scope_json', type: 'text', comment: '盘点范围参数 JSON' })
  scopeJson!: string

  @Column({ name: 'scope_label', type: 'varchar', length: 255, nullable: true, comment: '盘点范围展示文本' })
  scopeLabel!: string | null

  @Column({ name: 'blind_mode', ...entityColumnOptions.booleanFlag, comment: '是否盲盘' })
  blindMode!: boolean

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'counting', comment: '盘点状态' })
  status!: string

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '备注' })
  remark!: string | null

  @Column({ name: 'created_by_id', type: 'varchar', length: 64, nullable: true, comment: '创建人ID' })
  createdById!: string | null

  @Column({ name: 'created_by_name', type: 'varchar', length: 128, nullable: true, comment: '创建人' })
  createdByName!: string | null

  @Column({ name: 'submitted_at', ...entityColumnOptions.timestamp, nullable: true, comment: '提交确认时间' })
  submittedAt!: Date | null

  @Column({ name: 'completed_at', ...entityColumnOptions.timestamp, nullable: true, comment: '完成时间' })
  completedAt!: Date | null

  @Column({ name: 'completed_by_name', type: 'varchar', length: 128, nullable: true, comment: '确认人' })
  completedByName!: string | null

  @Column({ name: 'cancelled_at', ...entityColumnOptions.timestamp, nullable: true, comment: '取消时间' })
  cancelledAt!: Date | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  @OneToMany(() => InvStocktakeItem, (item) => item.stocktake)
  items?: Relation<InvStocktakeItem[]>
}
