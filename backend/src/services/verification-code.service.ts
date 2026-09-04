/**
 * 模块说明：backend/src/services/verification-code.service.ts
 * 文件职责：统一处理手机/邮箱验证码的发送与校验。
 * 设计说明：
 * - 验证码发送平台不写死在代码里，而是从系统配置读取 API 地址、请求头和请求体模板；
 * - 验证码状态当前使用内存 Map 保存，适合单机部署；
 * - 若后续升级多实例或需要更强可用性，应迁移到 Redis。
 */

import { randomInt } from 'node:crypto'
import { env } from '../config/env.js'
import type { AuthUserContext } from '../types/auth.js'
import type { RequestMeta } from '../utils/request-meta.js'
import { BizError } from '../utils/errors.js'
import { normalizeClientVerificationTarget } from '../utils/client-auth-account.js'
import { detectUnsafeHost, formatUnsafeHostReason } from '../utils/safe-network.js'
import {
  systemConfigService,
  type VerificationProviderConfigInput,
  type VerificationChannelType,
  type VerificationProviderConfigRecord,
} from './system-config.service.js'
import { auditService } from './audit.service.js'
import { EphemeralTicketStore } from '../utils/ephemeral-ticket-store.js'
import { safeHttpRequest } from '../utils/safe-http-request.js'
import { maskMobileVerificationTarget, smsVerificationRecordService, type SmsVerificationRecordService } from './sms-verification-record.service.js'
import type { AliyunDypnsProviderConfig } from './aliyun-dypns-sms.service.js'
import type { VerificationScene } from './system-config.service.js'

interface VerificationCodeTicket {
  channel: VerificationChannelType
  target: string
  scene: VerificationScene
  code: string
  expiresAt: number
}

const CODE_EXPIRE_MS = 5 * 60 * 1000
const verificationTicketStore = new EphemeralTicketStore<VerificationCodeTicket>({
  maxSize: 6000,
  resolveExpiresAt: (ticket) => ticket.expiresAt,
})

const buildTicketKey = (channel: VerificationChannelType, target: string, scene: VerificationScene) => `${channel}:${scene}:${target}`

export class VerificationCodeService {
  constructor(
    private readonly httpRequest: typeof safeHttpRequest = safeHttpRequest,
    private readonly smsRecordService: Pick<SmsVerificationRecordService, 'send' | 'verify' | 'invalidateActiveForTarget'> = smsVerificationRecordService,
  ) {}

  /**
   * 提炼测试发送审计摘要：
   * - 审计日志仅保留通道、地址和模板是否配置等治理信息；
   * - 不记录完整请求头/请求体模板，避免把敏感第三方凭证写入审计表。
   */
  private buildProviderAuditSummary(config: VerificationProviderConfigRecord) {
    let endpoint: { protocol: string; hostname: string; port: string; configured: boolean }
    try {
      const url = new URL(config.apiUrl)
      endpoint = { protocol: url.protocol, hostname: url.hostname, port: url.port, configured: true }
    } catch {
      endpoint = { protocol: '', hostname: '', port: '', configured: Boolean(config.apiUrl.trim()) }
    }
    return {
      enabled: config.enabled,
      ready: config.ready,
      httpMethod: config.httpMethod,
      endpoint,
      hasHeadersTemplate: Boolean(config.headersTemplate.trim()),
      hasBodyTemplate: Boolean(config.bodyTemplate.trim()),
      hasSuccessMatch: Boolean(config.successMatch.trim()),
      providerType: config.providerType,
      aliyun: config.providerType === 'aliyun_dypns'
        ? {
            signNameConfigured: Boolean(config.aliyunSignName.trim()),
            schemeNameConfigured: Boolean(config.aliyunSchemeName.trim()),
            templateConfigured: Object.fromEntries(
              Object.entries(config.aliyunTemplates).map(([scene, templateCode]) => [scene, Boolean(templateCode.trim())]),
            ),
            credentialsConfigured: config.credentialsConfigured,
            ticketHmacConfigured: config.ticketHmacConfigured,
            mnsEnabled: config.mnsEnabled,
            mnsConfigured: config.mnsConfigured,
            statusError: config.statusError,
          }
        : undefined,
    }
  }

  private buildCode() {
    return String(randomInt(100000, 1000000))
  }

  private normalizeProviderConfig(config: VerificationProviderConfigRecord): VerificationProviderConfigRecord {
    return {
      enabled: Boolean(config.enabled),
      ready: Boolean(config.ready),
      httpMethod: config.httpMethod === 'GET' ? 'GET' : 'POST',
      apiUrl: config.apiUrl.trim(),
      headersTemplate: config.headersTemplate.trim(),
      bodyTemplate: config.bodyTemplate.trim(),
      successMatch: config.successMatch.trim(),
      updatedAt: new Date(),
      providerType: config.providerType,
      aliyunSignName: config.aliyunSignName.trim(),
      aliyunSchemeName: config.aliyunSchemeName.trim(),
      aliyunTemplates: config.aliyunTemplates,
      credentialsConfigured: config.credentialsConfigured,
      ticketHmacConfigured: config.ticketHmacConfigured,
      mnsEnabled: config.mnsEnabled,
      mnsConfigured: config.mnsConfigured,
      statusError: config.statusError,
    }
  }

  private renderTemplate(template: string, context: Record<string, string>) {
    return Object.entries(context).reduce((result, [key, value]) => {
      const pattern = new RegExp(String.raw`\{\{\s*${key}\s*\}\}`, 'g')
      return result.replace(pattern, value)
    }, template)
  }

  private async sendByProvider(config: VerificationProviderConfigRecord, context: Record<string, string>) {
    if (!config.enabled) {
      throw new BizError('当前验证码通道未启用，请联系管理员配置', 400)
    }
    if (!config.apiUrl.trim()) {
      throw new BizError('验证码平台 API 未配置，请联系管理员补齐', 500)
    }

    /**
     * 运行期兜底：
     * - 旧数据库里可能已经存在历史危险配置；
     * - 即使绕过保存接口，真正出站前仍再次拦截 localhost、裸 IP、私网与链路本地地址；
     * - 这样可以把“存量脏数据”也纳入防线，避免直接向内网发起请求。
     */
    let providerUrl: URL
    try {
      providerUrl = new URL(config.apiUrl)
    } catch {
      throw new BizError('验证码平台 API 地址格式不正确，请联系管理员修正', 500)
    }
    const unsafeReason = detectUnsafeHost(providerUrl.hostname)
    if (unsafeReason) {
      throw new BizError(`验证码平台 API 地址命中受限主机：${formatUnsafeHostReason(unsafeReason)}`, 500)
    }

    const renderedHeadersText = this.renderTemplate(config.headersTemplate, context) || '{}'
    const renderedBodyText = this.renderTemplate(config.bodyTemplate, context)

    let headers: Record<string, string> = {}
    try {
      headers = JSON.parse(renderedHeadersText)
    } catch {
      throw new BizError('验证码平台请求头模板不是合法 JSON，请联系管理员修正', 500)
    }

    let response: Awaited<ReturnType<typeof safeHttpRequest>>
    let responseText: string
    try {
      response = await this.httpRequest(providerUrl, {
        method: config.httpMethod,
        headers,
        body: config.httpMethod === 'GET' ? undefined : renderedBodyText,
        timeoutMs: env.VERIFICATION_CODE_REQUEST_TIMEOUT_MS,
      })
      responseText = response.body.toString('utf8')
    } catch (error) {
      if (error instanceof Error && /超时/.test(error.message)) {
        throw new BizError(`验证码平台请求超时（>${env.VERIFICATION_CODE_REQUEST_TIMEOUT_MS}ms）`, 504)
      }
      throw new BizError('验证码平台请求失败，请稍后重试', 502)
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new BizError(`验证码平台请求失败（HTTP ${response.statusCode}）`, 502)
    }
    if (config.successMatch.trim() && !responseText.includes(config.successMatch.trim())) {
      throw new BizError('验证码平台返回结果未命中成功标识，请检查平台配置', 502)
    }
  }

  private toAliyunDypnsConfig(config: VerificationProviderConfigRecord): AliyunDypnsProviderConfig {
    return {
      signName: config.aliyunSignName,
      schemeName: config.aliyunSchemeName,
      templates: config.aliyunTemplates,
    }
  }

  async sendCode(input: {
    channel: VerificationChannelType
    target: string
    scene: VerificationScene
    requestMeta?: RequestMeta
  }) {
    const normalizedTarget = normalizeClientVerificationTarget(input.channel, input.target)
    const configs = await systemConfigService.getVerificationProviderConfigs({ maskSensitiveValues: false })
    const provider = configs[input.channel]
    if (!provider.ready) {
      throw new BizError(provider.statusError ?? '当前验证码通道未就绪，请联系管理员配置', 400)
    }
    if (input.channel === 'mobile' && provider.providerType === 'aliyun_dypns') {
      const result = await this.smsRecordService.send({
        target: normalizedTarget,
        scene: input.scene,
        config: this.toAliyunDypnsConfig(provider),
      })
      verificationTicketStore.delete(buildTicketKey(input.channel, normalizedTarget, input.scene))
      return result
    }
    const code = this.buildCode()
    await this.sendByProvider(provider, {
      target: normalizedTarget,
      code,
      scene: input.scene,
      ip: input.requestMeta?.ipAddress?.trim() || '',
    })
    if (input.channel === 'mobile' && (env.VERIFICATION_TICKET_HMAC_SECRET?.trim().length ?? 0) >= 32) {
      // 通用短信发送成功后必须持久化作废同手机号、同场景的旧 PNVS 记录，避免本地票据消费后回退核验旧动态码。
      await this.smsRecordService.invalidateActiveForTarget({
        target: normalizedTarget,
        scene: input.scene,
      })
    }
    verificationTicketStore.set(buildTicketKey(input.channel, normalizedTarget, input.scene), {
      channel: input.channel,
      target: normalizedTarget,
      scene: input.scene,
      code,
      expiresAt: Date.now() + CODE_EXPIRE_MS,
    })
    return {
      provider: 'generic_http' as const,
      expireSeconds: Math.floor(CODE_EXPIRE_MS / 1000),
    }
  }

  async sendTest(input: {
    channel: VerificationChannelType
    target: string
    config: VerificationProviderConfigInput
    actor?: Pick<AuthUserContext, 'userId' | 'username' | 'displayName'> | null
    requestMeta?: RequestMeta
  }) {
    const normalizedTarget = normalizeClientVerificationTarget(input.channel, input.target)
    const resolvedConfig = await systemConfigService.resolveVerificationProviderConfigInput(input.channel, input.config)
    const normalizedConfig = this.normalizeProviderConfig(resolvedConfig)
    try {
      if (!normalizedConfig.ready) {
        throw new BizError(normalizedConfig.statusError ?? '当前验证码通道未就绪，请联系管理员配置', 400)
      }
      if (input.channel === 'mobile' && normalizedConfig.providerType === 'aliyun_dypns') {
        const data = await this.smsRecordService.send({
          target: normalizedTarget,
          scene: 'test',
          config: this.toAliyunDypnsConfig(normalizedConfig),
        })
        await auditService.safeRecord({
          actionType: 'system_config.test_verification_provider',
          actionLabel: '测试验证码平台发送',
          targetType: 'verification_provider',
          targetCode: input.channel,
          actor: input.actor,
          requestMeta: input.requestMeta,
          detail: {
            channel: input.channel,
            target: maskMobileVerificationTarget(normalizedTarget),
            provider: this.buildProviderAuditSummary(normalizedConfig),
            outId: data.outId,
            bizId: data.bizId,
          },
        })
        return data
      }
      const code = this.buildCode()
      await this.sendByProvider(normalizedConfig, {
        target: normalizedTarget,
        code,
        scene: 'test',
        ip: input.requestMeta?.ipAddress?.trim() || '',
      })
      await auditService.safeRecord({
        actionType: 'system_config.test_verification_provider',
        actionLabel: '测试验证码平台发送',
        targetType: 'verification_provider',
        targetCode: input.channel,
        actor: input.actor,
        requestMeta: input.requestMeta,
        detail: {
          channel: input.channel,
          target: input.channel === 'mobile' ? maskMobileVerificationTarget(normalizedTarget) : '[已脱敏邮箱]',
          provider: this.buildProviderAuditSummary(normalizedConfig),
        },
      })
      return {
        channel: input.channel,
        target: input.channel === 'mobile' ? maskMobileVerificationTarget(normalizedTarget) : '[已脱敏邮箱]',
        code,
      }
    } catch (error) {
      await auditService.safeRecord({
        actionType: 'system_config.test_verification_provider',
        actionLabel: '测试验证码平台发送',
        targetType: 'verification_provider',
        targetCode: input.channel,
        actor: input.actor,
        requestMeta: input.requestMeta,
        resultStatus: 'failed',
        detail: {
          channel: input.channel,
          target: input.channel === 'mobile' ? maskMobileVerificationTarget(normalizedTarget) : '[已脱敏邮箱]',
          provider: this.buildProviderAuditSummary(normalizedConfig),
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  async verifyCode(input: {
    channel: VerificationChannelType
    target: string
    scene: VerificationScene
    code: string
  }): Promise<void> {
    const normalizedTarget = normalizeClientVerificationTarget(input.channel, input.target)
    const key = buildTicketKey(input.channel, normalizedTarget, input.scene)
    const ticket = verificationTicketStore.get(key)
    if (ticket) {
      if (ticket.code !== input.code.trim()) {
        throw new BizError('验证码错误，请重新输入', 400)
      }
      verificationTicketStore.delete(key)
      return
    }
    const canLookupDypnsRecord = (env.VERIFICATION_TICKET_HMAC_SECRET?.trim().length ?? 0) >= 32
    if (input.channel === 'mobile' && canLookupDypnsRecord) {
      await this.smsRecordService.verify({
        target: normalizedTarget,
        scene: input.scene,
        code: input.code,
      })
      return
    }
    throw new BizError('验证码不存在或已过期，请重新获取', 400)
  }
}

export const verificationCodeService = new VerificationCodeService()
