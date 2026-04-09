import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { BaseProduct } from './base-product.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'inventory_log' })
export class InventoryLog {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_inventory_log_product_id')
  @Column({ name: 'product_id', ...entityColumnOptions.foreignId, comment: '商品ID' })
  productId!: string

  @Column({ name: 'change_type', type: 'varchar', length: 32, comment: '变更类型' })
  changeType!: string

  @Column({ name: 'change_qty', type: 'int', comment: '变更数量' })
  changeQty!: number

  @Column({ name: 'before_current_stock', type: 'int', default: 0, comment: '变更前物理库存' })
  beforeCurrentStock!: number

  @Column({ name: 'after_current_stock', type: 'int', default: 0, comment: '变更后物理库存' })
  afterCurrentStock!: number

  @Column({ name: 'before_preordered_stock', type: 'int', default: 0, comment: '变更前预订库存' })
  beforePreorderedStock!: number

  @Column({ name: 'after_preordered_stock', type: 'int', default: 0, comment: '变更后预订库存' })
  afterPreorderedStock!: number

  @Column({ name: 'operator_type', type: 'varchar', length: 32, default: 'system', comment: '操作人类型' })
  operatorType!: string

  @Column({ name: 'operator_id', type: 'varchar', length: 64, nullable: true, comment: '操作人ID' })
  operatorId!: string | null

  @Column({ name: 'operator_name', type: 'varchar', length: 128, nullable: true, comment: '操作人名称' })
  operatorName!: string | null

  @Column({ name: 'ref_type', type: 'varchar', length: 32, nullable: true, comment: '关联类型' })
  refType!: string | null

  @Column({ name: 'ref_id', type: 'varchar', length: 64, nullable: true, comment: '关联ID' })
  refId!: string | null

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '备注' })
  remark!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @ManyToOne(() => BaseProduct, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>
}
