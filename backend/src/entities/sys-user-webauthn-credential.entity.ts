/** 管理端通行密钥凭据：usage 区分免密登录与密码登录第二因素；原始 ID 与公钥只用于校验。 */
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'
import { SysUser } from './sys-user.entity.js'

@Entity({ name: 'sys_user_webauthn_credential' })
@Index('uk_sys_user_webauthn_rp_credential_sha256', ['rpId', 'credentialIdSha256'], { unique: true })
export class SysUserWebauthnCredential {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('idx_sys_user_webauthn_credential_user_id')
  @Column({ name: 'user_id', ...entityColumnOptions.foreignId })
  userId!: string

  @Column({ name: 'rp_id', type: 'varchar', length: 253 })
  rpId!: string

  @Column({ name: 'credential_id_sha256', type: 'varchar', length: 64 })
  credentialIdSha256!: string

  @Column({ name: 'credential_id', type: 'blob', select: false })
  credentialId!: Buffer

  @Column({ name: 'public_key', type: 'blob', select: false })
  publicKey!: Buffer

  @Column({ name: 'counter', type: 'bigint', unsigned: true, default: '0' })
  counter!: string

  @Column({ name: 'transports_json', type: 'varchar', length: 512, nullable: true })
  transportsJson!: string | null

  @Column({ name: 'device_type', type: 'varchar', length: 32 })
  deviceType!: string

  @Column({ name: 'backed_up', type: 'boolean', default: false })
  backedUp!: boolean

  @Column({ name: 'name', type: 'varchar', length: 64 })
  name!: string

  @Column({ name: 'usage', type: 'varchar', length: 16, default: 'passwordless', comment: '凭据用途：免密登录或密码登录第二因素' })
  usage!: 'passwordless' | 'second_factor'

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @Column({ name: 'last_used_at', ...entityColumnOptions.timestamp, nullable: true })
  lastUsedAt!: Date | null

  @ManyToOne(() => SysUser, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'fk_sys_user_webauthn_credential_user_id' })
  user?: Relation<SysUser>
}
