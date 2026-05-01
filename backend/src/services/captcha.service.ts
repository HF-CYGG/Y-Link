/**
 * 模块说明：backend/src/services/captcha.service.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { BizError } from '../utils/errors.js'
import { EphemeralTicketStore } from '../utils/ephemeral-ticket-store.js'

interface CaptchaTicket {
  code: string
  expireAt: number
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const CAPTCHA_TTL_MS = 5 * 60 * 1000
const captchaStore = new EphemeralTicketStore<CaptchaTicket>({
  maxSize: 4000,
  resolveExpiresAt: (ticket) => ticket.expireAt,
})

const randomCaptchaCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buffer = randomBytes(6)
  return Array.from(buffer).map((item) => alphabet[item % alphabet.length]).join('')
}

const buildCaptchaSvg = (code: string) => {
  const chars = code.split('')
  const noiseLines = Array.from({ length: 5 }, (_, index) => {
    const startX = 8 + index * 24
    const startY = 10 + (index % 2 === 0 ? 4 : 16)
    const endX = startX + 28
    const endY = startY + (index % 2 === 0 ? 12 : -10)
    return `<path d="M${startX} ${startY} L${endX} ${endY}" stroke="rgba(13,148,136,0.22)" stroke-width="1.5" stroke-linecap="round"/>`
  }).join('')
  const noiseDots = Array.from({ length: 12 }, (_, index) => {
    const cx = 10 + ((index * 11) % 120)
    const cy = 8 + ((index * 7) % 24)
    const radius = index % 3 === 0 ? 1.4 : 1
    return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="rgba(15,23,42,0.16)"/>`
  }).join('')
  const labels = chars
    .map((char, index) => {
      const x = 18 + index * 18
      const y = 27 + (index % 2 === 0 ? -2 : 3)
      const rotate = index % 2 === 0 ? -8 : 7
      const color = index % 2 === 0 ? '#0f766e' : '#0f172a'
      return `<text x="${x}" y="${y}" font-size="20" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-weight="700" transform="rotate(${rotate} ${x} ${y})">${char}</text>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="40" viewBox="0 0 140 40" role="img" aria-label="图形验证码"><defs><linearGradient id="captcha-bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f8fafc"/><stop offset="100%" stop-color="#d1fae5"/></linearGradient></defs><rect width="140" height="40" rx="10" fill="url(#captcha-bg)"/>${noiseLines}${noiseDots}${labels}</svg>`
}

class CaptchaService {
  createCaptcha() {
    const captchaId = randomUUID()
    const code = randomCaptchaCode()
    captchaStore.set(captchaId, {
      code,
      expireAt: Date.now() + CAPTCHA_TTL_MS,
    })
    return {
      captchaId,
      captchaSvg: buildCaptchaSvg(code),
      expiresInSeconds: Math.floor(CAPTCHA_TTL_MS / 1000),
    }
  }

  verifyCaptcha(captchaId: string, captchaCode: string): void {
    const ticket = captchaStore.get(captchaId)
    if (!ticket) {
      throw new BizError('验证码已失效，请刷新后重试', 400)
    }
    if (ticket.code !== captchaCode.trim().toUpperCase()) {
      throw new BizError('验证码错误', 400)
    }
    captchaStore.delete(captchaId)
  }
}

export const captchaService = new CaptchaService()
