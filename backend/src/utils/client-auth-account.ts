/**
 * 模块说明：backend/src/utils/client-auth-account.ts
 * 文件职责：统一客户端认证相关的账号、用户名、验证码目标归一化规则，确保路由频控、服务查询与验证码校验使用同一口径。
 * 维护说明：
 * - 邮箱统一转小写，避免因为大小写差异导致风控分桶不一致或重复注册；
 * - 手机号保持数字原样，仅裁剪首尾空白；
 * - 用户名保留展示大小写，但风控与唯一性校验统一按小写键比较。
 */

import { BizError } from './errors.js'

export type ClientAccountChannel = 'mobile' | 'email' | 'username'

export interface NormalizedClientAccount {
  channel: ClientAccountChannel
  rawValue: string
  normalizedValue: string
}

interface NormalizeClientAccountOptions {
  allowUsername?: boolean
  fieldLabel?: string
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MOBILE_PATTERN = /^1\d{10}$/

/**
 * 统一归一化客户端登录/注册账号：
 * - 邮箱按 RFC 常见场景统一转小写；
 * - 手机号仅允许 11 位大陆手机号；
 * - 用户名用于登录时允许保留原展示值，但风控和查重统一按小写键处理。
 */
export function normalizeClientAccount(
  account: string,
  options: NormalizeClientAccountOptions = {},
): NormalizedClientAccount {
  const fieldLabel = options.fieldLabel ?? '账号'
  const trimmedAccount = account.trim()

  if (!trimmedAccount) {
    throw new BizError(`${fieldLabel}不能为空`, 400)
  }

  if (trimmedAccount.includes('@')) {
    const normalizedEmail = trimmedAccount.toLowerCase()
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      throw new BizError('邮箱格式不正确', 400)
    }
    return {
      channel: 'email',
      rawValue: trimmedAccount,
      normalizedValue: normalizedEmail,
    }
  }

  if (MOBILE_PATTERN.test(trimmedAccount)) {
    return {
      channel: 'mobile',
      rawValue: trimmedAccount,
      normalizedValue: trimmedAccount,
    }
  }

  if (!options.allowUsername) {
    throw new BizError(`${fieldLabel}格式不正确，请输入手机号或邮箱`, 400)
  }

  return {
    channel: 'username',
    rawValue: trimmedAccount,
    normalizedValue: trimmedAccount.toLowerCase(),
  }
}

/**
 * 统一归一化客户端“用户名”字段：
 * - 保存到数据库时保留用户输入的展示大小写；
 * - 唯一性校验、风控键和大小写绕过防护统一使用 normalizedValue。
 */
export function normalizeClientUsername(username: string): {
  value: string
  normalizedValue: string
} {
  const trimmedUsername = username.trim()
  if (!trimmedUsername) {
    throw new BizError('用户名不能为空', 400)
  }
  return {
    value: trimmedUsername,
    normalizedValue: trimmedUsername.toLowerCase(),
  }
}

/**
 * 统一归一化验证码发送目标：
 * - 手机验证码目标保持原数字；
 * - 邮箱验证码目标统一转小写，保证发送、存储、校验三处命中同一 key。
 */
export function normalizeClientVerificationTarget(channel: 'mobile' | 'email', target: string): string {
  const normalizedAccount = normalizeClientAccount(target, {
    allowUsername: false,
    fieldLabel: channel === 'email' ? '邮箱' : '手机号',
  })
  if (normalizedAccount.channel !== channel) {
    throw new BizError(channel === 'email' ? '邮箱格式不正确' : '手机号格式不正确', 400)
  }
  return normalizedAccount.normalizedValue
}
