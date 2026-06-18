/**
 * 模块说明：backend/src/entities/o2o-preorder-item.entity.ts
 * 文件职责：O2O 预订单明细实体，记录每个商品项的数量、价格快照与明细行信息。
 * 实现逻辑：与预订单主表一对多关联，支撑核销、退货、改单等按明细处理流程。
 * 维护说明：明细字段改动需同步预订单详情展示与库存扣减计算逻辑。
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

  @Column({ name: 'original_price', type: 'decimal', precision: 12, scale: 2, default: 0, comment: '下单时原价快照' })
  originalPrice!: string

  @Column({ name: 'discount_rate', type: 'decimal', precision: 4, scale: 2, default: 10, comment: '下单时折扣快照（几折）' })
  discountRate!: string

  @Column({ name: 'unit_price', type: 'decimal', precision: 12, scale: 2, default: 0, comment: '下单时折后单价快照' })
  unitPrice!: string

  @Column({ name: 'line_amount', type: 'decimal', precision: 14, scale: 2, default: 0, comment: '明细行折后金额快照' })
  lineAmount!: string

  // 明细项随订单删除级联清理，避免订单取消或清理后残留孤立 item。
  @ManyToOne(() => O2oPreorder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order?: Relation<O2oPreorder>

  // 商品实体使用 RESTRICT，防止仍被订单引用的商品被误删，影响历史订单追溯。
  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>
}
