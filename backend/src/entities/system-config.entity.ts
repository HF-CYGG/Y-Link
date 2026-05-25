/**
 * 模块说明：backend/src/entities/system-config.entity.ts
 * 文件职责：系统配置实体，保存平台级功能开关与参数值。
 * 实现逻辑：以键值对形式承载配置项，供系统配置服务统一读写与默认值补齐。
 * 维护说明：配置键命名与类型变化需同步前后端与迁移脚本。
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
