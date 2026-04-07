import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm'
import { BizOutboundOrderItem } from './biz-outbound-order-item.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Index('uk_biz_outbound_show_no_is_deleted', ['showNo', 'isDeleted'], { unique: true })
@Index('idx_biz_outbound_order_type_created_at', ['orderType', 'createdAt'])
@Entity({ name: 'biz_outbound_order' })
export class BizOutboundOrder {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_biz_outbound_order_uuid', { unique: true })
  @Column({ name: 'order_uuid', ...entityColumnOptions.uuid, length: 36, comment: '系统唯一UUID' })
  orderUuid!: string

  @Column({ name: 'show_no', type: 'varchar', length: 32, comment: '业务展示单号' })
  showNo!: string

  @Index('idx_biz_outbound_order_type')
  @Column({ name: 'order_type', type: 'varchar', length: 32, default: 'walkin', comment: '订单类型' })
  orderType!: string

  @Column({ name: 'has_customer_order', ...entityColumnOptions.booleanFlag, default: 0, comment: '是否有客户订单' })
  hasCustomerOrder!: boolean

  @Column({ name: 'is_system_applied', ...entityColumnOptions.booleanFlag, default: 0, comment: '是否系统申请' })
  isSystemApplied!: boolean

  @Column({ name: 'issuer_name', type: 'varchar', length: 64, nullable: true, comment: '出单人' })
  issuerName!: string | null

  @Column({
    name: 'customer_department_name',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '客户部门名称',
  })
  customerDepartmentName!: string | null

  @Index('uk_biz_outbound_idempotency_key', { unique: true })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, comment: '幂等键' })
  idempotencyKey!: string

  @Column({ name: 'customer_name', type: 'varchar', length: 128, nullable: true, comment: '客户名称' })
  customerName!: string | null

  @Column({ name: 'remark', type: 'varchar', length: 500, nullable: true, comment: '备注' })
  remark!: string | null

  @Column({ name: 'total_qty', type: 'decimal', precision: 12, scale: 2, default: 0, comment: '总数量' })
  totalQty!: string

  @Column({ name: 'total_amount', type: 'decimal', precision: 14, scale: 2, default: 0, comment: '总金额' })
  totalAmount!: string

  @Index('idx_biz_outbound_is_deleted')
  @Column({ name: 'is_deleted', type: 'tinyint', width: 1, default: 0, comment: '是否已删除（软删除）' })
  isDeleted!: boolean

  @Column({ name: 'deleted_at', ...entityColumnOptions.timestamp, nullable: true, comment: '删除时间' })
  deletedAt!: Date | null

  @Index('idx_biz_outbound_deleted_by_user_id')
  @Column({ name: 'deleted_by_user_id', ...entityColumnOptions.foreignId, nullable: true, comment: '删除操作用户ID' })
  deletedByUserId!: string | null

  @Column({ name: 'deleted_by_username', type: 'varchar', length: 64, nullable: true, comment: '删除操作账号快照' })
  deletedByUsername!: string | null

  @Column({ name: 'deleted_by_display_name', type: 'varchar', length: 64, nullable: true, comment: '删除操作姓名快照' })
  deletedByDisplayName!: string | null

  @Index('idx_biz_outbound_creator_user_id')
  @Column({ name: 'creator_user_id', ...entityColumnOptions.foreignId, nullable: true, comment: '开单用户ID' })
  creatorUserId!: string | null

  @Column({ name: 'creator_username', type: 'varchar', length: 64, nullable: true, comment: '开单账号快照' })
  creatorUsername!: string | null

  @Column({ name: 'creator_display_name', type: 'varchar', length: 64, nullable: true, comment: '开单姓名快照' })
  creatorDisplayName!: string | null

  @Index('idx_biz_outbound_created_at')
  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  // 主子表采用一对多关系，结合事务可保证整单原子提交。
  @OneToMany(() => BizOutboundOrderItem, (item) => item.order)
  items?: Relation<BizOutboundOrderItem[]>
}
