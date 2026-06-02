/**
 * 文件说明：O2O 预订单明细实体，记录每张预订单下的商品、数量以及与主表和商品表的关联关系。
 * 实现逻辑：用订单外键和商品外键组织明细项，并通过级联删除与限制删除规则保护订单历史和商品引用完整性。
 * 维护重点：调整预订单明细字段时，需要同步确认下单入参、订单详情展示和库存占用计算逻辑。
 */

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

  // 明细项随订单删除级联清理，避免订单取消或清理后残留孤立 item。
  @ManyToOne(() => O2oPreorder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order?: Relation<O2oPreorder>

  // 商品实体使用 RESTRICT，防止仍被订单引用的商品被误删，影响历史订单追溯。
  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>
}
