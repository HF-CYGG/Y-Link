/**
 * 模块说明：backend/src/entities/client-user.entity.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export const CLIENT_USER_STATUSES = ['enabled', 'disabled'] as const
export type ClientUserStatus = (typeof CLIENT_USER_STATUSES)[number]

@Entity({ name: 'client_user' })
// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
export class ClientUser {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Index('uk_client_user_mobile', { unique: true })
  @Column({ name: 'mobile', type: 'varchar', length: 20, nullable: true, comment: '手机号（手机号注册时必填）' })
  mobile!: string | null

  @Index('uk_client_user_email', { unique: true })
  @Column({ name: 'email', type: 'varchar', length: 128, nullable: true, comment: '邮箱（邮箱注册时必填）' })
  email!: string | null

  @Column({ name: 'password_hash', type: 'varchar', length: 255, select: false, comment: '密码哈希' })
  passwordHash!: string

  // 兼容历史字段名：数据库列仍叫 real_name，但业务上已作为“用户名/展示名”使用。
  @Column({ name: 'real_name', type: 'varchar', length: 128, comment: '用户名（兼容历史 real_name 列）' })
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
