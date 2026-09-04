/**
 * 模块说明：阿里云 PNVS 服务端动态短信验证码适配器。
 * 文件职责：封装 SendSmsVerifyCode / CheckSmsVerifyCode，统一固定协议参数与安全错误口径。
 * 维护说明：验证码由阿里云生成，服务端不得接收、记录或返回验证码明文。
 */

import { createRequire } from 'node:module'
import { CheckSmsVerifyCodeRequest, SendSmsVerifyCodeRequest } from '@alicloud/dypnsapi20170525/dist/models/model.js'
import { env } from '../config/env.js'
import { BizError } from '../utils/errors.js'
import type { AliyunDypnsTemplateConfig, VerificationScene } from './system-config.service.js'

const ALIYUN_DYPNS_REGION = 'cn-hangzhou'
const ALIYUN_DYPNS_ENDPOINT = 'dypnsapi.aliyuncs.com'
export const DYPNS_CODE_EXPIRE_SECONDS = 300
const require = createRequire(import.meta.url)

type DypnsRuntimeOptions = {
  connectTimeout: number
  readTimeout: number
}

type DypnsSdkClient = {
  sendSmsVerifyCodeWithOptions(request: SendSmsVerifyCodeRequest, runtime: DypnsRuntimeOptions): Promise<{ body?: { code?: string; success?: boolean; message?: string; model?: { bizId?: string } } }>
  checkSmsVerifyCodeWithOptions(request: CheckSmsVerifyCodeRequest, runtime: DypnsRuntimeOptions): Promise<{ body?: { code?: string; success?: boolean; message?: string; model?: { verifyResult?: string } } }>
}

type DypnsSdkClientConstructor = new (config: Record<string, string>) => DypnsSdkClient

function loadDypnsClientConstructor(): DypnsSdkClientConstructor {
  const loaded = require('@alicloud/dypnsapi20170525') as { default?: DypnsSdkClientConstructor } | DypnsSdkClientConstructor
  const constructor = typeof loaded === 'function' ? loaded : loaded.default
  if (!constructor) {
    throw new Error('阿里云 PNVS SDK 未正确加载')
  }
  return constructor
}

export interface AliyunDypnsProviderConfig {
  signName: string
  schemeName: string
  templates: AliyunDypnsTemplateConfig
}

export interface SendAliyunDypnsSmsInput {
  phoneNumber: string
  countryCode: '86'
  outId: string
  scene: VerificationScene
  config: AliyunDypnsProviderConfig
}

export interface CheckAliyunDypnsSmsInput {
  phoneNumber: string
  countryCode: '86'
  outId: string
  verifyCode: string
  schemeName: string
}

export interface AliyunDypnsSmsApi {
  send(input: SendAliyunDypnsSmsInput): Promise<{ code?: string; success?: boolean; bizId?: string; message?: string }>
  check(input: CheckAliyunDypnsSmsInput): Promise<{ code?: string; success?: boolean; verifyResult?: string; message?: string }>
}

function resolveTemplateCode(scene: VerificationScene, templates: AliyunDypnsTemplateConfig): string {
  const templateCodeByScene: Record<VerificationScene, string> = {
    register: templates.register,
    forgot_password: templates.forgotPassword,
    profile_update: templates.profileUpdate,
    test: templates.test,
  }
  const templateCode = templateCodeByScene[scene]?.trim() || ''
  if (!templateCode) {
    throw new BizError('当前场景未配置阿里云 PNVS 短信模板码', 500)
  }
  return templateCode
}

function getSafeProviderMessage(message: unknown): string {
  return String(message ?? '')
    .replace(/\b\d{7,15}\b/g, '[已脱敏手机号]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 300)
}

function createDypnsRuntimeOptions(): DypnsRuntimeOptions {
  return {
    connectTimeout: env.VERIFICATION_CODE_REQUEST_TIMEOUT_MS,
    readTimeout: env.VERIFICATION_CODE_REQUEST_TIMEOUT_MS,
  }
}

export class AliyunDypnsSmsProvider implements AliyunDypnsSmsApi {
  constructor(
    private readonly createClient: () => DypnsSdkClient = () => {
      if (!env.ALIBABA_CLOUD_ACCESS_KEY_ID || !env.ALIBABA_CLOUD_ACCESS_KEY_SECRET) {
        throw new BizError('阿里云 PNVS 凭证未配置，无法发送或核验短信验证码', 500)
      }
      return new (loadDypnsClientConstructor())({
        accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
        accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
        regionId: ALIYUN_DYPNS_REGION,
        endpoint: ALIYUN_DYPNS_ENDPOINT,
      })
    },
  ) {}

  async send(input: SendAliyunDypnsSmsInput) {
    const signName = input.config.signName.trim()
    if (!signName) {
      throw new BizError('阿里云 PNVS 短信签名未配置，无法发送验证码', 500)
    }
    const response = await this.createClient().sendSmsVerifyCodeWithOptions(new SendSmsVerifyCodeRequest({
      phoneNumber: input.phoneNumber,
      countryCode: input.countryCode,
      outId: input.outId,
      signName,
      schemeName: input.config.schemeName.trim() || undefined,
      templateCode: resolveTemplateCode(input.scene, input.config.templates),
      templateParam: '{"code":"##code##","min":"5"}',
      codeLength: 6,
      validTime: DYPNS_CODE_EXPIRE_SECONDS,
      interval: 60,
      returnVerifyCode: false,
      duplicatePolicy: 1,
      codeType: 1,
      autoRetry: 1,
    }), createDypnsRuntimeOptions())
    const body = response.body
    return {
      code: body?.code,
      success: body?.success,
      bizId: body?.model?.bizId,
      message: getSafeProviderMessage(body?.message),
    }
  }

  async check(input: CheckAliyunDypnsSmsInput) {
    const response = await this.createClient().checkSmsVerifyCodeWithOptions(new CheckSmsVerifyCodeRequest({
      phoneNumber: input.phoneNumber,
      countryCode: input.countryCode,
      outId: input.outId,
      schemeName: input.schemeName.trim() || undefined,
      verifyCode: input.verifyCode,
    }), createDypnsRuntimeOptions())
    const body = response.body
    return {
      code: body?.code,
      success: body?.success,
      verifyResult: body?.model?.verifyResult,
      message: getSafeProviderMessage(body?.message),
    }
  }
}
