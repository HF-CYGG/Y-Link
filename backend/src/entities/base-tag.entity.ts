/**
 * 文件说明：标签主数据实体，定义系统内可复用的标签名称、编码和与商品关联的基础结构。
 * 实现逻辑：通过名称与编码唯一索引维持标签主数据稳定性，并与商品标签关系表形成一对多映射。
 * 维护重点：修改标签唯一性或字段长度时，需要同步关注标签管理路由、商品筛选功能和历史关联数据。
 */

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

  // 注意：tagCode 历史上实际存放的是颜色值（如 #409EFF），字段名有误导性，
  // 因此 YZ 商品编码体系另开 seriesCode 承载“两位大写字母系列码”，两者互不影响。
  @Index('uk_base_tag_series_code', { unique: true })
  @Column({ name: 'series_code', type: 'varchar', length: 2, nullable: true, comment: '文创系列码（两位大写字母，供商品编码使用）' })
  seriesCode!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  // 反向关系仅用于联表查询，不直接持久化该字段。
  @OneToMany(() => RelProductTag, (rel) => rel.tag)
  productRelations?: Relation<RelProductTag[]>
}
