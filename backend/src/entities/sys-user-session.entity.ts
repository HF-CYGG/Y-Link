/**
 * 模块说明：backend/src/entities/sys-user-session.entity.ts
 * 文件职责：管理端会话实体，记录后台用户会话令牌哈希与访问状态。
 * 实现逻辑：为鉴权中间件提供会话查验依据，并支持会话失效与过期清理。
 * 维护说明：会话字段和索引调整需同步认证服务查询路径与清理逻辑。
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
