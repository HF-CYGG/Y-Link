import { randomBytes, randomUUID } from 'node:crypto'
import { BizError } from '../utils/errors.js'

interface CaptchaTicket {
  code: string
  expireAt: number
}

const CAPTCHA_TTL_MS = 5 * 60 * 1000
const captchaStore = new Map<string, CaptchaTicket>()

const cleanupExpiredTickets = () => {
  const now = Date.now()
  for (const [captchaId, ticket] of captchaStore) {
    if (ticket.expireAt <= now) {
      captchaStore.delete(captchaId)
    }
  }
}

const randomCaptchaCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buffer = randomBytes(6)
  return Array.from(buffer).map((item) => alphabet[item % alphabet.length]).join('')
}

const buildCaptchaSvg = (code: string) => {
  const chars = code.split('')
  const labels = chars
    .map((char, index) => {
      const x = 22 + index * 18
      const y = 28 + (index % 2 === 0 ? -1 : 2)
      return `<text x="${x}" y="${y}" font-size="20" fill="#0f172a" font-family="Arial" font-weight="700">${char}</text>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="40" viewBox="0 0 140 40"><rect width="140" height="40" rx="10" fill="#e2e8f0"/>${labels}</svg>`
}

class CaptchaService {
  createCaptcha() {
    cleanupExpiredTickets()
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
    cleanupExpiredTickets()
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
