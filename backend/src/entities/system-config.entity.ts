/**
 * 文件说明：系统配置实体，使用键值对方式存储后台运行参数、业务规则和可运营维护的文本配置。
 * 实现逻辑：通过唯一配置键、配置分组和备注字段组织可扩展配置项，配合服务层完成统一读取与持久化。
 * 维护重点：新增配置项时，需要同步确认配置键命名、默认值来源以及长文本在不同数据库方言下的兼容性。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'system_configs' })
// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class SystemConfig {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_system_configs_config_key', { unique: true })
  @Column({ name: 'config_key', type: 'varchar', length: 128 })
  configKey!: string

  // 配置值需要承载验证码模板等长文本，因此统一提升为 text，避免前端已通过校验但数据库写入截断。
  @Column({ name: 'config_value', type: 'text' })
  configValue!: string

  @Column({ name: 'config_group', type: 'varchar', length: 64, default: 'general' })
  configGroup!: string

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true })
  remark!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
