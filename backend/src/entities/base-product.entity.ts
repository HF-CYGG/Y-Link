import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm'
import { BizOutboundOrderItem } from './biz-outbound-order-item.entity.js'
import { entityColumnOptions } from './entity-column-options.js'
import { RelProductTag } from './rel-product-tag.entity.js'

@Entity({ name: 'base_product' })
export class BaseProduct {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_base_product_code', { unique: true })
  @Column({ name: 'product_code', type: 'varchar', length: 64, comment: '产品编码（业务唯一）' })
  productCode!: string

  @Index('idx_base_product_name')
  @Column({ name: 'product_name', type: 'varchar', length: 128, comment: '产品名称' })
  productName!: string

  @Index('idx_base_product_pinyin_abbr')
  @Column({
    name: 'pinyin_abbr',
    type: 'varchar',
    length: 64,
    default: '',
    comment: '拼音首字母检索字段',
  })
  pinyinAbbr!: string

  @Column({ name: 'default_price', type: 'decimal', precision: 12, scale: 2, default: 0, comment: '默认单价' })
  defaultPrice!: string

  @Index('idx_base_product_is_active')
  @Column({ name: 'is_active', ...entityColumnOptions.booleanFlag, comment: '是否启用' })
  isActive!: boolean

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  // 产品与标签是多对多，通过关系表进行维护。
  @OneToMany(() => RelProductTag, (rel) => rel.product)
  tagRelations?: Relation<RelProductTag[]>

  // 出库明细引用产品，保留反向关系便于统计查询。
  @OneToMany(() => BizOutboundOrderItem, (item) => item.product)
  orderItems?: Relation<BizOutboundOrderItem[]>
}
