/**
 * 文件说明：TOTP 动态码（RFC 6238）与恢复码工具，供管理端两步验证使用。
 * 实现逻辑：
 * - 秘钥为 20 字节随机数，按 RFC 4648 Base32（无填充）呈现给认证器应用；
 * - 动态码为 HMAC-SHA1、6 位、30 秒步长，与主流认证器（Google Authenticator、Microsoft Authenticator 等）默认参数一致；
 * - 校验时允许前后各 1 个时间步的时钟漂移，只接受大于上次成功时间步的步号，并用恒定时间比较；
 * - 恢复码取自去掉 0/O/1/I 的 32 字符表，12 位（60 位熵）分三组展示，输入时忽略大小写、空格与连字符。
 * 维护说明：修改位数、步长或算法会使已绑定的认证器全部失效，必须配合重新绑定流程，不能直接改常量。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const TOTP_SECRET_BYTES = 20
const RECOVERY_CODE_LENGTH = 12

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
export const TOTP_ISSUER = 'Y-Link'

export function encodeBase32(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

export function decodeBase32(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index < 0) {
      throw new Error('TOTP 秘钥不是合法的 Base32 字符串')
    }
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(TOTP_SECRET_BYTES))
}

export function currentTotpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS)
}

/** RFC 4226 HOTP：计数器按 8 字节大端写入，动态截断后取 6 位十进制。 */
export function computeHotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', key).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3]
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/**
 * 校验动态码并返回命中的时间步：
 * - 窗口内每个候选步都参与计算，耗时与命中位置无关；
 * - `afterStep` 为上次成功使用的步号，小于等于它的步一律不接受（防重放）；
 * - 未命中返回 null。
 */
export function matchTotpStep(
  secretBase32: string,
  code: string,
  options: { nowMs?: number; window?: number; afterStep?: number | null } = {},
): number | null {
  const normalizedCode = code.replace(/\s/g, '')
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalizedCode)) {
    return null
  }
  const key = decodeBase32(secretBase32)
  const current = currentTotpStep(options.nowMs)
  const window = options.window ?? 1
  const actual = Buffer.from(normalizedCode)
  let matchedStep: number | null = null
  for (let step = current - window; step <= current + window; step += 1) {
    if (step < 0) continue
    const expected = Buffer.from(computeHotp(key, step))
    const allowed = options.afterStep === null || options.afterStep === undefined || step > options.afterStep
    if (timingSafeEqual(expected, actual) && allowed && matchedStep === null) {
      matchedStep = step
    }
  }
  return matchedStep
}

/** 认证器扫码用的 otpauth URI；标签与参数均按 URI 组件编码，避免 `+` 被当成空格显示。 */
export function buildTotpUri(input: { accountName: string; secret: string; issuer?: string }): string {
  const issuer = input.issuer ?? TOTP_ISSUER
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.accountName)}`
  const params = [
    ['secret', input.secret],
    ['issuer', issuer],
    ['algorithm', 'SHA1'],
    ['digits', String(TOTP_DIGITS)],
    ['period', String(TOTP_PERIOD_SECONDS)],
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  return `otpauth://totp/${label}?${params.join('&')}`
}

/** 32 整除 256，按字节取低 5 位不会产生取模偏差。 */
export function generateRecoveryCode(): string {
  const chars = [...randomBytes(RECOVERY_CODE_LENGTH)].map((byte) => RECOVERY_CODE_ALPHABET[byte & 31])
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((group) => group.join('')).join('-')
}

export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

export function isRecoveryCodeShape(normalized: string): boolean {
  return normalized.length === RECOVERY_CODE_LENGTH && [...normalized].every((char) => RECOVERY_CODE_ALPHABET.includes(char))
}
