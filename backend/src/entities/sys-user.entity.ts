/**
 * 文件说明：后台系统用户实体，定义管理员、操作员和供货方等后台账号的基础资料与登录状态字段。
 * 实现逻辑：通过 TypeORM 注解声明唯一索引、角色状态字段和时间戳列，为后台鉴权、权限判断与用户管理提供持久化结构。
 * 维护重点：新增账号属性或调整角色枚举时，需要同步核对鉴权类型定义、登录流程以及数据库唯一约束。
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

  @Index('uk_sys_user_email', { unique: true })
  @Column({ name: 'email', type: 'varchar', length: 128, nullable: true, comment: '邮箱地址（可空且唯一）' })
  email!: string | null

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
