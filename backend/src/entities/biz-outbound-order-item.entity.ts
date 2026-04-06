import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm'
import { BaseProduct } from './base-product.entity.js'
import { BizOutboundOrder } from './biz-outbound-order.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'biz_outbound_order_item' })
@Index('uk_biz_outbound_order_line', ['orderId', 'lineNo'], { unique: true })
export class BizOutboundOrderItem {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'order_id', ...entityColumnOptions.foreignId })
  orderId!: string

  @Column({ name: 'line_no', type: 'int' })
  lineNo!: number

  @Index('idx_biz_outbound_item_product_id')
  @Column({ name: 'product_id', ...entityColumnOptions.foreignId })
  productId!: string

  @Column({ name: 'product_name_snapshot', type: 'varchar', length: 128 })
  productNameSnapshot!: string

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  qty!: string

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  unitPrice!: string

  @Column({ type: 'decimal', precision: 14, scale: 2 })
  lineAmount!: string

  @Column({ type: 'varchar', length: 200, nullable: true })
  remark!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  // 明细关联主单，删除主单时自动级联删除明细，保证数据一致性。
  @ManyToOne(() => BizOutboundOrder, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Relation<BizOutboundOrder>

  // 明细引用产品，出库后仍保留产品名称快照避免历史数据受产品改名影响。
  @ManyToOne(() => BaseProduct, (product) => product.orderItems, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product!: Relation<BaseProduct>
}
