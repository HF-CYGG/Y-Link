/**
 * 文件说明：YZ 通用 SKU 编码体系的变体码登记表实体，记录“一级变体码 / 尺码码”这两条编码轴上
 *          每个规格取值实际分配到的单字符编码。
 * 实现逻辑：核心约束是“变体码永不回收”——一个 (product_id, axis, spec_value) 一旦登记到某个 code，
 *          即使该规格值后续下架或改名，这一行也不会被删除、code 也不会被挪给别的规格值使用；
 *          重命名规格取值时只允许更新 spec_value 列本身，不允许更换 code。这样才能保证历史已印刷的
 *          条码/吊牌与商品实际规格的对应关系永远可追溯，不会因为编码复用而错乱。
 * 维护重点：写入该表只能新增或改名，禁止在业务代码里“删除后重新分配”同一个 code；
 *          `uk_registry_lookup` 保证同一商品同一编码轴下每个规格取值只登记一次（用于查找是否已分配），
 *          `uk_registry_code` 保证同一商品同一编码轴下每个 code 只分配给一个规格取值（用于防止重复分配）。
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

@Entity({ name: 'base_product_variant_code_registry' })
@Index('uk_registry_lookup', ['productId', 'axis', 'specValue'], { unique: true })
@Index('uk_registry_code', ['productId', 'axis', 'code'], { unique: true })
export class BaseProductVariantCodeRegistry {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'product_id', ...entityColumnOptions.foreignId, comment: '商品ID' })
  productId!: string

  @Column({ name: 'axis', type: 'varchar', length: 8, comment: '编码轴：variant=一级变体，size=尺码' })
  axis!: 'variant' | 'size'

  @Column({ name: 'spec_value', type: 'varchar', length: 64, comment: '规格取值原文，重命名时只改本列' })
  specValue!: string

  @Column({ name: 'code', type: 'varchar', length: 1, comment: '已分配的码，一经登记永不变更、永不回收' })
  code!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  @ManyToOne(() => BaseProduct, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product?: Relation<BaseProduct>
}
