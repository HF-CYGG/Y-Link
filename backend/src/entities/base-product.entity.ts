/**
 * 文件说明：商品主数据实体，定义商品编码、名称、价格、库存、限购和上下架等后台核心字段。
 * 实现逻辑：利用检查约束和多个索引保证库存与价格字段合法，并通过关系字段连接订单明细和标签关联表。
 * 维护重点：调整商品库存模型或上下架字段时，需要同步核对商品服务、库存日志和 O2O 预订占用逻辑。
 */

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm'
import { BaseCategory } from './base-category.entity.js'
import { BaseTag } from './base-tag.entity.js'
import { BizOutboundOrderItem } from './biz-outbound-order-item.entity.js'
import { BaseProductSku } from './base-product-sku.entity.js'
import { entityColumnOptions } from './entity-column-options.js'
import { RelProductTag } from './rel-product-tag.entity.js'

@Entity({ name: 'base_product' })
@Check('ck_base_product_non_negative', '`default_price` >= 0 AND `discount_rate` >= 1.0 AND `discount_rate` <= 10.0 AND `limit_per_user` >= 1 AND `current_stock` >= 0 AND `pre_ordered_stock` >= 0 AND `pre_ordered_stock` <= `current_stock`')
@Index('idx_base_product_mall_list', ['isActive', 'o2oStatus', 'id'])
@Index('uk_base_product_series_seq', ['primarySeriesTagId', 'seriesSeq'], { unique: true })
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

  @Column({ name: 'discount_rate', type: 'decimal', precision: 3, scale: 1, default: 10.0, comment: 'O2O 商品折扣' })
  discountRate!: string

  @Index('idx_base_product_is_active')
  @Column({ name: 'is_active', ...entityColumnOptions.booleanFlag, comment: '是否启用' })
  isActive!: boolean

  @Index('idx_base_product_o2o_status')
  @Column({ name: 'o2o_status', type: 'varchar', length: 16, default: 'unlisted', comment: '线上预订状态' })
  o2oStatus!: 'listed' | 'unlisted'

  @Index('idx_base_product_o2o_recommended')
  @Column({ name: 'o2o_recommended', ...entityColumnOptions.booleanFlag, default: 0, comment: '是否手动推荐到 O2O 商城' })
  o2oRecommended!: boolean

  @Column({ name: 'thumbnail', type: 'varchar', length: 255, nullable: true, comment: '预览图地址' })
  thumbnail!: string | null

  @Column({ name: 'detail_content', type: 'text', nullable: true, comment: '商品详情' })
  detailContent!: string | null

  @Column({ name: 'limit_per_user', type: 'int', default: 5, comment: '单人限购数量' })
  limitPerUser!: number

  @Column({ name: 'current_stock', type: 'int', default: 0, comment: '物理库存' })
  currentStock!: number

  @Index('idx_base_product_category_id')
  @Column({ name: 'category_id', ...entityColumnOptions.foreignId, nullable: true, comment: '商品分类ID' })
  categoryId!: string | null

  @Column({ name: 'pre_ordered_stock', type: 'int', default: 0, comment: '已预订库存' })
  preOrderedStock!: number

  // YZ 通用 SKU 编码体系：主系列标签是编码唯一权威，消除商品-标签多对多关系下“该用哪个系列码”的歧义。
  @Index('idx_base_product_primary_series_tag_id')
  @Column({ name: 'primary_series_tag_id', ...entityColumnOptions.foreignId, nullable: true, comment: '主系列标签ID（编码唯一权威，消除商品-标签多对多歧义）' })
  primarySeriesTagId!: string | null

  @Column({ name: 'series_seq', type: 'smallint', unsigned: true, nullable: true, comment: '系列内商品序号（1-99）' })
  seriesSeq!: number | null

  @Column({ name: 'code_scheme', type: 'varchar', length: 8, default: 'legacy', comment: '编码体系：legacy=历史P-/WC编码，yz=新版定长编码' })
  codeScheme!: string

  // 历史编码字段（B9 批次）：升级到 YZ 编码前的历史产品编码，仅作追溯展示，不参与任何查询匹配。
  @Column({ name: 'legacy_product_code', type: 'varchar', length: 64, nullable: true, comment: '升级到 YZ 编码前的历史产品编码，仅作追溯展示' })
  legacyProductCode!: string | null

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

  @OneToMany(() => BaseProductSku, (sku) => sku.product)
  skus?: Relation<BaseProductSku[]>

  @ManyToOne(() => BaseCategory, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category?: Relation<BaseCategory>

  @ManyToOne(() => BaseTag, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'primary_series_tag_id' })
  primarySeriesTag?: Relation<BaseTag>
}
