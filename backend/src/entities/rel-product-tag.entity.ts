/**
 * 文件说明：商品与标签的关联实体，用于维护商品主数据和标签主数据之间的多对多映射关系。
 * 实现逻辑：通过复合唯一索引约束同一商品与标签只关联一次，并声明双向外键关系供查询和级联维护复用。
 * 维护重点：调整商品分类模型时，需要同步核对标签查询性能、唯一约束命名以及关联删除策略。
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
} from 'typeorm'
import { BaseProduct } from './base-product.entity.js'
import { BaseTag } from './base-tag.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'rel_product_tag' })
@Index('uk_rel_product_tag', ['productId', 'tagId'], { unique: true })
@Index('idx_rel_product_tag_tag_id_product_id', ['tagId', 'productId'])
// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class RelProductTag {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'product_id', ...entityColumnOptions.foreignId })
  productId!: string

  @Column({ name: 'tag_id', ...entityColumnOptions.foreignId })
  tagId!: string

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  // 多对多关系拆解为两条多对一关系，便于维护外键约束与查询性能。
  @ManyToOne(() => BaseProduct, (product) => product.tagRelations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product!: Relation<BaseProduct>

  @ManyToOne(() => BaseTag, (tag) => tag.productRelations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tag_id' })
  tag!: Relation<BaseTag>
}
