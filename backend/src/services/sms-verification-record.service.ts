/**
 * 模块说明：阿里云 PNVS 短信验证码受理记录服务。
 * 文件职责：用 HMAC 关联手机号与 outId，落库发送、回执、核验状态并提供脱敏查询。
 * 维护说明：本服务永不保存验证码或完整手机号；外部平台异常不得透传给前端。
 */

import { createHmac, randomUUID } from 'node:crypto'
import type { Repository } from 'typeorm'
import { AppDataSource } from '../config/data-source.js'
import { env } from '../config/env.js'
import {
  SmsVerificationRecord,
  type SmsVerificationDeliveryStatus,
} from '../entities/sms-verification-record.entity.js'
import { BizError } from '../utils/errors.js'
import { databaseMaintenanceModeService } from './database-maintenance-mode.service.js'
import {
  AliyunDypnsSmsProvider,
  DYPNS_CODE_EXPIRE_SECONDS,
  type AliyunDypnsProviderConfig,
  type AliyunDypnsSmsApi,
} from './aliyun-dypns-sms.service.js'
import type { VerificationScene } from './system-config.service.js'

export function maskMobileVerificationTarget(rawTarget: string): string {
  const normalized = rawTarget.trim()
  if (normalized.length < 7) {
    return '***'
  }
  return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`
}

function sanitizeProviderErrorMessage(message: unknown, target?: string, verificationCode?: string): string | null {
  const raw = String(message ?? '')
  const escapedTarget = target ? target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''
  const escapedCode = verificationCode ? verificationCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''
  const withoutSensitiveValues = (escapedTarget ? raw.replace(new RegExp(escapedTarget, 'g'), '[已脱敏手机号]') : raw)
    .replace(/\b\d{6}\b/g, '[已脱敏验证码]')
  const normalized = (escapedCode
    ? withoutSensitiveValues.replace(new RegExp(escapedCode, 'g'), '[已脱敏验证码]')
    : withoutSensitiveValues)
    .replace(/\b\d{7,15}\b/g, '[已脱敏手机号]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500)
  return normalized || null
}

function getTicketHmacSecret(): string {
  const secret = env.VERIFICATION_TICKET_HMAC_SECRET?.trim() || ''
  if (secret.length < 32) {
    throw new BizError('验证码 HMAC 密钥未配置或长度不足，无法安全关联短信核验记录', 500)
  }
  return secret
}

function createTargetDigest(target: string): string {
  return createHmac('sha256', getTicketHmacSecret()).update(target).digest('hex')
}

export interface SendDypnsVerificationInput {
  target: string
  scene: VerificationScene
  config: AliyunDypnsProviderConfig
}

export interface VerifyDypnsVerificationInput {
  target: string
  scene: VerificationScene
  code: string
}

export interface InvalidateDypnsVerificationInput {
  target: string
  scene: VerificationScene
}

export interface SmsReceiptUpdateInput {
  outId: string
  bizId?: string | null
  deliveryStatus: SmsVerificationDeliveryStatus
  errorCode?: string | null
  errorMessage?: string | null
  sentAt: Date
  reportedAt: Date
}

export class SmsVerificationRecordService {
  constructor(
    private readonly dypnsApi: AliyunDypnsSmsApi = new AliyunDypnsSmsProvider(),
    private readonly recordRepo: Repository<SmsVerificationRecord> = AppDataSource.getRepository(SmsVerificationRecord),
  ) {}

  async send(input: SendDypnsVerificationInput) {
    const target = input.target.trim()
    const outId = randomUUID()
    const expiresAt = new Date(Date.now() + DYPNS_CODE_EXPIRE_SECONDS * 1000)
    const record = await this.recordRepo.save(this.recordRepo.create({
      outId,
      bizId: null,
      channel: 'mobile',
      scene: input.scene,
      schemeName: input.config.schemeName.trim(),
      targetDigest: createTargetDigest(target),
      targetMasked: maskMobileVerificationTarget(target),
      sendStatus: 'pending',
      deliveryStatus: 'pending',
      verificationStatus: 'pending',
      providerErrorCode: null,
      providerErrorMessage: null,
      sentAt: null,
      reportedAt: null,
      verifiedAt: null,
      expiresAt,
    }))

    try {
      const result = await this.dypnsApi.send({
        phoneNumber: target,
        countryCode: '86',
        outId,
        scene: input.scene,
        config: input.config,
      })
      if (result.code !== 'OK' || result.success !== true) {
        await this.recordRepo.update({ id: record.id }, {
          sendStatus: 'failed',
          providerErrorCode: String(result.code ?? 'UNKNOWN').slice(0, 128),
          providerErrorMessage: sanitizeProviderErrorMessage(result.message, target),
        })
        throw new BizError('短信验证码发送失败，请稍后重试', 502)
      }
      await this.recordRepo.update({ id: record.id }, {
        sendStatus: 'sent',
        bizId: result.bizId?.trim().slice(0, 128) || null,
        providerErrorCode: null,
        providerErrorMessage: null,
        sentAt: new Date(),
      })
      return {
        provider: 'aliyun_dypns' as const,
        outId,
        bizId: result.bizId?.trim() || null,
        targetMasked: record.targetMasked,
        expireSeconds: DYPNS_CODE_EXPIRE_SECONDS,
      }
    } catch (error) {
      const latestRecord = await this.recordRepo.findOne({ where: { id: record.id }, select: { id: true, sendStatus: true } })
      if (latestRecord?.sendStatus !== 'failed') {
        await this.recordRepo.update({ id: record.id }, {
          sendStatus: 'failed',
          providerErrorCode: 'REQUEST_FAILED',
          providerErrorMessage: sanitizeProviderErrorMessage(error instanceof Error ? error.message : error, target),
        })
      }
      if (error instanceof BizError) {
        throw error
      }
      throw new BizError('短信验证码发送服务暂不可用，请稍后重试', 502)
    }
  }

  async verify(input: VerifyDypnsVerificationInput): Promise<void> {
    const target = input.target.trim()
    const record = await this.recordRepo.createQueryBuilder('record')
      .where('record.channel = :channel', { channel: 'mobile' })
      .andWhere('record.scene = :scene', { scene: input.scene })
      .andWhere('record.targetDigest = :targetDigest', { targetDigest: createTargetDigest(target) })
      .andWhere('record.sendStatus = :sendStatus', { sendStatus: 'sent' })
      .andWhere('record.expiresAt > :now', { now: new Date() })
      .orderBy('record.createdAt', 'DESC')
      .addOrderBy('record.id', 'DESC')
      .getOne()
    if (!record) {
      throw new BizError('验证码不存在或已过期，请重新获取', 400)
    }
    if (record.verificationStatus === 'passed') {
      throw new BizError('验证码已完成核验，请勿重复提交', 400)
    }

    try {
      const result = await this.dypnsApi.check({
        phoneNumber: target,
        countryCode: '86',
        outId: record.outId,
        verifyCode: input.code.trim(),
        schemeName: record.schemeName,
      })
      if (result.code === 'OK' && result.success === true && result.verifyResult === 'PASS') {
        const verifiedAt = new Date()
        const updateResult = await this.recordRepo.createQueryBuilder()
          .update(SmsVerificationRecord)
          .set({
          verificationStatus: 'passed',
          providerErrorCode: null,
          providerErrorMessage: null,
          verifiedAt,
          })
          .where('id = :id', { id: record.id })
          .andWhere('verification_status <> :passed', { passed: 'passed' })
          .andWhere('expires_at > :verifiedAt', { verifiedAt })
          .execute()
        if (Number(updateResult.affected ?? 0) !== 1) {
          throw new BizError('验证码已完成核验，请勿重复提交', 400)
        }
        return
      }
      const providerAccepted = result.code === 'OK' && result.success === true
      const providerCode = String(
        providerAccepted
          ? (result.verifyResult ?? 'UNKNOWN')
          : (result.code === 'OK' ? 'REQUEST_FAILED' : (result.code ?? 'REQUEST_FAILED')),
      ).slice(0, 128)
      const updateResult = await this.recordRepo.createQueryBuilder()
        .update(SmsVerificationRecord)
        .set({
        verificationStatus: 'failed',
        providerErrorCode: providerCode,
        providerErrorMessage: sanitizeProviderErrorMessage(result.message, target, input.code),
        })
        .where('id = :id', { id: record.id })
        .andWhere('verification_status <> :passed', { passed: 'passed' })
        .execute()
      if (Number(updateResult.affected ?? 0) !== 1) {
        throw new BizError('验证码已完成核验，请勿重复提交', 400)
      }
      if (providerAccepted) {
        throw new BizError('验证码校验未通过，请重新获取后再试', 400)
      }
      throw new BizError('验证码校验服务暂不可用，请稍后重试', 502)
    } catch (error) {
      if (error instanceof BizError) {
        throw error
      }
      const updateResult = await this.recordRepo.createQueryBuilder()
        .update(SmsVerificationRecord)
        .set({
        verificationStatus: 'failed',
        providerErrorCode: 'CHECK_FAILED',
        providerErrorMessage: sanitizeProviderErrorMessage(error instanceof Error ? error.message : error, target, input.code),
        })
        .where('id = :id', { id: record.id })
        .andWhere('verification_status <> :passed', { passed: 'passed' })
        .execute()
      if (Number(updateResult.affected ?? 0) !== 1) {
        throw new BizError('验证码已完成核验，请勿重复提交', 400)
      }
      throw new BizError('验证码校验服务暂不可用，请稍后重试', 502)
    }
  }

  async invalidateActiveForTarget(input: InvalidateDypnsVerificationInput): Promise<number> {
    const now = new Date()
    const result = await this.recordRepo.createQueryBuilder()
      .update(SmsVerificationRecord)
      .set({
        verificationStatus: 'failed',
        providerErrorCode: 'SUPERSEDED_BY_GENERIC',
        providerErrorMessage: null,
        expiresAt: now,
      })
      .where('channel = :channel', { channel: 'mobile' })
      .andWhere('scene = :scene', { scene: input.scene })
      .andWhere('target_digest = :targetDigest', { targetDigest: createTargetDigest(input.target.trim()) })
      .andWhere('send_status = :sendStatus', { sendStatus: 'sent' })
      .andWhere('expires_at > :now', { now })
      .andWhere('verification_status <> :passed', { passed: 'passed' })
      .execute()
    return Number(result.affected ?? 0)
  }

  async applyReceipt(input: SmsReceiptUpdateInput): Promise<'updated' | 'unknown' | 'mismatched' | 'deferred'> {
    const releaseMaintenanceLease = databaseMaintenanceModeService.registerInFlightWrite()
    if (!releaseMaintenanceLease) {
      return 'deferred'
    }
    try {
      const outId = input.outId.trim()
      const record = await this.recordRepo.findOne({ where: { outId }, select: { id: true, outId: true, bizId: true } })
      if (!record) {
        return 'unknown'
      }
      const reportedBizId = input.bizId?.trim() || null
      if (reportedBizId && record.bizId && reportedBizId !== record.bizId) {
        return 'mismatched'
      }
      const receiptDelivered = input.deliveryStatus === 'delivered' ? 1 : 0
      const receiptErrorCode = input.errorCode?.trim().slice(0, 128) || null
      const receiptErrorMessage = sanitizeProviderErrorMessage(input.errorMessage)
      await this.recordRepo.createQueryBuilder()
        .update(SmsVerificationRecord)
        .set({
          deliveryStatus: input.deliveryStatus,
          bizId: record.bizId ?? reportedBizId,
          // 成功回执是阿里云已受理并送达的权威证据，可恢复响应途中失败的发送记录。
          sendStatus: () => `CASE WHEN :receiptDelivered = 1 THEN 'sent' ELSE send_status END`,
          sentAt: () => 'CASE WHEN :receiptDelivered = 1 AND sent_at IS NULL THEN :receiptSentAt ELSE sent_at END',
          // 单字段兼容期内优先保留核验错误，避免迟到回执把 REJECT/UNKNOWN 等用户侧失败原因清空。
          providerErrorCode: () => 'CASE WHEN verification_status = :verificationFailed THEN provider_error_code ELSE :receiptErrorCode END',
          providerErrorMessage: () => 'CASE WHEN verification_status = :verificationFailed THEN provider_error_message ELSE :receiptErrorMessage END',
          reportedAt: input.reportedAt,
        })
        .where('id = :id', { id: record.id })
        .setParameters({
          receiptDelivered,
          receiptSentAt: input.sentAt,
          verificationFailed: 'failed',
          receiptErrorCode,
          receiptErrorMessage,
        })
        .execute()
      return 'updated'
    } finally {
      releaseMaintenanceLease()
    }
  }

  async listReceipts(input: {
    page: number
    pageSize: number
    scene?: VerificationScene
    deliveryStatus?: SmsVerificationDeliveryStatus
    startDate?: Date
    endDate?: Date
  }) {
    const query = this.recordRepo.createQueryBuilder('record')
    if (input.scene) query.andWhere('record.scene = :scene', { scene: input.scene })
    if (input.deliveryStatus) query.andWhere('record.deliveryStatus = :deliveryStatus', { deliveryStatus: input.deliveryStatus })
    if (input.startDate) query.andWhere('record.createdAt >= :startDate', { startDate: input.startDate })
    if (input.endDate) query.andWhere('record.createdAt <= :endDate', { endDate: input.endDate })
    const [rows, total] = await query
      .orderBy('record.createdAt', 'DESC')
      .skip((input.page - 1) * input.pageSize)
      .take(input.pageSize)
      .getManyAndCount()
    return {
      items: rows.map((record) => ({
        outId: record.outId,
        bizId: record.bizId,
        scene: record.scene,
        targetMasked: record.targetMasked,
        sendStatus: record.sendStatus,
        deliveryStatus: record.deliveryStatus,
        verificationStatus: record.verificationStatus,
        errorCode: record.providerErrorCode,
        sentAt: record.sentAt,
        reportedAt: record.reportedAt,
        verifiedAt: record.verifiedAt,
        createdAt: record.createdAt,
      })),
      total,
      page: input.page,
      pageSize: input.pageSize,
    }
  }

  async cleanupExpiredRecords(now = new Date()): Promise<number> {
    const releaseMaintenanceLease = databaseMaintenanceModeService.registerInFlightWrite()
    if (!releaseMaintenanceLease) {
      return 0
    }
    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    try {
      const result = await this.recordRepo.createQueryBuilder()
        .delete()
        .where('created_at < :cutoff', { cutoff })
        .andWhere(`(
          send_status = :sendFailed
          OR delivery_status IN (:...terminalDeliveryStatuses)
          OR verification_status IN (:...terminalVerificationStatuses)
          OR expires_at < :now
        )`, {
        sendFailed: 'failed',
        terminalDeliveryStatuses: ['delivered', 'failed'],
        terminalVerificationStatuses: ['passed', 'failed'],
        now,
        })
        .execute()
      return Number(result.affected ?? 0)
    } finally {
      releaseMaintenanceLease()
    }
  }
}

export const smsVerificationRecordService = new SmsVerificationRecordService()
