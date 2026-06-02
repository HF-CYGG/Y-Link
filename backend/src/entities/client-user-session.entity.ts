/**
 * 文件说明：客户端用户会话实体，保存客户端登录后的会话令牌、所属用户和会话访问时间信息。
 * 实现逻辑：通过唯一令牌索引与客户端用户外键管理登录态持久化，为客户端自动登录、退出和会话续期提供基础数据。
 * 维护重点：变更客户端会话时效或退出策略时，需要同步核对 Cookie 配置、服务层刷新规则和级联删除行为。
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { ClientUser } from './client-user.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'client_user_session' })
// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class ClientUserSession {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_client_user_session_token', { unique: true })
  @Column({ name: 'session_token', type: 'varchar', length: 128, comment: '会话令牌' })
  sessionToken!: string

  @Index('idx_client_user_session_user_id')
  @Column({ name: 'user_id', ...entityColumnOptions.foreignId, comment: '客户端用户ID' })
  userId!: string

  @Column({ name: 'expires_at', ...entityColumnOptions.timestamp, comment: '过期时间' })
  expiresAt!: Date

  @Column({ name: 'last_access_at', ...entityColumnOptions.timestamp, comment: '最近访问时间' })
  lastAccessAt!: Date

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @ManyToOne(() => ClientUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: Relation<ClientUser>
}
