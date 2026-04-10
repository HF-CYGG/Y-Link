/**
 * 模块说明：backend/src/entities/rel-product-tag.entity.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
