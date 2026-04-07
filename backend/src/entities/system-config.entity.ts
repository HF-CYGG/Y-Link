import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'system_configs' })
export class SystemConfig {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_system_configs_config_key', { unique: true })
  @Column({ name: 'config_key', type: 'varchar', length: 128 })
  configKey!: string

  @Column({ name: 'config_value', type: 'varchar', length: 255 })
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
