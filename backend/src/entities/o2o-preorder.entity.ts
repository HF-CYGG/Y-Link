/**
 * 模块说明：backend/src/entities/o2o-preorder.entity.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

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
export const O2O_PREORDER_CANCEL_REASONS = ['manual', 'timeout'] as const
export type O2oPreorderCancelReason = (typeof O2O_PREORDER_CANCEL_REASONS)[number]

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

  // cancelReason 用于稳定区分“用户主动撤回/人工取消”和“系统超时取消”，
  // 不能再依赖 timeoutAt 与当前时间推断，否则主动撤回单在过了超时点后会被误判成超时取消。
  @Column({ name: 'cancel_reason', type: 'varchar', length: 16, nullable: true, comment: '取消原因' })
  cancelReason!: O2oPreorderCancelReason | null

  // totalQty 记录整单总件数，便于列表快速展示，避免每次都聚合子项。
  @Column({ name: 'total_qty', type: 'int', default: 0, comment: '总件数' })
  totalQty!: number

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '备注' })
  remark!: string | null

  @Column({ name: 'timeout_at', ...entityColumnOptions.timestamp, nullable: true, comment: '超时取消时间' })
  timeoutAt!: Date | null

  // verifiedAt / verifiedBy 只有在管理端实际核销后才会写入，用于线下履约追踪。
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
