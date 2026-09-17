/**
 * 文件说明：商品分类主数据实体，承载两位分类编码与分类名称，供 SKU 编码生成、盘点范围与库存筛选使用。
 * 实现逻辑：分类编码为两位数字且唯一，是 `WC + 分类编码 + 流水号` SKU 编码规则的组成部分；分类只停用不删除，保证历史 SKU 编码可追溯。
 * 维护重点：已关联商品的分类不允许改码，由服务层拦截。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'base_category' })
export class BaseCategory {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_base_category_code', { unique: true })
  @Column({ name: 'category_code', type: 'varchar', length: 2, comment: '两位分类编码' })
  categoryCode!: string

  @Index('uk_base_category_name', { unique: true })
  @Column({ name: 'category_name', type: 'varchar', length: 64, comment: '分类名称' })
  categoryName!: string

  @Column({ name: 'sort_order', type: 'int', default: 0, comment: '排序' })
  sortOrder!: number

  @Column({ name: 'is_active', ...entityColumnOptions.booleanFlag, comment: '是否启用' })
  isActive!: boolean

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
