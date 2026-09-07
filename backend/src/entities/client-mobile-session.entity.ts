/**
 * 模块说明：backend/src/entities/client-mobile-session.entity.ts
 * 文件职责：保存 Native Mobile 独立的 access/refresh 会话血缘与设备展示信息。
 * 实现逻辑：数据库只持久化 SHA-256 摘要；当前/上一 refresh 摘要、grace 截止和 generation
 * 共同构成原子轮换状态，revokedAt/revokeReason 保留主动撤销与安全事件证据。
 * 维护说明：Mobile 会话不得与 Web Cookie 会话混表；新增撤销原因需同步 Contract 闭集、迁移与验证脚本。
 */
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { ClientUser } from './client-user.entity.js'
import { entityColumnOptions } from './entity-column-options.js'

export const MOBILE_SESSION_REVOKE_REASONS = [
  'user_logout',
  'user_logout_all',
  'user_revoke_device',
  'password_changed',
  'password_reset',
  'account_disabled',
  'refresh_replay_detected',
  'session_limit_evicted',
  'expired_cleanup',
  'admin_revoke',
] as const

export type MobileSessionRevokeReason = (typeof MOBILE_SESSION_REVOKE_REASONS)[number]
export type MobileSessionPlatform = 'android' | 'ios'

const refreshGenerationColumn = entityColumnOptions.isSqlite
  ? ({ type: 'integer' as const, default: 0 })
  : ({ type: 'int' as const, unsigned: true, default: 0 })

@Entity({ name: 'client_mobile_session' })
@Index('idx_client_mobile_session_user_active', ['clientUserId', 'revokedAt', 'lastAccessAt'])
@Index('idx_client_mobile_session_user_device', ['clientUserId', 'deviceId'])
@Index('idx_client_mobile_session_cleanup', ['revokedAt', 'absoluteExpiresAt', 'id'])
@Index('idx_client_mobile_session_refresh_expiry', ['revokedAt', 'refreshExpiresAt', 'id'])
export class ClientMobileSession {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'client_user_id', ...entityColumnOptions.foreignId, comment: '客户端用户 ID' })
  clientUserId!: string

  @Column({ name: 'device_id', type: 'varchar', length: 64, comment: '客户端设备标签，不参与认证' })
  deviceId!: string

  @Column({ name: 'device_name', type: 'varchar', length: 64, nullable: true })
  deviceName!: string | null

  @Column({ name: 'platform', type: 'varchar', length: 16 })
  platform!: MobileSessionPlatform

  @Column({ name: 'app_version', type: 'varchar', length: 32, nullable: true })
  appVersion!: string | null

  @Index('uk_client_mobile_session_access_hash', { unique: true })
  @Column({ name: 'access_token_hash', type: 'varchar', length: 64, select: false })
  accessTokenHash!: string

  @Column({ name: 'access_expires_at', ...entityColumnOptions.timestamp })
  accessExpiresAt!: Date

  @Index('uk_client_mobile_session_refresh_hash', { unique: true })
  @Column({ name: 'refresh_token_hash', type: 'varchar', length: 64, select: false })
  refreshTokenHash!: string

  @Column({ name: 'refresh_expires_at', ...entityColumnOptions.timestamp })
  refreshExpiresAt!: Date

  @Index('idx_client_mobile_session_previous_refresh_hash')
  @Column({ name: 'previous_refresh_token_hash', type: 'varchar', length: 64, nullable: true, select: false })
  previousRefreshTokenHash!: string | null

  @Column({ name: 'previous_refresh_grace_until', ...entityColumnOptions.timestamp, nullable: true })
  previousRefreshGraceUntil!: Date | null

  @Column({ name: 'refresh_generation', ...refreshGenerationColumn })
  refreshGeneration!: number

  @Column({ name: 'absolute_expires_at', ...entityColumnOptions.timestamp })
  absoluteExpiresAt!: Date

  @Column({ name: 'last_ip', type: 'varchar', length: 64, nullable: true })
  lastIp!: string | null

  @Column({ name: 'last_access_at', ...entityColumnOptions.timestamp })
  lastAccessAt!: Date

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @Column({ name: 'revoked_at', ...entityColumnOptions.timestamp, nullable: true })
  revokedAt!: Date | null

  @Column({ name: 'revoke_reason', type: 'varchar', length: 64, nullable: true })
  revokeReason!: MobileSessionRevokeReason | null

  @ManyToOne(() => ClientUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_user_id' })
  user?: Relation<ClientUser>
}
