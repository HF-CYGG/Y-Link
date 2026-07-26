import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'
import { BizError } from './errors.js'

export const STAFF_INVITE_CODE_PATTERN = /^\d{8}$/
export const STAFF_INVITE_TTL_MS = 24 * 60 * 60 * 1000
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

export function digestStaffInviteCode(staffNo: string, inviteCode: string): string {
  return createHmac('sha256', getPepper()).update(`${staffNo.trim()}\0${normalizeStaffInviteCode(inviteCode)}`).digest('hex')
}

export function verifyStaffInviteCode(staffNo: string, inviteCode: string, expectedDigest: string): boolean {
  const actual = Buffer.from(digestStaffInviteCode(staffNo, inviteCode), 'hex')
  const expected = Buffer.from(expectedDigest, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function generateStaffInviteCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0')
}
