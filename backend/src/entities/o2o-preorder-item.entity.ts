import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { BaseProduct } from './base-product.entity.js'
import { O2oPreorder } from './o2o-preorder.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'o2o_preorder_item' })
export class O2oPreorderItem {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_o2o_preorder_item_order_id')
  @Column({ name: 'order_id', ...entityColumnOptions.foreignId, comment: '预订单ID' })
  orderId!: string

  @Index('idx_o2o_preorder_item_product_id')
  @Column({ name: 'product_id', ...entityColumnOptions.foreignId, comment: '商品ID' })
  productId!: string

  @Column({ name: 'qty', type: 'int', default: 0, comment: '预订数量' })
  qty!: number

  @ManyToOne(() => O2oPreorder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order?: Relation<O2oPreorder>

  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>
}
