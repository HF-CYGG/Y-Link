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
import { BaseStorageLocation } from './base-storage-location.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

const skuSpecValuesJsonColumnOptions = entityColumnOptions.isSqlite ? { default: '{}' } : {}

@Entity({ name: 'base_product_sku' })
@Index('idx_base_product_sku_product_id', ['productId'])
@Index('idx_base_product_sku_mall_list', ['productId', 'isActive', 'sortOrder', 'id'])
@Index('idx_base_product_sku_current_mall_list', ['productId', 'isCurrent', 'isActive', 'sortOrder', 'id'])
@Index('uk_base_product_sku_code', ['skuCode'], { unique: true })
@Index('uk_base_product_sku_barcode', ['barcode'], { unique: true })
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

  @Column({ name: 'barcode', type: 'varchar', length: 64, nullable: true, comment: '原厂条码（为空时以 SKU 编码作为内部条码）' })
  barcode!: string | null

  @Column({ name: 'cost_price', type: 'decimal', precision: 12, scale: 2, nullable: true, comment: 'SKU 成本价' })
  costPrice!: string | null

  @Index('idx_base_product_sku_location_id')
  @Column({ name: 'location_id', ...entityColumnOptions.foreignId, nullable: true, comment: '默认库位ID' })
  locationId!: string | null

  @Column({ name: 'current_stock', type: 'int', default: 0, comment: 'SKU 物理库存' })
  currentStock!: number

  @Column({ name: 'pre_ordered_stock', type: 'int', default: 0, comment: 'SKU 已预订库存' })
  preOrderedStock!: number

  @Column({ name: 'is_active', ...entityColumnOptions.booleanFlag, default: 1, comment: 'SKU 是否启用' })
  isActive!: boolean

  @Column({ name: 'is_current', ...entityColumnOptions.booleanFlag, default: 1, comment: 'SKU current matrix marker' })
  isCurrent!: boolean

  @Column({ name: 'o2o_recommended', ...entityColumnOptions.booleanFlag, default: 0, comment: 'SKU 是否推荐到 O2O 商城' })
  o2oRecommended!: boolean

  @Column({ name: 'thumbnail', type: 'varchar', length: 255, nullable: true, comment: 'SKU 图片' })
  thumbnail!: string | null

  @Column({ name: 'sort_order', type: 'int', default: 0, comment: '排序' })
  sortOrder!: number

  // YZ 通用 SKU 编码体系专用字段：历史规格组合（颜色/款式等）编码的商品不写这两列，保持 NULL。
  @Column({ name: 'variant_code', type: 'varchar', length: 1, nullable: true, comment: '一级变体码（0-9），仅 YZ 编码商品使用' })
  variantCode!: string | null

  @Column({ name: 'size_code', type: 'varchar', length: 1, nullable: true, comment: '尺码码（A-E），NULL 表示无尺码位' })
  sizeCode!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  @ManyToOne(() => BaseProduct, (product) => product.skus, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>

  @ManyToOne(() => BaseStorageLocation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'location_id' })
  location?: Relation<BaseStorageLocation>

  /**
   * 序列化保护：成本价属于经营敏感数据，实体被直接 JSON 化（例如送货单详情带出的 SKU 关联）时不下发。
   * 需要成本价的接口必须显式构造视图（商品 SKU 视图、当前库存查询），并按 products:manage 裁剪。
   */
  toJSON(): Record<string, unknown> {
    const plain = { ...this } as unknown as Record<string, unknown>
    delete plain.costPrice
    return plain
  }
}
