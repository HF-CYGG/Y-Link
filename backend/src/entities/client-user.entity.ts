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

  @Column({ name: 'department_name', type: 'varchar', length: 128, default: '', comment: '所属部门' })
  departmentName!: string

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

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
