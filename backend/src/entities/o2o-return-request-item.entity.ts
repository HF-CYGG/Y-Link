/**
 * 文件说明：O2O 退货申请明细实体，记录单次退货申请下各商品的退货数量与商品关联关系。
 * 实现逻辑：通过退货申请外键和商品外键组织退货明细，为售后审核、入库回补和明细展示提供基础数据结构。
 * 维护重点：若扩展批次、良品次品或原始订单行绑定能力，需要同步调整服务校验和退货详情展示字段。
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { BaseProduct } from './base-product.entity.js'
import { BaseProductSku } from './base-product-sku.entity.js'
import { O2oReturnRequest } from './o2o-return-request.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'o2o_return_request_item' })
export class O2oReturnRequestItem {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_o2o_return_request_item_request_id')
  @Column({ name: 'return_request_id', ...entityColumnOptions.foreignId, comment: '退货申请ID' })
  returnRequestId!: string

  @Index('idx_o2o_return_request_item_product_id')
  @Column({ name: 'product_id', ...entityColumnOptions.foreignId, comment: '商品ID' })
  productId!: string

  @Index('idx_o2o_return_request_item_sku_id')
  @Column({ name: 'sku_id', ...entityColumnOptions.foreignId, nullable: true, comment: 'SKU ID' })
  skuId!: string | null

  @Column({ name: 'sku_code_snapshot', type: 'varchar', length: 96, nullable: true, comment: '退货 SKU 编码快照' })
  skuCodeSnapshot!: string | null

  @Column({ name: 'spec_text_snapshot', type: 'varchar', length: 255, nullable: true, comment: '退货规格文本快照' })
  specTextSnapshot!: string | null

  @Column({ name: 'qty', type: 'int', default: 0, comment: '退货数量' })
  qty!: number

  @ManyToOne(() => O2oReturnRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'return_request_id' })
  returnRequest?: Relation<O2oReturnRequest>

  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>

  @ManyToOne(() => BaseProductSku, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sku_id' })
  sku?: Relation<BaseProductSku>
}
