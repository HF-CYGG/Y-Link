/**
 * 文件说明：规格分库位库存实体，记录某个 SKU 在“主库位以外”的库位上实际存放的件数。
 * 实现逻辑：
 * - SKU 的物理总库存仍以 base_product_sku.current_stock 为唯一口径；本表只记录拆分到其他库位的件数；
 * - 主库位（base_product_sku.location_id）件数不落表，恒等于“总库存 − 本表该 SKU 各行之和”，
 *   因此入库、退货、导入等增加库存的链路无需改动，新增件数自然落在主库位；
 * - 一个 SKU 在同一库位至多一行，件数为 0 的行直接删除，不保留空行。
 * 维护重点：
 * - 任何扣减物理库存的写入都必须在同一事务内调用 sku-location-stock.service 的规整函数，
 *   保证“本表之和 ≤ 总库存”，不能只在读取时折算；
 * - 主库位所在库位不得同时出现在本表（写入时会合并回主库位）。
 */
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation, UpdateDateColumn } from 'typeorm'
import { BaseProductSku } from './base-product-sku.entity.js'
import { BaseStorageLocation } from './base-storage-location.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'inv_sku_location_stock' })
@Index('uk_inv_sku_location_stock_sku_location', ['skuId', 'locationId'], { unique: true })
export class InvSkuLocationStock {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'sku_id', ...entityColumnOptions.foreignId, comment: 'SKU ID' })
  skuId!: string

  @Index('idx_inv_sku_location_stock_location_id')
  @Column({ name: 'location_id', ...entityColumnOptions.foreignId, comment: '库位ID（主库位以外）' })
  locationId!: string

  @Column({ name: 'qty', type: 'int', comment: '该库位存放件数（大于 0）' })
  qty!: number

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  @ManyToOne(() => BaseProductSku, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sku_id' })
  sku?: Relation<BaseProductSku>

  @ManyToOne(() => BaseStorageLocation, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'location_id' })
  location?: Relation<BaseStorageLocation>
}
