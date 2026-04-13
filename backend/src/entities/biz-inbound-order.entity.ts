import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'biz_inbound_order' })
export class BizInboundOrder {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_biz_inbound_show_no', { unique: true })
  @Column({
    name: 'show_no',
    type: 'varchar',
    length: 48,
    comment: '业务展示单号，如 IN202310250001',
  })
  showNo!: string

  @Index('uk_biz_inbound_verify_code', { unique: true })
  @Column({
    name: 'verify_code',
    type: 'varchar',
    length: 64,
    comment: '二维码核销码',
  })
  verifyCode!: string

  @Index('idx_biz_inbound_supplier_id')
  @Column({
    name: 'supplier_id',
    ...entityColumnOptions.foreignId,
    comment: '关联供货方用户 ID (sys_user)',
  })
  supplierId!: string

  @Column({
    name: 'supplier_name',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '供货方名称快照',
  })
  supplierName!: string | null

  @Index('idx_biz_inbound_status')
  @Column({
    name: 'status',
    type: 'varchar',
    length: 32,
    comment: '单据状态：pending(待入库), verified(已核销入库), cancelled(已取消)',
    default: 'pending',
  })
  status!: 'pending' | 'verified' | 'cancelled'

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    name: 'total_qty',
    comment: '总数量',
    default: '0.00',
  })
  totalQty!: string

  @Column({
    name: 'remark',
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: '供货方备注',
  })
  remark!: string | null

  @Column({
    name: 'verified_at',
    ...entityColumnOptions.timestamp,
    nullable: true,
    comment: '核销入库时间',
  })
  verifiedAt!: Date | null

  @Column({
    name: 'verified_by_user_id',
    ...entityColumnOptions.foreignId,
    nullable: true,
    comment: '核销操作人 ID',
  })
  verifiedByUserId!: string | null

  @Column({
    name: 'verified_by_username',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '核销操作人账号快照',
  })
  verifiedByUsername!: string | null

  @Column({
    type: 'varchar',
    length: 128,
    name: 'verified_by_display_name',
    nullable: true,
    comment: '核销操作人姓名快照',
  })
  verifiedByDisplayName!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp, comment: '创建时间' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp, comment: '更新时间' })
  updatedAt!: Date
}
