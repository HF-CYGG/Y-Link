/**
 * 模块说明：backend/src/utils/password.ts
 * 文件职责：统一处理密码规范、密码强度校验与密码哈希/比对能力。
 * 维护说明：
 * - 客户端注册、找回重置、本人改密等入口都应复用这里的统一密码策略，避免规则散落；
 * - 哈希与校验仍保持无状态实现，便于服务层在事务内外安全复用。
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { BizError } from './errors.js'

const scrypt = promisify(scryptCallback)
const PASSWORD_SALT_BYTES = 16
const PASSWORD_KEY_LENGTH = 64
export const CLIENT_PASSWORD_POLICY_MIN_LENGTH = 8

/**
 * 客户端统一密码策略说明：
 * - 仅对真正提交到后端的密码做 `trim` 归一化，避免首尾空格造成“看起来一致、实际不一致”；
 * - 当前策略要求至少 8 位，且必须同时包含字母与数字；
 * - 若后续要扩展特殊字符、黑名单词等规则，只在这里集中追加即可。
 */
export function normalizePassword(plainPassword: string): string {
  return plainPassword.trim()
}

/**
 * 判断客户端密码是否满足统一策略：
 * - 该方法只返回布尔结果，便于路由层和服务层共用；
 * - 路由层可据此做请求拦截，服务层仍应继续调用断言方法兜底。
 */
export function isClientPasswordPolicySatisfied(plainPassword: string): boolean {
  const normalizedPassword = normalizePassword(plainPassword)
  return (
    normalizedPassword.length >= CLIENT_PASSWORD_POLICY_MIN_LENGTH &&
    /[A-Za-z]/.test(normalizedPassword) &&
    /\d/.test(normalizedPassword)
  )
}

/**
 * 生成统一的客户端密码策略报错文案：
 * - 允许调用方传入“密码 / 新密码”等字段名，保证不同入口的提示语义自然；
 * - 文案集中后，前后端联调时也更容易保持一致。
 */
export function getClientPasswordPolicyMessage(fieldLabel = '密码'): string {
  return `${fieldLabel}至少 ${CLIENT_PASSWORD_POLICY_MIN_LENGTH} 位，且需包含字母和数字`
}

/**
 * 对客户端密码执行统一断言：
 * - 服务层应始终调用该方法，避免绕过路由直接调用服务时失去约束；
 * - 断言通过后返回归一化后的密码，便于后续直接参与哈希。
 */
export function assertClientPasswordPolicy(plainPassword: string, fieldLabel = '密码'): string {
  const normalizedPassword = normalizePassword(plainPassword)
  if (!isClientPasswordPolicySatisfied(normalizedPassword)) {
    throw new BizError(getClientPasswordPolicyMessage(fieldLabel), 400)
  }
  return normalizedPassword
}

/**
 * 生成密码哈希：
 * - 使用 Node.js 原生 scrypt，避免额外引入第三方依赖；
 * - 以 `salt:hash` 格式持久化，便于后续统一校验。
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  const normalizedPassword = normalizePassword(plainPassword)
  const salt = randomBytes(PASSWORD_SALT_BYTES).toString('hex')
  const derivedKey = (await scrypt(normalizedPassword, salt, PASSWORD_KEY_LENGTH)) as Buffer
  return `${salt}:${derivedKey.toString('hex')}`
}

/**
 * 校验密码是否匹配：
 * - 使用 timingSafeEqual 避免因字符串比较短路引入时序侧信道；
 * - 若历史数据格式异常，直接返回 false，避免抛出底层异常影响登录接口稳定性。
 */
export async function verifyPassword(plainPassword: string, persistedPasswordHash: string): Promise<boolean> {
  const [salt, storedHash] = persistedPasswordHash.split(':')
  if (!salt || !storedHash) {
    return false
  }

  const normalizedPassword = normalizePassword(plainPassword)
  const derivedKey = (await scrypt(normalizedPassword, salt, PASSWORD_KEY_LENGTH)) as Buffer
  const storedBuffer = Buffer.from(storedHash, 'hex')

  if (storedBuffer.length !== derivedKey.length) {
    return false
  }

  return timingSafeEqual(storedBuffer, derivedKey)
}
