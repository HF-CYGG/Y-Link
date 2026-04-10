/**
 * 模块说明：backend/src/entities/base-product.entity.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

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
// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
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

  @Column({ name: 'category', type: 'varchar', length: 64, default: '默认分类', comment: '商品分类' })
  category!: string

  @Index('idx_base_product_is_active')
  @Column({ name: 'is_active', ...entityColumnOptions.booleanFlag, comment: '是否启用' })
  isActive!: boolean

  @Index('idx_base_product_o2o_status')
  @Column({ name: 'o2o_status', type: 'varchar', length: 16, default: 'unlisted', comment: '线上预订状态' })
  o2oStatus!: 'listed' | 'unlisted'

  @Column({ name: 'thumbnail', type: 'varchar', length: 255, nullable: true, comment: '预览图地址' })
  thumbnail!: string | null

  @Column({ name: 'detail_content', type: 'text', nullable: true, comment: '商品详情' })
  detailContent!: string | null

  @Column({ name: 'limit_per_user', type: 'int', default: 5, comment: '单人限购数量' })
  limitPerUser!: number

  @Column({ name: 'current_stock', type: 'int', default: 0, comment: '物理库存' })
  currentStock!: number

  @Column({ name: 'pre_ordered_stock', type: 'int', default: 0, comment: '已预订库存' })
  preOrderedStock!: number

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
