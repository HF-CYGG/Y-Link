/**
 * 模块说明：阿里云 PNVS 短信验证码受理与回执记录。
 * 文件职责：仅保存动态验证码平台的可审计状态，不保存验证码或完整手机号。
 * 维护说明：targetDigest 必须始终由服务端 HMAC 生成；回执按 outId 幂等更新。
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'
import { entityColumnOptions } from './entity-column-options.js'

export const SMS_VERIFICATION_SEND_STATUSES = ['pending', 'sent', 'failed'] as const
export type SmsVerificationSendStatus = (typeof SMS_VERIFICATION_SEND_STATUSES)[number]

export const SMS_VERIFICATION_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const
export type SmsVerificationDeliveryStatus = (typeof SMS_VERIFICATION_DELIVERY_STATUSES)[number]

export const SMS_VERIFICATION_RESULT_STATUSES = ['pending', 'passed', 'failed'] as const
export type SmsVerificationResultStatus = (typeof SMS_VERIFICATION_RESULT_STATUSES)[number]

@Entity({ name: 'sms_verification_record' })
@Index('uk_sms_verification_record_out_id', ['outId'], { unique: true })
@Index('idx_sms_verification_record_lookup', ['channel', 'scene', 'targetDigest', 'expiresAt'])
@Index('idx_sms_verification_record_retention', ['createdAt'])
export class SmsVerificationRecord {
  @PrimaryGeneratedColumn({ name: 'id', ...entityColumnOptions.primaryId })
  id!: string

  @Column({ name: 'out_id', type: 'varchar', length: 64, comment: '阿里云请求外部幂等标识' })
  outId!: string

  @Column({ name: 'biz_id', type: 'varchar', length: 128, nullable: true, comment: '阿里云业务标识' })
  bizId!: string | null

  @Column({ name: 'channel', type: 'varchar', length: 16, default: 'mobile', comment: '验证码通道' })
  channel!: 'mobile'

  @Column({ name: 'scene', type: 'varchar', length: 32, comment: '验证码业务场景' })
  scene!: 'register' | 'forgot_password' | 'profile_update' | 'test'

  @Column({ name: 'scheme_name', type: 'varchar', length: 20, default: '', comment: '发送时的阿里云方案名称' })
  schemeName!: string

  @Column({ name: 'target_digest', type: 'varchar', length: 64, comment: '手机号 HMAC 摘要' })
  targetDigest!: string

  @Column({ name: 'target_masked', type: 'varchar', length: 32, comment: '脱敏手机号展示值' })
  targetMasked!: string

  @Column({ name: 'send_status', type: 'varchar', length: 16, default: 'pending', comment: '发送受理状态' })
  sendStatus!: SmsVerificationSendStatus

  @Column({ name: 'delivery_status', type: 'varchar', length: 16, default: 'pending', comment: '短信回执状态' })
  deliveryStatus!: SmsVerificationDeliveryStatus

  @Column({ name: 'verification_status', type: 'varchar', length: 16, default: 'pending', comment: '验证码核验状态' })
  verificationStatus!: SmsVerificationResultStatus

  @Column({ name: 'provider_error_code', type: 'varchar', length: 128, nullable: true, comment: '平台错误码' })
  providerErrorCode!: string | null

  @Column({ name: 'provider_error_message', type: 'varchar', length: 500, nullable: true, comment: '脱敏平台错误信息' })
  providerErrorMessage!: string | null

  @Column({ name: 'sent_at', ...entityColumnOptions.timestamp, nullable: true, comment: '发送受理时间' })
  sentAt!: Date | null

  @Column({ name: 'reported_at', ...entityColumnOptions.timestamp, nullable: true, comment: 'MNS 回执时间' })
  reportedAt!: Date | null

  @Column({ name: 'verified_at', ...entityColumnOptions.timestamp, nullable: true, comment: '核验成功时间' })
  verifiedAt!: Date | null

  @Column({ name: 'expires_at', ...entityColumnOptions.timestamp, comment: '验证码到期时间' })
  expiresAt!: Date

  @CreateDateColumn({ name: 'created_at', ...entityColumnOptions.timestamp })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', ...entityColumnOptions.timestamp })
  updatedAt!: Date
}
