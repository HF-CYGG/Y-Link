/**
 * 模块说明：backend/src/entities/system-config.entity.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
