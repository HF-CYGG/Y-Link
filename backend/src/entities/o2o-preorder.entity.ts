import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm'
import { ClientUser } from './client-user.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

export const O2O_PREORDER_STATUSES = ['pending', 'verified', 'cancelled'] as const
export type O2oPreorderStatus = (typeof O2O_PREORDER_STATUSES)[number]

@Entity({ name: 'o2o_preorder' })
export class O2oPreorder {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_o2o_preorder_show_no', { unique: true })
  @Column({ name: 'show_no', type: 'varchar', length: 48, comment: '预订单号' })
  showNo!: string

  @Index('idx_o2o_preorder_client_user_id')
  @Column({ name: 'client_user_id', ...entityColumnOptions.foreignId, comment: '客户端用户ID' })
  clientUserId!: string

  @Index('uk_o2o_preorder_verify_code', { unique: true })
  @Column({ name: 'verify_code', type: 'varchar', length: 64, comment: '核销码' })
  verifyCode!: string

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'pending', comment: '订单状态' })
  status!: O2oPreorderStatus

  @Column({ name: 'total_qty', type: 'int', default: 0, comment: '总件数' })
  totalQty!: number

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '备注' })
  remark!: string | null

  @Column({ name: 'timeout_at', ...entityColumnOptions.timestamp, nullable: true, comment: '超时取消时间' })
  timeoutAt!: Date | null

  @Column({ name: 'verified_at', ...entityColumnOptions.timestamp, nullable: true, comment: '核销时间' })
  verifiedAt!: Date | null

  @Column({ name: 'verified_by', type: 'varchar', length: 64, nullable: true, comment: '核销操作人' })
  verifiedBy!: string | null

  @ManyToOne(() => ClientUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_user_id' })
  clientUser?: Relation<ClientUser>

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
