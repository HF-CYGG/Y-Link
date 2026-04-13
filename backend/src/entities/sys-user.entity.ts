/**
 * 模块说明：backend/src/entities/sys-user.entity.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'
import type { UserRole, UserStatus } from '../types/auth.js'

@Entity({ name: 'sys_user' })
// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class SysUser {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_sys_user_username', { unique: true })
  @Column({ name: 'username', type: 'varchar', length: 64, comment: '登录账号（唯一）' })
  username!: string

  @Column({ name: 'password_hash', type: 'varchar', length: 255, select: false, comment: '密码哈希（salt:hash）' })
  passwordHash!: string

  @Column({ name: 'display_name', type: 'varchar', length: 64, comment: '用户显示名称' })
  displayName!: string

  @Index('idx_sys_user_role')
  @Column({ name: 'role', type: 'varchar', length: 32, default: 'operator', comment: '用户角色：admin/operator/supplier' })
  role!: UserRole

  @Index('idx_sys_user_status')
  @Column({ name: 'status', type: 'varchar', length: 32, default: 'enabled', comment: '用户状态：enabled/disabled' })
  status!: UserStatus

  @Index('idx_sys_user_last_login_at')
  @Column({ name: 'last_login_at', ...entityColumnOptions.timestamp, nullable: true, comment: '最后登录时间' })
  lastLoginAt!: Date | null

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
