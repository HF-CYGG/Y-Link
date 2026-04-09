import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { ClientUser } from './client-user.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'client_user_session' })
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
