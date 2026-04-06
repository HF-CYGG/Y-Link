import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'sys_user_session' })
export class SysUserSession {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_sys_user_session_token', { unique: true })
  @Column({ name: 'session_token', type: 'varchar', length: 128, comment: 'Bearer 会话令牌' })
  sessionToken!: string

  @Index('idx_sys_user_session_user_id')
  @Column({ name: 'user_id', ...entityColumnOptions.foreignId, comment: '所属用户ID' })
  userId!: string

  @Index('idx_sys_user_session_expires_at')
  @Column({ name: 'expires_at', ...entityColumnOptions.timestamp, comment: '会话过期时间' })
  expiresAt!: Date

  @Column({ name: 'last_access_at', ...entityColumnOptions.timestamp, comment: '最后访问时间' })
  lastAccessAt!: Date

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
