import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'
import { BizError } from './errors.js'

export const STAFF_INVITE_CODE_PATTERN = /^\d{8}$/
export const STAFF_INVITE_CONFIG_KEY = 'client.staff_invite_code'
export const STAFF_INVITE_LOCK_MS = 30 * 60 * 1000
export const STAFF_INVITE_MAX_FAILURES = 5

function getPepper(): string {
  const pepper = env.INVITE_CODE_PEPPER?.trim() ?? ''
  if (Buffer.byteLength(pepper, 'utf8') < 32) {
    throw new BizError('教师邀请码功能未配置安全密钥，请联系管理员', 503)
  }
  return pepper
}

export function normalizeStaffInviteCode(inviteCode: string): string {
  const normalized = inviteCode.trim()
  if (!STAFF_INVITE_CODE_PATTERN.test(normalized)) throw new BizError('邀请码必须是 8 位数字', 400)
  return normalized
}

// 固定业务域将统一码与历史绑定工号的摘要隔离；邀请码始终按字符串处理，保留前导零。
export function digestSharedStaffInviteCode(inviteCode: string): string {
  return createHmac('sha256', getPepper()).update(`client.staff-invite-code:v1\0${normalizeStaffInviteCode(inviteCode)}`).digest('hex')
}

export function verifySharedStaffInviteCode(inviteCode: string, expectedDigest: string): boolean {
  const actual = Buffer.from(digestSharedStaffInviteCode(inviteCode), 'hex')
  const expected = Buffer.from(expectedDigest, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
