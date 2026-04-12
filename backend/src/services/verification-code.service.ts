/**
 * 模块说明：backend/src/services/verification-code.service.ts
 * 文件职责：统一处理手机/邮箱验证码的发送与校验。
 * 设计说明：
 * - 验证码发送平台不写死在代码里，而是从系统配置读取 API 地址、请求头和请求体模板；
 * - 验证码状态当前使用内存 Map 保存，适合单机部署；
 * - 若后续升级多实例或需要更强可用性，应迁移到 Redis。
 */

import { randomInt } from 'node:crypto'
import type { RequestMeta } from '../utils/request-meta.js'
import { BizError } from '../utils/errors.js'
import {
  systemConfigService,
  type VerificationChannelType,
  type VerificationProviderConfigRecord,
} from './system-config.service.js'

type VerificationScene = 'register' | 'forgot_password'

interface VerificationCodeTicket {
  channel: VerificationChannelType
  target: string
  scene: VerificationScene
  code: string
  expiresAt: number
}

const CODE_EXPIRE_MS = 5 * 60 * 1000
const verificationTicketStore = new Map<string, VerificationCodeTicket>()

const buildTicketKey = (channel: VerificationChannelType, target: string, scene: VerificationScene) => `${channel}:${scene}:${target}`

const normalizeTarget = (channel: VerificationChannelType, target: string) =>
  channel === 'email' ? target.trim().toLowerCase() : target.trim()

export class VerificationCodeService {
  private buildCode() {
    return String(randomInt(100000, 1000000))
  }

  private renderTemplate(template: string, context: Record<string, string>) {
    return Object.entries(context).reduce((result, [key, value]) => {
      const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g')
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

    const renderedHeadersText = this.renderTemplate(config.headersTemplate, context) || '{}'
    const renderedBodyText = this.renderTemplate(config.bodyTemplate, context)

    let headers: Record<string, string> = {}
    try {
      headers = JSON.parse(renderedHeadersText)
    } catch {
      throw new BizError('验证码平台请求头模板不是合法 JSON，请联系管理员修正', 500)
    }

    const requestInit: RequestInit = {
      method: config.httpMethod,
      headers,
    }

    if (config.httpMethod !== 'GET') {
      requestInit.body = renderedBodyText
    }

    const response = await fetch(config.apiUrl, requestInit)
    const responseText = await response.text()
    if (!response.ok) {
      throw new BizError(`验证码平台请求失败（HTTP ${response.status}）`, 502)
    }
    if (config.successMatch.trim() && !responseText.includes(config.successMatch.trim())) {
      throw new BizError('验证码平台返回结果未命中成功标识，请检查平台配置', 502)
    }
  }

  async sendCode(input: {
    channel: VerificationChannelType
    target: string
    scene: VerificationScene
    requestMeta?: RequestMeta
  }) {
    const normalizedTarget = normalizeTarget(input.channel, input.target)
    const configs = await systemConfigService.getVerificationProviderConfigs()
    const provider = configs[input.channel]
    const code = this.buildCode()
    await this.sendByProvider(provider, {
      target: normalizedTarget,
      code,
      scene: input.scene,
      ip: input.requestMeta?.ipAddress?.trim() || '',
    })
    verificationTicketStore.set(buildTicketKey(input.channel, normalizedTarget, input.scene), {
      channel: input.channel,
      target: normalizedTarget,
      scene: input.scene,
      code,
      expiresAt: Date.now() + CODE_EXPIRE_MS,
    })
    return {
      expireSeconds: Math.floor(CODE_EXPIRE_MS / 1000),
    }
  }

  verifyCode(input: {
    channel: VerificationChannelType
    target: string
    scene: VerificationScene
    code: string
  }) {
    const normalizedTarget = normalizeTarget(input.channel, input.target)
    const key = buildTicketKey(input.channel, normalizedTarget, input.scene)
    const ticket = verificationTicketStore.get(key)
    if (!ticket) {
      throw new BizError('验证码不存在或已过期，请重新获取', 400)
    }
    if (ticket.expiresAt <= Date.now()) {
      verificationTicketStore.delete(key)
      throw new BizError('验证码已过期，请重新获取', 400)
    }
    if (ticket.code !== input.code.trim()) {
      throw new BizError('验证码错误，请重新输入', 400)
    }
    verificationTicketStore.delete(key)
  }
}

export const verificationCodeService = new VerificationCodeService()
