/**
 * 模块说明：backend/src/entities/o2o-return-request-item.entity.ts
 * 文件职责：定义 O2O 退货申请明细表结构，记录每次退货申请中各商品的退货数量。
 * 维护说明：若后续需要区分批次、良品/次品或绑定原始订单行，可在本实体扩展字段，并同步更新服务校验逻辑。
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { BaseProduct } from './base-product.entity.js'
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

  @Column({ name: 'qty', type: 'int', default: 0, comment: '退货数量' })
  qty!: number

  @ManyToOne(() => O2oReturnRequest, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'return_request_id' })
  returnRequest?: Relation<O2oReturnRequest>

  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>
}
