/**
 * 文件说明：登录类原始输入在审计中的安全表示（OWASP 日志速查表：凭据与个人信息不得原样落日志）。
 * 实现逻辑：
 * - 账号不存在的登录失败、频控与锁定等守卫事件里，账号框输入可能是误填的密码，也可能是他人手机号或邮箱；
 * - 手机号记为 `138****5678`，邮箱记为 `a***@域名`，其它输入只保留前 2 个字符与长度；
 * - 追加 HMAC 指纹前 10 位（由数据加密主密钥派生的子密钥计算），同一输入在不同事件间可关联分析，
 *   但无法从审计反推原文；主密钥不可用时指纹记为 `nokey`。
 * 维护说明：已解析为真实账号的主体（管理端规范用户名、客户端 `uid:<ID>`）不属于敏感输入，应原样记录以便排查。
 */
import { createHmac } from 'node:crypto'
import { deriveDataSubkey } from './data-encryption.js'

const MAINLAND_MOBILE_PATTERN = /^1\d{10}$/
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/

let fingerprintKey: Buffer | null | undefined

function resolveFingerprintKey(): Buffer | null {
  if (fingerprintKey === undefined) {
    fingerprintKey = deriveDataSubkey('audit-subject-fingerprint.v1')
  }
  return fingerprintKey
}

export function maskLoginInputForAudit(rawInput: string | null | undefined): string {
  const value = (rawInput ?? '').trim()
  if (!value) return '(空)'
  let masked: string
  if (MAINLAND_MOBILE_PATTERN.test(value)) {
    masked = `${value.slice(0, 3)}****${value.slice(-4)}`
  } else if (EMAIL_PATTERN.test(value)) {
    const [localPart, domain] = value.split('@')
    masked = `${Array.from(localPart)[0] ?? ''}***@${domain}`
  } else {
    const characters = Array.from(value)
    masked = `${characters.slice(0, 2).join('')}***(${characters.length})`
  }
  const key = resolveFingerprintKey()
  const fingerprint = key
    ? createHmac('sha256', key).update(value.toLowerCase(), 'utf8').digest('hex').slice(0, 10)
    : 'nokey'
  return `${masked}#${fingerprint}`
}

/** 客户端登录主体：已解析账号为 `uid:<ID>` 原样保留，否则按原始输入脱敏。 */
export function describeClientRiskSubjectForAudit(subject: string): string {
  return subject.startsWith('uid:') ? subject : maskLoginInputForAudit(subject)
}
