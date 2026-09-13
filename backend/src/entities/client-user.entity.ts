import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

export const CLIENT_USER_STATUSES = ['enabled', 'disabled'] as const
export type ClientUserStatus = (typeof CLIENT_USER_STATUSES)[number]

export const CLIENT_USER_ACCOUNT_TYPES = ['personal', 'department'] as const
export type ClientUserAccountType = (typeof CLIENT_USER_ACCOUNT_TYPES)[number]

@Entity({ name: 'client_user' })
export class ClientUser {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_client_user_mobile', { unique: true })
  @Column({ name: 'mobile', type: 'varchar', length: 20, nullable: true, comment: '手机号（手机号注册时必填）' })
  mobile!: string | null

  @Index('uk_client_user_email', { unique: true })
  @Column({ name: 'email', type: 'varchar', length: 128, nullable: true, comment: '邮箱（邮箱注册时必填）' })
  email!: string | null

  @Column({ name: 'mobile_verified_at', ...entityColumnOptions.timestamp, nullable: true })
  mobileVerifiedAt!: Date | null

  @Column({ name: 'email_verified_at', ...entityColumnOptions.timestamp, nullable: true })
  emailVerifiedAt!: Date | null

  @Column({ name: 'password_hash', type: 'varchar', length: 255, select: false, comment: '密码哈希' })
  passwordHash!: string

  @Column({ name: 'real_name', type: 'varchar', length: 128, comment: '用户名（兼容历史 real_name 列）' })
  realName!: string

  @Column({ name: 'department_name', type: 'varchar', length: 271, default: '', comment: '所属部门完整路径（最多 8 级，每级 32 字符）' })
  departmentName!: string

  @Index('uk_client_user_department_node_id', { unique: true })
  @Column({ name: 'department_node_id', type: 'varchar', length: 128, nullable: true, comment: '部门共享账号绑定的稳定部门节点ID' })
  departmentNodeId!: string | null

  @Column({ name: 'account_type', type: 'varchar', length: 16, default: 'personal', comment: '账号类型' })
  accountType!: ClientUserAccountType

  @Index('uk_client_user_staff_no', { unique: true })
  @Column({ name: 'staff_no', type: 'varchar', length: 64, nullable: true, comment: '教职工号' })
  staffNo!: string | null

  @Column({ name: 'staff_verified', ...entityColumnOptions.booleanFlag, default: 0, comment: '工号是否通过目录校验' })
  staffVerified!: boolean

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'enabled', comment: '账号状态' })
  status!: ClientUserStatus

  @Column({ name: 'last_login_at', ...entityColumnOptions.timestamp, nullable: true, comment: '最后登录时间' })
  lastLoginAt!: Date | null

  @Column({ name: 'deactivated_at', ...entityColumnOptions.timestamp, nullable: true, comment: '最近一次注销时间' })
  deactivatedAt!: Date | null

  @Column({ name: 'deactivation_reason', type: 'varchar', length: 500, nullable: true, comment: '最近一次注销原因' })
  deactivationReason!: string | null

  @Column({ name: 'deactivated_by_user_id', ...entityColumnOptions.foreignId, nullable: true, comment: '注销操作者 ID 快照' })
  deactivatedByUserId!: string | null

  @Column({ name: 'deactivated_by_username', type: 'varchar', length: 64, nullable: true, comment: '注销操作者账号快照' })
  deactivatedByUsername!: string | null

  @Column({ name: 'deactivated_by_display_name', type: 'varchar', length: 64, nullable: true, comment: '注销操作者名称快照' })
  deactivatedByDisplayName!: string | null

  @Column({ name: 'restored_at', ...entityColumnOptions.timestamp, nullable: true, comment: '最近一次恢复时间' })
  restoredAt!: Date | null

  @Column({ name: 'restored_by_user_id', ...entityColumnOptions.foreignId, nullable: true, comment: '恢复操作者 ID 快照' })
  restoredByUserId!: string | null

  @Column({ name: 'restored_by_username', type: 'varchar', length: 64, nullable: true, comment: '恢复操作者账号快照' })
  restoredByUsername!: string | null

  @Column({ name: 'restored_by_display_name', type: 'varchar', length: 64, nullable: true, comment: '恢复操作者名称快照' })
  restoredByDisplayName!: string | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
