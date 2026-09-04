/**
 * 模块说明：阿里云 PNVS MNS 短信回执 Worker。
 * 文件职责：获取临时 STS、长轮询固定队列、白名单解析回执并按 outId 幂等回写。
 * 维护说明：格式错误消息只输出脱敏告警后删除；数据库或网络暂态失败绝不确认删除消息。
 */

import MNSClient from '@alicloud/mns'
import RPCClient from '@alicloud/pop-core'
import { env } from '../config/env.js'
import type { SmsVerificationDeliveryStatus } from '../entities/sms-verification-record.entity.js'
import { databaseMaintenanceModeService } from './database-maintenance-mode.service.js'
import { smsVerificationRecordService, type SmsVerificationRecordService } from './sms-verification-record.service.js'

const DYPNS_SMS_RECEIPT_MESSAGE_TYPE = 'DypnsSmsVerifyReport'
const DYPNS_SMS_RECEIPT_QUEUE_NAME = 'Alicom-Queue-1873897471328909-DypnsSmsVerifyReport'
const DYPNS_MNS_ACCOUNT_ID = '1943695596114318'
const DYPNS_MNS_ENDPOINT = 'https://1943695596114318.mns.cn-hangzhou.aliyuncs.com'
const DYBASEAPI_ENDPOINT = 'dybaseapi.aliyuncs.com'
const DYPNS_REGION = 'cn-hangzhou'
const STS_REFRESH_EARLY_MS = 2 * 60 * 1000
const MNS_POLL_WAIT_SECONDS = 5
const MNS_BATCH_SIZE = 10
const RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

type UnknownRecord = Record<string, unknown>

interface StsCredentials {
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  expiresAt: number
}

interface MnsMessage {
  receiptHandle: string
  body: unknown
}

interface MnsClientLike {
  batchReceiveMessage(queueName: string, numOfMessages: number, waitSeconds: number): Promise<unknown>
  deleteMessage(queueName: string, receiptHandle: string): Promise<unknown>
}

interface PopClientLike {
  request<T>(action: string, params: object, options?: object): Promise<T>
}

interface MnsSdkDependencies {
  createMnsClient(input: {
    accountId: string
    endpoint: string
    accessKeyId: string
    accessKeySecret: string
    securityToken: string
    refreshSTSToken: () => Promise<{ accessKeyId: string; accessKeySecret: string; securityToken: string }>
  }): MnsClientLike
  createPopClient(input: { accessKeyId: string; accessKeySecret: string }): PopClientLike
}

type ReceiptApplyOutcome = 'updated' | 'unknown' | 'malformed' | 'deferred'

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasForbiddenPrototypeKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenPrototypeKey(item))
  }
  if (!isRecord(value)) {
    return false
  }
  return Object.entries(value).some(([key, item]) => (
    key === '__proto__' || key === 'constructor' || key === 'prototype' || hasForbiddenPrototypeKey(item)
  ))
}

function asNonEmptyString(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= maxLength ? normalized : null
}

function asBoundedString(value: unknown, maxLength = 500): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value.trim() : null
}

function findFirstRecord(root: UnknownRecord, keys: string[]): UnknownRecord | null {
  for (const key of keys) {
    const value = root[key]
    if (isRecord(value)) return value
  }
  return null
}

function readFirstString(root: UnknownRecord, keys: string[], maxLength = 500): string | null {
  for (const key of keys) {
    const value = asNonEmptyString(root[key], maxLength)
    if (value) return value
  }
  return null
}

function parseAliyunDateTime(value: string): Date | null {
  const normalized = value.trim()
  const chinaDateTime = /^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2}):(\d{2})$/.exec(normalized)
  if (chinaDateTime) {
    const [, year, month, day, hour, minute, second] = chinaDateTime
    const localAsUtc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)))
    if (
      localAsUtc.getUTCFullYear() !== Number(year)
      || localAsUtc.getUTCMonth() !== Number(month) - 1
      || localAsUtc.getUTCDate() !== Number(day)
      || localAsUtc.getUTCHours() !== Number(hour)
      || localAsUtc.getUTCMinutes() !== Number(minute)
      || localAsUtc.getUTCSeconds() !== Number(second)
    ) {
      return null
    }
    return new Date(localAsUtc.getTime() - 8 * 60 * 60 * 1000)
  }
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? new Date(parsed) : null
}

function decodeReceiptBody(value: unknown): unknown {
  if (isRecord(value)) return value
  if (Buffer.isBuffer(value)) value = value.toString('utf8')
  if (typeof value !== 'string') throw new Error('回执消息体不是字符串')
  const source = value.trim()
  if (!source) throw new Error('回执消息体为空')
  const candidates = [source]
  try {
    const decoded = Buffer.from(source, 'base64').toString('utf8').trim()
    if (decoded) candidates.unshift(decoded)
  } catch {
    // 继续尝试原始 JSON，不能把原文写入日志。
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // 尝试下一种 SDK 消息体形态。
    }
  }
  throw new Error('回执消息体不是合法 JSON')
}

function normalizeMnsMessages(response: unknown): MnsMessage[] {
  const root = isRecord(response) ? response : {}
  const rawBody = root.body
  const body = isRecord(rawBody) || Array.isArray(rawBody) ? rawBody : root
  const messagesContainer = Array.isArray(body) ? body : (findFirstRecord(body, ['Messages', 'messages']) ?? body)
  const rawMessages = Array.isArray(messagesContainer)
    ? messagesContainer
    : messagesContainer.Message ?? messagesContainer.messages ?? messagesContainer.message
  const list = Array.isArray(rawMessages) ? rawMessages : rawMessages ? [rawMessages] : []
  return list.flatMap((item) => {
    if (!isRecord(item)) return []
    const receiptHandle = readFirstString(item, ['ReceiptHandle', 'receiptHandle'], 10_000)
    const messageBody = item.MessageBody ?? item.messageBody ?? item.body
    return receiptHandle && messageBody !== undefined ? [{ receiptHandle, body: messageBody }] : []
  })
}

function readStsResponse(response: unknown): StsCredentials {
  if (!isRecord(response) || hasForbiddenPrototypeKey(response)) {
    throw new Error('阿里云 MNS 临时凭证响应格式不正确')
  }
  const responseCode = readFirstString(response, ['Code', 'code'], 64)
  if (responseCode && responseCode !== 'OK') {
    throw new Error('阿里云 MNS 临时凭证请求未成功')
  }
  const firstLevel = findFirstRecord(response, ['MessageTokenDTO', 'messageTokenDTO', 'Token', 'token', 'Data', 'data', 'Model', 'model']) ?? response
  const data = findFirstRecord(firstLevel, ['Token', 'token', 'Data', 'data', 'Model', 'model']) ?? firstLevel
  const accessKeyId = readFirstString(data, ['AccessKeyId', 'AccessKeyID', 'accessKeyId'], 256)
  const accessKeySecret = readFirstString(data, ['AccessKeySecret', 'accessKeySecret'], 256)
  const securityToken = readFirstString(data, ['SecurityToken', 'securityToken'], 4096)
  if (!accessKeyId || !accessKeySecret || !securityToken) {
    throw new Error('阿里云 MNS 临时凭证响应缺少必要字段')
  }
  const expiresRaw = readFirstString(data, ['Expiration', 'expiration', 'ExpireTime', 'expireTime'], 128)
  const parsedExpiration = expiresRaw ? (parseAliyunDateTime(expiresRaw)?.getTime() ?? Number.NaN) : Number.NaN
  if (!Number.isFinite(parsedExpiration)) {
    throw new Error('阿里云 MNS 临时凭证响应缺少有效到期时间')
  }
  return {
    accessKeyId,
    accessKeySecret,
    securityToken,
    expiresAt: parsedExpiration,
  }
}

function parseOfficialFlatReceipt(root: UnknownRecord): {
  outId: string
  bizId: string
  deliveryStatus: SmsVerificationDeliveryStatus
  errorCode: string | null
  errorMessage: string | null
  reportedAt: Date
} | null {
  const allowedFields = new Set(['send_time', 'report_time', 'success', 'sms_size', 'err_msg', 'err_code', 'phone_number', 'biz_id', 'out_id'])
  const keys = Object.keys(root)
  if (keys.length !== allowedFields.size || keys.some((key) => !allowedFields.has(key))) {
    return null
  }
  const sendTime = asBoundedString(root.send_time, 64)
  const reportTime = asBoundedString(root.report_time, 64)
  const smsSize = asNonEmptyString(root.sms_size, 32)
  const errMessage = asBoundedString(root.err_msg, 500)
  const errCode = asBoundedString(root.err_code, 128)
  const phoneNumber = asBoundedString(root.phone_number, 32)
  const bizId = asNonEmptyString(root.biz_id, 128)
  const outId = asNonEmptyString(root.out_id, 64)
  const reportedAt = reportTime ? parseAliyunDateTime(reportTime) : null
  if (
    !sendTime || !parseAliyunDateTime(sendTime) || !reportedAt || !smsSize || !phoneNumber || !bizId || !outId
    || typeof root.success !== 'boolean' || errMessage === null || errCode === null
  ) {
    return null
  }
  return {
    outId,
    bizId,
    deliveryStatus: root.success ? 'delivered' : 'failed',
    errorCode: errCode || null,
    errorMessage: errMessage || null,
    reportedAt,
  }
}

function isMnsQueueEmptyError(error: unknown): boolean {
  const errorCode = isRecord(error) ? readFirstString(error, ['Code', 'code'], 128) : null
  const message = error instanceof Error ? error.message : String(error ?? '')
  const errorName = error instanceof Error ? error.name : ''
  return errorCode === 'MessageNotExist'
    || errorName === 'MNSMessageNotExistError'
    || /\bMessage\s*Not\s*Exist\b/i.test(message)
}

export class AliyunDypnsMnsWorkerService {
  private client: MnsClientLike | null = null
  private credentials: StsCredentials | null = null
  private loopPromise: Promise<void> | null = null
  private stopping = false
  private lastRetentionCleanupAt = 0
  private cleanupTimer: ReturnType<typeof globalThis.setInterval> | null = null

  constructor(
    private readonly recordService: Pick<SmsVerificationRecordService, 'applyReceipt' | 'cleanupExpiredRecords'> = smsVerificationRecordService,
    private readonly sdk: MnsSdkDependencies = {
      createMnsClient: (input) => new MNSClient(input.accountId, {
        accessKeyId: input.accessKeyId,
        accessKeySecret: input.accessKeySecret,
        securityToken: input.securityToken,
        endpoint: input.endpoint,
        refreshSTSToken: input.refreshSTSToken,
        refreshSTSTokenInterval: 60_000,
      }),
      createPopClient: (input) => new RPCClient({
        endpoint: DYBASEAPI_ENDPOINT,
        apiVersion: '2017-05-25',
        accessKeyId: input.accessKeyId,
        accessKeySecret: input.accessKeySecret,
      }),
    },
  ) {}

  getStatus() {
    const credentialsConfigured = Boolean(env.ALIBABA_CLOUD_ACCESS_KEY_ID && env.ALIBABA_CLOUD_ACCESS_KEY_SECRET)
    const enabled = env.ALIYUN_DYPNS_MNS_ENABLED
    return {
      enabled,
      configured: !enabled || credentialsConfigured,
      running: this.loopPromise !== null,
      error: enabled && !credentialsConfigured ? '已启用阿里云 MNS 回执，但阿里云访问凭证未配置' : null,
    }
  }

  private assertMnsConfiguration(): void {
    const status = this.getStatus()
    if (status.enabled && !status.configured) {
      throw new Error(status.error ?? '阿里云 MNS 回执配置不完整')
    }
  }

  private async requestStsCredentials(): Promise<StsCredentials> {
    if (!env.ALIBABA_CLOUD_ACCESS_KEY_ID || !env.ALIBABA_CLOUD_ACCESS_KEY_SECRET) {
      throw new Error('阿里云访问凭证未配置，无法获取 MNS 临时凭证')
    }
    const client = this.sdk.createPopClient({
      accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    })
    const response = await client.request<unknown>('QueryTokenForMnsQueue', {
      MessageType: DYPNS_SMS_RECEIPT_MESSAGE_TYPE,
      QueueName: DYPNS_SMS_RECEIPT_QUEUE_NAME,
      RegionId: DYPNS_REGION,
    }, { method: 'POST' })
    return readStsResponse(response)
  }

  private async getCredentials(): Promise<StsCredentials> {
    const current = this.credentials
    if (current && current.expiresAt > Date.now() + STS_REFRESH_EARLY_MS) {
      return current
    }
    const next = await this.requestStsCredentials()
    this.credentials = next
    this.client = this.sdk.createMnsClient({
      accountId: DYPNS_MNS_ACCOUNT_ID,
      endpoint: DYPNS_MNS_ENDPOINT,
      accessKeyId: next.accessKeyId,
      accessKeySecret: next.accessKeySecret,
      securityToken: next.securityToken,
      // SDK 在请求前会调用该回调；Worker 另外在每轮提前两分钟自行刷新。
      refreshSTSToken: async () => this.getCredentials(),
    })
    return next
  }

  private async getClient(): Promise<MnsClientLike> {
    await this.getCredentials()
    if (!this.client) {
      throw new Error('阿里云 MNS 客户端初始化失败')
    }
    return this.client
  }

  async applyReceiptMessage(body: unknown): Promise<ReceiptApplyOutcome> {
    let parsed: unknown
    try {
      parsed = decodeReceiptBody(body)
    } catch {
      return 'malformed'
    }
    if (!isRecord(parsed) || hasForbiddenPrototypeKey(parsed)) {
      return 'malformed'
    }
    const officialReceipt = parseOfficialFlatReceipt(parsed)
    if (!officialReceipt) {
      return 'malformed'
    }
    const result = await this.recordService.applyReceipt(officialReceipt)
    return result === 'unknown' ? 'unknown' : result === 'deferred' ? 'deferred' : result === 'mismatched' ? 'malformed' : 'updated'
  }

  async runOnce(): Promise<number> {
    if (!env.ALIYUN_DYPNS_MNS_ENABLED || databaseMaintenanceModeService.isReadOnly()) {
      return 0
    }
    this.assertMnsConfiguration()
    if (Date.now() - this.lastRetentionCleanupAt >= RETENTION_CLEANUP_INTERVAL_MS) {
      await this.recordService.cleanupExpiredRecords()
      this.lastRetentionCleanupAt = Date.now()
    }
    const client = await this.getClient()
    let response: unknown
    try {
      response = await client.batchReceiveMessage(DYPNS_SMS_RECEIPT_QUEUE_NAME, MNS_BATCH_SIZE, MNS_POLL_WAIT_SECONDS)
    } catch (error) {
      if (isMnsQueueEmptyError(error)) {
        return 0
      }
      throw error
    }
    const messages = normalizeMnsMessages(response)
    for (const message of messages) {
      const outcome = await this.applyReceiptMessage(message.body)
      if (outcome === 'deferred') {
        continue
      }
      if (outcome === 'malformed') {
        console.warn('[aliyun-dypns-mns] 已丢弃格式错误的短信回执消息')
      } else if (outcome === 'unknown') {
        console.warn('[aliyun-dypns-mns] 收到未知 outId 的短信回执消息，已确认删除')
      }
      // updated（含重复回执）、unknown 与 malformed 都是确定性结果，可以确认删除。
      await client.deleteMessage(DYPNS_SMS_RECEIPT_QUEUE_NAME, message.receiptHandle)
    }
    return messages.length
  }

  private startRetentionCleanupLoop(): void {
    if (this.cleanupTimer !== null) return
    const cleanup = () => {
      if (databaseMaintenanceModeService.isReadOnly()) return
      void this.recordService.cleanupExpiredRecords().catch((error) => {
        void error
        console.error('[aliyun-dypns-mns] 短信回执历史清理失败，将在下一周期重试')
      })
    }
    this.cleanupTimer = globalThis.setInterval(cleanup, RETENTION_CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref?.()
    queueMicrotask(cleanup)
  }

  start(): void {
    this.startRetentionCleanupLoop()
    if (!env.ALIYUN_DYPNS_MNS_ENABLED || this.loopPromise) {
      return
    }
    this.assertMnsConfiguration()
    this.stopping = false
    this.loopPromise = this.runLoop().finally(() => {
      this.loopPromise = null
    })
  }

  private async runLoop(): Promise<void> {
    let retryDelayMs = 1_000
    while (!this.stopping) {
      try {
        if (databaseMaintenanceModeService.isReadOnly()) {
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          continue
        }
        await this.runOnce()
        retryDelayMs = 1_000
      } catch (error) {
        void error
        console.error('[aliyun-dypns-mns] 回执处理周期失败，将退避重试')
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        retryDelayMs = Math.min(retryDelayMs * 2, 60_000)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.cleanupTimer !== null) {
      globalThis.clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    if (this.loopPromise) {
      await this.loopPromise
    }
  }
}

export const aliyunDypnsMnsWorkerService = new AliyunDypnsMnsWorkerService()
