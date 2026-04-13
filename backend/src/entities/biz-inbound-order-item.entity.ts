import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { BizInboundOrder } from './biz-inbound-order.entity.js'
import { BaseProduct } from './base-product.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'biz_inbound_order_item' })
export class BizInboundOrderItem {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_biz_inbound_item_order_id')
  @Column({
    name: 'order_id',
    ...entityColumnOptions.foreignId,
    comment: '关联入库单 ID',
  })
  orderId!: string

  @ManyToOne(() => BizInboundOrder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order?: Relation<BizInboundOrder>

  @Index('idx_biz_inbound_item_product_id')
  @Column({
    name: 'product_id',
    ...entityColumnOptions.foreignId,
    comment: '关联商品 ID',
  })
  productId!: string

  @Column({
    name: 'product_name_snapshot',
    type: 'varchar',
    length: 255,
    comment: '商品名称快照',
  })
  productNameSnapshot!: string

  @Column({
    name: 'qty',
    type: 'decimal',
    precision: 10,
    scale: 2,
    comment: '入库数量',
    default: '0.00',
  })
  qty!: string

  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>
}
