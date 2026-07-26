import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

export const CLIENT_STAFF_DIRECTORY_STATUSES = ['active', 'inactive'] as const
export type ClientStaffDirectoryStatus = (typeof CLIENT_STAFF_DIRECTORY_STATUSES)[number]

@Entity({ name: 'client_staff_directory' })
export class ClientStaffDirectory {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_client_staff_directory_staff_no', { unique: true })
  @Column({ name: 'staff_no', type: 'varchar', length: 64, comment: '教职工号' })
  staffNo!: string

  @Column({ name: 'real_name', type: 'varchar', length: 128, comment: '真实姓名' })
  realName!: string

  @Column({ name: 'department_name', type: 'varchar', length: 128, comment: '所属部门' })
  departmentName!: string

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'active', comment: '目录状态' })
  status!: ClientStaffDirectoryStatus

  @Column({ name: 'invite_code_digest', type: 'varchar', length: 64, nullable: true, select: false })
  inviteCodeDigest!: string | null

  @Column({ name: 'invite_issued_at', ...entityColumnOptions.timestamp, nullable: true })
  inviteIssuedAt!: Date | null

  @Column({ name: 'invite_expires_at', ...entityColumnOptions.timestamp, nullable: true })
  inviteExpiresAt!: Date | null

  @Column({ name: 'invite_used_at', ...entityColumnOptions.timestamp, nullable: true })
  inviteUsedAt!: Date | null

  @Column({ name: 'invite_failed_attempts', type: 'int', default: 0 })
  inviteFailedAttempts!: number

  @Column({ name: 'invite_locked_until', ...entityColumnOptions.timestamp, nullable: true })
  inviteLockedUntil!: Date | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
