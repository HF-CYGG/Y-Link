/**
 * 文件说明：库存单据主表实体，承载扫码作业台提交的采购入库、其他出库、退货入库、报损出库与库存调整。
 * 实现逻辑：单据创建即完成记账（status=completed）；作废时生成反向流水并置为 voided。
 * 维护重点：单据类型与库存方向的映射集中在 inventory-doc.service.ts，新增类型时同步前端类型字典与流水类型。
 */

import { Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'
import { InvStockDocItem } from './inv-stock-doc-item.entity.js'

@Entity({ name: 'inv_stock_doc' })
@Index('idx_inv_stock_doc_type_created', ['docType', 'createdAt', 'id'])
export class InvStockDoc {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_inv_stock_doc_no', { unique: true })
  @Column({ name: 'doc_no', type: 'varchar', length: 32, comment: '单据号' })
  docNo!: string

  @Index('uk_inv_stock_doc_request', { unique: true })
  @Column({ name: 'client_request_id', type: 'varchar', length: 64, nullable: true, comment: '提交幂等键' })
  clientRequestId!: string | null

  @Column({ name: 'doc_type', type: 'varchar', length: 16, comment: '单据类型' })
  docType!: string

  @Index('idx_inv_stock_doc_status')
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'completed', comment: '单据状态' })
  status!: string

  @Column({ name: 'reason_code', type: 'varchar', length: 32, nullable: true, comment: '原因编码' })
  reasonCode!: string | null

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '备注' })
  remark!: string | null

  @Column({ name: 'total_qty', type: 'int', default: 0, comment: '变动数量绝对值合计' })
  totalQty!: number

  @Column({ name: 'operator_id', type: 'varchar', length: 64, nullable: true, comment: '操作人ID' })
  operatorId!: string | null

  @Column({ name: 'operator_name', type: 'varchar', length: 128, nullable: true, comment: '操作人' })
  operatorName!: string | null

  @Column({ name: 'void_reason', type: 'varchar', length: 255, nullable: true, comment: '作废原因' })
  voidReason!: string | null

  @Column({ name: 'voided_at', ...entityColumnOptions.timestamp, nullable: true, comment: '作废时间' })
  voidedAt!: Date | null

  @Column({ name: 'voided_by_name', type: 'varchar', length: 128, nullable: true, comment: '作废人' })
  voidedByName!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @OneToMany(() => InvStockDocItem, (item) => item.doc)
  items?: Relation<InvStockDocItem[]>
}
