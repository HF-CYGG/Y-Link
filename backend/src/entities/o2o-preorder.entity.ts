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
export const O2O_PREORDER_BUSINESS_STATUSES = [
  'preparing',
  'ready',
  'awaiting_shipment',
  'shipped',
  'partially_shipped',
  'closed',
  'completed',
  'after_sale',
  'after_sale_done',
  'verifying',
  'verify_failed',
] as const
export type O2oPreorderBusinessStatus = (typeof O2O_PREORDER_BUSINESS_STATUSES)[number]
export const O2O_CLIENT_ORDER_TYPES = ['department', 'walkin'] as const
export type O2oClientOrderType = (typeof O2O_CLIENT_ORDER_TYPES)[number]

@Entity({ name: 'o2o_preorder' })
@Index('idx_o2o_preorder_client_id', ['clientUserId', 'id'])
@Index('idx_o2o_preorder_client_status_id', ['clientUserId', 'status', 'id'])
@Index('idx_o2o_preorder_status_timeout_at', ['status', 'timeoutAt'])
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

  @Column({ name: 'business_status', type: 'varchar', length: 32, nullable: true, comment: '商家特殊状态' })
  businessStatus!: O2oPreorderBusinessStatus | null

  @Column({ name: 'merchant_message', type: 'varchar', length: 500, nullable: true, comment: '商家留言' })
  merchantMessage!: string | null

  // clientOrderType 记录用户本次下单时明确选择的归属类型，
  // 后续核销沉淀出库单、管理端筛选展示都必须以这个“订单快照”而不是当前用户资料为准。
  @Column({ name: 'client_order_type', type: 'varchar', length: 16, default: 'walkin', comment: '客户端下单归属类型' })
  clientOrderType!: O2oClientOrderType

  // departmentNameSnapshot 只在“部门订”时记录下单当时的部门名称，
  // 避免用户之后修改个人资料导致历史订单归属被串改。
  @Column({ name: 'department_name_snapshot', type: 'varchar', length: 128, nullable: true, comment: '下单时部门名称快照' })
  departmentNameSnapshot!: string | null

  // isSystemApplied 记录客户端下单时对“是否已在学校/企业系统申请”的明确选择，
  // 后续核销生成出库单时直接复用这个快照，避免被服务端默认值覆盖。
  @Column({ name: 'is_system_applied', ...entityColumnOptions.booleanFlag, default: 0, comment: '是否系统申请（客户端选择快照）' })
  isSystemApplied!: boolean

  // hasCustomerOrder 用于记录客户端是否触发过“正式出库单打印/导出”，
  // 核销生成后台出库单时将作为 hasCustomerOrder 的来源快照，避免继续写死为 false。
  @Column({ name: 'has_customer_order', ...entityColumnOptions.booleanFlag, default: 0, comment: '是否已触发正式出库单打印/导出（客户端快照）' })
  hasCustomerOrder!: boolean

  // pickupContact 记录用户本次下单明确填写的提货人，
  // 不能再回退为账号用户名，否则“代同事下单/代部门领取”场景会丢失真实提货口径。
  @Column({ name: 'pickup_contact', type: 'varchar', length: 32, nullable: true, comment: '提货人' })
  pickupContact!: string | null

  // totalQty 记录整单总件数，便于列表快速展示，避免每次都聚合子项。
  @Column({ name: 'total_qty', type: 'int', default: 0, comment: '总件数' })
  totalQty!: number

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '备注' })
  remark!: string | null

  // updateCount 用于约束客户端改单次数，避免待取货订单被无限次改写导致库存预占频繁抖动。
  @Column({ name: 'update_count', type: 'int', default: 0, comment: '客户端修改次数' })
  updateCount!: number

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
