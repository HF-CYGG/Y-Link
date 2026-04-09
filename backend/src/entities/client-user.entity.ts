import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

export const CLIENT_USER_STATUSES = ['enabled', 'disabled'] as const
export type ClientUserStatus = (typeof CLIENT_USER_STATUSES)[number]

@Entity({ name: 'client_user' })
export class ClientUser {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_client_user_mobile', { unique: true })
  @Column({ name: 'mobile', type: 'varchar', length: 20, comment: '手机号' })
  mobile!: string

  @Column({ name: 'password_hash', type: 'varchar', length: 255, select: false, comment: '密码哈希' })
  passwordHash!: string

  @Column({ name: 'real_name', type: 'varchar', length: 64, comment: '真实姓名' })
  realName!: string

  @Column({ name: 'department_name', type: 'varchar', length: 128, default: '', comment: '所属部门' })
  departmentName!: string

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'enabled', comment: '账号状态' })
  status!: ClientUserStatus

  @Column({ name: 'last_login_at', ...entityColumnOptions.timestamp, nullable: true, comment: '最后登录时间' })
  lastLoginAt!: Date | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
