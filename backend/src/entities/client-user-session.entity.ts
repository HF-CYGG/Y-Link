/**
 * 模块说明：backend/src/entities/client-user-session.entity.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
