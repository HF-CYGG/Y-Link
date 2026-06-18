/**
 * 文件说明：入库明细实体，记录每张入库单中的商品、数量和与主单的关联关系。
 * 实现逻辑：通过入库单外键和商品外键组织逐行明细，为核销入库、详情展示和库存回写提供基础数据。
 * 维护重点：若新增入库明细字段，需要同步更新数据库脚本、服务层保存逻辑和前端详情展示结构。
 */

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
