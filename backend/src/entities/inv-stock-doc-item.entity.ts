/**
 * 文件说明：库存单据明细实体，逐 SKU 记录单据的有符号变动量与记账时的前后库存快照。
 * 实现逻辑：qty 为库存净变化（入库为正、出库为负），前后库存取自共享记账函数的返回值，与 inventory_log 对应。
 * 维护重点：明细只在单据创建时写入，作废不改明细，由反向流水体现。
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { BaseProduct } from './base-product.entity.js'
import { BaseProductSku } from './base-product-sku.entity.js'
import { entityColumnOptions } from './entity-column-options.js'
import { InvStockDoc } from './inv-stock-doc.entity.js'

@Entity({ name: 'inv_stock_doc_item' })
export class InvStockDocItem {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_inv_stock_doc_item_doc_id')
  @Column({ name: 'doc_id', ...entityColumnOptions.foreignId, comment: '单据ID' })
  docId!: string

  @Index('idx_inv_stock_doc_item_product_id')
  @Column({ name: 'product_id', ...entityColumnOptions.foreignId, comment: '商品ID' })
  productId!: string

  @Index('idx_inv_stock_doc_item_sku_id')
  @Column({ name: 'sku_id', ...entityColumnOptions.foreignId, comment: 'SKU ID' })
  skuId!: string

  @Column({ name: 'sku_code_snapshot', type: 'varchar', length: 96, comment: 'SKU 编码快照' })
  skuCodeSnapshot!: string

  @Column({ name: 'product_name_snapshot', type: 'varchar', length: 128, comment: '商品名称快照' })
  productNameSnapshot!: string

  @Column({ name: 'spec_text_snapshot', type: 'varchar', length: 255, comment: '规格快照' })
  specTextSnapshot!: string

  @Column({ name: 'qty', type: 'int', comment: '库存净变化' })
  qty!: number

  @Column({ name: 'before_sku_stock', type: 'int', comment: '记账前 SKU 库存' })
  beforeSkuStock!: number

  @Column({ name: 'after_sku_stock', type: 'int', comment: '记账后 SKU 库存' })
  afterSkuStock!: number

  @ManyToOne(() => InvStockDoc, (doc) => doc.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'doc_id' })
  doc?: Relation<InvStockDoc>

  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>

  @ManyToOne(() => BaseProductSku, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sku_id' })
  sku?: Relation<BaseProductSku>
}
