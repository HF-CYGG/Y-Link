import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'
import { RelProductTag } from './rel-product-tag.entity.js'

@Entity({ name: 'base_tag' })
export class BaseTag {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_base_tag_name', { unique: true })
  @Column({ name: 'tag_name', type: 'varchar', length: 64, comment: '标签名称（唯一）' })
  tagName!: string

  @Index('uk_base_tag_code', { unique: true })
  @Column({ name: 'tag_code', type: 'varchar', length: 64, nullable: true, comment: '标签编码（可选，唯一）' })
  tagCode!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  // 反向关系仅用于联表查询，不直接持久化该字段。
  @OneToMany(() => RelProductTag, (rel) => rel.tag)
  productRelations?: Relation<RelProductTag[]>
}
