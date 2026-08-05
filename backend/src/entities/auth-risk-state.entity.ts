/**
 * 文件说明：认证与公共入口的共享风控状态。
 * 实现逻辑：仅持久化风控桶键的 SHA-256 摘要，并保存有界时间窗或登录失败状态，供多实例共同记账。
 * 维护重点：不得在本表写入原始账号、手机号或 IP；过期状态应通过 expires_at 定期清理。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

@Entity({ name: 'auth_risk_state' })
export class AuthRiskState {
  @PrimaryColumn({ name: 'bucket_digest', type: 'varchar', length: 64 })
  bucketDigest!: string

  @Column({ name: 'state_type', type: 'varchar', length: 24 })
  stateType!: 'rate_limit' | 'login_failure'

  @Column({ name: 'request_timestamps_json', type: 'text', nullable: true })
  requestTimestampsJson!: string | null

  @Column({ name: 'failure_count', type: 'int', default: 0 })
  failureCount!: number

  @Column({ name: 'first_failed_at', ...entityColumnOptions.timestamp, nullable: true })
  firstFailedAt!: Date | null

  @Column({ name: 'last_failed_at', ...entityColumnOptions.timestamp, nullable: true })
  lastFailedAt!: Date | null

  @Column({ name: 'locked_until', ...entityColumnOptions.timestamp, nullable: true })
  lockedUntil!: Date | null

  @Index('idx_auth_risk_state_expires_at')
  @Column({ name: 'expires_at', ...entityColumnOptions.timestamp })
  expiresAt!: Date

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
