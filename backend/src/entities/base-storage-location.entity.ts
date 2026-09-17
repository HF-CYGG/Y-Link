/**
 * 文件说明：库位主数据实体，记录货架位置编码（如 A-01-01），供 SKU 默认存放位置、盘点范围与找货使用。
 * 实现逻辑：库位编码唯一，只停用不删除，避免历史盘点单与 SKU 引用失效。
 * 维护重点：库位编码格式由服务层校验（字母、数字与短横线），调整规则时同步前端输入提示。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'base_storage_location' })
export class BaseStorageLocation {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_base_storage_location_code', { unique: true })
  @Column({ name: 'location_code', type: 'varchar', length: 32, comment: '库位编码' })
  locationCode!: string

  @Column({ name: 'location_name', type: 'varchar', length: 64, nullable: true, comment: '库位名称' })
  locationName!: string | null

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '备注' })
  remark!: string | null

  @Column({ name: 'is_active', ...entityColumnOptions.booleanFlag, comment: '是否启用' })
  isActive!: boolean

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
