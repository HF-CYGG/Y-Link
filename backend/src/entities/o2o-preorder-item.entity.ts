/**
 * 模块说明：backend/src/entities/o2o-preorder-item.entity.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
