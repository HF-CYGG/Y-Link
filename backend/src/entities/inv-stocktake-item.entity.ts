/**
 * 文件说明：盘点明细实体，逐 SKU 记录账面快照、实盘数量、差异、差异原因与处理方式。
 * 实现逻辑：账面快照在该 SKU 首次计数时由服务端记录，差异 = 实盘 − 快照；确认时按差异增量调账，避免盘点期间正常出入库被覆盖。
 * 维护重点：`(stocktake_id, sku_id)` 唯一；范围外追加的 SKU 以 in_scope=0 标记。
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation, UpdateDateColumn } from 'typeorm'
import { BaseProduct } from './base-product.entity.js'
import { BaseProductSku } from './base-product-sku.entity.js'
import { entityColumnOptions } from './entity-column-options.js'
import { InvStocktake } from './inv-stocktake.entity.js'

@Entity({ name: 'inv_stocktake_item' })
@Index('uk_inv_stocktake_item_sku', ['stocktakeId', 'skuId'], { unique: true })
export class InvStocktakeItem {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_inv_stocktake_item_stocktake_id')
  @Column({ name: 'stocktake_id', ...entityColumnOptions.foreignId, comment: '盘点单ID' })
  stocktakeId!: string

  @Index('idx_inv_stocktake_item_product_id')
  @Column({ name: 'product_id', ...entityColumnOptions.foreignId, comment: '商品ID' })
  productId!: string

  @Index('idx_inv_stocktake_item_sku_id')
  @Column({ name: 'sku_id', ...entityColumnOptions.foreignId, comment: 'SKU ID' })
  skuId!: string

  @Column({ name: 'in_scope', ...entityColumnOptions.booleanFlag, comment: '是否属于建单范围' })
  inScope!: boolean

  @Column({ name: 'book_qty_snapshot', type: 'int', nullable: true, comment: '首次计数时的账面库存' })
  bookQtySnapshot!: number | null

  @Column({ name: 'counted_qty', type: 'int', nullable: true, comment: '实盘数量' })
  countedQty!: number | null

  @Column({ name: 'counted_by_name', type: 'varchar', length: 128, nullable: true, comment: '计数人' })
  countedByName!: string | null

  @Column({ name: 'counted_at', ...entityColumnOptions.timestamp, nullable: true, comment: '计数时间' })
  countedAt!: Date | null

  @Column({ name: 'diff_reason', type: 'varchar', length: 32, nullable: true, comment: '差异原因' })
  diffReason!: string | null

  @Column({ name: 'resolution', type: 'varchar', length: 16, nullable: true, comment: '处理方式' })
  resolution!: string | null

  @Column({ name: 'resolution_remark', type: 'varchar', length: 255, nullable: true, comment: '处理备注' })
  resolutionRemark!: string | null

  @Column({ name: 'applied_qty', type: 'int', nullable: true, comment: '确认时实际调账数量' })
  appliedQty!: number | null

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  @ManyToOne(() => InvStocktake, (stocktake) => stocktake.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'stocktake_id' })
  stocktake?: Relation<InvStocktake>

  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>

  @ManyToOne(() => BaseProductSku, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sku_id' })
  sku?: Relation<BaseProductSku>
}
