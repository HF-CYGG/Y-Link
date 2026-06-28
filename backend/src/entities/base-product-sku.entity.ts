/**
 * 文件说明：商品 SKU 实体，承载同一商品下不同规格组合的价格、库存与启停状态。
 * 实现逻辑：规格组合以 JSON 文本保存，服务层负责归一化为“颜色 / 款式”等展示文本，并在 O2O 下单时写入快照。
 * 维护重点：SKU 库存是规格选择后的真实可售库存，订单占用和核销必须优先更新本表，不能只更新商品主表。
 */

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
import { entityColumnOptions } from './entity-column-options.js'

const skuSpecValuesJsonColumnOptions = entityColumnOptions.isSqlite ? { default: '{}' } : {}

@Entity({ name: 'base_product_sku' })
@Index('idx_base_product_sku_product_id', ['productId'])
@Index('idx_base_product_sku_mall_list', ['productId', 'isActive', 'sortOrder', 'id'])
@Index('uk_base_product_sku_code', ['skuCode'], { unique: true })
export class BaseProductSku {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'product_id', ...entityColumnOptions.foreignId, comment: '商品ID' })
  productId!: string

  @Column({ name: 'sku_code', type: 'varchar', length: 96, comment: 'SKU 编码' })
  skuCode!: string

  @Column({ name: 'spec_values_json', type: 'text', ...skuSpecValuesJsonColumnOptions, comment: '规格值 JSON' })
  specValuesJson!: string

  @Column({ name: 'spec_text', type: 'varchar', length: 255, default: '默认规格', comment: '规格展示文本' })
  specText!: string

  @Column({ name: 'default_price', type: 'decimal', precision: 12, scale: 2, default: 0, comment: 'SKU 原价' })
  defaultPrice!: string

  @Column({ name: 'discount_rate', type: 'decimal', precision: 3, scale: 1, default: 10.0, comment: 'SKU 折扣' })
  discountRate!: string

  @Column({ name: 'current_stock', type: 'int', default: 0, comment: 'SKU 物理库存' })
  currentStock!: number

  @Column({ name: 'pre_ordered_stock', type: 'int', default: 0, comment: 'SKU 已预订库存' })
  preOrderedStock!: number

  @Column({ name: 'is_active', ...entityColumnOptions.booleanFlag, default: 1, comment: 'SKU 是否启用' })
  isActive!: boolean

  @Column({ name: 'o2o_recommended', ...entityColumnOptions.booleanFlag, default: 0, comment: 'SKU 是否推荐到 O2O 商城' })
  o2oRecommended!: boolean

  @Column({ name: 'thumbnail', type: 'varchar', length: 255, nullable: true, comment: 'SKU 图片' })
  thumbnail!: string | null

  @Column({ name: 'sort_order', type: 'int', default: 0, comment: '排序' })
  sortOrder!: number

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  @ManyToOne(() => BaseProduct, (product) => product.skus, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>
}
