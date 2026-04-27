/**
 * 模块说明：backend/src/entities/o2o-return-request.entity.ts
 * 文件职责：定义 O2O 退货申请主表结构，承载退货申请单号、退货码、来源订单状态、核销状态与售后原因。
 * 维护说明：若调整退货申请生命周期或核销口径，请同步更新服务层、路由返回结构、SQL 脚本与 SQLite bootstrap 检查项。
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
import { O2oPreorder, type O2oPreorderStatus } from './o2o-preorder.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

export const O2O_RETURN_REQUEST_STATUSES = ['pending', 'verified', 'rejected'] as const
export type O2oReturnRequestStatus = (typeof O2O_RETURN_REQUEST_STATUSES)[number]

@Entity({ name: 'o2o_return_request' })
@Index('idx_o2o_return_request_order_id', ['orderId', 'id'])
@Index('idx_o2o_return_request_order_status_id', ['orderId', 'status', 'id'])
export class O2oReturnRequest {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_o2o_return_request_return_no', { unique: true })
  @Column({ name: 'return_no', type: 'varchar', length: 48, comment: '退货申请单号' })
  returnNo!: string

  @Index('idx_o2o_return_request_order_fk')
  @Column({ name: 'order_id', ...entityColumnOptions.foreignId, comment: '关联预订单ID' })
  orderId!: string

  @Index('idx_o2o_return_request_client_user_id')
  @Column({ name: 'client_user_id', ...entityColumnOptions.foreignId, comment: '申请客户端用户ID' })
  clientUserId!: string

  @Index('uk_o2o_return_request_verify_code', { unique: true })
  @Column({ name: 'verify_code', type: 'varchar', length: 64, comment: '退货核销码' })
  verifyCode!: string

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'pending', comment: '退货申请状态' })
  status!: O2oReturnRequestStatus

  @Column({ name: 'source_order_status', type: 'varchar', length: 16, comment: '申请时订单主状态快照' })
  sourceOrderStatus!: O2oPreorderStatus

  @Column({ name: 'reason', type: 'varchar', length: 500, comment: '退货原因' })
  reason!: string

  @Column({ name: 'total_qty', type: 'int', default: 0, comment: '退货总件数' })
  totalQty!: number

  // handledAt / handledBy 统一记录“本次退货申请的最终处理结果时间与处理人”，
  // 这样拒绝与回库核销都能复用同一套追踪口径；verifiedAt / verifiedBy 仍专用于回库成功场景。
  @Column({ name: 'handled_at', ...entityColumnOptions.timestamp, nullable: true, comment: '处理时间' })
  handledAt!: Date | null

  @Column({ name: 'handled_by', type: 'varchar', length: 64, nullable: true, comment: '处理人' })
  handledBy!: string | null

  @Column({ name: 'rejected_reason', type: 'varchar', length: 500, nullable: true, comment: '拒绝原因' })
  rejectedReason!: string | null

  @Column({ name: 'verified_at', ...entityColumnOptions.timestamp, nullable: true, comment: '退货核销时间' })
  verifiedAt!: Date | null

  @Column({ name: 'verified_by', type: 'varchar', length: 64, nullable: true, comment: '退货核销操作人' })
  verifiedBy!: string | null

  @ManyToOne(() => O2oPreorder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order?: Relation<O2oPreorder>

  @ManyToOne(() => ClientUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_user_id' })
  clientUser?: Relation<ClientUser>

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
