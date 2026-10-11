/**
 * 文件说明：管理端账号第二因素策略实体，一个账号至多一行，存在即表示密码登录仍需第二因素。
 * 实现逻辑：
 * - `totp_secret_sealed` 可空；存在时为 AES-256-GCM 密文（AAD 绑定账号 ID），
 *   `recovery_codes_json` 只存未使用恢复码的 HMAC-SHA256 摘要，两列默认不随查询返回；
 * - `factor_revision` 在第二因素配置变更时递增，用于拒绝旧验证票据；
 * - `last_used_step` 记录最近一次成功使用的 TOTP 时间步，只能单调推进，防止同一动态码重放。
 * 维护说明：外键为 RESTRICT，永久删除账号时由服务层在同一事务内先删除本行；MySQL 结构见 `sql/057_admin_mfa.sql` 与增量 `059_admin_webauthn_second_factor.sql`。
 */

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn, type Relation } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'
import { SysUser } from './sys-user.entity.js'

@Entity({ name: 'sys_user_mfa' })
export class SysUserMfa {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_sys_user_mfa_user_id', { unique: true })
  @Column({ name: 'user_id', ...entityColumnOptions.foreignId, comment: '管理端账号ID（一人一行）' })
  userId!: string

  @Column({ name: 'totp_secret_sealed', type: 'varchar', length: 255, nullable: true, select: false, comment: 'TOTP 秘钥密文（AES-256-GCM）；仅通行密钥用户可为空' })
  totpSecretSealed!: string | null

  @Column({ name: 'factor_revision', type: 'int', default: 1, comment: '第二因素配置版本；变更后使旧验证票据失效' })
  factorRevision!: number

  @Column({ name: 'recovery_codes_json', type: 'text', select: false, comment: '未使用恢复码的 HMAC-SHA256 摘要列表（JSON）' })
  recoveryCodesJson!: string

  @Column({ name: 'enabled_at', ...entityColumnOptions.timestamp, comment: '开启时间' })
  enabledAt!: Date

  @Column({ name: 'last_used_step', type: 'int', nullable: true, comment: '最近一次成功使用的 TOTP 时间步（防重放）' })
  lastUsedStep!: number | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date

  @ManyToOne(() => SysUser, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user?: Relation<SysUser>
}
