/**
 * 模块说明：backend/src/entities/sys-user-session.entity.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'sys_user_session' })
// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
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
